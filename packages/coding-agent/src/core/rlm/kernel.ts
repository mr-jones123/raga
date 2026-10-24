// Adapted from Prime Agent (MIT), github.com/PrimeIntellect-ai/prime-agent
/**
 * `Kernel` owns one Python kernel process (`python -m raga_rlm.repl`): it starts it, runs cells,
 * answers host requests, interrupts, restarts, snapshots, and stops it. See docs/RLM.md.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.ts";
import { killProcessTree } from "../../utils/shell.ts";
import {
	type DoneEvent,
	type ErrorEvent,
	type HostReplyData,
	type HostRequestEvent,
	type KernelEvent,
	type KernelRequest,
	PROTOCOL_VERSION,
	parseKernelEvent,
} from "./protocol.ts";
import { type PythonEnv, resolvePythonEnv } from "./python-env.ts";

export type HostRequest = { type: string; [key: string]: unknown };
export type HostHandler = (data: HostRequest, ctx: { cellId: string | null; signal: AbortSignal }) => Promise<unknown>;

export interface CellOutput {
	status: "ok" | "error";
	/** Output attributed to this cell, in full. */
	stdout: string;
	stderr: string;
	/** `repr` of the trailing expression. */
	result?: string;
	error?: { ename: string; evalue: string; traceback: string[] };
	/** Output with `id: null` or another cell's id that arrived while this cell ran. */
	background: string;
	/** True when the kernel was killed and restarted during the cell, so the namespace is empty. */
	restarted: boolean;
}

export interface KernelOptions {
	cwd: string;
	env?: Record<string, string>;
	handlers: ReadonlyMap<string, HostHandler>;
	/** Defaults to `resolvePythonEnv()`. */
	pythonEnv?: () => Promise<PythonEnv>;
}

/**
 * - `dead`: no process. `start()` leaves it unless the kernel is disposed.
 * - `starting` / `restarting`: a process is spawned and the host waits for `ready`.
 * - `ready`: idle process. `busy`: one request with an id is in flight.
 */
export type KernelState = "starting" | "ready" | "busy" | "restarting" | "dead";

const TRANSITIONS: Record<KernelState, readonly KernelState[]> = {
	dead: ["starting"],
	starting: ["ready", "restarting", "dead"],
	ready: ["busy", "restarting", "dead"],
	busy: ["ready", "restarting", "dead"],
	restarting: ["ready", "dead"],
};

const INTERRUPT_GRACE_MS = 1000;
const READY_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 8192;

type CellError = NonNullable<CellOutput["error"]>;
type RequestEvent = Exclude<KernelEvent, { event: "ready" } | HostRequestEvent>;
/** Why an in-flight request ended without its `done` event. */
type Teardown = "exit" | "restart" | "dispose";

interface PendingRequest {
	id: string;
	isCell: boolean;
	onEvent(event: RequestEvent): void;
	/** `restarting` settles when the replacement process is ready (or failed to start). */
	onTeardown(reason: Teardown, detail: string, restarting?: Promise<void>): void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One spawned kernel process. Events reach the owner only after a valid protocol-1 `ready`. */
class KernelProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly ready: Promise<void>;
	readonly hostRequests = new Map<string, { cell: string | null; controller: AbortController }>();
	exited = false;
	private stderrTail = "";

