import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir, getPackageDir } from "../../config.ts";

export interface LocalModelSpec {
	id: string;
	revision: string;
	files: string[];
	contextWindow: number;
	format?: "gguf";
	modelFile?: string;
}

export interface LocalModelProgress {
	message: string;
	percent?: number;
}

export interface MlxRuntimeOptions {
	backend?: "mlx" | "llama.cpp";
	llamaServerPath?: string;
	agentDir?: string;
	helperPath?: string;
	pythonPath?: string;
	uvPath?: string;
	platform?: string;
	arch?: string;
	env?: NodeJS.ProcessEnv;
	readyTimeoutMs?: number;
	killGraceMs?: number;
}

interface RunningProcess {
	child: ChildProcess;
	result: Promise<void>;
	output: string;
	modelPath?: string;
	installed?: boolean;
	cached?: boolean;
	error?: string;
	terminate?: Promise<void>;
}

/** Owns one local server and all transient installer/helper process groups. */
export class MlxRuntime {
	private readonly options: MlxRuntimeOptions;
	private readonly root: string;
	private readonly python: string;
	private readonly helper: string;
	private readonly label: string;
	private readonly processes = new Set<RunningProcess>();
	private server?: RunningProcess;
	private starting = false;
	private generation = 0;
	private readonly onExit = () => {
		// process exit cannot await TERM grace; never leave a detached server behind.
		for (const proc of this.processes) {
			if (proc.child.pid) {
				try {
					process.kill(-proc.child.pid, "SIGKILL");
				} catch {
					/* Already stopped. */
				}
			}
		}
	};

	constructor(options: MlxRuntimeOptions = {}) {
		this.options = options;
		this.label = options.backend === "llama.cpp" ? "llama.cpp" : "MLX";
		this.root = join(
			options.agentDir ?? getAgentDir(),
			"local-models",
			options.backend === "llama.cpp" ? "llama-cpp" : "mlx",
		);
		this.python = options.pythonPath ?? join(this.root, "venv", "bin", "python");
		this.helper = options.helperPath ?? join(getPackageDir(), "python", "raga_rlm", "mlx_models.py");
	}

	supported(): boolean {
		if (this.options.backend === "llama.cpp") {
			return ["darwin", "linux"].includes(this.options.platform ?? process.platform);
		}
		return (
			(this.options.platform ?? process.platform) === "darwin" && (this.options.arch ?? process.arch) === "arm64"
		);
	}

	private requireSupported(): void {
		if (!this.supported()) {
			throw new Error(
				this.options.backend === "llama.cpp"
					? "llama.cpp requires macOS or Linux (POSIX process groups)"
					: "MLX requires macOS on Apple Silicon (arm64)",
			);
		}
	}

