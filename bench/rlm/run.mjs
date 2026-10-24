#!/usr/bin/env node
/**
 * Compares stock pi tools ("pi" arm) with raga's RLM mode ("raga" arm, `--rlm`) on the same model.
 * See README.md in this directory.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findSessionFile, summarizeSession } from "./session.mjs";
import { TASKS } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARMS = { pi: [], raga: ["--rlm"] };

const { values: opts } = parseArgs({
	options: {
		task: { type: "string", default: "all" },
		arms: { type: "string", default: "pi,raga" },
		runs: { type: "string", default: "1" },
		model: { type: "string", default: "exe-dev-anthropic/claude-haiku-4-5@llm" },
		seed: { type: "string", default: "1" },
		jobs: { type: "string", default: "1" },
		"timeout-min": { type: "string", default: "15" },
		extension: { type: "string", multiple: true },
		help: { type: "boolean", short: "h" },
	},
});

if (opts.help) {
	console.log(`Usage: RAGA_BENCH_REPO=<checkout> node bench/rlm/run.mjs [options]

  --task T1|T2|all        Tasks to run (default all)
  --arms pi,raga          Arms to run (default pi,raga)
  --runs N                Runs per task and arm (default 1)
  --model provider/id     Model for both arms (default exe-dev-anthropic/claude-haiku-4-5@llm)
  --seed N                Fixture seed (default 1)
  --jobs N                Runs in parallel (default 1)
  --timeout-min N         Kill a run after N minutes and count it as a failure (default 15)
  --extension <path>      Load only these extensions (repeatable); without it pi discovers extensions as usual`);
	process.exit(0);
}

const repo = process.env.RAGA_BENCH_REPO;
if (!repo || !existsSync(join(repo, "pi-test.sh"))) {
	console.error("Set RAGA_BENCH_REPO to a raga checkout that has pi-test.sh (see bench/rlm/README.md).");
	process.exit(2);
}
const taskIds = opts.task === "all" ? Object.keys(TASKS) : opts.task.split(",");
const arms = opts.arms.split(",");
for (const id of taskIds) if (!TASKS[id]) throw new Error(`unknown task ${id}`);
for (const arm of arms) if (!ARMS[arm]) throw new Error(`unknown arm ${arm}`);
const runs = Number(opts.runs);
const seed = Number(opts.seed);
const jobs = Math.max(1, Number(opts.jobs));
const timeoutMs = Number(opts["timeout-min"]) * 60_000;

/** A Python with pytest: RAGA_BENCH_PYTHON, else bench/rlm/.venv (created with uv on first use). */
function ensurePython() {
	if (process.env.RAGA_BENCH_PYTHON) return process.env.RAGA_BENCH_PYTHON;
	const venv = join(HERE, ".venv");
	const python = join(venv, "bin", "python");
	const hasPytest = () => spawnSync(python, ["-c", "import pytest"]).status === 0;
	if (existsSync(python) && hasPytest()) return python;
	console.error(`Creating ${venv} with pytest (uv)...`);
	for (const args of [["venv", "-q", venv], ["pip", "install", "-q", "--python", python, "pytest"]]) {
		const result = spawnSync("uv", args, { stdio: "inherit" });
		if (result.status !== 0) throw new Error(`uv ${args.join(" ")} failed; set RAGA_BENCH_PYTHON to a Python with pytest`);
	}
	return python;
}

const python = resolve(ensurePython());
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(HERE, "results", stamp);
const workRoot = join(tmpdir(), "raga-bench", stamp);
mkdirSync(outDir, { recursive: true });

const truths = {};
for (const id of taskIds) {
	const fixtureDir = join(workRoot, "fixtures", id);
	mkdirSync(join(fixtureDir, "work"), { recursive: true });
	truths[id] = TASKS[id].generate(fixtureDir, seed);
}

function piArgs(arm, sessionDir, prompt) {
	const args = ["-p", "--model", opts.model, "--session-dir", sessionDir, "--no-skills", "-nc", "-np", "--no-mcp"];
	if (opts.extension?.length) {
		args.push("--no-extensions");
		for (const path of opts.extension) args.push("-e", resolve(path));
	}
	return [...args, ...ARMS[arm], prompt];
}

