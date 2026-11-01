/**
 * Optional Rex view of a Raga session's subagents. Each Raga session owns one Rex session; each openable
 * subagent gets one Rex pane running `agent-attach`, which connects to the live child session itself.
 * Rex is never installed or started from here.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { agentCommand } from "../../../core/agent-command.ts";
import type { ChildAgentInfo } from "../../../core/rlm/child-agents.ts";

export interface RexAvailability {
	status: "ready" | "missing" | "unavailable";
	message: string;
}
export type RexExecutor = (args: string[]) => Promise<string>;

const LABEL_LIMIT = 128;
const MESSAGE_LIMIT = 500;
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
/** Rex reports a missing session as `... not found (status=404 code=session_not_found)`. */
const SESSION_GONE = /\bcode=session_not_found\b|"code"\s*:\s*"session_not_found"/;
/** Calls without side effects; everything else gets more time so Rex is not killed halfway through a change. */
const READ_ONLY = new Set(["server.status", "session.view"]);

/** Replace terminal controls and bidi overrides with spaces, collapse whitespace, and cap the length. */
function sanitizeText(text: string, limit: number): string {
	const clean = text.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
	return Array.from(clean).slice(0, limit).join("");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const execute: RexExecutor = (args) => {
	const command = args[0] === "api" ? (args[2] ?? "api") : (args[0] ?? "");
	const readOnly = READ_ONLY.has(command);
	return new Promise((resolve, reject) => {
		execFile(
			"rex",
			["--autostart=false", readOnly ? "--timeout=3s" : "--timeout=10s", "--color=never", ...args],
			{ timeout: readOnly ? 5000 : 15_000, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				if (!error) {
					resolve(stdout);
					return;
				}
				// stderr is untrusted and can be large; it may echo session content.
				const detail = String(stderr).trim() || (error.killed ? "timed out" : String(error.code ?? error.signal));
				const message = `rex ${sanitizeText(command, 64)} failed: ${sanitizeText(detail, MESSAGE_LIMIT)}`;
				reject(Object.assign(error, { message }));
			},
		);
	});
};

export async function inspectRex(executor: RexExecutor = execute): Promise<RexAvailability> {
	try {
		await executor(["api", "call", "server.status"]);
		return { status: "ready", message: "Rex server is ready." };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return {
				status: "missing",
				message: "Rex is not installed or not on PATH. Install Rex yourself, or use the TUI dashboard.",
			};
		}
		return {
			status: "unavailable",
			message: `Cannot reach the Rex server. Start Rex explicitly, then retry. ${sanitizeText(errorText(error), MESSAGE_LIMIT)}`,
		};
	}
}

export interface RexWorkspaceOptions {
	rootSessionId: string;
	title: string;
	/** Socket of this process's agent server; panes run `agent-attach --socket <socketPath>`. */
	socketPath: string;
	cwd: string;
}
export interface RexWorkspace {
	sessionId: string;
	sessionLabel: string;
	/**
	 * Create missing panes for openable agents and refresh labels. Panes the user closed stay closed unless
	 * `reopenClosed`. Panes of agents that are gone or no longer openable are labeled closed and released.
	 */
	sync(agents: ChildAgentInfo[], options?: { reopenClosed?: boolean }): Promise<void>;
	/** Best-effort: ask connected Rex apps to show this session. */
	reveal(): Promise<void>;
}
export interface RexWorkspaces {
	(options: RexWorkspaceOptions): Promise<RexWorkspace>;
	/** Forget the workspace of a root session that ended. Its Rex session and panes stay in Rex. */
	dispose(rootSessionId: string): void;
}

/** Owned panes per window before a new window is started. */
const WINDOW_PANE_LIMIT = 9;

type Rect = [number, number, number, number];
interface Pane {
	blockId: string;
	/** Empty until a view shows the pane's window. */
	windowId: string;
	label: string;
	/** Agent name for the closed label after the agent leaves the registry. */
	name: string;
}
interface View {
	/** Window of every block in the session, including blocks the user created. */
	blockWindows: Map<string, string>;
	blockLabels: Map<string, string>;
	windows: Set<string>;
	rects: Map<string, Rect>;
}

