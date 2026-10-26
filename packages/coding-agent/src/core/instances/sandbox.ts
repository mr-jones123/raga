/**
 * Linux bubblewrap boundary for worker processes: generated Python, candidate probes, and
 * host-mediated shell/file operations. See docs/INSTANCE-PLAN.md M11.
 *
 * The sandbox starts from an empty root. It sees read-only system runtime directories, a few
 * runtime files from /etc, a private /tmp, and only the policy's roots at their host paths.
 * Nothing from the host environment is inherited. Restricted execution fails closed when
 * bubblewrap is unavailable.
 */
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { getAgentDir } from "../../config.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree } from "../../utils/shell.ts";
import type { CommandResult, SandboxCommand, SandboxPolicy } from "./types.ts";

export class SandboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUnavailableError";
	}
}

export class SandboxPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxPolicyError";
	}
}

export interface SandboxLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
}

/** Reported as `exitCode` when the command was aborted before it was spawned. */
export const NOT_STARTED_EXIT_CODE = -1;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap", "/run/current-system/sw/bin/bwrap"];
/** Mounted read-only (or recreated as the same symlink) when present on the host. */
const RUNTIME_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/nix/store"];
const RUNTIME_ETC = [
	"/etc/ld.so.cache",
	"/etc/ld.so.conf",
	"/etc/ld.so.conf.d",
	"/etc/alternatives",
	"/etc/localtime",
	"/etc/passwd",
	"/etc/group",
	"/etc/nsswitch.conf",
	"/etc/hosts",
	"/etc/ssl",
	"/etc/ca-certificates",
	"/etc/pki",
];
const NETWORK_ETC = ["/etc/resolv.conf", "/etc/gai.conf"];
/** Writable roots may not equal, contain, or sit inside the runtime trees mounted read-only. */
const SYSTEM_ROOTS = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/nix"];
/** No root of any kind may equal, contain, or sit inside these. */
const KERNEL_ROOTS = ["/proc", "/sys", "/dev"];
/** Supervisor administration masked whenever it sits directly under a mounted root. */
const MASKED_NAMES = [".git", ".raga"];
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Mount =
	| { kind: "ro" | "rw"; path: string }
	| { kind: "mask-dir" | "mask-file"; path: string }
	| { kind: "symlink"; path: string; target: string };

interface SandboxPlan {
	workspace: string;
	cwd: string;
	network: boolean;
	env: Record<string, string>;
	/** Policy roots and masks, deepest last so nested mounts layer over their parents. */
	mounts: Mount[];
	/** Host paths visible inside the sandbox, used to check an absolute command is reachable. */
	visibleRoots: string[];
}

