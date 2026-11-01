/**
 * Private local-socket attach channel for live subagents. A separate terminal process (a Rex pane
 * running `raga agent-attach`) connects, names one child of this root session, and receives that
 * child's real session transcript and live events; it can prompt or stop the child through the
 * registry. Clients never own an agent: disconnecting does not affect it.
 *
 * Protocol (version 1): newline-delimited JSON.
 * - client -> server: `hello` first, then `prompt` and `stop`.
 * - server -> client: `welcome`, `agent`, `event`, and `error`. The first reply to an accepted
 *   `hello` is always a `welcome`, and no `agent` or `event` precedes it. An `error` before any
 *   `welcome` means the hello was rejected and the server closes the connection.
 * - `message_update` events carry no `assistantMessageEvent` delta: updates are coalesced, so
 *   clients render from `event.message`, the full partial message.
 * Viewing does not keep a child in memory. If its session is parked, the client keeps its last
 * view and receives a fresh `welcome` when the child is reopened.
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";
import { type ChildAgentInfo, type ChildAgentRegistry, childAgents } from "./child-agents.ts";

export const CHILD_AGENT_PROTOCOL_VERSION = 1;
/** Longest accepted client line, in bytes. */
export const CHILD_AGENT_MAX_LINE_BYTES = 256 * 1024;
/** Longest accepted prompt text, in bytes. */
export const CHILD_AGENT_MAX_PROMPT_BYTES = 64 * 1024;
/** A client that lets this much output queue up before a write is too slow and is dropped. */
export const CHILD_AGENT_MAX_PENDING_WRITE_BYTES = 32 * 1024 * 1024;
const AGENT_UPDATE_INTERVAL_MS = 250;
/** A rejected client that has not closed its end by then is destroyed. */
const REJECT_CLOSE_TIMEOUT_MS = 1000;
const STREAM_UPDATE_INTERVAL_MS = 50;
/** macOS limits socket paths to 104 bytes including the terminator. */
const MAX_SOCKET_PATH_BYTES = 100;

export const FORWARDED_CHILD_AGENT_EVENTS = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
] as const;
export type ForwardedChildAgentEventType = (typeof FORWARDED_CHILD_AGENT_EVENTS)[number];
type SessionForwardedEvent = Extract<AgentSessionEvent, { type: ForwardedChildAgentEventType }>;
/** A forwarded session event; `message_update` omits its delta (see the protocol notes above). */
export type ForwardedChildAgentEvent =
	| Exclude<SessionForwardedEvent, { type: "message_update" }>
	| Omit<Extract<SessionForwardedEvent, { type: "message_update" }>, "assistantMessageEvent">;
const forwarded = new Set<string>(FORWARDED_CHILD_AGENT_EVENTS);

export type ChildAgentClientMessage =
	| { type: "hello"; version: number; agentId: string }
	| { type: "prompt"; text: string }
	| { type: "stop" };

export type ChildAgentServerMessage =
	| {
			type: "welcome";
			agent: ChildAgentInfo;
			messages: AgentMessage[];
			streaming: AgentMessage | null;
			pendingToolCallIds: string[];
	  }
	| { type: "agent"; agent: ChildAgentInfo }
	| { type: "event"; event: ForwardedChildAgentEvent }
	| { type: "error"; message: string };

export interface ChildAgentServer {
	socketPath: string;
	close(): Promise<void>;
}

/**
 * JSON that never throws: functions and symbols are dropped, bigints become strings, and a reference
 * back to an ancestor becomes "[Circular]". Returns undefined only if a getter or `toJSON` throws.
 */
export function safeJsonStringify(value: unknown): string | undefined {
	const ancestors: object[] = [];
	try {
		return JSON.stringify(value, function (this: unknown, _key: string, item: unknown): unknown {
			if (typeof item === "bigint") return item.toString();
			if (typeof item === "function" || typeof item === "symbol") return undefined;
			if (item === null || typeof item !== "object") return item;
			// `this` is the object holding `item`; ancestors above it are finished.
			ancestors.length = ancestors.lastIndexOf(this as object) + 1;
			if (ancestors.includes(item)) return "[Circular]";
			ancestors.push(item);
			return item;
		});
	} catch {
		return undefined;
	}
}

