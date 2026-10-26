import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { handleInstanceCommand } from "../src/cli/instance-command.ts";
import type { MemoryEntry, MemoryRetrieval } from "../src/core/instances/memory.ts";
import { instancePaths, readInstance } from "../src/core/instances/store.ts";
import type { HarnessCandidate, InstanceManifest } from "../src/core/instances/types.ts";

let temporary: string;
let project: string;
let logs: MockInstance<typeof console.log>;
let errors: MockInstance<typeof console.error>;
let previousExitCode: typeof process.exitCode;

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "instance-cli-"));
	project = join(temporary, "project");
	await mkdir(project);
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
	logs = vi.spyOn(console, "log").mockImplementation(() => {});
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	process.exitCode = previousExitCode;
	vi.restoreAllMocks();
	await rm(temporary, { recursive: true, force: true });
});

async function invoke<T>(...args: string[]): Promise<T> {
	logs.mockClear();
	errors.mockClear();
	process.exitCode = undefined;
	expect(await handleInstanceCommand(["instance", ...args, "--project", project])).toBe(true);
	expect(errors.mock.calls).toEqual([]);
	expect(process.exitCode ?? 0).toBe(0);
	expect(logs.mock.calls).toHaveLength(1);
	return JSON.parse(String(logs.mock.calls[0][0])) as T;
}

