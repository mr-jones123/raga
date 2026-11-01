import { statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	type ChildAgentServer,
	type ChildAgentServerMessage,
	safeJsonStringify,
	startChildAgentServer,
} from "../src/core/rlm/child-agent-server.ts";
import { ChildAgentRegistry } from "../src/core/rlm/child-agents.ts";

function fakeSession(messages: unknown[] = []) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	return {
		sessionId: "child-session",
		sessionFile: undefined,
		model: undefined,
		isStreaming: false,
		messages,
		agent: { state: { streamingMessage: undefined, pendingToolCalls: new Set(["call-1"]) } },
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit(event: unknown) {
			for (const listener of [...listeners]) listener(event as AgentSessionEvent);
		},
		listenerCount: () => listeners.size,
		prompt: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(),
		flushRlmSnapshot: async () => {},
	};
}
type FakeSession = ReturnType<typeof fakeSession>;

function setup(root = "root") {
	const registry = new ChildAgentRegistry(() => 0.5);
	const cancel = vi.fn();
	const add = (
		id: string,
		rootSessionId = root,
		session: FakeSession = fakeSession([{ role: "user", content: "hi", timestamp: 1 }]),
	) => {
		registry.register({
			id,
			rootSessionId,
			parentSessionId: rootSessionId,
			depth: 1,
			task: "task",
			model: "p/m",
			maxTurns: 5,
			cancel,
		});
		registry.start(id);
		registry.attach(id, session as unknown as AgentSession, { followUps: true });
		return session;
	};
	return { registry, cancel, add };
}

class Client {
	readonly socket: Socket;
	readonly messages: ChildAgentServerMessage[] = [];
	closed = false;
	private buffer = "";
	private waiters: (() => void)[] = [];

	constructor(path: string, allowHalfOpen = false) {
		this.socket = createConnection({ path, allowHalfOpen });
		this.socket.setEncoding("utf8");
		this.socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			let index = this.buffer.indexOf("\n");
			while (index !== -1) {
				this.messages.push(JSON.parse(this.buffer.slice(0, index)) as ChildAgentServerMessage);
				this.buffer = this.buffer.slice(index + 1);
				index = this.buffer.indexOf("\n");
			}
			this.wake();
		});
		this.socket.on("error", () => {});
		this.socket.on("close", () => {
			this.closed = true;
			this.wake();
		});
	}

	send(value: unknown): void {
		this.socket.write(`${JSON.stringify(value)}\n`);
	}

	async until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error("timed out");
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
				setTimeout(resolve, 20);
			});
		}
	}

	of<T extends ChildAgentServerMessage["type"]>(type: T): Extract<ChildAgentServerMessage, { type: T }>[] {
		return this.messages.filter((m): m is Extract<ChildAgentServerMessage, { type: T }> => m.type === type);
	}

	private wake(): void {
		for (const waiter of this.waiters.splice(0)) waiter();
	}
}

const servers: ChildAgentServer[] = [];
const clients: Client[] = [];
async function start(registry: ChildAgentRegistry, rootSessionId = "root", maxPendingWriteBytes?: number) {
	const server = await startChildAgentServer({ rootSessionId, registry, maxPendingWriteBytes });
	servers.push(server);
	return server;
}
function connect(server: ChildAgentServer, allowHalfOpen = false) {
	const client = new Client(server.socketPath, allowHalfOpen);
	clients.push(client);
	return client;
}
async function attach(server: ChildAgentServer, agentId: string) {
	const client = connect(server);
	client.send({ type: "hello", version: 1, agentId });
	await client.until(() => client.of("welcome").length > 0 || client.closed);
	return client;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const client of clients.splice(0)) client.socket.destroy();
	for (const server of servers.splice(0)) await server.close();
});