function privateSocketPath(): { dir: string; socketPath: string } {
	for (const base of [tmpdir(), "/tmp"]) {
		const dir = mkdtempSync(join(base, "raga-agents-"));
		const socketPath = join(dir, "s");
		if (Buffer.byteLength(socketPath) < MAX_SOCKET_PATH_BYTES) {
			chmodSync(dir, 0o700);
			return { dir, socketPath };
		}
		rmSync(dir, { recursive: true, force: true });
	}
	throw new Error("Cannot create a private socket path short enough for this platform.");
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One attached client: a viewer of a single child agent. */
class AttachClient {
	private readonly socket: Socket;
	private readonly registry: ChildAgentRegistry;
	private readonly rootSessionId: string;
	private readonly onClosed: (client: AttachClient) => void;
	private readonly maxPendingWriteBytes: number;
	private inbound: Buffer[] = [];
	private inboundBytes = 0;
	private closed = false;
	private agentId?: string;
	private opening = false;
	/** A welcome was sent; agent updates wait for it. */
	private welcomed = false;
	private gone = false;
	private session?: AgentSession;
	private unsubscribeSession?: () => void;
	private unsubscribeRegistry?: () => void;
	private lastAgentJson?: string;
	private lastAgentAt = 0;
	private agentTimer?: ReturnType<typeof setTimeout>;
	private readonly pendingUpdates = new Map<string, ForwardedChildAgentEvent>();
	private lastUpdateAt = 0;
	private updateTimer?: ReturnType<typeof setTimeout>;

	constructor(
		socket: Socket,
		registry: ChildAgentRegistry,
		rootSessionId: string,
		maxPendingWriteBytes: number,
		onClosed: (client: AttachClient) => void,
	) {
		this.socket = socket;
		this.registry = registry;
		this.rootSessionId = rootSessionId;
		this.maxPendingWriteBytes = maxPendingWriteBytes;
		this.onClosed = onClosed;
		socket.unref();
		socket.on("data", (chunk: Buffer) => this.receive(chunk));
		socket.on("error", () => this.dispose());
		// The server tracks the client until its socket is gone, so close() can always destroy it.
		socket.on("close", () => {
			this.dispose();
			this.onClosed(this);
		});
	}

	destroy(): void {
		this.socket.destroy();
		this.dispose();
	}

	private receive(chunk: Buffer): void {
		if (this.closed) return;
		let start = 0;
		for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
			const piece = chunk.subarray(start, index);
			if (this.inboundBytes + piece.length > CHILD_AGENT_MAX_LINE_BYTES) {
				this.destroy();
				return;
			}
			const line = Buffer.concat([...this.inbound, piece]).toString("utf8");
			this.inbound = [];
			this.inboundBytes = 0;
			start = index + 1;
			if (line.trim()) this.handleLine(line);
			if (this.closed) return;
		}
		const rest = chunk.subarray(start);
		if (rest.length === 0) return;
		this.inboundBytes += rest.length;
		if (this.inboundBytes > CHILD_AGENT_MAX_LINE_BYTES) {
			this.destroy();
			return;
		}
		this.inbound.push(Buffer.from(rest));
	}

	private handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.send({ type: "error", message: "Malformed message: expected one JSON object per line." });
			return;
		}
		if (!message || typeof message !== "object" || !("type" in message)) {
			this.send({ type: "error", message: "Malformed message: missing type." });
			return;
		}
		if (message.type === "hello") {
			if (this.agentId !== undefined) {
				this.send({ type: "error", message: "Already attached." });
				return;
			}
			if (!("version" in message) || message.version !== CHILD_AGENT_PROTOCOL_VERSION) {
				this.reject(`Unsupported protocol version; this Raga speaks version ${CHILD_AGENT_PROTOCOL_VERSION}.`);
				return;
			}
			if (!("agentId" in message) || typeof message.agentId !== "string") {
				this.reject("Malformed hello: missing agentId.");
				return;
			}
			void this.hello(message.agentId);
			return;
		}
		const agentId = this.agentId;
		if (agentId === undefined) {
			this.reject("Expected hello first.");
			return;
		}
		if (message.type === "prompt") {
			if (!("text" in message) || typeof message.text !== "string") {
				this.send({ type: "error", message: "Malformed prompt: missing text." });
				return;
			}
			if (Buffer.byteLength(message.text) > CHILD_AGENT_MAX_PROMPT_BYTES) {
				this.send({ type: "error", message: "Message too long (64 KiB limit)." });
				return;
			}
			this.registry.prompt(agentId, message.text).catch((error: unknown) => {
				this.send({ type: "error", message: errorMessage(error) });
			});
			return;
		}
		if (message.type === "stop") {
			this.registry.stop(agentId);
			return;
		}
		this.send({ type: "error", message: `Unknown message type: ${String(message.type).slice(0, 40)}` });
	}

	/** Send a final error and close. A peer that never closes its end is destroyed after a timeout. */
	private reject(message: string): void {
		this.send({ type: "error", message });
		this.socket.end();
		const timer = setTimeout(() => this.socket.destroy(), REJECT_CLOSE_TIMEOUT_MS).unref();
		this.socket.once("close", () => clearTimeout(timer));
		this.dispose();
	}

	private async hello(agentId: string): Promise<void> {
		const info = this.registry.get(agentId);
		if (!info || info.rootSessionId !== this.rootSessionId) {
			this.reject("Unknown subagent.");
			return;
		}
		this.agentId = agentId;
		this.unsubscribeRegistry = this.registry.subscribe(() => this.registryChanged());
		this.opening = true;
		let session: AgentSession | undefined;
		try {
			session = await this.registry.open(agentId);
			// The child may have been parked between open() resolving and this continuation; its session
			// is then disposed. Reopen once rather than show a dead session.
			if (!this.closed && !this.gone && this.registry.session(agentId) !== session) {
				session = await this.registry.open(agentId);
			}
		} catch (error) {
			this.opening = false;
			if (this.closed || this.gone) return;
			this.sendWelcome(undefined);
			this.send({ type: "error", message: errorMessage(error) });
			return;
		}
		this.opening = false;
		if (this.closed || this.gone) return;
		const current = this.registry.session(agentId);
		if (current) {
			this.bind(current);
			return;
		}
		// Parked again: show the agent without a transcript; registryChanged binds it when it reopens.
		this.sendWelcome(undefined);
		this.send({
			type: "error",
			message: "This subagent was parked before it could be shown; send a message to reopen it.",
		});
	}

	private registryChanged(): void {
		const agentId = this.agentId;
		if (this.closed || agentId === undefined) return;
		if (!this.registry.get(agentId)) {
			if (!this.gone) {
				this.gone = true;
				this.unbind();
				this.send({ type: "error", message: "This subagent is no longer available." });
			}
			return;
		}
		if (!this.opening) {
			const session = this.registry.session(agentId);
			if (session && session !== this.session) {
				this.bind(session);
				return;
			}
			if (!session && this.session) this.unbind();
		}
		this.sendAgent(false);
	}

	/** Follow `session`: subscribe first, then send its current state, so no event is lost or early. */
	private bind(session: AgentSession): void {
		if (this.agentId === undefined) return;
		this.unbind();
		if (!this.registry.get(this.agentId)) return;
		this.session = session;
		this.unsubscribeSession = session.subscribe((event) => this.forward(event));
		this.sendWelcome(session);
	}

	/** Send the agent with `session`'s state, or with an empty transcript when there is no session. */
	private sendWelcome(session: AgentSession | undefined): void {
		if (this.agentId === undefined) return;
		const agent = this.registry.get(this.agentId);
		if (!agent) return;
		const state = session?.agent.state;
		this.lastAgentJson = safeJsonStringify(agent);
		this.lastAgentAt = Date.now();
		this.welcomed = true;
		this.send({
			type: "welcome",
			agent,
			messages: session ? session.messages : [],
			streaming: state?.streamingMessage ?? null,
			pendingToolCallIds: state ? [...state.pendingToolCalls] : [],
		});
	}

	private unbind(): void {
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		this.session = undefined;
		this.pendingUpdates.clear();
		if (this.updateTimer) clearTimeout(this.updateTimer);
		this.updateTimer = undefined;
	}

	/** Send the agent's info at most four times per second, always ending with the latest. */
	private sendAgent(force: boolean): void {
		if (this.closed || this.agentId === undefined || !this.welcomed) return;
		const wait = force ? 0 : this.lastAgentAt + AGENT_UPDATE_INTERVAL_MS - Date.now();
		if (wait > 0) {
			this.agentTimer ??= setTimeout(() => {
				this.agentTimer = undefined;
				this.sendAgent(false);
			}, wait).unref();
			return;
		}
		if (this.agentTimer) clearTimeout(this.agentTimer);
		this.agentTimer = undefined;
		const agent = this.registry.get(this.agentId);
		if (!agent) return;
		const json = safeJsonStringify(agent);
		if (!force && json === this.lastAgentJson) return;
		this.lastAgentJson = json;
		this.lastAgentAt = Date.now();
		this.send({ type: "agent", agent });
	}

	private forward(event: AgentSessionEvent): void {
		if (this.closed || !forwarded.has(event.type)) return;
		const forwardedEvent = event as SessionForwardedEvent;
		const relayed: ForwardedChildAgentEvent =
			forwardedEvent.type === "message_update"
				? { type: "message_update", message: forwardedEvent.message }
				: forwardedEvent;
		if (relayed.type === "message_update" || relayed.type === "tool_execution_update") {
			const key = relayed.type === "message_update" ? "message" : `tool:${relayed.toolCallId}`;
			this.pendingUpdates.delete(key);
			this.pendingUpdates.set(key, relayed);
			const wait = this.lastUpdateAt + STREAM_UPDATE_INTERVAL_MS - Date.now();
			if (wait <= 0) this.flushUpdates();
			else this.updateTimer ??= setTimeout(() => this.flushUpdates(), wait).unref();
			return;
		}
		this.flushUpdates();
		this.send({ type: "event", event: relayed });
	}

	private flushUpdates(): void {
		if (this.updateTimer) clearTimeout(this.updateTimer);
		this.updateTimer = undefined;
		if (this.pendingUpdates.size === 0) return;
		this.lastUpdateAt = Date.now();
		const updates = [...this.pendingUpdates.values()];
		this.pendingUpdates.clear();
		for (const event of updates) this.send({ type: "event", event });
	}

	private send(message: ChildAgentServerMessage): void {
		if (this.closed || this.socket.destroyed || !this.socket.writable) return;
		const json =
			safeJsonStringify(message) ??
			safeJsonStringify({ type: "error", message: `Could not serialize a ${message.type} message.` });
		if (json === undefined) return;
		// Only a backlog that built up before this write counts, so one large welcome never drops a client.
		if (this.socket.writableLength > this.maxPendingWriteBytes) {
			this.destroy();
			return;
		}
		this.socket.write(`${json}\n`);
	}

	private dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.unbind();
		this.unsubscribeRegistry?.();
		this.unsubscribeRegistry = undefined;
		if (this.agentTimer) clearTimeout(this.agentTimer);
		this.agentTimer = undefined;
		this.inbound = [];
	}
}