function isWithin(path: string, root: string): boolean {
	if (path === root) return true;
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function overlaps(a: string, b: string): boolean {
	return isWithin(a, b) || isWithin(b, a);
}

function depth(path: string): number {
	return path === "/" ? 0 : path.split(sep).length - 1;
}

function lstatOrUndefined(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function credentialPaths(): string[] {
	const home = homedir();
	return [
		...[
			".ssh",
			".gnupg",
			".aws",
			".azure",
			".kube",
			".docker",
			".netrc",
			".git-credentials",
			".npmrc",
			".pypirc",
			".config/gcloud",
			".config/gh",
			".password-store",
		].map((name) => join(home, name)),
		join(getAgentDir(), "auth.json"),
	];
}

function canonicalRoot(path: string, label: string): { path: string; stats: Stats } {
	if (!isAbsolute(path)) throw new SandboxPolicyError(`${label} must be an absolute path: ${path}`);
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		throw new SandboxPolicyError(`${label} does not exist: ${path}`);
	}
	if (real !== path) {
		throw new SandboxPolicyError(`${label} must be a canonical path without symlinks: ${path} resolves to ${real}`);
	}
	return { path, stats: lstatSync(path) };
}

function checkRootSafety(root: string, label: string): void {
	const home = homedir();
	if (root === "/" || isWithin(home, root)) {
		throw new SandboxPolicyError(`${label} ${root} would expose the whole home or root directory`);
	}
	for (const kernel of KERNEL_ROOTS) {
		if (overlaps(root, kernel)) throw new SandboxPolicyError(`${label} ${root} overlaps ${kernel}`);
	}
	for (const credential of credentialPaths()) {
		if (overlaps(root, credential))
			throw new SandboxPolicyError(`${label} ${root} overlaps credential path ${credential}`);
	}
}

function buildEnv(policyEnv: Record<string, string> | undefined): Record<string, string> {
	const env: Record<string, string> = { PATH: DEFAULT_PATH, HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8" };
	for (const [key, value] of Object.entries(policyEnv ?? {})) {
		if (!ENV_KEY.test(key)) throw new SandboxPolicyError(`Invalid environment variable name: ${key}`);
		if (value.includes("\0")) throw new SandboxPolicyError(`Environment variable ${key} contains a NUL byte`);
		env[key] = value;
	}
	return env;
}

/** Validates a policy against the host filesystem and resolves the exact mount layout. */
function planSandbox(policy: SandboxPolicy): SandboxPlan {
	const workspace = canonicalRoot(policy.workspace, "workspace");
	if (!workspace.stats.isDirectory())
		throw new SandboxPolicyError(`workspace is not a directory: ${policy.workspace}`);

	const readOnly = [...new Set(policy.readOnly)].map((path) => canonicalRoot(path, "readOnly root").path);
	const workspaceReadOnly = policy.workspaceReadOnly === true;
	const writable = [...new Set(workspaceReadOnly ? policy.writable : [workspace.path, ...policy.writable])].map(
		(path) => {
			const root = canonicalRoot(path, "writable root");
			if (!root.stats.isDirectory()) throw new SandboxPolicyError(`writable root is not a directory: ${path}`);
			return root.path;
		},
	);
	if (workspaceReadOnly && writable.includes(workspace.path)) {
		throw new SandboxPolicyError(`workspace ${workspace.path} is read-only but also listed as writable`);
	}

	if (workspaceReadOnly) checkRootSafety(workspace.path, "workspace");
	for (const root of readOnly) checkRootSafety(root, "readOnly root");
	for (const root of writable) {
		checkRootSafety(root, "writable root");
		for (const system of SYSTEM_ROOTS) {
			if (overlaps(root, system))
				throw new SandboxPolicyError(`writable root ${root} overlaps system root ${system}`);
		}
		for (const protectedRoot of readOnly) {
			if (isWithin(root, protectedRoot)) {
				throw new SandboxPolicyError(`writable root ${root} is inside read-only root ${protectedRoot}`);
			}
		}
		if (root.split(sep).includes(".git")) {
			throw new SandboxPolicyError(`writable root ${root} is inside Git administration`);
		}
	}

	const roots: Mount[] = [
		...(workspaceReadOnly && !readOnly.includes(workspace.path)
			? [{ kind: "ro" as const, path: workspace.path }]
			: []),
		...readOnly.filter((path) => !writable.includes(path)).map((path): Mount => ({ kind: "ro", path })),
		...writable.map((path): Mount => ({ kind: "rw", path })),
	];
	const explicit = new Set(roots.map((mount) => mount.path));
	const masks: Mount[] = [];
	for (const root of roots) {
		if (!lstatSync(root.path).isDirectory()) continue;
		for (const name of MASKED_NAMES) {
			const path = join(root.path, name);
			if (explicit.has(path)) continue;
			const stats = lstatOrUndefined(path);
			if (!stats) continue;
			if (stats.isSymbolicLink())
				throw new SandboxPolicyError(`Refusing to mount ${root.path}: ${path} is a symlink`);
			masks.push({ kind: stats.isDirectory() ? "mask-dir" : "mask-file", path });
		}
	}
	const mounts = [...roots, ...masks].sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));

	let cwd = workspace.path;
	if (policy.cwd !== undefined) {
		cwd = canonicalRoot(policy.cwd, "cwd").path;
		if (!roots.some((root) => isWithin(cwd, root.path))) {
			throw new SandboxPolicyError(`cwd ${cwd} is not inside a sandbox root`);
		}
	}

	return {
		workspace: workspace.path,
		cwd,
		network: policy.network === true,
		env: buildEnv(policy.env),
		mounts,
		visibleRoots: [
			...RUNTIME_ROOTS.filter((path) => lstatOrUndefined(path)).flatMap((path) => [path, realpathSync(path)]),
			...roots.map((root) => root.path),
		],
	};
}