	constructor(
		python: PythonEnv,
		options: KernelOptions,
		onEvent: (event: KernelEvent) => void,
		onExit: (detail: string) => void,
	) {
		this.child = spawn(python.python, ["-m", "raga_rlm.repl"], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, PYTHONPATH: python.runtimeDir, PYTHONUNBUFFERED: "1" },
			stdio: "pipe",
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		this.child.stdin.on("error", () => {
			// EPIPE after the process died; exit handling reports it.
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (text: string) => {
			this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
		});

		let isReady = false;
		const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
		this.ready = ready;

		attachJsonlLineReader(this.child.stdout, (line) => {
			if (line.trim() === "") return;
			let event: KernelEvent;
			try {
				event = parseKernelEvent(line);
			} catch (error) {
				if (!isReady) {
					rejectReady(new Error(`Kernel wrote invalid startup output: ${errorMessage(error)}`));
					return;
				}
				onEvent({
					event: "error",
					id: null,
					ename: "KernelProtocolError",
					evalue: errorMessage(error),
					traceback: [],
				});
				return;
			}
			if (isReady) {
				onEvent(event);
			} else if (event.event !== "ready") {
				rejectReady(new Error(`Kernel sent "${event.event}" before "ready"`));
			} else if (event.protocol !== PROTOCOL_VERSION) {
				rejectReady(new Error(`Kernel speaks protocol ${event.protocol}; the host needs ${PROTOCOL_VERSION}`));
			} else {
				isReady = true;
				resolveReady();
			}
		});

		const handleExit = (detail: string) => {
			if (this.exited) return;
			this.exited = true;
			const stderr = this.stderrTail.trim();
			const fullDetail = stderr ? `${detail}\n${stderr}` : detail;
			rejectReady(new Error(`Kernel exited before it was ready: ${fullDetail}`));
			for (const { controller } of this.hostRequests.values()) controller.abort();
			onExit(fullDetail);
		};
		this.child.on("error", (error) => handleExit(`failed to run ${python.python}: ${error.message}`));
		this.child.on("exit", (code, signal) => handleExit(signal ? `signal ${signal}` : `exit code ${code}`));
	}

	/** Returns false when the process is gone. Throws when `request` is not JSON-serializable. */
	write(request: KernelRequest): boolean {
		if (this.exited || !this.child.stdin.writable) return false;
		this.child.stdin.write(serializeJsonLine(request));
		return true;
	}

	/** Abort host requests made by `cell`, or all of them when `cell` is omitted. */
	abortHostRequests(cell?: string): void {
		for (const request of this.hostRequests.values()) {
			if (cell === undefined || request.cell === cell) request.controller.abort();
		}
	}

	kill(): void {
		this.abortHostRequests();
		if (this.child.pid !== undefined) killProcessTree(this.child.pid);
	}
}

export class Kernel {
	private readonly options: KernelOptions;
	private currentState: KernelState = "dead";
	private disposed = false;
	private proc: KernelProcess | undefined;
	private pending: PendingRequest | undefined;
	/** In-flight start or restart. */
	private launching: Promise<void> | undefined;
	/** Bumped by every launch and by dispose, so a superseded launch never installs its process. */
	private generation = 0;
	private envPromise: Promise<PythonEnv> | undefined;
	/** Serializes requests with an id; the kernel runs them one at a time anyway. */
	private queue: Promise<unknown> = Promise.resolve();
	private requestCounter = 0;

	constructor(options: KernelOptions) {
		this.options = options;
	}

	get state(): KernelState {
		return this.currentState;
	}

	/** Pid of the live kernel process. */
	get pid(): number | undefined {
		return this.proc?.child.pid;
	}

	start(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("Kernel is disposed"));
		if (this.launching) return this.launching;
		if (this.currentState !== "dead") return Promise.resolve();
		return this.launch();
	}

	execute(
		code: string,
		options: { signal?: AbortSignal; onOutput?: (stream: "stdout" | "stderr", text: string) => void } = {},
	): Promise<CellOutput> {
		return this.exclusive(async () => {
			await this.start();
			return this.runCell(code, options);
		});
	}

	/** Interrupt the running cell. No-op when no cell runs, so a stray interrupt never hits a later cell. */
	interrupt(): void {
		if (!this.pending?.isCell || !this.proc) return;
		this.proc.write({ type: "interrupt", id: this.pending.id });
		this.proc.abortHostRequests(this.pending.id);
	}

