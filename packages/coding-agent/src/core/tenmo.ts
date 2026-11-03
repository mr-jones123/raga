import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, PROJECT_CONFIG_DIR_NAME } from "../config.ts";
import { agentCommand } from "./agent-command.ts";

/**
 * Tenmo tracks every running session of this CLI across project folders. Each process writes one record,
 * `<agent dir>/tenmo/<pid>.json`, while it runs and deletes it on exit. Readers drop records whose process
 * is gone, so a crash leaves nothing behind for long.
 */

export type TenmoStatus = "working" | "idle" | "waiting";

export interface TenmoRecord {
	pid: number;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	name?: string;
	mode: string;
	model?: string;
	status: TenmoStatus;
	/** The first user message of the session: what it was started for. */
	intent?: string;
	/** The latest user message. */
	lastPrompt?: string;
	/** What the session is doing now: the running tool, or the start of its last reply. */
	activity?: string;
	/** tmux pane (`$TMUX_PANE`) and server socket the session runs in, when inside tmux. */
	tmux?: { pane: string; socket?: string };
	startedAt: number;
	updatedAt: number;
}

export interface TenmoSpawnRequest {
	cwd: string;
	prompt: string;
}

export interface TenmoSpawnResult {
	/** tmux target of the new window, such as `%12`. */
	pane: string;
	/** Set when tenmo created a detached tmux session because the caller was not inside tmux. */
	attach?: string;
}

const TENMO_TMUX_SESSION = "tenmo";
const COMMAND_TIMEOUT_MS = 5000;

export function tenmoDir(): string {
	return join(getAgentDir(), "tenmo");
}

function recordPath(pid: number): string {
	return join(tenmoDir(), `${pid}.json`);
}

export function writeTenmoRecord(record: TenmoRecord): void {
	const dir = tenmoDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = recordPath(record.pid);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

export function removeTenmoRecord(pid: number): void {
	rmSync(recordPath(pid), { force: true });
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isRecord(value: unknown): value is TenmoRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<TenmoRecord>;
	return (
		typeof record.pid === "number" &&
		typeof record.sessionId === "string" &&
		typeof record.cwd === "string" &&
		typeof record.startedAt === "number"
	);
}

/** Live sessions, newest activity first. Removes records of processes that no longer exist. */
export function listTenmoSessions(): TenmoRecord[] {
	const dir = tenmoDir();
	if (!existsSync(dir)) return [];
	const records: TenmoRecord[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const path = join(dir, file);
		let record: unknown;
		try {
			record = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			// A torn or foreign file. Writers rename atomically, so only drop it once it is old.
			const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
			if (Date.now() - mtime > 60_000) rmSync(path, { force: true });
			continue;
		}
		if (!isRecord(record) || !pidAlive(record.pid)) {
			rmSync(path, { force: true });
			continue;
		}
		records.push(record);
	}
	return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

function run(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolvePromise({ ok: !error, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
		});
	});
}

function field(value: unknown, ...path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

export function tenmoAgo(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86_400)}d ago`;
}

export function tenmoPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Read `/tenmo` arguments as a spawn request. The project is the first `@path` (or `@"path with spaces"`).
 * A leading "make/create/spawn/start/open ... at @path" phrase is dropped from the prompt, so
 * `make a raga session at @app. it needs to do X` sends `it needs to do X`.
 */
export function parseTenmoSpawn(input: string, cwd: string): TenmoSpawnRequest | { error: string } {
	const match = /@(?:"([^"]+)"|(\S+))/.exec(input);
	if (!match) return { error: "Name the project folder with @path, for example /tenmo @../app fix the login bug" };
	const raw = (match[1] ?? match[2]).replace(/[.,:;!?]+$/, "");
	const target = expandHome(raw);
	const projectCwd = isAbsolute(target) ? target : resolve(cwd, target);
	if (!existsSync(projectCwd) || !statSync(projectCwd).isDirectory()) return { error: `Not a folder: ${projectCwd}` };
	const before = input.slice(0, match.index).trim();
	const after = input
		.slice(match.index + match[0].length)
		.replace(/^[.,:;!?]+/, "")
		.trim();
	const lead = /^(?:\/?tenmo\s+)?(?:please\s+)?(?:make|create|spawn|start|open|run)\b.*\b(?:at|in|on|for)$/i;
	const prompt = (lead.test(before) || !before ? after : `${before} ${after}`).trim();
	if (!prompt) return { error: "Add the task after the folder, for example /tenmo @../app fix the login bug" };
	return { cwd: projectCwd, prompt };
}

function appendProjectLog(cwd: string, entry: { spawnedAt: string; prompt: string; pane: string }): void {
	const dir = join(cwd, PROJECT_CONFIG_DIR_NAME);
	const path = join(dir, "tenmo.json");
	let log: { spawns: unknown[] } = { spawns: [] };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (Array.isArray(field(parsed, "spawns"))) log = parsed as { spawns: unknown[] };
	} catch {
		// Missing or unreadable: start a new log.
	}
	log.spawns.push(entry);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(log, null, "\t")}\n`);
}

/**
 * Start a session in a new tmux window with `prompt` as its first message. Inside tmux the window opens in
 * the current tmux session without taking focus; outside tmux it goes to a detached `tenmo` tmux session.
 */