function runtimeMounts(network: boolean): Mount[] {
	const mounts: Mount[] = [];
	for (const path of RUNTIME_ROOTS) {
		const stats = lstatOrUndefined(path);
		if (stats?.isSymbolicLink()) mounts.push({ kind: "symlink", path, target: readlinkSync(path) });
		else if (stats?.isDirectory()) mounts.push({ kind: "ro", path });
	}
	for (const path of network ? [...RUNTIME_ETC, ...NETWORK_ETC] : RUNTIME_ETC) {
		if (lstatOrUndefined(path)) mounts.push({ kind: "ro", path });
	}
	return mounts;
}

function mountArgs(mount: Mount): string[] {
	switch (mount.kind) {
		case "ro":
			// Source resolves on the host (e.g. /etc/resolv.conf -> /run/...); destination keeps the host path.
			return ["--ro-bind", realpathSync(mount.path), mount.path];
		case "rw":
			return ["--bind", mount.path, mount.path];
		case "mask-dir":
			return ["--tmpfs", mount.path];
		case "mask-file":
			return ["--ro-bind", "/dev/null", mount.path];
		case "symlink":
			return ["--symlink", mount.target, mount.path];
	}
}

function bwrapArgs(plan: SandboxPlan): string[] {
	const args = [
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		...(plan.network ? ["--share-net"] : []),
		...runtimeMounts(plan.network).flatMap(mountArgs),
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		...plan.mounts.flatMap(mountArgs),
	];
	// Masks start as writable tmpfs so bwrap can create mount points for nested approved roots.
	for (const mount of plan.mounts) {
		if (mount.kind === "mask-dir") args.push("--remount-ro", mount.path);
	}
	args.push("--chdir", plan.cwd);
	return args;
}

function checkCommandVisible(command: string, plan: SandboxPlan): void {
	if (command === "") throw new SandboxPolicyError("command must not be empty");
	if (!isAbsolute(command)) return;
	let real: string;
	try {
		real = realpathSync(command);
	} catch {
		throw new SandboxPolicyError(`command does not exist: ${command}`);
	}
	const reachable = (path: string) => plan.visibleRoots.some((root) => isWithin(path, root));
	const masked = (path: string) =>
		plan.mounts.some(
			(mask) =>
				(mask.kind === "mask-dir" || mask.kind === "mask-file") &&
				isWithin(path, mask.path) &&
				!plan.mounts.some(
					(root) =>
						(root.kind === "ro" || root.kind === "rw") &&
						root.path !== mask.path &&
						isWithin(root.path, mask.path) &&
						isWithin(path, root.path),
				),
		);
	if (!reachable(command) || !reachable(real) || masked(command) || masked(real)) {
		throw new SandboxPolicyError(`command ${command} (${real}) is not visible inside the sandbox`);
	}
}

let verifiedBwrap: string | undefined;
let availability: Promise<{ available: boolean; reason?: string }> | undefined;

function findBwrap(): string | undefined {
	for (const candidate of BWRAP_CANDIDATES) {
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next trusted location.
		}
	}
	return undefined;
}

/**
 * Build a bubblewrap invocation for a long-lived process (the RLM kernel). Spawn the result with
 * `detached: true` and kill its process group; the returned env is complete. Throws
 * SandboxUnavailableError unless checkSandbox() has confirmed a working backend.
 */
export function sandboxLaunch(command: string, args: string[], policy: SandboxPolicy): SandboxLaunch {
	if (verifiedBwrap === undefined) {
		throw new SandboxUnavailableError("Sandbox backend not verified; call checkSandbox() and require available");
	}
	const plan = planSandbox(policy);
	checkCommandVisible(command, plan);
	return {
		command: verifiedBwrap,
		args: [...bwrapArgs(plan), "--", command, ...args],
		env: plan.env,
		cwd: plan.workspace,
	};
}