	private sanitize(text: string): string {
		const env = { ...process.env, ...this.options.env };
		for (const [key, value] of Object.entries(env)) {
			if (value && /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)) text = text.split(value).join("[redacted]");
		}
		return text.replace(/hf_[A-Za-z0-9]+/g, "[redacted]").slice(-4096);
	}

	private launch(
		command: string,
		args: string[],
		signal?: AbortSignal,
		input?: LocalModelSpec,
		update?: (p: LocalModelProgress) => void,
		offline = false,
	): RunningProcess {
		signal?.throwIfAborted();
		const child = spawn(command, args, {
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				...this.options.env,
				RAGA_LOCAL_MODEL_BACKEND: this.options.backend ?? "mlx",
				...(this.options.llamaServerPath ? { LLAMA_SERVER_PATH: this.options.llamaServerPath } : {}),
				PYTHONUNBUFFERED: "1",
				HF_XET_HIGH_PERFORMANCE: "1",
				...(offline ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } : {}),
			},
		});
		const proc: RunningProcess = { child, output: "", result: Promise.resolve() };
		if (this.processes.size === 0) process.once("exit", this.onExit);
		this.processes.add(proc);
		let pending = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			proc.output = this.sanitize(proc.output + chunk.toString());
			pending = (pending + chunk.toString()).slice(-16384);
			while (pending.includes("\n")) {
				const newline = pending.indexOf("\n");
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				try {
					const frame = JSON.parse(line) as Record<string, unknown>;
					if (typeof frame.installed === "boolean") proc.installed = frame.installed;
					if (typeof frame.cached === "boolean") proc.cached = frame.cached;
					if (typeof frame.modelPath === "string") proc.modelPath = frame.modelPath;
					if (typeof frame.error === "string") proc.error = this.sanitize(frame.error);
					if (typeof frame.message === "string") {
						update?.({
							message: this.sanitize(frame.message),
							...(typeof frame.percent === "number" ? { percent: frame.percent } : {}),
						});
					}
				} catch {
					/* Non-protocol server output is diagnostics only. */
				}
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			proc.output = this.sanitize(proc.output + chunk.toString());
		});
		const abort = () => {
			void this.terminate(proc);
		};
		signal?.addEventListener("abort", abort, { once: true });
		proc.result = new Promise<void>((resolve, reject) => {
			child.once("error", (error: NodeJS.ErrnoException) => {
				reject(
					new Error(
						error.code === "ENOENT" && command === (this.options.uvPath ?? "uv")
							? "uv is required on PATH. Install uv yourself, then retry; Raga does not install uv."
							: `Unable to launch ${this.label} runtime (${error.code ?? "unknown error"})`,
					),
				);
			});
			child.once("close", (code) => {
				signal?.removeEventListener("abort", abort);
				if (signal?.aborted) reject(signal.reason ?? new Error(`${this.label} operation cancelled`));
				else if (code !== 0)
					reject(new Error(proc.error ?? `${this.label} process exited (${code}): ${proc.output}`));
				else resolve();
				// Also clean descendants when the group leader exits unexpectedly.
				void this.terminate(proc);
			});
		});
		// A long-lived server can fail between launch and readiness polling.
		void proc.result.catch((error: unknown) => {
			proc.error ??= error instanceof Error ? error.message : `${this.label} process failed`;
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input ? JSON.stringify(input) : undefined);
		if (signal?.aborted) abort();
		return proc;
	}

	private terminate(proc: RunningProcess): Promise<void> {
		proc.terminate ??= (async () => {
			const kill = (signal: NodeJS.Signals) => {
				if (!proc.child.pid) return;
				try {
					process.kill(-proc.child.pid, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") proc.child.kill(signal);
				}
			};
			kill("SIGTERM");
			await delay(this.options.killGraceMs ?? 1000);
			kill("SIGKILL");
			this.processes.delete(proc);
			if (this.processes.size === 0) process.removeListener("exit", this.onExit);
		})();
		return proc.terminate;
	}

	private async ensureLlamaServer(signal: AbortSignal, update: (p: LocalModelProgress) => void): Promise<void> {
		const binary =
			this.options.llamaServerPath ??
			this.options.env?.LLAMA_SERVER_PATH ??
			process.env.LLAMA_SERVER_PATH ??
			"llama-server";
		const instructions =
			"llama-server >= v0.8.0 / b11960 is required. Install or upgrade llama.cpp and put llama-server on PATH, or set LLAMA_SERVER_PATH.";
		let found = false;
		try {
			const proc = this.launch(binary, ["--version"], AbortSignal.any([signal, AbortSignal.timeout(15000)]));
			await proc.result;
			found = true;
			const version = proc.output.match(/\bversion:\s*b?(\d+)(?![\d.])\b/i) ?? proc.output.match(/\bb(\d+)\b/i);
			const release = proc.output.match(/(?:\bversion:\s*v?|\bv)(\d+)\.(\d+)\.(\d+)\b/i);
			// Build output also contains compiler versions; never mistake those for llama.cpp.
			if (version ? Number(version[1]) >= 11960 : release && (Number(release[1]) > 0 || Number(release[2]) >= 8))
				return;
		} catch {
			signal.throwIfAborted();
		}
		if ((this.options.platform ?? process.platform) !== "darwin" || binary !== "llama-server") {
			throw new Error(instructions);
		}
		try {
			await this.launch("brew", ["--version"], signal).result;
		} catch {
			signal.throwIfAborted();
			throw new Error(`Homebrew must be on PATH to install or upgrade llama.cpp. ${instructions}`);
		}
		update({ message: `${found ? "Upgrading" : "Installing"} llama.cpp using Homebrew` });
		await this.launch("brew", [found ? "upgrade" : "install", "llama.cpp"], signal).result;
	}

	async installed(): Promise<boolean> {
		if (!this.supported()) return false;
		try {
			const proc = this.launch(this.python, [this.helper, "probe"], AbortSignal.timeout(30000));
			await proc.result;
			return proc.installed === true;
		} catch {
			return false;
		}
	}

	async install(signal: AbortSignal, update: (p: LocalModelProgress) => void): Promise<void> {
		this.requireSupported();
		signal.throwIfAborted();
		const uv = this.options.uvPath ?? "uv";
		await this.launch(uv, ["--version"], signal).result;
		await mkdir(this.root, { recursive: true });
		if (this.options.backend === "llama.cpp") await this.ensureLlamaServer(signal, update);
		update({
			message:
				this.options.backend === "llama.cpp"
					? "Creating private Python downloader environment"
					: "Creating private MLX Python environment",
		});
		await this.launch(
			uv,
			["venv", "--managed-python", "--allow-existing", "--python", "3.12", join(this.root, "venv")],
			signal,
		).result;
		update({
			message:
				this.options.backend === "llama.cpp"
					? "Installing pinned downloader dependencies"
					: "Installing pinned MLX dependencies",
		});
		await this.launch(
			uv,
			[
				"pip",
				"install",
				"--python",
				this.python,
				...(this.options.backend === "llama.cpp" ? [] : ["mlx-lm==0.32.2"]),
				"huggingface-hub==2.4.0",
				"hf-xet==1.7.1",
			],
			signal,
		).result;
		await this.launch(this.python, [this.helper, "probe"], signal).result;
		update({ message: `${this.label} runtime installed`, percent: 100 });
	}

	async cached(spec: LocalModelSpec, signal?: AbortSignal): Promise<boolean> {
		signal?.throwIfAborted();
		try {
			const proc = this.launch(
				this.python,
				[this.helper, "cache"],
				signal ?? AbortSignal.timeout(30000),
				spec,
				undefined,
				true,
			);
			await proc.result;
			return proc.cached === true;
		} catch (error) {
			if (signal?.aborted) throw error;
			return false;
		}
	}

	async download(spec: LocalModelSpec, signal: AbortSignal, update: (p: LocalModelProgress) => void): Promise<void> {
		this.requireSupported();
		await this.launch(this.python, [this.helper, "download"], signal, spec, update).result;
	}

	async start(
		spec: LocalModelSpec,
		signal: AbortSignal,
		update: (p: LocalModelProgress) => void,
	): Promise<{ baseUrl: string }> {
		this.requireSupported();
		signal.throwIfAborted();
		if (this.starting || this.server)
			throw new Error(`${this.label} server is already running or starting; stop it first`);
		this.starting = true;
		const generation = this.generation;
		try {
			const listener = createServer();
			const port = await new Promise<number>((resolve, reject) => {
				listener.once("error", reject);
				listener.listen(0, "127.0.0.1", () => {
					const address = listener.address();
					if (!address || typeof address === "string") {
						listener.close();
						reject(new Error(`Unable to allocate ${this.label} port`));
						return;
					}
					listener.close((error) => (error ? reject(error) : resolve(address.port)));
				});
			});
			if (generation !== this.generation) throw new Error(`${this.label} startup cancelled`);
			update({
				message:
					this.options.backend === "llama.cpp"
						? "Starting local llama.cpp server"
						: "Checking architecture and starting local MLX server",
			});
			const proc = this.launch(this.python, [this.helper, "serve", String(port)], signal, spec, update, true);
			this.server = proc;
			const baseUrl = `http://127.0.0.1:${port}/v1`;
			const deadline = Date.now() + (this.options.readyTimeoutMs ?? 120000);
			while (Date.now() < deadline) {
				signal.throwIfAborted();
				if (proc.error || proc.child.exitCode !== null || proc.child.signalCode !== null || proc.terminate) {
					await proc.result;
					throw new Error(`${this.label} server stopped before becoming ready`);
				}
				try {
					const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(500)]);
					if (this.options.backend === "llama.cpp") {
						const health = await fetch(`http://127.0.0.1:${port}/health`, {
							signal: requestSignal,
							redirect: "error",
						});
						if (!health.ok || ((await health.json()) as { status?: string }).status !== "ok") {
							await delay(50, undefined, { signal });
							continue;
						}
					}
					const response = await fetch(`${baseUrl}/models`, {
						signal: requestSignal,
						redirect: "error",
					});
					if (response.ok) {
						const body = (await response.json()) as { data?: { id?: string }[] };
						const expected = this.options.backend === "llama.cpp" ? spec.id : proc.modelPath;
						if (expected && body.data?.some((model) => model.id === expected)) {
							signal.throwIfAborted();
							if (generation !== this.generation || proc.terminate || proc.error)
								throw new Error(`${this.label} startup cancelled`);
							update({ message: `Local ${this.label} server ready`, percent: 100 });
							return { baseUrl };
						}
					}
				} catch {
					/* Connection refused while loading is expected. */
				}
				await delay(50, undefined, { signal });
			}
			throw new Error(`${this.label} server readiness timed out: ${proc.error ?? proc.output}`);
		} catch (error) {
			await this.stop();
			throw error;
		} finally {
			this.starting = false;
		}
	}

	async stop(): Promise<void> {
		this.generation++;
		await Promise.all([...this.processes].map((proc) => this.terminate(proc)));
		this.server = undefined;
	}
}