	/** Kill the process and start a new one. A running request ends with `restarted: true` (cells) or an error. */
	restart(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("Kernel is disposed"));
		this.killProcess();
		const launching = this.launch();
		this.failPending("restart", "restart requested", launching);
		return launching;
	}

	async snapshot(
		path: string,
		options: { maxBytes?: number; maxVariableBytes?: number } = {},
	): Promise<{ saved: string[]; skipped: string[]; bytes: number }> {
		const done = await this.request((id) => ({
			type: "snapshot",
			id,
			path,
			max_bytes: options.maxBytes,
			max_variable_bytes: options.maxVariableBytes,
		}));
		if (done.status === "error") throw new Error(`Kernel snapshot failed: ${done.reason ?? "unknown error"}`);
		return { saved: done.saved ?? [], skipped: done.skipped ?? [], bytes: done.bytes ?? 0 };
	}

	async restore(path: string): Promise<{ restored: string[]; failed: string[]; reason?: string }> {
		const done = await this.request((id) => ({ type: "restore", id, path }));
		if (done.status === "error") throw new Error(`Kernel restore failed: ${done.reason ?? "unknown error"}`);
		const result: { restored: string[]; failed: string[]; reason?: string } = {
			restored: done.restored ?? [],
			failed: done.failed ?? [],
		};
		if (done.reason !== undefined) result.reason = done.reason;
		return result;
	}

	async listNames(): Promise<string[]> {
		const done = await this.request((id) => ({ type: "list_names", id }));
		if (done.status === "error") throw new Error(`Kernel list_names failed: ${done.reason ?? "unknown error"}`);
		return done.names ?? [];
	}

	/** Kill the process tree synchronously. Pending requests end with an error; later calls reject. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.launching = undefined;
		this.killProcess();
		this.setState("dead");
		this.failPending("dispose", "kernel disposed");
	}

	private setState(next: KernelState): void {
		if (next === this.currentState) return;
		if (!TRANSITIONS[this.currentState].includes(next)) {
			throw new Error(`Invalid kernel state transition: ${this.currentState} -> ${next}`);
		}
		this.currentState = next;
	}

	private exclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.catch(() => {});
		return run;
	}

	private launch(): Promise<void> {
		this.setState(this.currentState === "dead" ? "starting" : "restarting");
		const generation = ++this.generation;
		const launching = this.spawnProcess(generation).then(
			() => {
				if (generation === this.generation) {
					this.launching = undefined;
					this.setState("ready");
					return;
				}
				return this.supersededBy();
			},
			(error: unknown) => {
				if (generation === this.generation) {
					this.launching = undefined;
					this.killProcess();
					this.setState("dead");
					throw error;
				}
				return this.supersededBy();
			},
		);
		this.launching = launching;
		return launching;
	}

	/** A newer launch or dispose replaced this one; follow whatever replaced it. */
	private supersededBy(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("Kernel is disposed"));
		return this.launching ?? Promise.resolve();
	}

	private async spawnProcess(generation: number): Promise<void> {
		this.envPromise ??= (this.options.pythonEnv ?? resolvePythonEnv)();
		let python: PythonEnv;
		try {
			python = await this.envPromise;
		} catch (error) {
			this.envPromise = undefined;
			throw error;
		}
		if (generation !== this.generation) return;
		const proc: KernelProcess = new KernelProcess(
			python,
			this.options,
			(event) => this.handleEvent(proc, event),
			(detail) => this.handleExit(proc, detail),
		);
		this.proc = proc;
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => timeout.reject(new Error(`Kernel did not send "ready" within ${READY_TIMEOUT_MS} ms`)),
			READY_TIMEOUT_MS,
		);
		try {
			await Promise.race([proc.ready, timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	private killProcess(): void {
		const proc = this.proc;
		this.proc = undefined;
		proc?.kill();
	}

	private failPending(reason: Teardown, detail: string, restarting?: Promise<void>): void {
		const pending = this.pending;
		this.pending = undefined;
		pending?.onTeardown(reason, detail, restarting);
	}

	private handleExit(proc: KernelProcess, detail: string): void {
		if (proc !== this.proc) return;
		this.proc = undefined;
		// During a launch, the rejected `ready` promise moves the state.
		if (this.currentState === "starting" || this.currentState === "restarting") return;
		this.setState("dead");
		this.failPending("exit", detail);
	}

	private handleEvent(proc: KernelProcess, event: KernelEvent): void {
		if (proc !== this.proc || event.event === "ready") return;
		if (event.event === "host_request") {
			this.handleHostRequest(proc, event);
			return;
		}
		this.pending?.onEvent(event);
	}

	private handleHostRequest(proc: KernelProcess, event: HostRequestEvent): void {
		const controller = new AbortController();
		proc.hostRequests.set(event.id, { cell: event.cell, controller });
		const handler = this.options.handlers.get(event.data.type);
		const run = async (): Promise<unknown> => {
			if (!handler) throw new Error(`Unknown host request type: ${event.data.type}`);
			return handler(event.data, { cellId: event.cell, signal: controller.signal });
		};
		void run()
			.then(
				(result): HostReplyData => ({ status: "ok", result: result ?? null }),
				(error: unknown): HostReplyData => ({ status: "error", error: errorMessage(error) }),
			)
			.then((data) => {
				proc.hostRequests.delete(event.id);
				if (proc !== this.proc) return;
				try {
					proc.write({ type: "host_reply", id: event.id, data });
				} catch (error) {
					proc.write({
						type: "host_reply",
						id: event.id,
						data: { status: "error", error: `Host reply is not JSON-serializable: ${errorMessage(error)}` },
					});
				}
			});
	}

	private readyProcess(): KernelProcess {
		if (!this.proc || this.currentState !== "ready") {
			throw new Error(`Kernel is not ready (state: ${this.currentState})`);
		}
		return this.proc;
	}

	private runCell(
		code: string,
		options: { signal?: AbortSignal; onOutput?: (stream: "stdout" | "stderr", text: string) => void },
	): Promise<CellOutput> {
		const { signal, onOutput } = options;
		const output: CellOutput = { status: "ok", stdout: "", stderr: "", background: "", restarted: false };
		const fail = (error: CellError) => {
			output.status = "error";
			output.error = error;
		};
		if (signal?.aborted) {
			fail({ ename: "KeyboardInterrupt", evalue: "cell aborted before it started", traceback: [] });
			return Promise.resolve(output);
		}
		const proc = this.readyProcess();
		const id = `cell-${++this.requestCounter}`;
		this.setState("busy");

		const { promise, resolve } = Promise.withResolvers<CellOutput>();
		let graceTimer: NodeJS.Timeout | undefined;
		const settle = () => {
			clearTimeout(graceTimer);
			signal?.removeEventListener("abort", onAbort);
			resolve(output);
		};
		const pending: PendingRequest = {
			id,
			isCell: true,
			onEvent: (event) => {
				switch (event.event) {
					case "stdout":
					case "stderr":
						if (event.id === id) {
							output[event.event] += event.text;
							onOutput?.(event.event, event.text);
						} else {
							output.background += event.text;
						}
						return;
					case "error":
						if (event.id === id) {
							output.error = { ename: event.ename, evalue: event.evalue, traceback: event.traceback };
						} else {
							output.background += `${event.ename}: ${event.evalue}\n`;
						}
						return;
					case "result":
						if (event.id === id) output.result = event.text;
						return;
					case "done":
						if (event.id !== id) return;
						output.status = event.status;
						this.pending = undefined;
						this.setState("ready");
						settle();
				}
			},
			onTeardown: (reason, detail, restarting) => {
				if (reason === "dispose") {
					fail({ ename: "KernelDisposed", evalue: "the kernel was disposed while the cell ran", traceback: [] });
					settle();
					return;
				}
				if (reason === "exit") {
					fail({
						ename: "KernelDied",
						evalue: `the kernel process exited while the cell ran (${detail}); the namespace is lost`,
						traceback: [],
					});
					settle();
					return;
				}
				// A forced restart after an ignored interrupt already recorded its KeyboardInterrupt.
				if (output.error?.ename !== "KeyboardInterrupt") {
					fail({
						ename: "KernelRestarted",
						evalue: "the kernel restarted while the cell ran; the namespace is empty",
						traceback: [],
					});
				}
				output.status = "error";
				void (restarting ?? Promise.resolve()).then(
					() => {
						output.restarted = true;
						settle();
					},
					(error: unknown) => {
						if (output.error) output.error.evalue += `; the restart failed: ${errorMessage(error)}`;
						settle();
					},
				);
			},
		};
		const onAbort = () => {
			if (this.pending !== pending) return;
			proc.write({ type: "interrupt", id });
			proc.abortHostRequests(id);
			graceTimer = setTimeout(() => {
				if (this.pending !== pending) return;
				fail({
					ename: "KeyboardInterrupt",
					evalue: `the cell did not stop within ${INTERRUPT_GRACE_MS} ms of the interrupt; the kernel was killed and restarted, and the namespace is empty`,
					traceback: [],
				});
				this.restart().catch(() => {
					// onTeardown reports the failed restart in the cell's error.
				});
			}, INTERRUPT_GRACE_MS);
		};
		this.pending = pending;
		signal?.addEventListener("abort", onAbort, { once: true });
		proc.write({ type: "execute", id, code });
		return promise;
	}

	/** Run a non-cell request and resolve with its `done` event. */
	private request(build: (id: string) => KernelRequest): Promise<DoneEvent> {
		return this.exclusive(async () => {
			await this.start();
			const proc = this.readyProcess();
			const id = `req-${++this.requestCounter}`;
			this.setState("busy");
			const { promise, resolve, reject } = Promise.withResolvers<DoneEvent>();
			let error: ErrorEvent | undefined;
			this.pending = {
				id,
				isCell: false,
				onEvent: (event) => {
					if (event.id !== id) return;
					if (event.event === "error") error = event;
					if (event.event !== "done") return;
					this.pending = undefined;
					this.setState("ready");
					if (event.reason === undefined && error) event.reason = `${error.ename}: ${error.evalue}`;
					resolve(event);
				},
				onTeardown: (reason, detail) => reject(new Error(`Kernel request ${id} ended by ${reason}: ${detail}`)),
			};
			proc.write(build(id));
			return promise;
		});
	}
}
