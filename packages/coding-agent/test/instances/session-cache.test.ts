import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSandbox, SandboxPolicyError, sandboxCommand } from "../../src/core/instances/sandbox.ts";
import { instanceSandbox } from "../../src/core/instances/session.ts";
import { initializeInstance, instancePaths, openInstance } from "../../src/core/instances/store.ts";
import type { HarnessPin, SandboxPolicy } from "../../src/core/instances/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const status = await checkSandbox();

let base: string;
let project: string;
let pin: HarnessPin;

beforeEach(async () => {
	vi.stubEnv("RAGA_SANDBOX_READ_ONLY", undefined);
	base = await realpath(await mkdtemp(join(tmpdir(), "raga-session-cache-")));
	project = join(base, "project");
	const bundle = join(base, "bundle");
	await mkdir(project, { recursive: true });
	await mkdir(bundle, { recursive: true });
	await writeFile(join(bundle, "AGENTS.md"), "bundle instructions\n");
	await writeFile(join(project, "main.txt"), "original\n");
	await initializeInstance(project, { harnessSource: bundle });
	pin = await openInstance(instancePaths(project).root);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(base, { recursive: true, force: true });
});

const cacheOf = (policy: SandboxPolicy) => policy.env?.XDG_CACHE_HOME ?? "";
const isInside = (parent: string, path: string) => {
	const rel = relative(parent, path);
	return rel !== "" && !rel.startsWith("..");
};

describe("instanceSandbox cache", () => {
	it("gives each session a private cache inside its own writable state", () => {
		const root = instanceSandbox(pin, project, SessionManager.inMemory(project));
		const child = instanceSandbox(pin, project, SessionManager.inMemory(project));

		expect(isInside(join(pin.stateRoot, "kernels"), cacheOf(root))).toBe(true);
		expect(root.writable.some((path) => isInside(path, cacheOf(root)))).toBe(true);
		expect(statSync(cacheOf(root)).mode & 0o777).toBe(0o700);
		expect(cacheOf(child)).not.toBe(cacheOf(root));
		expect(root.writable.some((path) => isInside(path, cacheOf(child)) || path === cacheOf(child))).toBe(false);
	});

	it("returns the same cache for the same session on every call", () => {
		const session = SessionManager.inMemory(project);
		expect(cacheOf(instanceSandbox(pin, project, session))).toBe(cacheOf(instanceSandbox(pin, project, session)));
	});
});

describe("instanceSandbox dependency boundaries", () => {
	it("rejects dependency roots that would expose project or instance state", () => {
		for (const path of [project, pin.instanceRoot, pin.stateRoot, base]) {
			vi.stubEnv("RAGA_SANDBOX_READ_ONLY", path);
			expect(() => instanceSandbox(pin, project, SessionManager.inMemory(project))).toThrow(SandboxPolicyError);
		}
	});

	it("rejects unresolved, missing, and relative dependency paths", async () => {
		const dependency = join(base, "dependency");
		const alias = join(base, "dependency-link");
		await mkdir(dependency);
		await symlink(dependency, alias);
		for (const path of [alias, join(base, "missing"), relative(base, dependency)]) {
			vi.stubEnv("RAGA_SANDBOX_READ_ONLY", path);
			expect(() => instanceSandbox(pin, project, SessionManager.inMemory(project))).toThrow(SandboxPolicyError);
		}
	});
});

describe.runIf(status.available)("instanceSandbox cache in bubblewrap", () => {
	const sh = (script: string, policy: SandboxPolicy) =>
		sandboxCommand({ command: "sh", args: ["-c", script], policy, timeoutMs: 30_000 });

	it("persists across separate commands while /tmp stays per-command", async () => {
		const policy = instanceSandbox(pin, project, SessionManager.inMemory(project));
		const first = await sh('printf kept > "$XDG_CACHE_HOME/marker" && printf gone > /tmp/marker', policy);
		expect(first.exitCode).toBe(0);

		const second = await sh('cat "$XDG_CACHE_HOME/marker"; test ! -e /tmp/marker', policy);
		expect(second).toMatchObject({ exitCode: 0, stdout: "kept" });
	});

	it("lets a read-only child write only its own cache", async () => {
		const root = instanceSandbox(pin, project, SessionManager.inMemory(project));
		expect((await sh('printf root > "$XDG_CACHE_HOME/marker"', root)).exitCode).toBe(0);
		const child = { ...instanceSandbox(pin, project, SessionManager.inMemory(project)), workspaceReadOnly: true };

		const cache = await sh(
			`printf child > "$XDG_CACHE_HOME/marker" && test ! -e ${JSON.stringify(join(cacheOf(root), "marker"))}`,
			child,
		);
		expect(cache.exitCode).toBe(0);
		const source = await sh(`printf changed > ${JSON.stringify(join(project, "main.txt"))}`, child);
		expect(source.exitCode).not.toBe(0);

		const rootMarker = await sh('cat "$XDG_CACHE_HOME/marker"', root);
		expect(rootMarker.stdout).toBe("root");
	});

	it("exposes explicit dependencies read-only to root and read-only child commands", async () => {
		const first = join(base, "dependency one");
		const second = join(base, "dependency-two");
		await mkdir(first);
		await mkdir(second);
		const firstFile = join(first, "runtime.txt");
		const secondFile = join(second, "runtime.txt");
		await writeFile(firstFile, "first-runtime");
		await writeFile(secondFile, "second-runtime");
		const command = `cat ${JSON.stringify(firstFile)} ${JSON.stringify(secondFile)}`;
		const hidden = await sh(command, instanceSandbox(pin, project, SessionManager.inMemory(project)));
		expect(hidden.exitCode).not.toBe(0);
		expect(hidden.stdout).not.toContain("first-runtime");

		vi.stubEnv("RAGA_SANDBOX_READ_ONLY", [first, second].join(delimiter));
		const root = instanceSandbox(pin, project, SessionManager.inMemory(project));
		const child = { ...instanceSandbox(pin, project, SessionManager.inMemory(project)), workspaceReadOnly: true };
		for (const policy of [root, child]) {
			expect(await sh(command, policy)).toMatchObject({ exitCode: 0, stdout: "first-runtimesecond-runtime" });
			const write = await sh(`printf tampered > ${JSON.stringify(firstFile)}`, policy);
			expect(write.exitCode).not.toBe(0);
			expect(await readFile(firstFile, "utf8")).toBe("first-runtime");
		}
	});
});