describe("child agent attach server", () => {
	it("listens on a private socket and removes its directory on close", async () => {
		const { registry } = setup();
		const server = await start(registry);
		const dir = server.socketPath.slice(0, -2);
		expect(server.socketPath.endsWith("/s")).toBe(true);
		expect(Buffer.byteLength(server.socketPath)).toBeLessThan(100);
		expect(dir.startsWith(tmpdir()) || dir.startsWith("/tmp")).toBe(true);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(server.socketPath).mode & 0o777).toBe(0o600);
		await server.close();
		expect(() => statSync(dir)).toThrow();
	});

	it("rejects unknown agents and agents of another root session", async () => {
		const { registry, add } = setup();
		add("foreign", "other-root");
		const server = await start(registry);
		for (const agentId of ["missing", "foreign"]) {
			const client = await attach(server, agentId);
			await client.until(() => client.closed);
			expect(client.of("welcome")).toHaveLength(0);
			expect(client.of("error")[0]?.message).toBe("Unknown subagent.");
		}
		const early = connect(server);
		early.send({ type: "prompt", text: "x" });
		await early.until(() => early.closed);
		expect(early.of("error")[0]?.message).toMatch(/hello/);
	});

	it("welcomes with the session transcript, streaming message, and running tool calls", async () => {
		const { registry, add } = setup();
		add("a1");
		const server = await start(registry);
		const client = await attach(server, "a1");
		const [welcome] = client.of("welcome");
		expect(welcome.agent.id).toBe("a1");
		expect(welcome.messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
		expect(welcome.streaming).toBeNull();
		expect(welcome.pendingToolCallIds).toEqual(["call-1"]);
	});

	it("forwards only view events and delivers agent updates", async () => {
		const { registry, add } = setup();
		const session = add("a1");
		const server = await start(registry);
		const client = await attach(server, "a1");
		session.emit({ type: "agent_start" });
		session.emit({ type: "compaction_start", reason: "manual" });
		session.emit({ type: "entry_appended", entry: {} });
		session.emit({ type: "tool_execution_start", toolCallId: "c", toolName: "python", args: { code: "1" } });
		await client.until(() => client.of("event").length >= 2);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.of("event").map((m) => m.event.type)).toEqual(["agent_start", "tool_execution_start"]);
		registry.finish("a1", { status: "done" });
		await client.until(() => client.of("agent").some((m) => m.agent.status === "done"));
	});

	it("coalesces stream updates and delivers the latest before the next event", async () => {
		const { registry, add } = setup();
		const session = add("a1");
		const server = await start(registry);
		const client = await attach(server, "a1");
		const message = (n: number) => ({ role: "assistant", content: [{ type: "text", text: `t${n}` }] });
		for (let n = 0; n < 50; n++) {
			session.emit({ type: "message_update", message: message(n), assistantMessageEvent: { type: "text_delta" } });
			session.emit({
				type: "tool_execution_update",
				toolCallId: "c",
				toolName: "python",
				args: {},
				partialResult: n,
			});
		}
		session.emit({ type: "message_end", message: message(50) });
		await client.until(() => client.of("event").some((m) => m.event.type === "message_end"));
		const events = client.of("event").map((m) => m.event);
		const texts = events.flatMap((event) =>
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			event.message.content[0]?.type === "text"
				? [event.message.content[0].text]
				: [],
		);
		const partials = events.flatMap((event) => (event.type === "tool_execution_update" ? [event.partialResult] : []));
		expect(texts).toEqual(["t0", "t49"]);
		// Deltas are stripped: coalescing drops intermediate ones, so clients render from event.message.
		expect(events.some((event) => "assistantMessageEvent" in event)).toBe(false);
		expect(partials).toEqual([49]);
		expect(events.at(-1)?.type).toBe("message_end");

		// Updates without a following event arrive after the interval.
		for (let n = 0; n < 10; n++) {
			session.emit({
				type: "message_update",
				message: message(100 + n),
				assistantMessageEvent: { type: "text_delta" },
			});
		}
		await client.until(() => client.messages.some((m) => m.type === "event" && JSON.stringify(m).includes("t109")));
	});

	it("delegates prompt and stop to the registry and reports failures", async () => {
		const { registry, add } = setup();
		add("a1");
		const prompt = vi.spyOn(registry, "prompt");
		const stop = vi.spyOn(registry, "stop");
		const server = await start(registry);
		const client = await attach(server, "a1");
		client.send({ type: "prompt", text: "steer this" });
		client.send({ type: "stop" });
		await client.until(() => stop.mock.calls.length > 0);
		expect(prompt).toHaveBeenCalledWith("a1", "steer this");
		expect(stop).toHaveBeenCalledWith("a1");

		prompt.mockRejectedValueOnce(new Error("read-only"));
		client.send({ type: "prompt", text: "again" });
		await client.until(() => client.of("error").length > 0);
		expect(client.of("error")[0].message).toBe("read-only");

		client.send({ type: "prompt", text: "x".repeat(64 * 1024 + 1) });
		client.socket.write("not json\n");
		await client.until(() => client.of("error").length >= 3);
		expect(
			client
				.of("error")
				.map((m) => m.message)
				.slice(1),
		).toEqual(["Message too long (64 KiB limit).", "Malformed message: expected one JSON object per line."]);
		expect(client.closed).toBe(false);
	});

	it("closes a client that sends an oversized line", async () => {
		const { registry, add } = setup();
		add("a1");
		const server = await start(registry);
		const client = await attach(server, "a1");
		client.socket.write("x".repeat(300 * 1024));
		await client.until(() => client.closed);
	});

	it("leaves agents untouched when a client disconnects", async () => {
		const { registry, add, cancel } = setup();
		const session = add("a1");
		const before = session.listenerCount();
		const server = await start(registry);
		const client = await attach(server, "a1");
		expect(session.listenerCount()).toBe(before + 1);
		client.socket.destroy();
		await vi.waitFor(() => expect(session.listenerCount()).toBe(before));
		expect(cancel).not.toHaveBeenCalled();
		expect(session.abort).not.toHaveBeenCalled();
		expect(session.dispose).not.toHaveBeenCalled();
		expect(registry.get("a1")?.status).toBe("running");
	});

	it("destroys a rejected client that never closes its end, and close() does not wait for it", async () => {
		const { registry } = setup();
		const server = await start(registry);
		const lingering = connect(server, true);
		lingering.send({ type: "hello", version: 1, agentId: "missing" });
		await lingering.until(() => lingering.of("error").length > 0);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		// The server destroyed its socket, so a write now fails and the client closes.
		const writes = setInterval(() => lingering.socket.write("x"), 20);
		try {
			await lingering.until(() => lingering.closed);
		} finally {
			clearInterval(writes);
		}

		const held = connect(server, true);
		held.send({ type: "prompt", text: "x" });
		await held.until(() => held.of("error").length > 0);
		const started = Date.now();
		await server.close();
		expect(Date.now() - started).toBeLessThan(800);
	});

	it("sends a large welcome whole and drops only a client whose backlog exceeds the cap", async () => {
		const { registry, add } = setup();
		const big = "y".repeat(1024 * 1024);
		const session = add("a1", "root", fakeSession([{ role: "user", content: big, timestamp: 1 }]));
		const server = await start(registry, "root", 64 * 1024);
		const client = await attach(server, "a1");
		expect(client.of("welcome")[0]?.messages).toEqual([{ role: "user", content: big, timestamp: 1 }]);
		expect(client.closed).toBe(false);

		client.socket.pause();
		const chunk = "z".repeat(256 * 1024);
		for (let n = 0; n < 40; n++) {
			session.emit({ type: "message_start", message: { role: "user", content: chunk, timestamp: n } });
		}
		client.socket.resume();
		await client.until(() => client.closed, 5000);
		expect(client.of("event").length).toBeLessThan(40);
	});

	it("re-opens once when the opened session was parked before the welcome", async () => {
		const { registry, add } = setup();
		const live = add("a1");
		const stale = fakeSession([{ role: "user", content: "stale", timestamp: 9 }]);
		const open = vi.spyOn(registry, "open").mockResolvedValueOnce(stale as unknown as AgentSession);
		const server = await start(registry);
		const client = await attach(server, "a1");
		expect(open).toHaveBeenCalledTimes(2);
		expect(client.of("welcome")).toHaveLength(1);
		expect(client.of("welcome")[0].messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
		expect(stale.listenerCount()).toBe(0);
		expect(live.listenerCount()).toBeGreaterThan(1);
	});

	it("welcomes without a transcript when the child stays parked, then welcomes its reopened session", async () => {
		const { registry, add } = setup();
		add("a1");
		const stale = fakeSession();
		const server = await start(registry);
		vi.spyOn(registry, "session").mockReturnValue(undefined);
		vi.spyOn(registry, "open").mockResolvedValue(stale as unknown as AgentSession);
		const client = await attach(server, "a1");
		await client.until(() => client.of("error").length > 0);
		expect(client.messages.map((m) => m.type)).toEqual(["welcome", "error"]);
		expect(client.of("welcome")[0]).toMatchObject({ messages: [], streaming: null, pendingToolCallIds: [] });
		expect(stale.listenerCount()).toBe(0);
		vi.mocked(registry.session).mockRestore();
		const reopened = fakeSession([{ role: "user", content: "back", timestamp: 3 }]);
		registry.attach("a1", reopened as unknown as AgentSession, { followUps: true });
		await client.until(() => client.of("welcome").length === 2);
		expect(client.of("welcome")[1].messages).toEqual([{ role: "user", content: "back", timestamp: 3 }]);
	});

	it("sends welcome before any agent update, also when opening fails", async () => {
		const { registry, add } = setup();
		const session = add("a1");
		vi.spyOn(registry, "open").mockImplementationOnce(async (id) => {
			// Reopening attaches the session, which notifies registry listeners before open() resolves.
			registry.attach(id, session as unknown as AgentSession, { followUps: true });
			await new Promise((resolve) => setTimeout(resolve, 20));
			return session as unknown as AgentSession;
		});
		const server = await start(registry);
		const client = await attach(server, "a1");
		expect(client.messages[0]?.type).toBe("welcome");

		registry.register({
			id: "unsaved",
			rootSessionId: "root",
			parentSessionId: "root",
			depth: 1,
			task: "t",
			model: "p/m",
			maxTurns: 1,
			cancel: () => {},
		});
		const failed = await attach(server, "unsaved");
		await failed.until(() => failed.of("error").length > 0);
		expect(failed.messages.map((m) => m.type)).toEqual(["welcome", "error"]);
		expect(failed.of("welcome")[0]).toMatchObject({ agent: { id: "unsaved" }, messages: [], streaming: null });
		expect(failed.of("error")[0].message).toMatch(/cannot be reopened/);
		expect(failed.closed).toBe(false);
	});

	it("sends a fresh welcome when the agent's session is replaced", async () => {
		const { registry, add } = setup();
		const first = add("a1");
		const server = await start(registry);
		const client = await attach(server, "a1");
		const second = fakeSession([{ role: "user", content: "reopened", timestamp: 2 }]);
		registry.attach("a1", second as unknown as AgentSession, { followUps: true });
		await client.until(() => client.of("welcome").length === 2);
		expect(client.of("welcome")[1].messages).toEqual([{ role: "user", content: "reopened", timestamp: 2 }]);
		second.emit({ type: "agent_start" });
		first.emit({ type: "turn_start" });
		await client.until(() => client.of("event").length > 0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.of("event").map((m) => m.event.type)).toEqual(["agent_start"]);
	});
});

describe("safeJsonStringify", () => {
	it("drops functions and symbols, stringifies bigints, and marks cycles", () => {
		const value: Record<string, unknown> = { n: 10n, f: () => 1, s: Symbol("x"), shared: { a: 1 } };
		value.self = value;
		value.again = value.shared;
		expect(JSON.parse(safeJsonStringify(value) ?? "")).toEqual({
			n: "10",
			shared: { a: 1 },
			self: "[Circular]",
			again: { a: 1 },
		});
		const throwing = {
			get bad() {
				throw new Error("no");
			},
		};
		expect(safeJsonStringify(throwing)).toBeUndefined();
	});
});