/**
 * Listen on a socket in a new private directory (0700, socket 0600) for viewers of `rootSessionId`'s
 * children. The server never keeps the process alive and removes its directory on exit.
 */
export async function startChildAgentServer(options: {
	rootSessionId: string;
	registry?: ChildAgentRegistry;
	/** Defaults to CHILD_AGENT_MAX_PENDING_WRITE_BYTES. */
	maxPendingWriteBytes?: number;
}): Promise<ChildAgentServer> {
	const registry = options.registry ?? childAgents;
	const maxPendingWriteBytes = options.maxPendingWriteBytes ?? CHILD_AGENT_MAX_PENDING_WRITE_BYTES;
	const { dir, socketPath } = privateSocketPath();
	const removeDir = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* Best effort during exit. */
		}
	};
	process.on("exit", removeDir);
	const clients = new Set<AttachClient>();
	const server: Server = createServer((socket) => {
		clients.add(
			new AttachClient(socket, registry, options.rootSessionId, maxPendingWriteBytes, (client) =>
				clients.delete(client),
			),
		);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		chmodSync(socketPath, 0o600);
	} catch (error) {
		server.close();
		process.off("exit", removeDir);
		removeDir();
		throw error;
	}
	server.on("error", () => {
		/* Accept errors affect only the failing connection. */
	});
	server.unref();
	let closing: Promise<void> | undefined;
	return {
		socketPath,
		close() {
			closing ??= new Promise<void>((resolve) => {
				for (const client of [...clients]) client.destroy();
				server.close(() => {
					process.off("exit", removeDir);
					removeDir();
					resolve();
				});
			});
			return closing;
		},
	};
}
