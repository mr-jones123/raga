import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type HostHandler, Kernel } from "../src/core/rlm/kernel.ts";
import { type PythonEnv, resolvePythonEnv } from "../src/core/rlm/python-env.ts";

// Runs the real Python kernel (packages/coding-agent/python). RAGA_PYTHON picks the interpreter;
// the default is python3 on PATH, so the test never provisions a venv or touches the network.
let pythonEnv: PythonEnv;
let tempDir: string;
const kernels: Kernel[] = [];

beforeAll(async () => {
	vi.stubEnv("RAGA_PYTHON", process.env.RAGA_PYTHON || "python3");
	pythonEnv = await resolvePythonEnv();
	tempDir = mkdtempSync(join(tmpdir(), "rlm-kernel-test-"));
});

afterEach(() => {
	for (const kernel of kernels.splice(0)) kernel.dispose();
});

afterAll(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function createKernel(handlers: Record<string, HostHandler> = {}): Kernel {
	const kernel = new Kernel({
		cwd: tempDir,
		handlers: new Map(Object.entries(handlers)),
		pythonEnv: async () => pythonEnv,
	});
	kernels.push(kernel);
	return kernel;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("Kernel", () => {
	test("starts and reaches ready; start is idempotent", async () => {
		const kernel = createKernel();
		expect(kernel.state).toBe("dead");
		await Promise.all([kernel.start(), kernel.start()]);
		expect(kernel.state).toBe("ready");
		const pid = kernel.pid;
		expect(pid).toBeTypeOf("number");
		await kernel.start();
		expect(kernel.pid).toBe(pid);
	});

	test("execute returns stdout, stderr, and the trailing expression", async () => {
		const kernel = createKernel();
		const streamed: string[] = [];
		const out = await kernel.execute('import sys\nprint("hello")\nprint("warn", file=sys.stderr)\nx = 20\nx + 1', {
			onOutput: (stream, text) => streamed.push(`${stream}:${text}`),
		});
		expect(out.status).toBe("ok");
		expect(out.stdout).toBe("hello\n");
		expect(out.stderr).toBe("warn\n");
		expect(out.result).toBe("21");
		expect(out.restarted).toBe(false);
		expect(streamed.join("")).toContain("stdout:hello");
		expect(kernel.state).toBe("ready");

		// The namespace persists across cells.
		const next = await kernel.execute("x * 2");
		expect(next.result).toBe("40");
	});

	test("execute reports a Python error with its traceback", async () => {
		const kernel = createKernel();
		const out = await kernel.execute('print("before")\n1 / 0');
		expect(out.status).toBe("error");
		expect(out.stdout).toBe("before\n");
		expect(out.error?.ename).toBe("ZeroDivisionError");
		expect(out.error?.traceback.join("")).toContain("1 / 0");
		expect(out.restarted).toBe(false);
		expect((await kernel.execute("1 + 1")).result).toBe("2");
	});

	test("a host handler answers a request made during a cell", async () => {
		const calls: Array<{ data: unknown; cellId: string | null }> = [];
		const kernel = createKernel({
			"test.double": async (data, ctx) => {
				calls.push({ data, cellId: ctx.cellId });
				return { value: Number(data.x) * 2 };
			},
		});
		const out = await kernel.execute(
			'import raga_rlm\nr = await raga_rlm.host_request({"type": "test.double", "x": 21})\nr["value"]',
		);
		expect(out.status).toBe("ok");
		expect(out.result).toBe("42");
		expect(calls).toHaveLength(1);
		expect(calls[0].data).toEqual({ type: "test.double", x: 21 });
		expect(calls[0].cellId).toMatch(/^cell-/);
	});

	test("a throwing handler raises HostError in Python", async () => {
		const kernel = createKernel({
			"test.fail": async () => {
				throw new Error("boom from host");
			},
		});
		const out = await kernel.execute(
			'import raga_rlm\ntry:\n    await raga_rlm.host_request({"type": "test.fail"})\nexcept HostError as e:\n    print("caught:", e)',
		);
		expect(out.status).toBe("ok");
		expect(out.stdout).toBe("caught: boom from host\n");
	});

	test("an unknown host request type raises HostError naming the type", async () => {
		const kernel = createKernel();
		const out = await kernel.execute('import raga_rlm\nawait raga_rlm.host_request({"type": "no.such.type"})');
		expect(out.status).toBe("error");
		expect(out.error?.ename).toBe("HostError");
		expect(out.error?.evalue).toContain("no.such.type");
	});

	test("abort interrupts a synchronous infinite loop and keeps the namespace", async () => {
		const kernel = createKernel();
		await kernel.execute("kept = 7");
		const pid = kernel.pid;
		const controller = new AbortController();
		const out = await kernel.execute('print("looping")\nwhile True:\n    pass', {
			signal: controller.signal,
			onOutput: () => controller.abort(),
		});
		expect(out.status).toBe("error");
		expect(out.error?.ename).toBe("KeyboardInterrupt");
		expect(out.restarted).toBe(false);
		expect(kernel.pid).toBe(pid);
		expect((await kernel.execute("kept")).result).toBe("7");
	});

	test("abort of code that ignores KeyboardInterrupt kills and restarts the kernel", async () => {
		const kernel = createKernel();
		await kernel.execute("kept = 7");
		const pid = kernel.pid;
		expect(pid).toBeTypeOf("number");
		const controller = new AbortController();
		let abortedAt = 0;
		const out = await kernel.execute(
			'print("looping")\nwhile True:\n    try:\n        while True:\n            pass\n    except KeyboardInterrupt:\n        pass',
			{
				signal: controller.signal,
				onOutput: () => {
					abortedAt = Date.now();
					controller.abort();
				},
			},
		);
		// The host waits a real 1000 ms for the ignored interrupt before it kills the process.
		expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(1000);
		expect(out.status).toBe("error");
		expect(out.restarted).toBe(true);
		expect(out.error?.ename).toBe("KeyboardInterrupt");
		expect(kernel.state).toBe("ready");
		expect(kernel.pid).not.toBe(pid);
		await vi.waitFor(() => expect(isAlive(pid as number)).toBe(false));

		const next = await kernel.execute("1 + 1");
		expect(next.status).toBe("ok");
		expect(next.result).toBe("2");
		const gone = await kernel.execute("kept");
		expect(gone.error?.ename).toBe("NameError");
	});

	test("snapshot and restore carry the namespace across a restart", async (ctx) => {
		if (!pythonEnv.hasDill) {
			ctx.skip(`dill is not installed for ${pythonEnv.python}; set RAGA_PYTHON to an interpreter with dill`);
		}
		const kernel = createKernel();
		await kernel.execute('numbers = [1, 2, 3]\nconfig = {"k": "v"}\n_private = 1\nimport json');
		const path = join(tempDir, "snapshot.pkl");
		const saved = await kernel.snapshot(path);
		expect(saved.saved).toEqual(expect.arrayContaining(["numbers", "config"]));
		expect(saved.saved).not.toContain("_private");
		expect(saved.saved).not.toContain("json");
		expect(saved.bytes).toBeGreaterThan(0);

		await kernel.restart();
		expect(await kernel.listNames()).not.toContain("numbers");

		const restored = await kernel.restore(path);
		expect(restored.restored).toEqual(expect.arrayContaining(["numbers", "config"]));
		expect(restored.failed).toEqual([]);
		expect(await kernel.listNames()).toEqual(expect.arrayContaining(["numbers", "config"]));
		expect((await kernel.execute("numbers, config")).result).toBe("([1, 2, 3], {'k': 'v'})");

		const missing = await kernel.restore(join(tempDir, "missing.pkl"));
		expect(missing).toEqual({ restored: [], failed: [], reason: "snapshot not found" });
	});

	test("dispose kills the kernel process", async () => {
		const kernel = createKernel();
		await kernel.start();
		const pid = kernel.pid as number;
		expect(isAlive(pid)).toBe(true);
		kernel.dispose();
		expect(kernel.state).toBe("dead");
		await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
		await expect(kernel.execute("1")).rejects.toThrow("disposed");
	});
});
