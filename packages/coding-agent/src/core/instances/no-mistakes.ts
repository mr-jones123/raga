import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import lockfile from "proper-lockfile";
import { stringify } from "yaml";
import { getBundledHarnessPath } from "./bundle.ts";
import type { CommandResult } from "./types.ts";

export const NO_MISTAKES_PIN = {
	version: "1.84.0",
	tag: "v1.84.0",
	commit: "4822244e763fd4c3d7f48be6433f92df10bb5b33",
	repository: "https://github.com/kunchenguid/no-mistakes",
	skillSha256: "7ee4d49f3fbe9d639a19aee37f40d43bcac013ba7cf212f9fd2a70c21dafad44",
	assets: {
		"linux-x64": "b0fb8a9df412c5fa1fb92a3584ffa1d4d5b4d6e0d1738efa2f8b88320f8bf1c2",
		"linux-arm64": "8d8cefd927b7f921c207e4dd6c575081dc255dc068f0205f74b52e482bf2f7ab",
		"darwin-x64": "88b1a481924488f55456b3f96070f739b109e19555232e4f8be0a7ebae7c08ac",
		"darwin-arm64": "2e5f838303ab727edccd1a60a4834068024606c68ae7d97fdc0fdeecd7bd4d90",
	},
} as const;

export interface NoMistakesOptions {
	instanceRoot: string;
	projectRoot: string;
	agent?: { executable: string; args?: string[]; version: string };
	/** Explicit trusted credential values. Ambient environment values are never copied. */
	environment?: Record<string, string>;
}

export interface NoMistakesInspection {
	version: string;
	installed: boolean;
	enabled: boolean;
	executable: string;
	prerequisites: string[];
}

export interface NoMistakesResult extends CommandResult {
	state: "gate" | "passed" | "failed" | "running" | "inconclusive" | "stopped";
	outcome?: string;
	skipped: string[];
	fullyVerified: false;
}

export interface NoMistakesApproval {
	network: true;
	push?: true;
	pr?: true;
	ci?: true;
	yes?: true;
}

interface Enablement {
	schemaVersion: 1;
	projectRoot: string;
	version: string;
	agentExecutable: string;
	agentHash: string;
	agentArgs: string[];
	agentVersion: string;
}

export async function getNoMistakesBackend(instanceRoot: string, projectRoot: string): Promise<NoMistakesBackend> {
	return new NoMistakesBackend({ instanceRoot, projectRoot });
}

export function noMistakesRunPolicy(
	intent: string,
	approval?: NoMistakesApproval,
): { args: string[]; skipped: string[] } {
	requireApproval(approval?.network);
	if (!intent.trim()) throw new Error("The user's complete intent is required");
	const skipped = (["push", "pr", "ci"] as const).filter((step) => approval?.[step] !== true);
	if (approval?.pr && !approval.push) throw new Error("PR creation also requires explicit push authorization");
	if (approval?.ci && (!approval.push || !approval.pr))
		throw new Error("CI monitoring also requires push and PR authorization");
	const args = ["axi", "run", "--intent", intent, "--wait", "8m", "--no-publish-intent"];
	if (skipped.length) args.push("--skip", skipped.join(","));
	if (approval?.yes === true) args.push("--yes");
	return { args, skipped };
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function requireApproval(approved: unknown): void {
	if (approved !== true) throw new Error("Explicit supervisor approval is required");
}

function assertOuterGate(): void {
	if (process.env.NO_MISTAKES_GATE || process.env.RAGA_VALIDATION_STEP) {
		throw new Error("nested_gate_context: validation-step agents cannot control an outer gate");
	}
}

/** Extract only the regular executable. Never let archive paths choose filesystem writes. */
function extractExecutable(archive: Buffer): Buffer {
	const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
	let executable: Buffer | undefined;
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
		const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(), 8);
		if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
			throw new Error("Invalid pinned no-mistakes archive");
		}
		if (name === "no-mistakes" || name === "./no-mistakes") {
			if (executable || (header[156] !== 0 && header[156] !== 48)) {
				throw new Error("Pinned archive must contain one regular no-mistakes executable");
			}
			executable = tar.subarray(offset + 512, offset + 512 + size);
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	if (!executable?.length) throw new Error("Pinned archive contains no no-mistakes executable");
	return executable;
}