export async function spawnTenmoSession(request: TenmoSpawnRequest): Promise<TenmoSpawnResult> {
	const agent = agentCommand();
	const command = [agent.executable, ...agent.args, "--", request.prompt];
	const name = basename(request.cwd) || "raga";
	const format = ["-P", "-F", "#{pane_id}"];
	let result: Awaited<ReturnType<typeof run>>;
	let attach: string | undefined;
	if (process.env.TMUX) {
		result = await run("tmux", ["new-window", "-d", ...format, "-c", request.cwd, "-n", name, ...command]);
	} else if ((await run("tmux", ["has-session", "-t", `=${TENMO_TMUX_SESSION}`])).ok) {
		result = await run("tmux", [
			"new-window",
			"-d",
			...format,
			"-t",
			`=${TENMO_TMUX_SESSION}:`,
			"-c",
			request.cwd,
			"-n",
			name,
			...command,
		]);
		attach = `tmux attach -t ${TENMO_TMUX_SESSION}`;
	} else {
		result = await run("tmux", [
			"new-session",
			"-d",
			...format,
			"-s",
			TENMO_TMUX_SESSION,
			"-c",
			request.cwd,
			"-n",
			name,
			...command,
		]);
		attach = `tmux attach -t ${TENMO_TMUX_SESSION}`;
	}
	if (!result.ok) {
		const reason = result.stderr.includes("ENOENT") ? "tmux is not installed" : result.stderr.trim();
		throw new Error(`Could not open a tmux window: ${reason}`);
	}
	const pane = result.stdout.trim();
	appendProjectLog(request.cwd, { spawnedAt: new Date().toISOString(), prompt: request.prompt, pane });
	return { pane, attach };
}

/** Bring a session's tmux pane to the front of the calling tmux client. */
export async function focusTenmoSession(record: TenmoRecord): Promise<void> {
	if (!record.tmux) throw new Error("That session is not running inside tmux.");
	if (!process.env.TMUX) throw new Error(`Run inside tmux to jump to it, or attach to the pane ${record.tmux.pane}.`);
	const socket = record.tmux.socket ? ["-S", record.tmux.socket] : [];
	const result = await run("tmux", [...socket, "switch-client", "-t", record.tmux.pane]);
	if (!result.ok) throw new Error(`tmux could not switch to ${record.tmux.pane}: ${result.stderr.trim()}`);
}

/** The tmux pane this process runs in, from tmux's own environment variables. */
export function currentTmuxPane(): TenmoRecord["tmux"] {
	const pane = process.env.TMUX_PANE;
	if (!pane) return undefined;
	const socket = process.env.TMUX?.split(",")[0];
	return socket ? { pane, socket } : { pane };
}

const EXIT_WAIT_MS = 5000;

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (pidAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	return true;
}

function sessionHeader(path: string): { id?: string; parentSession?: string } | undefined {
	try {
		const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
		const header: unknown = JSON.parse(firstLine);
		return { id: text(field(header, "id")), parentSession: text(field(header, "parentSession")) };
	} catch {
		return undefined;
	}
}

/**
 * A session file and every session in its folder that descends from it through `parentSession`: subagent
 * sessions and forks. Files in `keep` (sessions still running elsewhere) and their descendants are left out.
 */
export function sessionTree(sessionFile: string, keep: ReadonlySet<string> = new Set()): string[] {
	const dir = dirname(sessionFile);
	const children = new Map<string, string[]>();
	for (const name of existsSync(dir) ? readdirSync(dir) : []) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		const parent = sessionHeader(path)?.parentSession;
		if (!parent) continue;
		children.set(parent, [...(children.get(parent) ?? []), path]);
	}
	const tree: string[] = [];
	const visit = (path: string) => {
		if (keep.has(path) || tree.includes(path)) return;
		tree.push(path);
		for (const child of children.get(path) ?? []) visit(child);
	};
	visit(sessionFile);
	return tree;
}

/**
 * End a session and delete it: close its tmux pane (or signal it outside tmux), wait for the process to
 * exit, then remove its session file, its subagent sessions and forks, and their Python kernel snapshots
 * (`<id>.rlm`). Returns the deleted paths.
 */
export async function deleteTenmoSession(record: TenmoRecord): Promise<string[]> {
	if (record.pid === process.pid) throw new Error("This is the session you are in; quit it instead.");
	if (record.tmux) {
		const socket = record.tmux.socket ? ["-S", record.tmux.socket] : [];
		await run("tmux", [...socket, "kill-pane", "-t", record.tmux.pane]);
	}
	if (pidAlive(record.pid)) process.kill(record.pid, "SIGTERM");
	if (!(await waitForExit(record.pid, EXIT_WAIT_MS))) {
		process.kill(record.pid, "SIGKILL");
		if (!(await waitForExit(record.pid, 1000))) throw new Error(`Process ${record.pid} did not exit.`);
	}
	removeTenmoRecord(record.pid);
	if (!record.sessionFile) return [];
	const live = new Set(listTenmoSessions().flatMap((session) => (session.sessionFile ? [session.sessionFile] : [])));
	const deleted: string[] = [];
	for (const path of sessionTree(record.sessionFile, live)) {
		const id = sessionHeader(path)?.id;
		rmSync(path, { force: true });
		deleted.push(path);
		if (id) {
			const kernel = join(dirname(path), `${id}.rlm`);
			if (existsSync(kernel)) {
				rmSync(kernel, { recursive: true, force: true });
				deleted.push(kernel);
			}
		}
	}
	const dir = dirname(record.sessionFile);
	if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
	return deleted;
}
