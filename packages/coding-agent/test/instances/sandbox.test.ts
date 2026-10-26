import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	checkSandbox,
	NOT_STARTED_EXIT_CODE,
	SandboxPolicyError,
	sandboxCommand,
	sandboxLaunch,
} from "../../src/core/instances/sandbox.ts";
import type { SandboxPolicy } from "../../src/core/instances/types.ts";
import { waitForChildProcess } from "../../src/utils/child-process.ts";

const status = await checkSandbox();
const hasPython = existsSync("/usr/bin/python3");

// Process-lifetime checks observe real OS processes inside a PID namespace, so fake timers cannot drive them.
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await sleep(20);
	}
}

describe("checkSandbox", () => {
	it.runIf(process.platform !== "linux")("fails closed off Linux", () => {
		expect(status.available).toBe(false);
		expect(status.reason).toMatch(/Linux/);
	});
});

describe.runIf(status.available)("bubblewrap sandbox", () => {
	let base: string;
	let workspace: string;
	let readOnlyDir: string;
	let scratch: string;
	let outside: string;

	const sh = (script: string, policy: Partial<SandboxPolicy> = {}, extra: { timeoutMs?: number } = {}) =>
		sandboxCommand({
			command: "sh",
			args: ["-c", script],
			policy: { workspace, readOnly: [], writable: [], ...policy },
			timeoutMs: extra.timeoutMs ?? 10_000,
		});

	beforeAll(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), "raga-sandbox-test-")));
		workspace = join(base, "workspace");
		readOnlyDir = join(base, "readonly");
		scratch = join(base, "scratch");
		outside = join(base, "outside");
		for (const dir of [workspace, readOnlyDir, scratch, outside]) mkdirSync(dir);
		writeFileSync(join(readOnlyDir, "engine.txt"), "engine");
		writeFileSync(join(outside, "secret.txt"), "top secret");
	});

	afterAll(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it("reports the backend as available", () => {
		expect(status).toEqual({ available: true });
	});

	describe("filesystem", () => {
		it("persists writes inside the workspace to the host", async () => {
			const result = await sh("echo written > out.txt");
			expect(result.exitCode).toBe(0);
			expect(readFileSync(join(workspace, "out.txt"), "utf8")).toBe("written\n");
		});

		it("rejects writes to read-only roots while allowing reads", async () => {
			const result = await sh(`cat ${readOnlyDir}/engine.txt; echo tampered > ${readOnlyDir}/engine.txt`, {
				readOnly: [readOnlyDir],
			});
			expect(result.stdout).toBe("engine");
			expect(result.exitCode).not.toBe(0);
			expect(readFileSync(join(readOnlyDir, "engine.txt"), "utf8")).toBe("engine");
		});

		it.runIf(hasPython)("rejects Python writes to read-only roots", async () => {
			const result = await sandboxCommand({
				command: "python3",
				args: ["-c", `open(${JSON.stringify(join(readOnlyDir, "engine.txt"))}, "w").write("tampered")`],
				policy: { workspace, readOnly: [readOnlyDir], writable: [] },
				timeoutMs: 10_000,
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/Read-only file system/);
			expect(readFileSync(join(readOnlyDir, "engine.txt"), "utf8")).toBe("engine");
		});

		it("hides host paths outside the policy roots", async () => {
			const result = await sh(`cat ${outside}/secret.txt || echo hidden`);
			expect(result.stdout).toBe("hidden\n");
			expect(result.stdout).not.toContain("top secret");
		});

		it("does not let a workspace symlink reach outside paths", async () => {
			symlinkSync(join(outside, "secret.txt"), join(workspace, "escape"));
			const read = await sh("cat escape");
			expect(read.exitCode).not.toBe(0);
			expect(read.stdout).not.toContain("top secret");
			const write = await sh("echo overwritten > escape");
			expect(write.exitCode).not.toBe(0);
			expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("top secret");
		});

		it("masks .git and .raga but exposes approved leaves beneath .raga", async () => {
			const project = join(base, "project");
			const pin = join(project, ".raga", "worktrees", "pin");
			const session = join(project, ".raga", "state", "sessions", "s1");
			mkdirSync(join(project, ".git"), { recursive: true });
			mkdirSync(pin, { recursive: true });
			mkdirSync(session, { recursive: true });
			writeFileSync(join(project, ".git", "config"), "[core]\n");
			writeFileSync(join(project, ".raga", "instance.json"), '{"activeRevision":"a"}');
			writeFileSync(join(pin, "AGENTS.md"), "pinned\n");

			const result = await sh(
				[
					"test -e .git/config && echo git-visible",
					"test -e .raga/instance.json && echo instance-visible",
					"echo x > .git/config 2>/dev/null && echo git-writable",
					"echo x > .raga/instance.json 2>/dev/null && echo instance-writable",
					"cat .raga/worktrees/pin/AGENTS.md",
					"echo x > .raga/worktrees/pin/AGENTS.md 2>/dev/null && echo pin-writable",
					"echo snapshot > .raga/state/sessions/s1/snap && echo session-writable",
				].join("; "),
				{ workspace: project, readOnly: [pin], writable: [session] },
			);
			expect(result.stdout.split("\n").filter(Boolean)).toEqual(["pinned", "session-writable"]);
			expect(readFileSync(join(project, ".raga", "instance.json"), "utf8")).toBe('{"activeRevision":"a"}');
			expect(readFileSync(join(project, ".git", "config"), "utf8")).toBe("[core]\n");
			expect(readFileSync(join(session, "snap"), "utf8")).toBe("snapshot\n");
		});

		it("keeps the workspace read-only when requested while scratch stays writable", async () => {
			const result = await sh(
				`echo a > ro.txt 2>/dev/null && echo workspace-writable; echo b > ${scratch}/s.txt && echo ok`,
				{
					workspaceReadOnly: true,
					writable: [scratch],
				},
			);
			expect(result.stdout).toBe("ok\n");
			expect(existsSync(join(workspace, "ro.txt"))).toBe(false);
			expect(readFileSync(join(scratch, "s.txt"), "utf8")).toBe("b\n");
		});

		it("rejects unsafe policies before running anything", async () => {
			const link = join(base, "link-to-readonly");
			symlinkSync(readOnlyDir, link);
			const nested = join(readOnlyDir, "nested");
			mkdirSync(nested);
			const cases: SandboxPolicy[] = [
				{ workspace: nested, readOnly: [readOnlyDir], writable: [] },
				{ workspace, readOnly: [readOnlyDir], writable: [nested] },
				{ workspace: link, readOnly: [], writable: [] },
				{ workspace, readOnly: [dirname(homedir())], writable: [] },
				{ workspace, readOnly: [], writable: ["/usr"] },
				{ workspace, readOnly: ["/proc"], writable: [] },
				{ workspace, readOnly: [], writable: [], cwd: outside },
			];
			for (const policy of cases) {
				await expect(
					sandboxCommand({ command: "true", args: [], policy, timeoutMs: 5_000 }),
				).rejects.toBeInstanceOf(SandboxPolicyError);
			}
		});
	});

	describe("environment", () => {
		it("does not inherit host environment and passes explicit variables", async () => {
			process.env.RAGA_SANDBOX_TEST_TOKEN = "leaked-credential";
			try {
				const result = await sh("env", { env: { EXPLICIT_VALUE: "given" } });
				expect(result.stdout).not.toContain("leaked-credential");
				expect(result.stdout).toContain("EXPLICIT_VALUE=given\n");
				expect(result.stdout).toContain("HOME=/tmp\n");
			} finally {
				delete process.env.RAGA_SANDBOX_TEST_TOKEN;
			}
		});
	});

	describe("network", () => {
		let server: Server;
		let port: number;

		beforeAll(async () => {
			server = createServer((socket) => socket.end("pong"));
			const { promise, resolve } = Promise.withResolvers<void>();
			server.listen(0, "127.0.0.1", () => resolve());
			await promise;
			const address = server.address();
			port = typeof address === "object" && address ? address.port : 0;
		});

		afterAll(() => {
			server.close();
		});

		const connect = (network: boolean) =>
			sandboxCommand({
				command: "bash",
				args: ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3`],
				policy: { workspace, readOnly: [], writable: [], network },
				timeoutMs: 10_000,
			});

		it("denies connections to host services by default", async () => {
			const result = await connect(false);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("pong");
		});

		it("allows network only when the policy enables it", async () => {
			const result = await connect(true);
			expect(result.stdout).toBe("pong");
		});
	});

	describe("processes", () => {
		it("runs in a private PID namespace", async () => {
			const result = await sh("echo $$");
			expect(Number(result.stdout.trim())).toBeLessThan(10);
		});

		it("reports timeouts and kills the command", async () => {
			const started = Date.now();
			const result = await sh("sleep 30", {}, { timeoutMs: 300 });
			expect(result.timedOut).toBe(true);
			expect(result.exitCode).not.toBe(0);
			expect(Date.now() - started).toBeLessThan(5_000);
		});

		it("stops descendant processes on cancellation", async () => {
			const controller = new AbortController();
			const tick = join(workspace, "tick");
			const pending = sandboxCommand({
				command: "sh",
				args: ["-c", "(while true; do echo t >> tick; sleep 0.05; done) & wait"],
				policy: { workspace, readOnly: [], writable: [] },
				timeoutMs: 30_000,
				signal: controller.signal,
			});
			await waitFor(() => existsSync(tick) && statSync(tick).size > 4);
			controller.abort();
			const result = await pending;
			expect(result.aborted).toBe(true);
			await sleep(200);
			const size = statSync(tick).size;
			await sleep(400);
			expect(statSync(tick).size).toBe(size);
		});

		it("does not let background processes outlive the command", async () => {
			const result = await sh("(sleep 0.3; echo late > late.txt) & exit 0");
			expect(result.exitCode).toBe(0);
			await sleep(800);
			expect(existsSync(join(workspace, "late.txt"))).toBe(false);
		});

		it("returns without running when already aborted", async () => {
			const controller = new AbortController();
			controller.abort();
			const result = await sandboxCommand({
				command: "sh",
				args: ["-c", "echo ran > aborted.txt"],
				policy: { workspace, readOnly: [], writable: [] },
				timeoutMs: 5_000,
				signal: controller.signal,
			});
			expect(result).toMatchObject({ exitCode: NOT_STARTED_EXIT_CODE, aborted: true });
			expect(existsSync(join(workspace, "aborted.txt"))).toBe(false);
		});

		it("bounds captured output", async () => {
			const result = await sandboxCommand({
				command: "sh",
				args: ["-c", "head -c 100000 /dev/zero | tr '\\0' a"],
				policy: { workspace, readOnly: [], writable: [] },
				timeoutMs: 10_000,
				maxOutputBytes: 1000,
			});
			expect(result.stdout.startsWith("a".repeat(1000))).toBe(true);
			expect(result.stdout).not.toContain("a".repeat(1001));
			expect(result.stdout).toContain("99000 bytes omitted");
		});
	});

	describe("sandboxLaunch", () => {
		it("produces a spawnable long-lived invocation confined to the policy", async () => {
			const launch = sandboxLaunch("sh", ["-c", `echo launched > launch.txt; cat ${outside}/secret.txt`], {
				workspace,
				readOnly: [],
				writable: [],
			});
			const child = spawn(launch.command, launch.args, {
				cwd: launch.cwd,
				env: launch.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			let stdout = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			const code = await waitForChildProcess(child);
			expect(code).not.toBe(0);
			expect(stdout).not.toContain("top secret");
			expect(readFileSync(join(workspace, "launch.txt"), "utf8")).toBe("launched\n");
		});

		it("rejects an absolute command that is not mounted", () => {
			const tool = join(outside, "tool.sh");
			writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
			expect(() => sandboxLaunch(tool, [], { workspace, readOnly: [], writable: [] })).toThrow(SandboxPolicyError);
		});
	});
});