async function execute(
	command: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
	timeoutMs = 30_000,
	signal?: AbortSignal,
	input?: string,
): Promise<CommandResult> {
	const { promise, resolve: fulfill, reject } = Promise.withResolvers<CommandResult>();
	if (signal?.aborted) return { exitCode: 1, stdout: "", stderr: "Cancelled", timedOut: false, aborted: true };
	const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let size = 0;
	let timedOut = false;
	let aborted = false;
	let killTimer: NodeJS.Timeout | undefined;
	const terminate = () => {
		const pid = child.pid;
		if (!pid) return;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			/* Already exited. */
		}
		killTimer ??= setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* Already exited. */
			}
		}, 1500);
		killTimer.unref();
	};
	const onAbort = () => {
		aborted = true;
		terminate();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, timeoutMs);
	signal?.addEventListener("abort", onAbort, { once: true });
	const capture = (target: Buffer[], chunk: Buffer) => {
		const remaining = 4 * 1024 * 1024 - size;
		if (remaining > 0) target.push(chunk.subarray(0, remaining));
		size += chunk.length;
		if (remaining < chunk.length) terminate();
	};
	child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
	child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
	child.stdin.on("error", () => {});
	child.stdin.end(input);
	const cleanup = () => {
		clearTimeout(timer);
		clearTimeout(killTimer);
		if (killTimer && child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* No surviving descendants. */
			}
		}
		signal?.removeEventListener("abort", onAbort);
	};
	child.on("error", (error) => {
		cleanup();
		reject(error);
	});
	child.on("close", (code) => {
		cleanup();
		fulfill({
			exitCode: size > 4 * 1024 * 1024 ? 1 : (code ?? 1),
			stdout: Buffer.concat(stdout).toString(),
			stderr: Buffer.concat(stderr).toString() + (size > 4 * 1024 * 1024 ? "\nOutput limit exceeded" : ""),
			timedOut,
			aborted,
		});
	});
	return promise;
}

export function interpretNoMistakesResult(result: CommandResult, skipped: string[] = []): NoMistakesResult {
	const outcome = /^outcome:\s*([\w-]+)\s*$/m.exec(result.stdout)?.[1];
	const observedSkips = [...result.stdout.matchAll(/^\s+(push|pr|ci),skipped,/gm)].map((match) => match[1]);
	const state =
		result.aborted || result.timedOut
			? "inconclusive"
			: /^gate:\s*$/m.test(result.stdout)
				? "gate"
				: /wait of .* elapsed while driving the run/.test(result.stdout)
					? "running"
					: result.exitCode === 0 && (outcome === "passed" || outcome === "checks-passed")
						? "passed"
						: outcome === "failed" || outcome === "cancelled" || result.exitCode !== 0
							? "failed"
							: outcome
								? "inconclusive"
								: "running";
	return { ...result, state, outcome, skipped: [...new Set([...skipped, ...observedSkips])], fullyVerified: false };
}

export class NoMistakesBackend {
	readonly root: string;
	readonly executable: string;
	private options: NoMistakesOptions;
	private home: string;
	private nmHome: string;
	private verifiedExecutable?: Stats;

	constructor(options: NoMistakesOptions) {
		this.options = {
			...options,
			agent: options.agent ? { ...options.agent, args: options.agent.args?.slice() } : undefined,
			environment: options.environment ? { ...options.environment } : undefined,
		};
		this.root = join(resolve(options.instanceRoot), "state", "backends", "no-mistakes");
		this.executable = join(this.root, "bin", NO_MISTAKES_PIN.tag, "no-mistakes");
		this.home = join(this.root, "home");
		this.nmHome = join(this.root, "data");
		for (const key of Object.keys(options.environment ?? {})) {
			if (
				!/^[A-Z][A-Z0-9_]*$/.test(key) ||
				/^(HOME|PATH|NM_HOME|SHELL|XDG_.*|GIT_.*|NO_MISTAKES_.*|RAGA_.*|NM_.*|LD_.*|DYLD_.*|NODE_OPTIONS|BASH_ENV|ENV)$/.test(
					key,
				)
			) {
				throw new Error(`Backend environment cannot override managed variable ${key}`);
			}
		}
	}