describe("instance command", () => {
	test("leaves unrelated commands and help requests free of instance writes", async () => {
		expect(await handleInstanceCommand(["auth", "check"])).toBe(false);
		expect(logs).not.toHaveBeenCalled();
		expect(errors).not.toHaveBeenCalled();
		expect(await handleInstanceCommand(["instance", "--help"])).toBe(true);
		expect(await readdir(project)).toEqual([]);
	});

	test.each([
		["init", "--unknown"],
		["init", "unexpected"],
		["init", "--project", "--approved"],
		["init", "--project", "/tmp", "--project", "/other"],
		["migrate"],
		["activate", "revision", "--evidence", "evidence", "--expected-base", "base"],
		["activate", "revision", "--approved", "--evidence", "evidence"],
		["rollback", "revision"],
		["candidate", "commit", "candidate"],
		["memory", "retrieve", "--query", "test", "--limit", "0"],
		["memory", "retrieve", "--query", "test", "--limit", "9007199254740992"],
		["memory", "get", "id", "--version", "1.5"],
		["memory", "export", "--ids", "first,"],
		["refine", "--goal", "test", "--check", "echo test"],
		["refine", "--goal", "test", "--check", "[]"],
		["refine", "--goal", "test", "--check", "[42]"],
		["skill", "verify"],
		["skill", "verify", "--directory", "skill", "--revision", "rev", "--skill", "name"],
		["no-mistakes", "enable", "--approved"],
		["verify", "enable"],
		["verify", "install", "--approved"],
		["no-mistakes", "provision"],
		["no-mistakes", "respond", "--action", "publish", "--approved"],
		["no-mistakes", "run", "--intent-file", "intent", "--network", "--yes"],
	])("rejects malformed input without creating instance state %j", async (...args) => {
		expect(await handleInstanceCommand(["instance", ...args, "--project", project])).toBe(true);
		expect(process.exitCode).toBe(2);
		expect(errors).toHaveBeenCalledOnce();
		expect(logs).not.toHaveBeenCalled();
		expect(await readdir(project)).toEqual([]);
	});

	test.each([
		{ executable: "relative-agent", version: "1.0.0" },
		{ executable: "/usr/bin/node", version: "1.0.0", args: [42] },
		{ executable: "/usr/bin/node", version: "1.0.0", environment: { TOKEN: "secret" } },
	])("rejects malformed adapter configuration before backend activation %j", async (config) => {
		await invoke("init");
		const path = join(temporary, "agent.json");
		await writeFile(path, JSON.stringify(config));
		await handleInstanceCommand([
			"instance",
			"no-mistakes",
			"enable",
			"--project",
			project,
			"--approved",
			"--network",
			"--agent-config",
			path,
		]);
		expect(process.exitCode).toBe(2);
		await expect(
			readFile(join(project, ".raga", "state", "backends", "no-mistakes", "enabled.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("initializes default skills and reports the exact pinned revision and capabilities", async () => {
		vi.spyOn(process, "cwd").mockReturnValue(project);
		expect(await handleInstanceCommand(["instance", "init"])).toBe(true);
		expect(errors.mock.calls).toEqual([]);
		const initialized = JSON.parse(String(logs.mock.calls[0][0])) as InstanceManifest;
		expect(initialized.projectRoot).toBe(project);
		const status = await invoke<{
			manifest: InstanceManifest;
			pin: { revision: string; resourceRoot: string; projectRoot: string };
			skills: Array<{ name: string }>;
			capabilities: { sandbox: { available: boolean }; noMistakes: { installed: boolean } };
		}>("status");
		expect(status.manifest.id).toBe(initialized.id);
		expect(status.pin.revision).toBe(initialized.activeRevision);
		expect(status.pin.projectRoot).toBe(project);
		expect(status.skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["poteto-mode", "architect", "no-mistakes"]),
		);
		expect(typeof status.capabilities.sandbox.available).toBe("boolean");
		expect(typeof status.capabilities.noMistakes.installed).toBe("boolean");
		expect(await readFile(join(status.pin.resourceRoot, "skills", "no-mistakes", "SKILL.md"), "utf8")).toContain(
			"no-mistakes",
		);
	});

	test("creates and commits a candidate without changing the active revision", async () => {
		const initial = await invoke<InstanceManifest>("init");
		const candidate = await invoke<HarnessCandidate>("candidate", "create");
		expect(candidate.baseRevision).toBe(initial.activeRevision);
		await writeFile(join(candidate.path, "AGENTS.md"), "Candidate project instructions.\n");
		const committed = await invoke<HarnessCandidate>(
			"candidate",
			"commit",
			candidate.id,
			"--message",
			"Test candidate",
		);
		expect(committed.revision).toMatch(/^[a-f0-9]{40}$/);
		const inspected = await invoke<HarnessCandidate>("candidate", "inspect", candidate.id);
		expect(inspected.revision).toBe(committed.revision);
		const revisions = await invoke<Array<{ revision: string; active: boolean; accepted: boolean }>>("revisions");
		expect(revisions).toContainEqual(
			expect.objectContaining({ revision: initial.activeRevision, active: true, accepted: true }),
		);
		expect(revisions).toContainEqual(
			expect.objectContaining({ revision: committed.revision, active: false, accepted: false }),
		);
		expect(
			await handleInstanceCommand([
				"instance",
				"activate",
				committed.revision!,
				"--approved",
				"--evidence",
				"missing",
				"--expected-base",
				initial.activeRevision,
				"--project",
				project,
			]),
		).toBe(true);
		expect(process.exitCode).toBe(1);
		expect((await readInstance(instancePaths(project).root)).activeRevision).toBe(initial.activeRevision);
	});

	test("records, revises, retrieves, exports, and retires structured memory", async () => {
		await invoke("init");
		const input = join(temporary, "input.json");
		await writeFile(
			input,
			JSON.stringify({
				text: "Compile before deploying the release",
				scope: project,
				kind: "lesson",
				evidence: ["test:release"],
				sharing: "reusable",
			}),
		);
		const first = await invoke<MemoryEntry>("memory", "observe", "--input", input);
		expect(first.text).toBe("Compile before deploying the release");
		await writeFile(
			input,
			JSON.stringify({
				text: "Compile and inspect diagnostics before deploying",
				scope: project,
				kind: "lesson",
				evidence: ["test:release-2"],
				sharing: "reusable",
				expectedVersion: first.version,
			}),
		);
		const second = await invoke<MemoryEntry>("memory", "revise", first.id, "--input", input);
		expect(second.version).toBe(first.version + 1);
		const historic = await invoke<MemoryEntry>("memory", "get", first.id, "--version", String(first.version));
		expect(historic.text).toBe(first.text);
		const history = await invoke<MemoryEntry[]>("memory", "history", first.id);
		expect(history.map((entry) => entry.version)).toEqual([first.version, second.version]);
		const retrieval = await invoke<MemoryRetrieval>(
			"memory",
			"retrieve",
			"--query",
			"compile diagnostics",
			"--max-chars",
			"1024",
		);
		expect(retrieval.selected.map((entry) => entry.id)).toContain(first.id);
		expect(retrieval.text.length).toBeLessThanOrEqual(1024);
		const foreign = await invoke<MemoryRetrieval>(
			"memory",
			"retrieve",
			"--query",
			"compile",
			"--scope",
			"other-project",
		);
		expect(foreign.selected).toEqual([]);
		const exported = await invoke<MemoryEntry[]>("memory", "export", "--ids", first.id);
		expect(exported).toHaveLength(1);
		expect(exported[0].text).toBe(second.text);
		const retired = await invoke<MemoryEntry>(
			"memory",
			"retire",
			first.id,
			"--reason",
			"Replaced deployment pipeline",
		);
		expect(retired.status).toBe("retired");
		const afterRetirement = await invoke<MemoryRetrieval>("memory", "retrieve", "--query", "compile");
		expect(afterRetirement.selected).toEqual([]);
	});

	test("forks only the accepted harness and supports deliberate reusable memory import", async () => {
		const source = await invoke<InstanceManifest>("init");
		const input = join(temporary, "lesson.json");
		await writeFile(
			input,
			JSON.stringify({
				text: "Check compiler diagnostics",
				scope: project,
				kind: "lesson",
				evidence: ["test:compiler"],
				sharing: "reusable",
			}),
		);
		const lesson = await invoke<MemoryEntry>("memory", "observe", "--input", input);
		const exported = await invoke<MemoryEntry[]>("memory", "export", "--ids", lesson.id);
		const exportFile = join(temporary, "export.json");
		await writeFile(exportFile, JSON.stringify(exported));
		await writeFile(join(instancePaths(project).state, "private-token"), "not copied");
		const sourceProject = project;
		project = join(temporary, "fork");
		await mkdir(project);
		const forked = await invoke<InstanceManifest>(
			"fork",
			"--from",
			sourceProject,
			"--revision",
			source.activeRevision,
		);
		expect(forked.id).not.toBe(source.id);
		expect(forked.forkedFrom).toEqual({ instanceId: source.id, revision: source.activeRevision });
		expect(await invoke<MemoryEntry[]>("memory", "list")).toEqual([]);
		await expect(readFile(join(instancePaths(project).state, "private-token"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const imported = await invoke<MemoryEntry[]>("memory", "import", "--input", exportFile, "--scope", project);
		expect(imported).toHaveLength(1);
		expect(imported[0].scope).toBe(project);
		expect(imported[0].importedFrom?.scope).toBe(sourceProject);
	});

	test("rejects malformed memory files without changing observations", async () => {
		await invoke("init");
		const input = join(temporary, "malformed.json");
		for (const content of ["{", "[]", '{"text":"x","scope":"project","kind":"lesson","evidence":[]}']) {
			await writeFile(input, content);
			await handleInstanceCommand(["instance", "memory", "observe", "--input", input, "--project", project]);
			expect(process.exitCode).toBe(2);
			expect(await invoke<MemoryEntry[]>("memory", "list")).toEqual([]);
		}
	});

	test("rejects broken executable skill manifests with a failing command result", async () => {
		const skill = join(temporary, "broken-skill");
		await mkdir(skill);
		await writeFile(join(skill, "SKILL.md"), "---\nname: broken-skill\ndescription: Broken test skill.\n---\n");
		await handleInstanceCommand(["instance", "skill", "verify", "--directory", skill, "--project", project]);
		expect(process.exitCode).toBe(1);
		const result = JSON.parse(String(logs.mock.calls[0][0])) as { accepted: boolean; failures: unknown[] };
		expect(result.accepted).toBe(false);
		expect(result.failures.length).toBeGreaterThan(0);
	});

	test("launches the current CLI entry in its project with pinned env and isolated session storage", async () => {
		const manifest = await invoke<InstanceManifest>("init");
		const capture = join(temporary, "capture.json");
		const entry = join(temporary, "cli-entry.mjs");
		const loader = join(temporary, "source-loader.mjs");
		await writeFile(loader, "process.env.INSTANCE_CLI_LOADER = 'loaded';");
		await writeFile(
			entry,
			`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, JSON.stringify({cwd:process.cwd(), loader:process.env.INSTANCE_CLI_LOADER, root:process.env.RAGA_INSTANCE_ROOT, revision:process.env.RAGA_INSTANCE_REVISION, args:process.argv.slice(2)})); process.exit(23);`,
		);
		const savedEntry = process.argv[1];
		const savedExecArgv = process.execArgv;
		try {
			process.argv[1] = entry;
			process.execArgv = ["--import", `./${relative(process.cwd(), loader)}`];
			await handleInstanceCommand(["instance", "run", "--project", project, "--", "--print", "--help"]);
			expect(process.exitCode).toBe(23);
			const observed = JSON.parse(await readFile(capture, "utf8"));
			expect(observed.cwd).toBe(project);
			expect(observed.loader).toBe("loaded");
			expect(observed.root).toBe(instancePaths(project).root);
			expect(observed.revision).toBe(manifest.activeRevision);
			expect(observed.args).toEqual([
				"--print",
				"--help",
				"--session-dir",
				join(instancePaths(project).state, "sessions"),
			]);
		} finally {
			process.argv[1] = savedEntry;
			process.execArgv = savedExecArgv;
		}
	});

	test("migrates project configuration only with explicit trust and preserves its source", async () => {
		const legacy = join(project, ".pi");
		await mkdir(legacy);
		await writeFile(join(legacy, "settings.json"), JSON.stringify({ theme: "dark" }));
		await writeFile(join(legacy, "AGENTS.md"), "Trusted project instructions.\n");
		const migrated = await invoke<{ source: string; destination: string; copied: string[]; skipped: string[] }>(
			"migrate",
			"--trust",
		);
		expect(migrated.source).toBe(legacy);
		expect(migrated.destination).toBe(instancePaths(project).root);
		expect(migrated.copied.length).toBeGreaterThan(0);
		expect(await readFile(join(legacy, "AGENTS.md"), "utf8")).toBe("Trusted project instructions.\n");
		expect(await readFile(join(migrated.destination, "AGENTS.md"), "utf8")).toBe("Trusted project instructions.\n");
		await handleInstanceCommand(["instance", "migrate", "--trust", "--project", project]);
		expect(process.exitCode).toBe(1);
		expect(await readFile(join(legacy, "settings.json"), "utf8")).toBe(JSON.stringify({ theme: "dark" }));
	});

	test.skipIf(process.platform === "win32")(
		"forwards termination to the launched process and preserves its exit code",
		async () => {
			await invoke("init");
			const ready = join(temporary, "ready");
			const entry = join(temporary, "signal-entry.mjs");
			await writeFile(
				entry,
				`import {writeFileSync} from 'node:fs'; import {MessageChannel} from 'node:worker_threads'; const channel = new MessageChannel(); channel.port1.on('message', () => {}); process.on('SIGTERM', () => process.exit(19)); writeFileSync(${JSON.stringify(ready)}, 'ready');`,
			);
			const savedEntry = process.argv[1];
			const savedExecArgv = process.execArgv;
			const oldListeners = process.listenerCount("SIGTERM");
			const nativeKill = process.kill.bind(process);
			vi.spyOn(process, "kill").mockImplementation((pid, signal) =>
				pid === process.pid ? true : nativeKill(pid, signal),
			);
			let running: Promise<boolean> | undefined;
			try {
				process.argv[1] = entry;
				process.execArgv = [];
				running = handleInstanceCommand(["instance", "run", "--project", project]);
				await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("ready"));
				process.emit("SIGTERM");
				expect(await running).toBe(true);
				expect(process.exitCode).toBe(19);
				expect(process.listenerCount("SIGTERM")).toBe(oldListeners);
			} finally {
				if (process.listenerCount("SIGTERM") > oldListeners) process.emit("SIGTERM");
				await running;
				process.argv[1] = savedEntry;
				process.execArgv = savedExecArgv;
			}
		},
	);

	test.each(["--session-dir", "--session", "--session-id", "--resume", "--continue", "--fork"])(
		"rejects run session escape %s before opening an instance",
		async (option) => {
			await handleInstanceCommand(["instance", "run", "--project", project, "--", option, "/outside"]);
			expect(process.exitCode).toBe(2);
			expect(await readdir(project)).toEqual([]);
		},
	);
});
