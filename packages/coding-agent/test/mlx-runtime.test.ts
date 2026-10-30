import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type LocalModelSpec, MlxRuntime, type MlxRuntimeOptions } from "../src/extensions/mlx/runtime.ts";

const spec: LocalModelSpec = {
	id: "org/model",
	revision: "a".repeat(40),
	files: ["config.json", "model.safetensors"],
	contextWindow: 4096,
};
const directories: string[] = [];
const runtimes: MlxRuntime[] = [];

async function fixture(env: NodeJS.ProcessEnv = {}, readyTimeoutMs = 2000, options: MlxRuntimeOptions = {}) {
	const dir = await mkdtemp(join(tmpdir(), "raga-mlx-"));
	directories.push(dir);
	const helper = join(dir, "helper.mjs");
	await writeFile(
		helper,
		`
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const mode = process.argv[2];
if (process.env.RECORD) writeFileSync(process.env.RECORD, JSON.stringify({mode, input, argv:process.argv, offline:process.env.HF_HUB_OFFLINE, token:process.env.HF_TOKEN, backend:process.env.RAGA_LOCAL_MODEL_BACKEND, binary:process.env.LLAMA_SERVER_PATH}));
if (mode === 'probe') console.log(JSON.stringify({installed:true}));
if (mode === 'cache') console.log(JSON.stringify({cached:JSON.parse(input).files.length === 2}));
if (mode === 'download') { console.log(JSON.stringify({message:'Downloading'})); setInterval(() => {}, 1000); }
if (mode === 'serve') {
 console.log(JSON.stringify({modelPath:'/cache/expected'}));
 createServer((req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(req.url === '/health' ? {status:process.env.LOADING ? 'loading' : 'ok'} : {data:[{id:process.env.WRONG ? '/other' : process.env.RAGA_LOCAL_MODEL_BACKEND === 'llama.cpp' ? JSON.parse(input).id : '/cache/expected'}]})); }).listen(Number(process.argv[3]),'127.0.0.1');
}
`,
	);
	const runtime = new MlxRuntime({
		agentDir: dir,
		helperPath: helper,
		pythonPath: process.execPath,
		platform: "darwin",
		arch: "arm64",
		env,
		readyTimeoutMs,
		killGraceMs: 30,
		...options,
	});
	runtimes.push(runtime);
	return { runtime, dir };
}

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MLX runtime", () => {
	it("reports platform support without installing anything", async () => {
		expect(new MlxRuntime({ platform: "linux", arch: "arm64" }).supported()).toBe(false);
		expect(await new MlxRuntime({ platform: "darwin", arch: "x64" }).installed()).toBe(false);
		const { runtime } = await fixture();
		expect(await runtime.installed()).toBe(true);
	});

	it("passes specs only on stdin, inherits auth, and probes cache offline", async () => {
		const { dir } = await fixture();
		const record = join(dir, "record.json");
		const { runtime } = await fixture({ RECORD: record, HF_TOKEN: "hf_private" });
		expect(await runtime.cached(spec)).toBe(true);
		const data = JSON.parse(await readFile(record, "utf8")) as {
			argv: string[];
			input: string;
			offline: string;
			token: string;
		};
		expect(JSON.parse(data.input)).toEqual(spec);
		expect(data.argv.join(" ")).not.toContain(spec.id);
		expect(data.argv.join(" ")).not.toContain("hf_private");
		expect(data.offline).toBe("1");
		expect(data.token).toBe("hf_private");
		expect(await runtime.cached({ ...spec, files: ["config.json"] })).toBe(false);
	});

	it("requires uv explicitly and does not attempt bootstrap installation", async () => {
		const { dir } = await fixture();
		const runtime = new MlxRuntime({
			platform: "darwin",
			arch: "arm64",
			uvPath: join(dir, "missing-uv"),
			killGraceMs: 1,
		});
		runtimes.push(runtime);
		await expect(runtime.install(new AbortController().signal, () => {})).rejects.toThrow("uv is required on PATH");
	});

	it("installs only the pinned dependencies into the private uv venv", async () => {
		const { dir } = await fixture();
		const uv = join(dir, "uv-stub");
		const log = join(dir, "uv.jsonl");
		await writeFile(
			uv,
			`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
		);
		await chmod(uv, 0o755);
		const runtime = new MlxRuntime({
			agentDir: dir,
			platform: "darwin",
			arch: "arm64",
			uvPath: uv,
			pythonPath: process.execPath,
			helperPath: join(dir, "helper.mjs"),
			killGraceMs: 1,
		});
		runtimes.push(runtime);
		await runtime.install(new AbortController().signal, () => {});
		const commands = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(commands).toEqual([
			["--version"],
			["venv", "--managed-python", "--allow-existing", "--python", "3.12", join(dir, "local-models", "mlx", "venv")],
			["pip", "install", "--python", process.execPath, "mlx-lm==0.32.2", "huggingface-hub==2.4.0", "hf-xet==1.7.1"],
		]);
	});

	it("cancels downloads and rejects already-aborted operations", async () => {
		const { runtime } = await fixture();
		const abort = new AbortController();
		const download = runtime.download(spec, abort.signal, () => abort.abort());
		await expect(download).rejects.toThrow();
		await expect(runtime.cached(spec, abort.signal)).rejects.toThrow();
	});

	it("waits for the expected cached model and stops the server", async () => {
		const { runtime } = await fixture();
		const { baseUrl } = await runtime.start(spec, new AbortController().signal, () => {});
		expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
		expect((await fetch(`${baseUrl}/models`)).ok).toBe(true);
		await expect(runtime.start(spec, new AbortController().signal, () => {})).rejects.toThrow("already running");
		await runtime.stop();
		await expect(fetch(`${baseUrl}/models`)).rejects.toThrow();
	});

	it("rejects a different model on the selected port and cleans up on timeout", async () => {
		const { runtime } = await fixture({ WRONG: "1" }, 250);
		await expect(runtime.start(spec, new AbortController().signal, () => {})).rejects.toThrow("timed out");
	});

	it("keeps cancellation connected after readiness", async () => {
		const { runtime } = await fixture();
		const abort = new AbortController();
		const { baseUrl } = await runtime.start(spec, abort.signal, () => {});
		abort.abort();
		await runtime.stop();
		await expect(fetch(`${baseUrl}/models`)).rejects.toThrow();
	});
});

const ggufSpec: LocalModelSpec = {
	id: "LiquidAI/LFM3-1.7B-GGUF",
	revision: "b".repeat(40),
	files: ["LFM3-1.7B-Q4_K_M.gguf"],
	format: "gguf",
	modelFile: "LFM3-1.7B-Q4_K_M.gguf",
	contextWindow: 16384,
};

describe("llama.cpp runtime", () => {
	it("supports POSIX macOS and Linux, but not Windows", () => {
		for (const platform of ["darwin", "linux"]) {
			expect(new MlxRuntime({ backend: "llama.cpp", platform, arch: "x64" }).supported()).toBe(true);
		}
		expect(new MlxRuntime({ backend: "llama.cpp", platform: "win32" }).supported()).toBe(false);
	});

	it("passes the backend and binary override in the environment and waits for the repository alias", async () => {
		const { dir } = await fixture();
		const record = join(dir, "gguf.json");
		const { runtime } = await fixture({ RECORD: record }, 2000, {
			backend: "llama.cpp",
			llamaServerPath: "/local/llama-server",
		});
		const { baseUrl } = await runtime.start(ggufSpec, new AbortController().signal, () => {});
		expect((await fetch(`${baseUrl}/models`)).ok).toBe(true);
		const data = JSON.parse(await readFile(record, "utf8"));
		expect(data.backend).toBe("llama.cpp");
		expect(data.binary).toBe("/local/llama-server");
		expect(data.offline).toBe("1");
		expect(JSON.parse(data.input)).toEqual(ggufSpec);
	});

	it.each([{ LOADING: "1" }, { WRONG: "1" }])("never accepts loading health or a different alias: %j", async (env) => {
		const { runtime } = await fixture(env, 250, { backend: "llama.cpp" });
		await expect(runtime.start(ggufSpec, new AbortController().signal, () => {})).rejects.toThrow("timed out");
	});

	it("installs only the private downloader dependencies with a supported binary", async () => {
		const { dir } = await fixture();
		const binary = join(dir, "llama-server");
		const uv = join(dir, "uv");
		const log = join(dir, "commands.jsonl");
		await writeFile(binary, "#!/bin/sh\necho 'version: 11960 (abc)'\n");
		await writeFile(
			uv,
			`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
		);
		await chmod(binary, 0o755);
		await chmod(uv, 0o755);
		const runtime = new MlxRuntime({
			backend: "llama.cpp",
			platform: "linux",
			agentDir: dir,
			pythonPath: process.execPath,
			helperPath: join(dir, "helper.mjs"),
			uvPath: uv,
			llamaServerPath: binary,
			killGraceMs: 1,
		});
		runtimes.push(runtime);
		await runtime.install(new AbortController().signal, () => {});
		const commands = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(commands).toEqual([
			["--version"],
			[
				"venv",
				"--managed-python",
				"--allow-existing",
				"--python",
				"3.12",
				join(dir, "local-models", "llama-cpp", "venv"),
			],
			["pip", "install", "--python", process.execPath, "huggingface-hub==2.4.0", "hf-xet==1.7.1"],
		]);
	});

	it("gives manual installation instructions on Linux without installing OS packages", async () => {
		const { dir } = await fixture();
		const runtime = new MlxRuntime({
			backend: "llama.cpp",
			platform: "linux",
			uvPath: process.execPath,
			llamaServerPath: join(dir, "missing"),
			agentDir: dir,
			killGraceMs: 1,
		});
		runtimes.push(runtime);
		await expect(runtime.install(new AbortController().signal, () => {})).rejects.toThrow("b11960");
	});
});

