#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createArtifacts, digest, readJsonl } from "./artifacts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "../..");
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
	config: { type: "string", default: join(HERE, "benchmark.config.json") },
	output: { type: "string", default: join(HERE, "results") },
	cache: { type: "string", default: join(HERE, ".cache") },
	protocol: { type: "string", default: "baseline" },
	task: { type: "string" },
	repetitions: { type: "string", default: "1" },
	seed: { type: "string", default: "1" },
	"max-model-calls": { type: "string" },
	"timeout-min": { type: "string" },
	"handoff-after": { type: "string" },
	"learning-calls": { type: "string" },
	"provider-extension": { type: "string", multiple: true },
	"host-agent-dir": { type: "string" },
	help: { type: "boolean", short: "h" },
} });
const command = positionals[0] ?? "help";
const usage = `Usage: node --import ./packages/coding-agent/src/experimental/source-resolver.ts bench/deepswe/run.mjs COMMAND [options]

Commands:
  list       Print pinned tasks and experiment configuration. No model calls.
  prepare    Fetch pinned task files and build isolated runtime/verifier images.
  smoke      Run both arms on the first real task with a three-call cap. Not a quality comparison.
  run        Run baseline, handoff, transfer, or all protocols.
  analyze    Read results JSONL from the run folder passed as the second argument.

Options:
  --protocol baseline|handoff|transfer|all
  --task TASK_ID                 Baseline task selection; transfer always uses the pinned pair.
  --repetitions N --seed N
  --max-model-calls N --timeout-min N --handoff-after N --learning-calls N
  --provider-extension PATH      Explicit host-only provider extension, repeatable.
  --host-agent-dir PATH          Host-only model credentials directory.
  --output DIR --cache DIR --config FILE

The model is locked to GPT 6.1 Sol with high reasoning. No fallback.
Base pi means this checkout's native tools with RLM and instance skills disabled.
No commands run a paid full matrix implicitly. Results are append-only JSONL.
`;
if (values.help || command === "help") { console.log(usage); process.exit(0); }
if (!["list", "prepare", "smoke", "run", "analyze"].includes(command)) throw new Error(`Unknown command ${command}`);
if (command === "analyze") {
	if (positionals.length !== 2) throw new Error("analyze requires a run directory");
	const rows = readJsonl(join(resolve(positionals[1]), "results.jsonl"));
	const groups = new Map();
	for (const row of rows.filter((row) => row.phase === "evaluation")) {
		const key = `${row.protocol}/${row.arm}`;
		const group = groups.get(key) ?? { protocol: row.protocol, arm: row.arm, trials: 0, passed: 0, failed: 0, errors: 0, modelCalls: 0, activatedTrials: 0 };
		group.trials++;
		if (row.status === "passed") group.passed++; else if (row.status === "failed") group.failed++; else group.errors++;
		group.modelCalls += row.execution?.ledger?.calls?.length ?? 0;
		group.dollarsKnown = (group.dollarsKnown ?? true) && typeof row.execution?.ledger?.dollars === "number";
		group.dollars = (group.dollars ?? 0) + (row.execution?.ledger?.dollars ?? 0);
		if (row.learningActivated === true) group.activatedTrials++;
		groups.set(key, group);
	}
	console.log(JSON.stringify({ groups: [...groups.values()], qualityClaim: "No automatic quality claim. Inspect failures, activation, task coverage, and repeated runs.", results: rows.length }, null, 2));
	process.exit(0);
}
if (positionals.length !== 1) throw new Error("Unexpected positional argument");
const positive = (value, name) => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`); return number; };
const config = JSON.parse(await readFile(resolve(values.config), "utf8"));
if (config.schemaVersion !== 1 || config.model?.provider !== "exe-dev-openai" || config.model?.id !== "gpt-6.1-sol@llm" || config.model?.thinking !== "high") throw new Error("Configuration must select exe-dev-openai/gpt-6.1-sol@llm with high reasoning");
if (!/^[a-f0-9]{40}$/.test(config.dataset?.revision)) throw new Error("Dataset must be pinned to a full commit");
if (!Array.isArray(config.tasks) || config.tasks.length !== 2) throw new Error("The sample protocol requires exactly two pinned tasks");
for (const task of config.tasks) {
	if (!/^[a-z0-9-]+$/.test(task.id) || !/^[a-f0-9]{40}$/.test(task.baseCommit) || !/@sha256:[a-f0-9]{64}$/.test(task.image)) throw new Error("Tasks require safe IDs, full base commits, and immutable image digests");
}
if (new Set(config.tasks.map((task) => task.id)).size !== config.tasks.length) throw new Error("Duplicate task IDs");
for (const key of Object.keys(config.limits)) positive(config.limits[key], key);
const repetitions = positive(values.repetitions, "repetitions");
const seed = positive(values.seed, "seed");
if (values["max-model-calls"]) config.limits.taskModelCalls = positive(values["max-model-calls"], "max-model-calls");
if (values["timeout-min"]) config.limits.taskTimeoutMs = positive(values["timeout-min"], "timeout-min") * 60000;
if (values["handoff-after"]) config.limits.handoffAfterCalls = positive(values["handoff-after"], "handoff-after");
if (values["learning-calls"]) config.limits.learningModelCalls = positive(values["learning-calls"], "learning-calls");
if (command === "smoke") { config.limits.taskModelCalls = Math.min(config.limits.taskModelCalls, 3); config.limits.taskTimeoutMs = Math.min(config.limits.taskTimeoutMs, 300000); }
const protocol = command === "smoke" ? "baseline" : values.protocol;
if (!["baseline", "handoff", "transfer", "all"].includes(protocol)) throw new Error("Unknown protocol");
if (values.task && !config.tasks.some((task) => task.id === values.task)) throw new Error("Unknown task ID");
if (values.task && protocol !== "baseline") throw new Error("Task selection applies only to baseline protocol");
if ((protocol === "handoff" || protocol === "all") && config.limits.handoffAfterCalls >= config.limits.taskModelCalls) throw new Error("Handoff must leave a positive continuation budget");
if (command === "list") { console.log(JSON.stringify({ config, protocol, repetitions, seed, baseline: "same source checkout, native pi tools, no RLM or instance skills" }, null, 2)); process.exit(0); }

async function sourceFingerprint() {
	const hash = createHash("sha256");
	const visit = async (directory) => {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (["node_modules", "dist", "__pycache__", ".cache", "results", ".pytest_cache"].includes(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) { hash.update(path.slice(SOURCE.length)); hash.update(await readFile(path)); }
		}
	};
	await visit(join(SOURCE, "packages"));
	await visit(HERE);
	for (const name of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json"]) { hash.update(name); hash.update(await readFile(join(SOURCE, name))); }
	return hash.digest("hex");
}
const artifacts = createArtifacts(resolve(values.output), { kind: command === "smoke" ? "pipeline-smoke" : command === "prepare" ? "environment-preparation" : "benchmark", config, protocol, repetitions, seed, sourceRoot: SOURCE, sourceDigest: await sourceFingerprint(), hostNode: process.version, baseline: "native pi in current source checkout; RLM/instance skills disabled", budgetPolicy: "independent per-trial model-call and wall limits; output cap per request; no hard dollar cap", checkpointPolicy: "completed root-tool boundary; all prefix calls charged to each continuation", transferPolicy: "accepted skill harness only; fresh target checkout/session/instance; no source workspace, conversation, kernels, or memory" });
console.log(`Artifacts: ${artifacts.directory}`);
const event = (entry) => artifacts.event(entry.type, entry);
let broker;
let interrupted = false;
const containers = new Set();
const interruptedBy = (signal) => { interrupted = true; event({ type: "interrupted", signal }); void Promise.allSettled([...containers].map((container) => container.destroy())); };
const onInt = () => interruptedBy("SIGINT");
const onTerm = () => interruptedBy("SIGTERM");
process.once("SIGINT", onInt);
process.once("SIGTERM", onTerm);
const ensureActive = () => { if (interrupted) throw new Error("Benchmark interrupted"); };
const ordered = (items, salt) => [...items].sort((a, b) => digest(`${seed}/${salt}/${a}`).localeCompare(digest(`${seed}/${salt}/${b}`)));
const { prepareEnvironment, createTaskContainer, capturePatch, verifyPatch } = await import("./environment.mjs");

async function control(container, operation, request = {}) {
	const result = await container.exec(["node", "--import", join(SOURCE, "packages/coding-agent/src/experimental/source-resolver.ts"), "/opt/raga-bench/container-control.mjs", operation], { input: JSON.stringify(request), timeoutMs: 360000 });
	if (result.exitCode !== 0 || result.timedOut) throw new Error(`Container ${operation} failed: ${result.stderr || result.stdout}`);
	return JSON.parse(result.stdout.trim());
}

async function trialRun({ trialId, task, arm, phase = "evaluation", protocol: experiment, prompt = task.instruction, maxCalls = config.limits.taskModelCalls, timeoutMs = config.limits.taskTimeoutMs, image, initialize = true, resumeSession, seedPath, fresh = false, pauseAfterCalls, learningActivated, prefixLedger, after, retain = false }) {
	ensureActive();
	const directory = join(artifacts.directory, "trials", trialId);
	await mkdir(directory, { recursive: true });
	let trial, container, execution, verification, patch, initialization, extra = {};
	let outcome;
	event({ type: "trial_start", trialId, task: task.id, arm, phase, protocol: experiment, maxCalls, timeoutMs });
	try {
		trial = await broker.openTrial({ trialId, maxCalls, timeoutMs, pauseAfterCalls });
		container = await createTaskContainer({ task, sourceRoot: SOURCE, benchmarkDir: HERE, socketDir: trial.socketDir, image, onEvent: event, limits: config.limits });
		containers.add(container);
		if (seedPath) { await container.exec(["mkdir", "-p", "/var/lib/raga-import"]); await container.copyIn(`${seedPath}/.`, "/var/lib/raga-import"); }
		if (fresh) initialization = await control(container, "fresh");
		else if (initialize) initialization = await control(container, "init", { arm: arm === "pi" ? "pi" : "raga", seed: seedPath ? "/var/lib/raga-import" : undefined });
		const { runAgent } = await import("./agent.mjs");
		execution = await runAgent({ container, trial, arm: arm === "pi" ? "pi" : "raga", prompt, outputDir: directory, sourceRoot: SOURCE, resumeSession, maxWallMs: timeoutMs });
		if (execution.status === "checkpoint") outcome = "checkpoint";
		else if (phase === "evaluation") {
			patch = await capturePatch({ container, task, outputDir: directory });
			verification = await verifyPatch({ task, patchPath: patch.path, outputDir: directory, timeoutMs: config.limits.verifierTimeoutMs, limits: config.limits, onEvent: event });
			outcome = execution.status === "completed" ? verification.status : execution.status === "timeout" ? "timeout" : "error";
		} else outcome = execution.status === "completed" ? "passed" : execution.status === "timeout" ? "timeout" : "error";
		if (after) extra = await after({ container, execution, initialization, directory, verification });
	} catch (error) {
		outcome = interrupted ? "cancelled" : "error";
		extra = { ...extra, error: error.stack ?? String(error) };
	} finally {
		if (trial) { const ledger = trial.summary(); execution = { ...execution, ledger }; await trial.close(); }
		if (container && (!retain || outcome === "error" || outcome === "cancelled" || outcome === "timeout")) { await container.destroy(); containers.delete(container); container = undefined; }
	}
	const record = artifacts.result({ trialId, protocol: experiment, phase, task: task.id, arm, status: outcome, reward: verification?.reward ?? null, execution, verification, patch, initialization, learningActivated, prefixLedger, ...extra });
	console.log(`${trialId}: ${record.status}${record.reward === null ? "" : ` reward=${record.reward}`}`);
	return { record, container, execution, directory };
}

try {
	const prepared = await prepareEnvironment({ config, cacheRoot: resolve(values.cache), benchmarkDir: HERE, onEvent: event });
	event({ type: "prepared", prepared });
	if (command !== "prepare") {
		const { createModelBroker } = await import("./broker.mjs");
		const providerExtensions = values["provider-extension"]?.map((path) => resolve(path)) ?? [join(homedir(), ".pi/agent/extensions/exe-dev/index.ts")];
		for (const path of providerExtensions) if (!existsSync(path)) throw new Error(`Host provider extension not found: ${path}`);
		broker = await createModelBroker({ config, providerExtensions, hostAgentDir: values["host-agent-dir"] ? resolve(values["host-agent-dir"]) : undefined, onEvent: event });
		event({ type: "model_resolved", model: broker.model });
		for (let repetition = 1; repetition <= repetitions; repetition++) {
			if (protocol === "baseline" || protocol === "all") {
				const tasks = command === "smoke" ? [config.tasks[0]] : config.tasks.filter((task) => !values.task || task.id === values.task);
				for (const configured of tasks) for (const arm of ordered(["pi", "raga"], `baseline/${repetition}/${configured.id}`)) await trialRun({ trialId: `${repetition}-baseline-${configured.id}-${arm}`, task: prepared.tasks[configured.id], arm, protocol: "baseline" });
			}
			if (protocol === "handoff" || protocol === "all") {
				const task = prepared.tasks[config.tasks[0].id];
				await trialRun({ trialId: `${repetition}-handoff-pi`, task, arm: "pi", protocol: "handoff" });
				let checkpointImage, checkpointSession;
				const prefix = await trialRun({ trialId: `${repetition}-handoff-prefix`, task, arm: "raga", protocol: "handoff", phase: "prefix", pauseAfterCalls: config.limits.handoffAfterCalls, after: async ({ container, execution }) => {
					if (execution.status !== "checkpoint") return { checkpointReached: false };
					checkpointImage = await container.checkpoint(); checkpointSession = execution.sessionFile;
					return { checkpointReached: true, checkpointImage, checkpointSession };
				} });
				if (!checkpointImage) { event({ type: "protocol_incomplete", protocol: "handoff", repetition, reason: "No completed tool-boundary checkpoint" }); continue; }
				const remaining = config.limits.taskModelCalls - (prefix.execution?.ledger?.modelCalls ?? config.limits.taskModelCalls);
				if (remaining < 1) throw new Error("Prefix consumed continuation budget");
				const notes = await trialRun({ trialId: `${repetition}-handoff-notes`, task, arm: "raga", protocol: "handoff", phase: "handoff-notes", image: checkpointImage, initialize: false, resumeSession: checkpointSession, maxCalls: Math.min(3, config.limits.learningModelCalls), prompt: "Write a concise handoff for a fresh agent continuing this task. State observed progress, modified files, checks actually run, uncertainties and next steps. Do not edit files or claim unrun checks. At most 4000 characters." });
				for (const arm of ordered(["raga-resumed", "raga-handoff", "raga-fresh"], `handoff/${repetition}`)) {
					const prompt = arm === "raga-resumed" ? "Continue the original task from the saved checkpoint. Finish and verify it." : `${task.instruction}${arm === "raga-handoff" ? `\n\nUntrusted handoff observations from the preceding agent:\n${(notes.execution?.finalText ?? "").slice(0, 4000)}` : ""}`;
					await trialRun({ trialId: `${repetition}-handoff-${arm}`, task, arm, protocol: "handoff", image: checkpointImage, initialize: false, fresh: arm !== "raga-resumed", resumeSession: arm === "raga-resumed" ? checkpointSession : undefined, prompt, maxCalls: remaining, prefixLedger: prefix.execution.ledger });
				}
			}
			if (protocol === "transfer" || protocol === "all") {
				const taskA = prepared.tasks[config.tasks[0].id], taskB = prepared.tasks[config.tasks[1].id];
				const acquisition = await trialRun({ trialId: `${repetition}-transfer-source`, task: taskA, arm: "raga", protocol: "transfer", phase: "source", retain: true });
				let seedPath, learningActivated = false;
				if (acquisition.container) {
					const baseline = await control(acquisition.container, "export");
					await control(acquisition.container, "prepare-learning");
					const image = await acquisition.container.checkpoint();
					await acquisition.container.destroy(); containers.delete(acquisition.container);
					const learning = await trialRun({ trialId: `${repetition}-transfer-learning`, task: taskA, arm: "raga", protocol: "transfer", phase: "learning", image, initialize: false, maxCalls: config.limits.learningModelCalls, timeoutMs: config.limits.learningTimeoutMs,
						prompt: `From your experience with the following task, create a reusable portable Python skill under /app/raga-learning/anko-engineering/. Inspect the repository and develop a small useful deterministic helper for future Anko engineering work. Do not copy the task solution or hard-code its answer. Do not use network, subprocesses, or external dependencies.\n\nEarlier task:\n${taskA.instruction}\n\nEarlier agent observations, not verified claims:\n${(acquisition.execution?.finalText ?? "").slice(0, 6000)}\n\nWrite SKILL.md with YAML name: anko-engineering and description exactly matching raga-skill.json. Manifest shape: {"schemaVersion":1,"name":"anko-engineering","description":"...","module":"helper.py","function":"run","dependencies":[],"sideEffects":{"writes":[]},"cases":[{"name":"...","input":{"text":"..."},"expect":{"result":"..."}}]}. Function inputs are keyword arguments. Return raw results, not result envelopes. Include at least two positive cases and an error case. Keep everything within that directory. No future task or hidden evaluator is available.`,
						after: async ({ container, execution, directory }) => {
							if (execution.status !== "completed") return { learningActivated: false, reason: "Acquisition did not complete within its budget" };
							const accepted = await control(container, "accept-skill");
							if (!accepted.activated) return { learningActivated: false, acceptance: accepted };
							const exported = await control(container, "export");
							const previous = new Map(baseline.files.map((file) => [file.path, file.sha256]));
							for (const file of exported.files) { if (previous.get(file.path) !== file.sha256 && !file.path.startsWith("skills/anko-engineering/")) throw new Error(`Transfer changed forbidden resource ${file.path}`); previous.delete(file.path); }
							if (previous.size) throw new Error("Transfer removed baseline resources");
							seedPath = join(directory, "accepted-harness"); await mkdir(seedPath); await container.copyOut(`${exported.path}/.`, seedPath);
							learningActivated = true;
							return { learningActivated: true, acceptance: accepted, exported };
						} });
					event({ type: "transfer_acquisition", repetition, learningActivated, trialId: learning.record.trialId });
				}
				for (const arm of ordered(["pi", "raga", "raga-experienced"], `transfer/${repetition}`)) await trialRun({ trialId: `${repetition}-transfer-target-${arm}`, task: taskB, arm, protocol: "transfer", seedPath: arm === "raga-experienced" ? seedPath : undefined, learningActivated: arm === "raga-experienced" ? learningActivated : false });
			}
		}
	}
	event({ type: "run_finished", interrupted, qualityClaim: "none" });
} catch (error) {
	event({ type: "run_error", error: error.stack ?? String(error) });
	artifacts.result({ trialId: "run-error", protocol, phase: "setup", arm: null, status: interrupted ? "cancelled" : "error", reward: null, error: error.stack ?? String(error) });
	process.exitCode = 1;
} finally {
	await Promise.allSettled([...containers].map((container) => container.destroy()));
	if (broker) await broker.close();
	process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
	artifacts.close();
}