function runOnce({ task, arm, index }) {
	const id = `${task}-${arm}-${index}`;
	const runDir = join(outDir, "runs", id);
	const sessionDir = join(runDir, "session");
	const fixtureDir = join(workRoot, "fixtures", task);
	const workDir = join(workRoot, "runs", id);
	mkdirSync(sessionDir, { recursive: true });
	cpSync(join(fixtureDir, "work"), workDir, { recursive: true });
	const venvBin = dirname(python);
	const env = { ...process.env, PATH: `${venvBin}:${process.env.PATH}`, VIRTUAL_ENV: dirname(venvBin) };
	const started = Date.now();
	return new Promise((resolveRun) => {
		const child = spawn("bash", [join(repo, "pi-test.sh"), ...piArgs(arm, sessionDir, TASKS[task].prompt)], {
			cwd: workDir,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.pipe(createWriteStream(join(runDir, "stdout.txt")));
		child.stderr.pipe(createWriteStream(join(runDir, "stderr.txt")));
		let timedOut = false;
		const killGroup = (signal) => {
			try {
				process.kill(-child.pid, signal);
			} catch {}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
		}, timeoutMs);
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			killGroup("SIGKILL"); // stray kernels or shells left in the group
			const wallSeconds = (Date.now() - started) / 1000;
			const sessionFile = findSessionFile(sessionDir);
			const session = sessionFile ? summarizeSession(sessionFile) : undefined;
			let score;
			try {
				score = TASKS[task].score({
					workDir,
					fixtureDir,
					truth: truths[task],
					python,
					finalText: session?.finalText ?? "",
				});
			} catch (error) {
				score = { success: false, scoreError: String(error) };
			}
			if (timedOut) score.success = false;
			const record = {
				id,
				task,
				arm,
				index,
				exitCode,
				timedOut,
				wallSeconds,
				workDir,
				sessionFile: sessionFile ?? null,
				...score,
				usage: session?.usage ?? null,
				subUsage: session?.subUsage ?? null,
				toolCalls: session?.toolCalls ?? {},
				subCallSites: session?.subCallSites ?? null,
				assistantTurns: session?.assistantTurns ?? 0,
				stopReason: session?.stopReason ?? null,
				errorMessage: session?.errorMessage ?? null,
				finalText: session?.finalText ?? "",
			};
			const tools = Object.entries(record.toolCalls)
				.map(([name, n]) => `${name}=${n}`)
				.join(" ");
			console.error(
				`${id}: ${record.success ? "PASS" : "FAIL"}${timedOut ? " (timeout)" : ""} ${wallSeconds.toFixed(0)}s $${(record.usage?.cost ?? 0).toFixed(4)} ${tools}`,
			);
			resolveRun(record);
		});
	});
}

const queue = [];
for (const task of taskIds) for (let index = 1; index <= runs; index++) for (const arm of arms) queue.push({ task, arm, index });

const records = [];
const resultsFile = join(outDir, "results.json");
const writeResults = () =>
	writeFileSync(
		resultsFile,
		`${JSON.stringify({ stamp, repo, model: opts.model, seed, runs, truths, records }, null, 2)}\n`,
	);

async function worker() {
	while (queue.length > 0) {
		records.push(await runOnce(queue.shift()));
		writeResults();
	}
}
console.error(`Results: ${outDir}\nWork dirs: ${workRoot}`);
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const rows = [
	"| Task | Arm | Success | Input tok | Output tok | Cache read/write tok | Cost $ | Wall s | Tool calls | Detail |",
	"|---|---|---|---|---|---|---|---|---|---|",
];
for (const task of taskIds) {
	for (const arm of arms) {
		const group = records.filter((r) => r.task === task && r.arm === arm).sort((a, b) => a.index - b.index);
		if (group.length === 0) continue;
		const u = (key) => mean(group.map((r) => r.usage?.[key] ?? 0));
		const toolNames = [...new Set(group.flatMap((r) => Object.keys(r.toolCalls)))].sort();
		const toolTotal = mean(group.map((r) => Object.values(r.toolCalls).reduce((a, b) => a + b, 0)));
		const toolDetail = toolNames.map((name) => `${name} ${mean(group.map((r) => r.toolCalls[name] ?? 0)).toFixed(1)}`).join(", ");
		let detail;
		if (task === "T1") {
			detail = `answers ${group.map((r) => r.answer ?? "none").join("/")} (truth ${truths.T1.answer}); mean abs err ${mean(group.map((r) => r.absError ?? truths.T1.answer)).toFixed(1)}`;
		} else {
			detail = `visible ${group.filter((r) => r.visiblePass).length}/${group.length}, hidden ${group.filter((r) => r.hiddenPass).length}/${group.length}, old name gone ${group.filter((r) => r.oldNameIn?.length === 0).length}/${group.length}`;
		}
		const sub = mean(group.map((r) => r.subUsage?.cost ?? 0));
		if (sub > 0) detail += `; sub-LLM $${sub.toFixed(4)}`;
		const timeouts = group.filter((r) => r.timedOut).length;
		if (timeouts > 0) detail += `; ${timeouts} timeout(s)`;
		rows.push(
			`| ${task} | ${arm} | ${group.filter((r) => r.success).length}/${group.length} | ${fmtInt(u("input"))} | ${fmtInt(u("output"))} | ${fmtInt(u("cacheRead"))}/${fmtInt(u("cacheWrite"))} | ${u("cost").toFixed(4)} | ${mean(group.map((r) => r.wallSeconds)).toFixed(0)} | ${toolTotal.toFixed(1)} (${toolDetail}) | ${detail} |`,
		);
	}
}
const table = `Model ${opts.model}, seed ${seed}, ${runs} run(s) per task and arm; token, cost, wall, and tool-call columns are means.\n\n${rows.join("\n")}\n`;
writeFileSync(join(outDir, "table.md"), table);
console.log(table);
console.log(`JSON: ${resultsFile}`);