const sanitizeLabel = (text: string): string => sanitizeText(text, LABEL_LIMIT);

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	// 999_950 would round to "1000.0k".
	if (tokens < 999_950) return `${(tokens / 1000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function paneLabel(agent: ChildAgentInfo): string {
	const status = `${agent.busy ? "running" : agent.status}${agent.parked ? " · parked" : ""}`;
	const model = agent.model.slice(agent.model.indexOf("/") + 1);
	const cost = agent.usage.cost.toFixed(agent.usage.cost >= 1 ? 2 : 3);
	return sanitizeLabel(
		`${agent.name} · ${status} · ${model} · ${formatTokens(agent.usage.totalTokens)} tok · $${cost}`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.parse errors quote the input; Rex output is untrusted, so report a fixed message instead. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Rex returned invalid JSON.");
	}
}

function parseRect(value: unknown): Rect | undefined {
	if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === "number")) return undefined;
	return [value[0], value[1], value[2], value[3]];
}

function collectRects(node: unknown, rects: Map<string, Rect>, depth = 0): void {
	if (!isRecord(node) || depth > 64) return;
	const rect = parseRect(node.rect);
	if (typeof node.block_id === "string" && rect) rects.set(node.block_id, rect);
	if (isRecord(node.split)) {
		collectRects(node.split.before, rects, depth + 1);
		collectRects(node.split.after, rects, depth + 1);
	}
}

function parseView(text: string, sessionId: string): View {
	const raw = parseJson(text);
	if (!isRecord(raw) || (raw.session_id !== undefined && raw.session_id !== sessionId)) {
		throw new Error("Rex returned an invalid session view.");
	}
	// A new, empty session has no `windows` key.
	if (raw.windows !== undefined && raw.windows !== null && !Array.isArray(raw.windows)) {
		throw new Error("Rex returned an invalid session view.");
	}
	const view: View = { blockWindows: new Map(), blockLabels: new Map(), windows: new Set(), rects: new Map() };
	for (const window of (raw.windows ?? []) as unknown[]) {
		if (!isRecord(window) || typeof window.window_id !== "string") continue;
		view.windows.add(window.window_id);
		for (const layer of Array.isArray(window.layers) ? window.layers : []) {
			if (!isRecord(layer)) continue;
			collectRects(layer.layout, view.rects);
			for (const block of Array.isArray(layer.blocks) ? layer.blocks : []) {
				if (!isRecord(block) || typeof block.block_id !== "string") continue;
				view.blockWindows.set(block.block_id, window.window_id);
				if (typeof block.label === "string") view.blockLabels.set(block.block_id, block.label);
			}
		}
	}
	return view;
}

class OwnedRexWorkspace implements RexWorkspace {
	readonly sessionId: string;
	readonly sessionLabel: string;
	options: RexWorkspaceOptions;
	/** `session.view` reported the session missing; only an explicit open recreates it. */
	gone = false;
	/** The root session ended; calls do nothing. */
	disposed = false;
	private readonly executor: RexExecutor;
	private queue: Promise<void> = Promise.resolve();
	private readonly panes = new Map<string, Pane>();
	/** Agents whose panes the user closed. */
	private readonly closed = new Set<string>();
	/** Windows that hold owned panes, oldest first. */
	private windows: string[] = [];
	private readonly windowLabels = new Map<string, string>();

	constructor(executor: RexExecutor, options: RexWorkspaceOptions, sessionId: string, sessionLabel: string) {
		this.executor = executor;
		this.options = { ...options };
		this.sessionId = sessionId;
		this.sessionLabel = sessionLabel;
	}

	sync(agents: ChildAgentInfo[], options: { reopenClosed?: boolean } = {}): Promise<void> {
		return this.enqueue(async () => {
			if (this.disposed) return;
			this.assertPresent();
			// Every sync starts from a fresh view, so a failed change is re-checked against Rex next time.
			await this.reconcile(agents, options.reopenClosed === true);
		});
	}

	reveal(): Promise<void> {
		return this.enqueue(async () => {
			if (this.gone || this.disposed) return;
			try {
				// Fails when zero or several Rex apps are connected; the session is still usable.
				await this.executor(["do", "session.select", `session_id=${this.sessionId}`]);
			} catch {}
		});
	}

	/** Confirm the session still exists. Marks it gone when Rex reports it missing. */
	check(): Promise<void> {
		return this.enqueue(async () => {
			this.assertPresent();
			await this.view();
		});
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.queue.then(task);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private assertPresent(): void {
		if (this.gone)
			throw new Error("The Rex session for this Raga session was closed. Choose Rex again to recreate it.");
	}

	private api(method: string, params: Record<string, string>): Promise<string> {
		return this.executor(["api", "call", method, JSON.stringify(params)]);
	}

	/** The only call that can mark the session gone: other calls also fail when one block or window is gone. */
	private async view(): Promise<View> {
		let text: string;
		try {
			text = await this.api("session.view", { session_id: this.sessionId });
		} catch (error) {
			if (SESSION_GONE.test(errorText(error))) this.gone = true;
			throw error;
		}
		return parseView(text, this.sessionId);
	}

	private async freshView(): Promise<View | undefined> {
		try {
			return await this.view();
		} catch {
			return undefined;
		}
	}

	private async setBlockLabel(pane: Pane, label: string): Promise<void> {
		if (pane.label === label) return;
		await this.api("session.set_block_label", { session_id: this.sessionId, block_id: pane.blockId, label });
		pane.label = label;
	}

	private async reconcile(agents: ChildAgentInfo[], reopenClosed: boolean): Promise<void> {
		const view = await this.view();
		const byId = new Map(agents.map((agent) => [agent.id, agent]));
		this.windows = this.windows.filter((windowId) => view.windows.has(windowId));
		for (const [agentId, pane] of this.panes) {
			const windowId = view.blockWindows.get(pane.blockId);
			if (!windowId) {
				this.panes.delete(agentId);
				if (byId.has(agentId)) this.closed.add(agentId);
				continue;
			}
			pane.windowId = windowId;
			// A pane recorded before its window was known.
			if (!this.windows.includes(windowId)) this.windows.push(windowId);
		}
		for (const agentId of this.closed) if (!byId.has(agentId)) this.closed.delete(agentId);
		for (const windowId of this.windowLabels.keys()) {
			if (!view.windows.has(windowId)) this.windowLabels.delete(windowId);
		}
		// Release panes whose agent left the registry or can no longer be opened; their attach has no target.
		for (const [agentId, pane] of this.panes) {
			const agent = byId.get(agentId);
			if (agent?.openable) continue;
			await this.setBlockLabel(pane, sanitizeLabel(`${agent?.name ?? pane.name} · closed`));
			this.panes.delete(agentId);
			if (agent) this.closed.add(agentId);
		}
		for (const agent of agents) {
			if (!agent.openable) continue;
			const label = paneLabel(agent);
			const pane = this.panes.get(agent.id);
			if (pane) {
				await this.setBlockLabel(pane, label);
				continue;
			}
			if (this.closed.has(agent.id) && !reopenClosed) continue;
			await this.setBlockLabel(await this.openPane(agent, view), label);
			this.closed.delete(agent.id);
		}
		for (const windowId of this.windows) {
			const count = this.ownedIn(windowId).length;
			const label = sanitizeLabel(`raga · ${this.options.title} · ${count} agents`);
			if (this.windowLabels.get(windowId) === label) continue;
			await this.api("session.set_window_label", { session_id: this.sessionId, window_id: windowId, label });
			this.windowLabels.set(windowId, label);
		}
	}

	private ownedIn(windowId: string): Pane[] {
		return [...this.panes.values()].filter((pane) => pane.windowId === windowId);
	}

	/**
	 * Split the largest owned pane of the newest owned window; start a new window when it is full or gone.
	 * The pane is recorded as soon as its block is known, under a per-attempt label with a random nonce. When
	 * `rex run` fails, a block carrying that label is adopted, so a retry never opens a second pane.
	 */
	private async openPane(agent: ChildAgentInfo, view: View): Promise<Pane> {
		const windowId = this.windows.at(-1);
		const owned = windowId ? this.ownedIn(windowId) : [];
		let anchor: Pane | undefined;
		let anchorRect: Rect | undefined;
		if (owned.length > 0 && owned.length < WINDOW_PANE_LIMIT) {
			let best = -1;
			for (const pane of owned) {
				const rect = view.rects.get(pane.blockId);
				const area = rect ? rect[2] * rect[3] : 0;
				if (area > best) {
					best = area;
					anchor = pane;
					anchorRect = rect;
				}
			}
		}
		const right = !anchorRect || anchorRect[2] >= anchorRect[3];
		const nonce = randomBytes(4).toString("hex");
		const name = sanitizeLabel(agent.name);
		const attemptLabel = `${Array.from(name)
			.slice(0, LABEL_LIMIT - nonce.length - 3)
			.join("")} · ${nonce}`;
		const { cwd, socketPath } = this.options;
		const cli = agentCommand();
		const args = ["run", "--session", this.sessionId, "--cwd", cwd, "--shell=none", "--focus=false"];
		args.push("--label", attemptLabel, "--json");
		if (anchor) args.push("--block", anchor.blockId, right ? "--split=right" : "--split=below");
		args.push("--", cli.executable, ...cli.args, "agent-attach", "--socket", socketPath, "--agent", agent.id);

		let blockId: string;
		let paneWindow: string | undefined;
		try {
			const result = parseJson(await this.executor(args));
			const id = isRecord(result) && Array.isArray(result.block_ids) ? result.block_ids[0] : undefined;
			if (typeof id !== "string") throw new Error("Rex returned no pane ID.");
			blockId = id;
			// Rex reports only the anchor for splits; the new pane is in the anchor's window.
			if (anchor) paneWindow = anchor.windowId;
			else if (isRecord(result) && typeof result.window_id === "string") paneWindow = result.window_id;
			else paneWindow = (await this.freshView())?.blockWindows.get(blockId);
		} catch (error) {
			const fresh = await this.freshView();
			const owned = new Set([...this.panes.values()].map((pane) => pane.blockId));
			const matches = fresh
				? [...fresh.blockLabels].filter(([id, label]) => label === attemptLabel && !owned.has(id))
				: [];
			if (!fresh || matches.length !== 1) throw error;
			blockId = matches[0][0];
			paneWindow = fresh.blockWindows.get(blockId);
		}

		const pane: Pane = { blockId, windowId: paneWindow ?? "", label: attemptLabel, name };
		this.panes.set(agent.id, pane);
		if (!paneWindow) return pane;
		if (!this.windows.includes(paneWindow)) this.windows.push(paneWindow);
		view.windows.add(paneWindow);
		view.blockWindows.set(blockId, paneWindow);
		if (anchor && anchorRect && paneWindow === anchor.windowId) {
			const [x, y, w, h] = anchorRect;
			view.rects.set(anchor.blockId, right ? [x, y, w / 2, h] : [x, y, w, h / 2]);
			view.rects.set(blockId, right ? [x + w / 2, y, w / 2, h] : [x, y + h / 2, w, h / 2]);
		} else if (!anchor) {
			view.rects.set(blockId, [0, 0, 1, 1]);
		}
		return pane;
	}

	dispose(): void {
		this.disposed = true;
		this.panes.clear();
		this.closed.clear();
		this.windowLabels.clear();
		this.windows = [];
	}
}

/**
 * One Rex session per Raga root session, owned by the ID Rex returned (never adopted by label).
 * Opens for one root are serialized; a session Rex reports missing is recreated on the next open, never
 * by a background sync.
 */
export function createRexWorkspaces(executor: RexExecutor = execute): RexWorkspaces {
	const workspaces = new Map<string, OwnedRexWorkspace>();
	const pending = new Map<string, Promise<void>>();
	/** Changes when the root is disposed, so an open that was in flight does not store its workspace. */
	const owners = new Map<string, object>();
	const openOnce = async (options: RexWorkspaceOptions, owner: object): Promise<RexWorkspace> => {
		const root = options.rootSessionId;
		const existing = workspaces.get(root);
		if (existing && !existing.gone) {
			existing.options = { ...options };
			try {
				await existing.check();
				return existing;
			} catch (error) {
				if (!existing.gone) throw error;
			}
		}
		if (owners.get(root) !== owner) throw new Error("The Raga session ended before Rex opened.");
		const label = sanitizeLabel(`raga · ${options.title}`);
		const created = parseJson(await executor(["api", "call", "session.create", JSON.stringify({ label })]));
		if (!isRecord(created) || typeof created.session_id !== "string") {
			throw new Error("Rex returned no session ID; refusing to adopt another session.");
		}
		const workspace = new OwnedRexWorkspace(executor, options, created.session_id, label);
		if (owners.get(root) !== owner) {
			workspace.dispose();
			throw new Error("The Raga session ended before Rex opened.");
		}
		workspaces.set(root, workspace);
		return workspace;
	};
	const open = (options: RexWorkspaceOptions): Promise<RexWorkspace> => {
		const root = options.rootSessionId;
		let owner = owners.get(root);
		if (!owner) {
			owner = {};
			owners.set(root, owner);
		}
		const current = owner;
		const result = (pending.get(root) ?? Promise.resolve()).then(() => openOnce(options, current));
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		pending.set(root, settled);
		void settled.then(() => {
			if (pending.get(root) === settled) pending.delete(root);
		});
		return result;
	};
	const dispose = (rootSessionId: string): void => {
		owners.delete(rootSessionId);
		pending.delete(rootSessionId);
		workspaces.get(rootSessionId)?.dispose();
		workspaces.delete(rootSessionId);
	};
	return Object.assign(open, { dispose });
}
export const openRexWorkspace = createRexWorkspaces();
/** Forget the Rex workspace of a root session that ended. Call next to `childAgents.disposeOwnedBy`. */
export const disposeRexWorkspace = (rootSessionId: string): void => openRexWorkspace.dispose(rootSessionId);