/** Probes bubblewrap once per process with a real sandboxed run. Failure is cached: restricted execution stays closed. */
export function checkSandbox(): Promise<{ available: boolean; reason?: string }> {
	availability ??= probeSandbox();
	return availability;
}

async function probeSandbox(): Promise<{ available: boolean; reason?: string }> {
	if (process.platform !== "linux") {
		return { available: false, reason: `bubblewrap sandbox requires Linux (platform is ${process.platform})` };
	}
	const bwrap = findBwrap();
	if (!bwrap) return { available: false, reason: `bubblewrap not found in ${BWRAP_CANDIDATES.join(", ")}` };
	const probeRoot = await realpath(await mkdtemp(join(tmpdir(), "raga-sandbox-probe-")));
	try {
		const plan = planSandbox({ workspace: probeRoot, readOnly: [], writable: [] });
		const result = await runBounded(
			{
				command: bwrap,
				args: [...bwrapArgs(plan), "--", "sh", "-c", "echo sandbox-ok"],
				env: plan.env,
				cwd: probeRoot,
			},
			{ timeoutMs: 15_000, maxOutputBytes: 4096 },
		);
		if (result.exitCode !== 0 || result.stdout.trim() !== "sandbox-ok") {
			return {
				available: false,
				reason: `bubblewrap probe failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
			};
		}
		verifiedBwrap = bwrap;
		return { available: true };
	} catch (error) {
		return {
			available: false,
			reason: `bubblewrap probe failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		await rm(probeRoot, { recursive: true, force: true });
	}
}

/** Runs one command inside the sandbox with time, cancellation, and output bounds. */
export async function sandboxCommand(command: SandboxCommand): Promise<CommandResult> {
	const status = await checkSandbox();
	if (!status.available) throw new SandboxUnavailableError(status.reason ?? "sandbox unavailable");
	if (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0) {
		throw new SandboxPolicyError(`timeoutMs must be a positive number, got ${command.timeoutMs}`);
	}
	const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) {
		throw new SandboxPolicyError(`maxOutputBytes must be a non-negative integer, got ${maxOutputBytes}`);
	}
	const launch = sandboxLaunch(command.command, command.args, command.policy);
	if (command.signal?.aborted) {
		return { exitCode: NOT_STARTED_EXIT_CODE, stdout: "", stderr: "", timedOut: false, aborted: true };
	}
	return runBounded(launch, { timeoutMs: command.timeoutMs, maxOutputBytes, signal: command.signal });
}

class BoundedOutput {
	private readonly chunks: Buffer[] = [];
	private readonly limit: number;
	private size = 0;
	private omitted = 0;

	constructor(limit: number) {
		this.limit = limit;
	}

	push(chunk: Buffer): void {
		const room = this.limit - this.size;
		if (room > 0) {
			const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
			this.chunks.push(kept);
			this.size += kept.length;
		}
		this.omitted += Math.max(0, chunk.length - Math.max(0, room));
	}

	text(): string {
		const text = Buffer.concat(this.chunks).toString("utf8");
		return this.omitted > 0 ? `${text}\n[output truncated: ${this.omitted} bytes omitted]\n` : text;
	}
}

async function runBounded(
	launch: SandboxLaunch,
	options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<CommandResult> {
	const child = spawn(launch.command, launch.args, {
		cwd: launch.cwd,
		env: launch.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const stdout = new BoundedOutput(options.maxOutputBytes);
	const stderr = new BoundedOutput(options.maxOutputBytes);
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

	let timedOut = false;
	let aborted = false;
	const kill = () => {
		if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, options.timeoutMs);
	const onAbort = () => {
		aborted = true;
		kill();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const code = await waitForChildProcess(child);
		const signal = child.signalCode;
		const exitCode = code ?? (signal ? 128 + osConstants.signals[signal] : NOT_STARTED_EXIT_CODE);
		return { exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut, aborted };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
