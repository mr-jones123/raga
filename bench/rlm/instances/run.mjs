#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ARMS, budgetPlan, cases } from "./tasks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
	help: { type: "boolean", short: "h" }, list: { type: "boolean" }, run: { type: "boolean" }, scenario: { type: "boolean" },
	arms: { type: "string", default: Object.keys(ARMS).join(",") }, model: { type: "string" },
	"harness-source": { type: "string" }, "agent-dir": { type: "string" }, output: { type: "string" },
	runs: { type: "string", default: "5" }, seed: { type: "string", default: "1" },
	"max-model-calls": { type: "string", default: "80" }, "budget-usd": { type: "string", default: "5" },
	"timeout-min": { type: "string", default: "20" }, "max-output-tokens": { type: "string", default: "2048" },
	"input-usd-per-million": { type: "string" }, "output-usd-per-million": { type: "string" },
} });
if (values.help) {
	console.log(`Usage: node bench/rlm/instances/run.mjs [options]

No provider is contacted without --run. Default prints validated configuration.
  --list                       List arms and development/selection/held-out cases
  --scenario                   Run deterministic real-module smoke without a provider
  --run --model provider/id     Execute paid transfer comparison
  --arms LIST                  Comma-separated arms (default all seven)
  --harness-source PATH        Trusted portable baseline, identical across arms
  --agent-dir PATH             Host-only provider auth/config directory
  --runs N                     Independent interleaved repetitions (default 5)
  --seed N                     Reproducible case and arm order (default 1)
  --max-model-calls N           Total call ceiling per arm/repetition (default 80)
  --budget-usd N                Conservative dollar reservation ceiling per arm/repetition (default 5)
  --max-output-tokens N         Per-call output token cap (default 2048)
  --timeout-min N               Deadline per arm/repetition (default 20)
  --input-usd-per-million N     Override conservative input/cache price
  --output-usd-per-million N    Override output price
  --output PATH                New supervisor output directory, outside source/project/harness

Child model calls, learning, failed proposals, and retries all consume the same ledger.
At most the displayed arms * runs * budget-usd dollars are admitted. Full-context
reservation can stop before the ceiling even when actual usage is smaller.
Scenario and provider results are separate. Neither automatically enables promotion.`);
	process.exit(0);
}
const positive = (name, fallback, integer = false) => {
	const result = Number(values[name] ?? fallback);
	if (!Number.isFinite(result) || result <= 0 || integer && !Number.isSafeInteger(result)) throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}`);
	return result;
};
const arms = values.arms.split(",");
if (new Set(arms).size !== arms.length || arms.some((arm) => !ARMS[arm])) throw new Error("Unknown or duplicate arm");
const seed = Number(values.seed);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be a uint32");
if (values.run && values.scenario) throw new Error("Choose --run or --scenario");
if (values.run && !/^[^/\s]+\/\S+$/.test(values.model ?? "")) throw new Error("--run requires --model provider/id");
const config = {
	arms, seed, runs: positive("runs", 5, true), model: values.model ?? null,
	maxModelCalls: positive("max-model-calls", 80, true), budgetUsd: positive("budget-usd", 5),
	timeoutMs: positive("timeout-min", 20) * 60_000, maxOutputTokens: positive("max-output-tokens", 2048, true),
	inputRate: values["input-usd-per-million"] ? positive("input-usd-per-million") : null,
	outputRate: values["output-usd-per-million"] ? positive("output-usd-per-million") : null,
	harnessSource: values["harness-source"] ? realpathSync(resolve(values["harness-source"])) : null,
	agentDir: values["agent-dir"] ? realpathSync(resolve(values["agent-dir"])) : null,
};
if (values.run && config.maxModelCalls < 24) throw new Error("--max-model-calls must be at least 24 to allocate all task and learning phases");
if (values.list) {
	console.log(JSON.stringify({ arms: ARMS, cases: cases(seed).map(({ id, split, repository, family }) => ({ id, split, repository, family })) }, null, 2));
	process.exit(0);
}
console.log(JSON.stringify({ ...config, budgetPlan: budgetPlan(config.maxModelCalls), maximumReservedDollars: config.budgetUsd * config.runs * arms.length, execute: Boolean(values.run || values.scenario) }, null, 2));
if (!values.run && !values.scenario) process.exit(0);
const sourceRoot = realpathSync(resolve(here, "../../.."));
const output = values.output ? resolve(values.output) : mkdtempSync(join(tmpdir(), "raga-transfer-"));
mkdirSync(output, { recursive: true });
const canonicalOutput = realpathSync(output);
for (const protectedRoot of [sourceRoot, config.harnessSource, config.agentDir].filter(Boolean)) {
	const rel = relative(protectedRoot, canonicalOutput);
	if (rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new Error("Output must be outside source, harness, and auth directories");
}
config.output = canonicalOutput;
const configPath = join(output, "config.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const child = spawn(process.execPath, ["--import", pathToFileURL(join(sourceRoot, "packages/coding-agent/src/experimental/source-resolver.ts")).href, join(here, values.scenario ? "scenario.mjs" : "runner.mjs"), configPath], { stdio: "inherit", detached: true });
let killTimer;
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const timer = setTimeout(() => {
	stop();
	killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10_000);
}, config.timeoutMs * config.runs * arms.length + 60_000);
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("close", (code) => {
	clearTimeout(timer); clearTimeout(killTimer);
	try { process.kill(-child.pid, "SIGKILL"); } catch {}
	process.exitCode = code ?? 1;
	console.log(`JSON: ${join(output, values.scenario ? "scenario.json" : "results.json")}`);
});
