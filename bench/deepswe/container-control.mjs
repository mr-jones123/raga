import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.env.RAGA_BENCH_SOURCE;
if (!sourceRoot) throw new Error("RAGA_BENCH_SOURCE is required");
const load = (path) => import(pathToFileURL(join(sourceRoot, "packages/coding-agent/src", path)).href);
const store = await load("core/instances/store.ts");
const { getBundledHarnessPath } = await load("core/instances/bundle.ts");
const { checkSandbox, sandboxCommand } = await load("core/instances/sandbox.ts");
const { resolvePythonEnv } = await load("core/rlm/python-env.ts");
const root = "/app/.raga";
const settings = { cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } };
const operation = process.argv[2];
const request = JSON.parse(readFileSync(0, "utf8") || "{}");

async function tree(directory, prefix = "") {
	const files = [];
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const name = prefix ? `${prefix}/${entry.name}` : entry.name;
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Symlink forbidden in exported harness: ${name}`);
		if (entry.isDirectory()) files.push(...await tree(path, name));
		else if (entry.isFile()) {
			const content = await readFile(path);
			files.push({ path: name, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
		} else throw new Error(`Non-regular harness entry: ${name}`);
	}
	return files;
}

async function initialize(arm, seed) {
	if (arm !== "pi" && arm !== "raga") throw new Error(`Unknown arm ${arm}`);
	await mkdir("/home/agent", { recursive: true });
	await mkdir("/var/lib/raga-agent", { recursive: true });
	await mkdir("/var/lib/raga-sessions", { recursive: true });
	await writeFile("/var/lib/raga-agent/settings.json", JSON.stringify({ ...settings, rlm: { enabled: false } }));
	if (arm === "pi") return { arm, instance: null };
	const harness = await mkdtemp("/var/lib/raga-harness-");
	await cp(seed ?? getBundledHarnessPath(), harness, { recursive: true });
	await tree(harness);
	await mkdir(join(harness, "extensions", "deepswe-broker"), { recursive: true });
	await cp("/opt/raga-bench/broker-client.ts", join(harness, "extensions", "deepswe-broker", "index.ts"));
	await writeFile(join(harness, "settings.json"), JSON.stringify({ ...settings, rlm: { enabled: true } }));
	try {
		const instance = await store.initializeInstance("/app", { harnessSource: harness });
		const pin = await store.openInstance(root);
		return { arm, instance, pin, files: await tree(pin.resourceRoot) };
	} finally { await rm(harness, { recursive: true, force: true }); }
}

async function execute() {
	switch (operation) {
		case "init": return initialize(request.arm, request.seed);
		case "fresh": {
			const previous = await store.openInstance(root);
			const seed = await mkdtemp("/var/lib/raga-handoff-");
			await cp(previous.resourceRoot, seed, { recursive: true });
			await rm(root, { recursive: true });
			try { return { previousInstanceId: previous.instanceId, ...await initialize("raga", seed) }; }
			finally { await rm(seed, { recursive: true, force: true }); }
		}
		case "export": {
			const pin = await store.openInstance(root);
			const destination = await mkdtemp("/var/lib/raga-export-");
			await cp(pin.resourceRoot, destination, { recursive: true });
			return { path: destination, revision: pin.revision, instanceId: pin.instanceId, files: await tree(destination) };
		}
		case "prepare-learning": {
			const directory = "/app/raga-learning/anko-engineering";
			await mkdir(directory, { recursive: true });
			return { directory, pin: await store.openInstance(root) };
		}
		case "accept-skill": {
			const directory = "/app/raga-learning/anko-engineering";
			const files = await tree(directory);
			if (files.reduce((sum, file) => sum + file.bytes, 0) > 128 * 1024) throw new Error("Learned skill exceeds 128 KiB");
			if (files.some((file) => !/\.(md|py|json)$/.test(file.path))) throw new Error("Only Markdown, Python, and JSON may transfer");
			const { proposeSkill } = await load("core/instances/skills.ts");
			const python = await resolvePythonEnv();
			const proposal = await proposeSkill(root, directory, { python: python.python, pythonMounts: [...python.runtimeRoots, ...python.modulePaths], timeoutMs: 30000 });
			if (!proposal.validation.accepted || !proposal.evidenceId) return { activated: false, proposal };
			const instance = await store.activateRevision(root, proposal.candidate.revision, {
				expectedRevision: proposal.candidate.baseRevision, evidenceId: proposal.evidenceId, approved: true, approvedBy: "user",
			});
			return { activated: true, instance, proposal, validationScope: "fresh-interpreter manifest cases; no claim of task transfer benefit" };
		}
		case "check": {
			const sandbox = await checkSandbox();
			if (!sandbox.available) throw new Error(sandbox.reason);
			const result = await sandboxCommand({ command: "/usr/local/bin/go", args: ["test", "./..."], policy: { workspace: "/app", writable: ["/app"], readOnly: [] }, timeoutMs: 300000 });
			if (result.exitCode !== 0 || result.timedOut || result.aborted) throw new Error(`Sandboxed Go tests failed: ${JSON.stringify(result)}`);
			const python = await resolvePythonEnv();
			return { sandbox, go: result, python, node: process.version };
		}
		default: throw new Error(`Unknown container operation ${operation}`);
	}
}

try { console.log(JSON.stringify(await execute())); }
catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