describe("llama.cpp Homebrew consented installation", () => {
	it.each([false, true])("uses Homebrew %s only for missing/outdated system binaries", async (outdated) => {
		const { dir } = await fixture();
		const log = join(dir, "brew.jsonl");
		const brew = join(dir, "brew");
		const uv = join(dir, "uv");
		await writeFile(
			brew,
			`#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
		);
		await writeFile(uv, `#!${process.execPath}\n`);
		await chmod(brew, 0o755);
		await chmod(uv, 0o755);
		if (outdated) {
			const binary = join(dir, "llama-server");
			await writeFile(binary, "#!/bin/sh\necho 'version: 11959 (abc)'\n");
			await chmod(binary, 0o755);
		}
		const runtime = new MlxRuntime({
			backend: "llama.cpp",
			platform: "darwin",
			agentDir: dir,
			pythonPath: process.execPath,
			helperPath: join(dir, "helper.mjs"),
			uvPath: uv,
			env: { PATH: dir, LLAMA_SERVER_PATH: undefined },
			killGraceMs: 1,
		});
		runtimes.push(runtime);
		await runtime.install(new AbortController().signal, () => {});
		const commands = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(commands).toEqual([["--version"], [outdated ? "upgrade" : "install", "llama.cpp"]]);
	});

	it("requires Homebrew on PATH and does not bootstrap it", async () => {
		const { dir } = await fixture();
		const runtime = new MlxRuntime({
			backend: "llama.cpp",
			platform: "darwin",
			agentDir: dir,
			uvPath: process.execPath,
			env: { PATH: dir, LLAMA_SERVER_PATH: undefined },
			killGraceMs: 1,
		});
		runtimes.push(runtime);
		await expect(runtime.install(new AbortController().signal, () => {})).rejects.toThrow("Homebrew must be on PATH");
	});
});
