import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { finished, pipeline } from "node:stream/promises";

const INSPECT_SESSION = String.raw`
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [sourceRoot, sessionDir, sessionId, checkpoint, arm] = process.argv.slice(1);
const { SessionManager } = await import(pathToFileURL(sourceRoot + '/packages/coding-agent/src/core/session-manager.ts').href);
const file = SessionManager.findById('/app', sessionId, sessionDir);
if (!file) throw new Error('Native session file was not persisted');
const manager = SessionManager.open(file);
const entries = manager.getBranch();
const messages = manager.buildSessionContext().messages;
const last = messages.findLast(message => message.role === 'assistant');
let sessionFile = file;
let snapshot = entries.findLast(entry => entry.type === 'custom' && entry.customType === 'rlm-kernel-snapshot');
let boundaryEntryId = null;
if (checkpoint === 'true') {
  const boundary = entries.findLast(entry => entry.type === 'message' && entry.message.role === 'toolResult');
  if (!boundary) throw new Error('Checkpoint did not end at a completed tool result');
  boundaryEntryId = boundary.id;
  if (arm === 'raga' && (!snapshot || !existsSync(snapshot.data?.path))) throw new Error('Checkpoint has no persisted native kernel snapshot');
  sessionFile = manager.createBranchedSession(boundary.id);
  if (!sessionFile) throw new Error('Native checkpoint branch was not persisted');
  if (snapshot && !manager.getBranch().some(entry => entry.id === snapshot.id)) manager.appendCustomEntry(snapshot.customType, snapshot.data);
  const checkpointMessages = manager.buildSessionContext().messages;
  if (checkpointMessages.at(-1)?.role !== 'toolResult') throw new Error('Checkpoint branch does not terminate at the completed tool boundary');
}
const artifactPaths = [...new Set(entries.filter(entry => entry.type === 'custom' && entry.customType === 'rlm-kernel-snapshot').map(entry => entry.data?.path).filter(path => typeof path === 'string' && existsSync(path)))];
console.log(JSON.stringify({ sessionFile, sourceSessionFile: file, sessionId: manager.getSessionId(), sourceSessionId: sessionId, boundaryEntryId, snapshot: snapshot?.data ?? null, artifactPaths, finalText: last?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? null, stopReason: last?.stopReason ?? null, error: last?.errorMessage ?? null, modelChanges: entries.filter(entry => entry.type === 'model_change').map(entry => ({ provider: entry.provider, modelId: entry.modelId })) }));
`;

const PREPARE_PI = String.raw`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('/app/.raga')) throw new Error('The pi baseline must not contain a raga instance');
if (existsSync('/app/.pi/settings.json')) {
  const project = JSON.parse(readFileSync('/app/.pi/settings.json', 'utf8'));
  if (project.rlm?.enabled) throw new Error('Project settings enable RLM for the pi baseline');
}
mkdirSync('/var/lib/raga-agent', { recursive: true });
mkdirSync('/var/lib/raga-sessions', { recursive: true });
writeFileSync('/var/lib/raga-agent/settings.json', JSON.stringify({ defaultProvider: 'exe-dev-openai', defaultModel: 'gpt-6.1-sol@llm', defaultThinkingLevel: 'high', enabledModels: ['exe-dev-openai/gpt-6.1-sol@llm'], cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, rlm: { enabled: false }, packages: [], extensions: [], skills: [] }));
`;

function nativeNode(sourceRoot, code, ...args) {
	return ["node", "--import", join(sourceRoot, "packages/coding-agent/src/experimental/source-resolver.ts"), "--input-type=module", "-e", code, ...args];
}