	private environment(): Record<string, string> {
		return {
			...this.options.environment,
			PATH: "/usr/local/bin:/usr/bin:/bin",
			HOME: this.home,
			NM_HOME: this.nmHome,
			XDG_CONFIG_HOME: join(this.home, ".config"),
			XDG_CACHE_HOME: join(this.home, ".cache"),
			XDG_DATA_HOME: join(this.home, ".local", "share"),
			SHELL: "/bin/sh",
			NO_MISTAKES_TELEMETRY: "off",
			NO_MISTAKES_NO_UPDATE_CHECK: "1",
			// Upstream's documented production escape hatch disables OS service operations.
			NM_TEST_START_DAEMON: "1",
			GIT_CONFIG_GLOBAL: join(this.home, ".gitconfig"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			NO_COLOR: "1",
		};
	}

	private asset(): { url: string; digest: string } {
		const key = `${process.platform}-${process.arch}`;
		if (!(key in NO_MISTAKES_PIN.assets)) throw new Error(`No managed no-mistakes backend for ${key}`);
		const digest = NO_MISTAKES_PIN.assets[key as keyof typeof NO_MISTAKES_PIN.assets];
		const arch = process.arch === "x64" ? "amd64" : "arm64";
		return {
			url: `${NO_MISTAKES_PIN.repository}/releases/download/${NO_MISTAKES_PIN.tag}/no-mistakes-${NO_MISTAKES_PIN.tag}-${process.platform}-${arch}.tar.gz`,
			digest,
		};
	}

	private async prepare(): Promise<void> {
		assertOuterGate();
		for (const path of [this.root, this.home, this.nmHome, dirname(this.executable)]) {
			let ancestor = path;
			for (;;) {
				try {
					if ((await realpath(ancestor)) !== ancestor)
						throw new Error(`Backend state must not contain symlinks: ${ancestor}`);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					ancestor = dirname(ancestor);
				}
			}
			await mkdir(path, { recursive: true, mode: 0o700 });
			if ((await realpath(path)) !== path) throw new Error(`Backend state must not contain symlinks: ${path}`);
		}
	}

	private async enabled(): Promise<Enablement | undefined> {
		try {
			const value: unknown = JSON.parse(await readFile(join(this.root, "enabled.json"), "utf8"));
			if (typeof value !== "object" || value === null) throw new Error("Invalid no-mistakes enablement");
			const entry = value as Record<string, unknown>;
			if (
				typeof entry.agentExecutable !== "string" ||
				!isAbsolute(entry.agentExecutable) ||
				typeof entry.agentVersion !== "string" ||
				!entry.agentVersion.trim() ||
				!Array.isArray(entry.agentArgs) ||
				!entry.agentArgs.every((arg: unknown) => typeof arg === "string") ||
				typeof entry.agentHash !== "string" ||
				!/^[a-f0-9]{64}$/.test(entry.agentHash)
			) {
				throw new Error("Invalid persisted no-mistakes adapter");
			}
			const record = entry as unknown as Enablement;
			const agent = this.options.agent ?? {
				executable: record.agentExecutable,
				version: record.agentVersion,
				args: record.agentArgs,
			};
			if (
				record.schemaVersion !== 1 ||
				record.projectRoot !== (await realpath(this.options.projectRoot)) ||
				record.version !== NO_MISTAKES_PIN.version ||
				record.agentVersion !== agent.version ||
				record.agentExecutable !== agent.executable ||
				!(await stat(agent.executable)).isFile() ||
				record.agentHash !== hash(await readFile(agent.executable)) ||
				JSON.stringify(record.agentArgs) !== JSON.stringify(agent.args ?? [])
			) {
				throw new Error("No-mistakes enablement no longer matches the project, binary, or agent; enable again");
			}
			return record;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async inspect(): Promise<NoMistakesInspection> {
		const prerequisites: string[] = [];
		this.verifiedExecutable = undefined;
		let installed = false;
		try {
			await this.checkStatePaths();
			const skill = await readFile(join(getBundledHarnessPath(), "skills", "no-mistakes", "upstream", "SKILL.md"));
			if (hash(skill) !== NO_MISTAKES_PIN.skillSha256)
				throw new Error("Pinned no-mistakes skill and executable revision do not match");
			const { digest } = this.asset();
			const archive = await readFile(join(dirname(this.executable), "asset.tar.gz"));
			if (hash(archive) !== digest) throw new Error("Pinned no-mistakes archive checksum mismatch");
			const expected = extractExecutable(archive);
			const actual = await readFile(this.executable);
			if (hash(actual) !== hash(expected)) throw new Error("Managed no-mistakes executable checksum mismatch");
			this.verifiedExecutable = await stat(this.executable);
			installed = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") prerequisites.push(String(error));
		}
		if (!installed) prerequisites.push(`Approve managed provisioning of no-mistakes ${NO_MISTAKES_PIN.tag}`);
		let enabled = false;
		try {
			enabled = Boolean(await this.enabled());
		} catch (error) {
			prerequisites.push(String(error));
		}
		if (!enabled)
			prerequisites.push("Explicit repository enablement and a verified runnable Pi JSON adapter are required");
		return { version: NO_MISTAKES_PIN.version, installed, enabled, executable: this.executable, prerequisites };
	}

	private async checkStatePaths(): Promise<void> {
		for (const path of [this.root, this.home, this.nmHome, dirname(this.executable), this.executable]) {
			try {
				if ((await realpath(path)) !== path) throw new Error(`Backend state must not contain symlinks: ${path}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}

	async provision(approval: { approved: true }): Promise<NoMistakesInspection> {
		requireApproval(approval.approved);
		await this.prepare();
		const release = await lockfile.lock(this.root, { retries: 0 });
		try {
			if ((await this.inspect()).installed) return this.inspect();
			const asset = this.asset();
			const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
			if (!response.ok || !response.body) throw new Error(`Pinned asset download failed: HTTP ${response.status}`);
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > 64 * 1024 * 1024) throw new Error("Pinned asset exceeds download limit");
				chunks.push(chunk);
			}
			const archive = Buffer.concat(chunks);
			if (hash(archive) !== asset.digest) throw new Error("Pinned no-mistakes asset checksum mismatch");
			const binary = extractExecutable(archive);
			const temporary = `${this.executable}.${randomUUID()}`;
			try {
				await writeFile(temporary, binary, { mode: 0o700, flag: "wx" });
				await chmod(temporary, 0o700);
				const version = await execute(temporary, ["--version"], this.root, this.environment());
				if (version.exitCode !== 0 || !version.stdout.includes(NO_MISTAKES_PIN.version))
					throw new Error("Pinned binary version mismatch");
				await writeFile(join(dirname(this.executable), "asset.tar.gz"), archive, { mode: 0o600 });
				await rename(temporary, this.executable);
			} finally {
				await rm(temporary, { force: true });
			}
			return this.inspect();
		} finally {
			await release();
		}
	}

	private async invoke(args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<CommandResult> {
		let identity: Stats | undefined;
		try {
			identity = await stat(this.executable);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const verified = this.verifiedExecutable;
		if (
			!identity ||
			!verified ||
			identity.dev !== verified.dev ||
			identity.ino !== verified.ino ||
			identity.size !== verified.size ||
			identity.mtimeMs !== verified.mtimeMs ||
			identity.ctimeMs !== verified.ctimeMs
		) {
			if (!(await this.inspect()).installed)
				throw new Error("No-mistakes is not provisioned. Approve managed provisioning first");
		}
		await this.checkStatePaths();
		return execute(this.executable, args, this.options.projectRoot, this.environment(), timeoutMs, signal);
	}

	private async verifyAgent(): Promise<void> {
		const agent = this.options.agent;
		if (!agent)
			throw new Error("Configure the actual pipeline agent executable and expected version before enabling");
		if (!isAbsolute(agent.executable) || !(await stat(agent.executable)).isFile())
			throw new Error("Agent executable must be an absolute regular file");
		if (!agent.version.trim()) throw new Error("Expected agent version is required");
		const version = await execute(
			agent.executable,
			[...(agent.args ?? []), "--version"],
			this.home,
			this.environment(),
		);
		if (version.exitCode || version.stdout.trim() !== agent.version.trim())
			throw new Error("Pipeline agent version does not match the approved version");
		const help = await execute(agent.executable, [...(agent.args ?? []), "--help"], this.home, this.environment());
		for (const flag of ["--mode", "--session", "--no-session", "--no-context-files"]) {
			if (help.exitCode || !help.stdout.includes(flag))
				throw new Error(`Pipeline agent lacks required Pi adapter flag ${flag}`);
		}
		const probe = 'Return only the JSON object {"raga_adapter_probe":true}. Do not call tools.';
		const sessionDir = join(this.root, "adapter-sessions");
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		const baseArgs = [
			...(agent.args ?? []),
			"--no-context-files",
			"--no-tools",
			"--mode",
			"json",
			"--session-dir",
			sessionDir,
		];
		let session: string | undefined;
		for (const resume of [false, true]) {
			const args = resume ? [...baseArgs, "--session", session!] : baseArgs;
			const result = await execute(agent.executable, args, this.home, this.environment(), 120_000, undefined, probe);
			if (result.exitCode || result.timedOut || result.aborted)
				throw new Error(`Pi adapter probe failed: ${result.stderr}`);
			const events: unknown[] = result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			let ended = false;
			let gotProbe = false;
			let emittedSession: string | undefined;
			for (const value of events) {
				if (typeof value !== "object" || value === null) continue;
				const event = value as Record<string, unknown>;
				if (
					event.type === "session" &&
					typeof event.id === "string" &&
					/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(event.id)
				)
					emittedSession = event.id;
				if (event.type === "agent_end") ended = true;
				if (event.type === "message_end" && typeof event.message === "object" && event.message !== null) {
					const message = event.message as Record<string, unknown>;
					if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
					for (const content of message.content as unknown[]) {
						if (typeof content !== "object" || content === null) continue;
						const block = content as Record<string, unknown>;
						if (block.type === "text" && typeof block.text === "string") {
							try {
								const text = block.text.trim();
								const response: unknown = JSON.parse(
									/^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)?.[1] ?? text,
								);
								gotProbe ||=
									typeof response === "object" &&
									response !== null &&
									(response as Record<string, unknown>).raga_adapter_probe === true;
							} catch {
								/* Not the probe response. */
							}
						}
					}
				}
			}
			if (!ended || !gotProbe || !emittedSession || (resume && emittedSession !== session))
				throw new Error("Pipeline agent violates Pi JSON event or durable-session contract");
			session = emittedSession;
		}
	}

	async enable(approval: { approved: true; network: true }): Promise<NoMistakesResult> {
		requireApproval(approval.approved);
		requireApproval(approval.network);
		await this.prepare();
		if (!(await this.inspect()).installed)
			throw new Error("Provision the pinned no-mistakes backend before repository enablement");
		await this.verifyAgent();
		const config = {
			agent: "pi",
			agent_path_override: { pi: this.options.agent!.executable },
			agent_args_override: { pi: [...(this.options.agent!.args ?? []), "--no-context-files"] },
			auto_fix: { review: 0 },
			intent: { publish_intent: false },
		};
		const release = await lockfile.lock(this.root, { retries: 0 });
		let started = false;
		try {
			const before = await this.invoke(["daemon", "status"]);
			if (/\bdaemon running\b/i.test(before.stdout)) {
				const stopped = await this.invoke(["daemon", "stop"]);
				if (stopped.exitCode !== 0) throw new Error(`Cannot reconfigure an active daemon: ${stopped.stderr}`);
			}
			await writeFile(join(this.nmHome, "config.yaml"), stringify(config), { mode: 0o600 });
			started = true;
			await this.startDaemon();
			const result = await this.invoke(["init"], 120_000);
			if (result.exitCode === 0) {
				const record: Enablement = {
					schemaVersion: 1,
					projectRoot: await realpath(this.options.projectRoot),
					version: NO_MISTAKES_PIN.version,
					agentExecutable: this.options.agent!.executable,
					agentHash: hash(await readFile(this.options.agent!.executable)),
					agentArgs: this.options.agent!.args ?? [],
					agentVersion: this.options.agent!.version,
				};
				await writeFile(join(this.root, "enabled.json"), JSON.stringify(record), { mode: 0o600 });
			}
			if (result.exitCode !== 0 && started) {
				const stopped = await this.invoke(["daemon", "stop"]);
				result.stderr += stopped.exitCode === 0 ? "" : `\nDaemon cleanup failed: ${stopped.stderr}`;
				started = false;
			}
			return interpretNoMistakesResult(result);
		} catch (error) {
			if (started) await this.invoke(["daemon", "stop"]);
			throw error;
		} finally {
			await release();
		}
	}

	async start(approval: { approved: true }): Promise<NoMistakesResult> {
		requireApproval(approval.approved);
		await this.prepare();
		if (!(await this.enabled())) throw new Error("Explicit repository enablement is required");
		const release = await lockfile.lock(this.root, { retries: 0 });
		try {
			return await this.startDaemon();
		} finally {
			await release();
		}
	}

	private async startDaemon(): Promise<NoMistakesResult> {
		const current = await this.invoke(["daemon", "status"]);
		if (/\bdaemon running\b/i.test(current.stdout)) return interpretNoMistakesResult(current);
		const log = await open(join(this.root, "daemon.log"), "a", 0o600);
		let ownedPid: number | undefined;
		try {
			const daemon = spawn(this.executable, ["daemon", "run", "--root", this.nmHome], {
				cwd: this.root,
				env: this.environment(),
				detached: true,
				stdio: ["ignore", log.fd, log.fd],
			});
			const { promise, resolve: started, reject } = Promise.withResolvers<void>();
			daemon.once("spawn", started);
			daemon.once("error", reject);
			await promise;
			daemon.unref();
			ownedPid = daemon.pid;
			await writeFile(join(this.root, "owner.json"), JSON.stringify({ pid: daemon.pid, root: this.nmHome }), {
				mode: 0o600,
			});
			for (let attempt = 0; attempt < 100; attempt++) {
				const status = await this.invoke(["daemon", "status"]);
				if (/\bdaemon running\b/i.test(status.stdout)) return interpretNoMistakesResult(status);
				if (daemon.exitCode !== null)
					throw new Error(`No-mistakes daemon exited. Inspect ${join(this.root, "daemon.log")}`);
				await delay(100);
			}
			throw new Error(`No-mistakes daemon did not become ready. Inspect ${join(this.root, "daemon.log")}`);
		} catch (error) {
			if (ownedPid) {
				try {
					process.kill(-ownedPid, "SIGTERM");
				} catch {
					/* Already exited. */
				}
			}
			throw error;
		} finally {
			await log.close();
		}
	}

	async status(): Promise<NoMistakesResult> {
		return interpretNoMistakesResult(await this.invoke(["axi", "status"]));
	}

	async run(options: {
		intent: string;
		approval?: NoMistakesApproval;
		signal?: AbortSignal;
	}): Promise<NoMistakesResult> {
		requireApproval(options.approval?.network);
		await this.prepare();
		if (!(await this.enabled())) throw new Error("Explicit repository enablement is required");
		const { skipped } = noMistakesRunPolicy(options.intent, options.approval);
		const release = await lockfile.lock(this.root, { retries: 0 });
		const intentFile = join(this.root, `intent-${randomUUID()}.txt`);
		try {
			const daemon = await this.invoke(["daemon", "status"]);
			if (!/\bdaemon running\b/i.test(daemon.stdout))
				throw new Error("Explicit daemon start is required before running validation");
			const home = await this.invoke(["axi"]);
			if (home.exitCode !== 0) return interpretNoMistakesResult(home, skipped);
			const activeId = /^active_run:\s*\n[ \t]+id:\s*("?)([A-Za-z0-9_-]+)\1\s*$/m.exec(home.stdout)?.[2];
			if (activeId) {
				const authorization = await this.runAuthorization(activeId);
				if (
					JSON.stringify(authorization.skipped) !== JSON.stringify(skipped) ||
					authorization.intentHash !== hash(Buffer.from(options.intent))
				) {
					throw new Error(
						"Active gate has different authorization or intent. Inspect it rather than reattaching with new permissions",
					);
				}
			}
			await writeFile(intentFile, options.intent, { mode: 0o600, flag: "wx" });
			// v1.84.0 accepts --intent, not --intent-file.
			const { args } = noMistakesRunPolicy(await readFile(intentFile, "utf8"), options.approval);
			args.push("--launch-nonce", randomUUID(), "--validation-generation", randomUUID());
			const result = await this.invoke(args, 510_000, options.signal);
			const runId =
				/^launch_receipt:\s*\n[ \t]+run_id:\s*("?)([A-Za-z0-9_-]+)\1\s*$/m.exec(result.stdout)?.[2] ??
				/^run:\s*\n[ \t]+id:\s*("?)([A-Za-z0-9_-]+)\1\s*$/m.exec(result.stdout)?.[2] ??
				activeId;
			if (runId) {
				await mkdir(join(this.root, "runs"), { recursive: true, mode: 0o700 });
				await writeFile(
					join(this.root, "runs", `${runId}.json`),
					JSON.stringify({
						skipped,
						intentHash: hash(Buffer.from(options.intent)),
						network: true,
					}),
					{ mode: 0o600 },
				);
			}
			return interpretNoMistakesResult(result, skipped);
		} finally {
			await rm(intentFile, { force: true });
			await release();
		}
	}

	private async runAuthorization(runId: string): Promise<{ skipped: string[]; intentHash: string; network: true }> {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new Error("Invalid no-mistakes run identity");
		try {
			const value: unknown = JSON.parse(await readFile(join(this.root, "runs", `${runId}.json`), "utf8"));
			if (typeof value !== "object" || value === null) throw new Error("Invalid gate authorization record");
			const record = value as Record<string, unknown>;
			if (
				!Array.isArray(record.skipped) ||
				!record.skipped.every((step: unknown) => typeof step === "string") ||
				typeof record.intentHash !== "string" ||
				record.network !== true
			)
				throw new Error("Invalid gate authorization record");
			return { skipped: record.skipped, intentHash: record.intentHash, network: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(
					"Active gate has no recorded raga authorization. Inspect its state before explicit operator recovery",
				);
			}
			throw error;
		}
	}

	async respond(options: {
		action: "approve" | "fix" | "skip";
		approved: true;
		findings?: string[];
		instructions?: string;
		reason?: string;
	}): Promise<NoMistakesResult> {
		requireApproval(options.approved);
		await this.prepare();
		if (!(await this.enabled())) throw new Error("Explicit repository enablement is required");
		if (!["approve", "fix", "skip"].includes(options.action)) throw new Error("Invalid gate action");
		const release = await lockfile.lock(this.root, { retries: 0 });
		try {
			const daemon = await this.invoke(["daemon", "status"]);
			if (!/\bdaemon running\b/i.test(daemon.stdout))
				throw new Error("Explicit daemon start is required before responding");
			const home = await this.invoke(["axi"]);
			const runId = /^active_run:\s*\n[ \t]+id:\s*("?)([A-Za-z0-9_-]+)\1\s*$/m.exec(home.stdout)?.[2];
			if (home.exitCode !== 0 || !runId) throw new Error("No current-branch active gate to respond to");
			const authorization = await this.runAuthorization(runId);
			const args = ["axi", "respond", "--action", options.action, "--wait", "8m"];
			if (options.findings?.length) args.push("--findings", options.findings.join(","));
			if (options.instructions) args.push("--instructions", options.instructions);
			if (options.reason) args.push("--reason", options.reason);
			return interpretNoMistakesResult(await this.invoke(args, 510_000), authorization.skipped);
		} finally {
			await release();
		}
	}

	async stop(approval: { approved: true; force?: true }): Promise<NoMistakesResult> {
		requireApproval(approval.approved);
		await this.prepare();
		const release = await lockfile.lock(this.root, { retries: 0 });
		try {
			const result = await this.invoke(["daemon", "stop", ...(approval.force ? ["--force"] : [])]);
			return { ...interpretNoMistakesResult(result), state: result.exitCode === 0 ? "stopped" : "failed" };
		} finally {
			await release();
		}
	}
}