async function checkedExec(container, argv, timeoutMs = 30_000) {
	const result = await container.exec(argv, { timeoutMs, cwd: "/app" });
	if (result.exitCode !== 0 || result.timedOut) throw new Error(`Container runtime command failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
	return result.stdout;
}

export async function runAgent({ container, trial, arm, prompt, outputDir, sourceRoot, resumeSession, maxWallMs }) {
	if (arm !== "pi" && arm !== "raga") throw new Error(`Unknown benchmark arm ${arm}`);
	if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A nonempty agent prompt is required");
	if (!Number.isSafeInteger(maxWallMs) || maxWallMs <= 0) throw new Error("maxWallMs must be a positive integer");
	if (trial.model?.provider !== "exe-dev-openai" || trial.model?.id !== "gpt-6.1-sol@llm") throw new Error("Agent requires the exact GPT 6.1 Sol broker model");
	outputDir = resolve(outputDir);
	sourceRoot = resolve(sourceRoot);
	await mkdir(outputDir, { recursive: true });
	const startedAt = Date.now();
	const stdoutPath = join(outputDir, "stdout.jsonl");
	const stderrPath = join(outputDir, "stderr.log");
	const sessionArtifactsDir = join(outputDir, "session-artifacts");
	const sessionDir = arm === "pi" ? "/var/lib/raga-sessions" : "/app/.raga/state/sessions";
	const launchId = randomUUID();
	const pidFile = `/var/lib/raga-agent/bench-${launchId}.pid`;
	const cli = join(sourceRoot, "packages/coding-agent/src/cli.ts");
	let sessionId = resumeSession ? null : launchId;
	let headerId = null;
	let exitCode = null;
	let processSignal = null;
	let error = null;
	let timedOut = false;
	let interrupted = false;
	let child;
	let timer;
	let terminating;
	let rawPartial = "";
	let lastAssistant = null;
	let malformedLines = 0;
	let outputFailure = null;
	let sessionInfo = null;
	const artifactErrors = [];
	const consumeLine = (line) => {
		if (!line.trim()) return;
		try {
			const event = JSON.parse(line);
			if (event.type === "session" && typeof event.id === "string") headerId = event.id;
			if (event.type === "message_end" && event.message?.role === "assistant") lastAssistant = event.message;
		} catch { malformedLines++; }
	};
	const terminate = () => {
		terminating ??= (async () => {
			if (!child || child.exitCode !== null || child.signalCode !== null) return;
			try {
				await checkedExec(container, ["node", "-e", "const fs=require('node:fs'); const f=process.argv[1]; if(fs.existsSync(f)){const pid=Number(fs.readFileSync(f,'utf8')); if(Number.isInteger(pid)&&pid>1){try{process.kill(pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}}}", pidFile], 10_000);
			} catch (failure) { artifactErrors.push(`Graceful CLI termination failed: ${failure.message}`); }
			await new Promise((resolveExit) => {
				if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
				const grace = setTimeout(() => {
					void container.exec(["node", "-e", "const fs=require('node:fs'); const f=process.argv[1]; if(fs.existsSync(f)){try{process.kill(Number(fs.readFileSync(f,'utf8')),'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}", pidFile], { timeoutMs: 10_000 }).finally(() => child.kill("SIGKILL"));
					resolveExit();
				}, 15_000);
				child.once("close", () => { clearTimeout(grace); resolveExit(); });
			});
		})();
		return terminating;
	};
	const onInterrupt = () => { interrupted = true; void terminate(); };
	try {
		if (arm === "pi") await checkedExec(container, ["node", "-e", PREPARE_PI]);
		else await checkedExec(container, ["node", "-e", "const fs=require('node:fs');if(!fs.existsSync('/app/.raga/instance.json'))throw Error('Initialize the raga instance before runAgent');"]);
		const args = ["--mode", "json", "--print", "--offline", "--no-mcp", "--thinking", "high", "--provider", trial.model.provider, "--model", `${trial.model.provider}/${trial.model.id}`, "--session-dir", sessionDir];
		if (arm === "pi") args.push("--no-extensions", "--extension", "/opt/raga-bench/broker-client.ts", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes");
		else args.push("--rlm");
		if (resumeSession) args.push("--session", resumeSession);
		else args.push("--session-id", sessionId);
		args.push("--", prompt);
		const launcher = "import {mkdirSync,writeFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url'; const [pidFile,cli,...args]=process.argv.slice(1);mkdirSync('/var/lib/raga-agent',{recursive:true});writeFileSync(pidFile,String(process.pid));process.argv=[process.execPath,cli,...args];await import(pathToFileURL(cli).href);";
		const argv = ["exec", "--workdir", "/app", "--env", "PI_OFFLINE=1", "--env", "PI_CODING_AGENT_DIR=/var/lib/raga-agent", "--env", "HOME=/home/agent", "--env", `RAGA_BENCH_ARM=${arm}`, container.id, ...nativeNode(sourceRoot, launcher, pidFile, cli, ...args)];
		await writeFile(join(outputDir, "command.json"), `${JSON.stringify({ command: "docker", argv, arm, resumeSession: resumeSession ?? null, startedAt, sourceRoot, model: trial.model, thinking: "high" }, null, 2)}\n`);
		child = spawn("docker", argv, { stdio: ["ignore", "pipe", "pipe"] });
		process.once("SIGINT", onInterrupt);
		process.once("SIGTERM", onInterrupt);
		const remainingMs = Math.max(1, maxWallMs - (Date.now() - startedAt));
		timer = setTimeout(() => { timedOut = true; void terminate(); }, remainingMs);
		const stdout = createWriteStream(stdoutPath, { flags: "wx" });
		const stderr = createWriteStream(stderrPath, { flags: "wx" });
		child.stdout.on("data", (chunk) => {
			rawPartial += chunk.toString("utf8");
			let newline;
			while ((newline = rawPartial.indexOf("\n")) >= 0) {
				consumeLine(rawPartial.slice(0, newline));
				rawPartial = rawPartial.slice(newline + 1);
			}
		});
		const pipes = [pipeline(child.stdout, stdout), pipeline(child.stderr, stderr)].map((pipe) => pipe.catch((failure) => { outputFailure ??= failure; void terminate(); }));
		await new Promise((resolveExit, rejectExit) => {
			child.once("error", rejectExit);
			child.once("close", (code, signal) => { exitCode = code; processSignal = signal; resolveExit(); });
		});
		clearTimeout(timer);
		await Promise.all(pipes);
		if (rawPartial.trim()) consumeLine(rawPartial);
		if (terminating) await terminating;
		if (outputFailure) throw outputFailure;
		if (malformedLines) throw new Error(`Native CLI emitted ${malformedLines} non-JSON stdout records`);
		if (headerId) sessionId = headerId;
		if (!sessionId) throw new Error("Native CLI did not emit its source session identity");
	} catch (failure) {
		error = failure instanceof Error ? failure.message : String(failure);
		if (child && child.exitCode === null && child.signalCode === null) await terminate();
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", onInterrupt);
		process.removeListener("SIGTERM", onInterrupt);
	}
	const ledger = trial.summary();
	const checkpoint = ledger.pause !== null && ledger.pause !== undefined;
	try {
		if (sessionId) {
			const output = await checkedExec(container, nativeNode(sourceRoot, INSPECT_SESSION, sourceRoot, sessionDir, sessionId, String(checkpoint), arm));
			sessionInfo = JSON.parse(output.trim());
			const selected = sessionInfo.modelChanges.at(-1);
			if (selected?.provider !== trial.model.provider || selected?.modelId !== trial.model.id) throw new Error("Persisted source session selected an incorrect model");
		}
	} catch (failure) { artifactErrors.push(failure.message); }
	try {
		await mkdir(sessionArtifactsDir, { recursive: true });
		await container.copyOut(sessionDir, join(sessionArtifactsDir, "sessions"));
		for (const [index, path] of (sessionInfo?.artifactPaths ?? []).entries()) {
			await container.copyOut(path, join(sessionArtifactsDir, `kernel-${index}.dill`));
		}
	} catch (failure) { artifactErrors.push(`Source session artifact copy failed: ${failure.message}`); }
	const finalText = sessionInfo?.finalText ?? lastAssistant?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? null;
	const stopReason = sessionInfo?.stopReason ?? lastAssistant?.stopReason ?? null;
	const assistantError = sessionInfo?.error ?? lastAssistant?.errorMessage ?? null;
	const checkpointError = typeof assistantError === "string" && assistantError.startsWith("CHECKPOINT:");
	if (!error && !checkpointError && assistantError) error = assistantError;
	if (!error && !checkpoint && exitCode !== 0) error = `Native CLI exited with ${exitCode ?? processSignal ?? "unknown status"}`;
	if (!error && !checkpoint && stopReason !== "stop") error = `Native CLI did not complete a final answer (${stopReason ?? "no assistant result"})`;
	if (artifactErrors.length) error = [error, ...artifactErrors].filter(Boolean).join("; ");
	let status = timedOut ? "timeout" : interrupted || error ? "error" : checkpoint ? "checkpoint" : "completed";
	if (status === "checkpoint" && (!sessionInfo?.boundaryEntryId || !checkpointError)) {
		status = "error";
		error = "Checkpoint did not preserve the completed native tool boundary";
	}
	const sessionFile = sessionInfo?.sessionFile ?? null;
	const hostSessionFile = sessionFile ? join(sessionArtifactsDir, "sessions", sessionFile.split("/").at(-1)) : null;
	const result = { status, exitCode, processSignal, sessionFile, hostSessionFile, sessionArtifactsDir, sourceSessionFile: sessionInfo?.sourceSessionFile ?? null, sourceSessionId: sessionId, checkpoint: checkpoint ? { ...ledger.pause, boundaryEntryId: sessionInfo?.boundaryEntryId ?? null, snapshot: sessionInfo?.snapshot ?? null } : null, finalText, stopReason, error, ledger, stdoutPath, stderrPath, wallMs: Date.now() - startedAt, artifactErrors };
	await writeFile(join(outputDir, "agent-result.json"), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}
