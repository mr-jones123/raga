import { describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { CHILD_AGENT_LIVE_IDLE_LIMIT, ChildAgentRegistry } from "../src/core/rlm/child-agents.ts";

class FakeSession {
	listeners: ((event: AgentSessionEvent) => void)[] = [];
	isStreaming = false;
	model = { provider: "faux", id: "model-a" };
	sessionId: string;
	sessionFile: string | undefined;
	disposed = false;
	prompts: { text: string; options: unknown }[] = [];
	flushRlmSnapshot = vi.fn(async () => {});
	abort = vi.fn(async () => {});
	constructor(id: string, file?: string) {
		this.sessionId = id;
		this.sessionFile = file;
	}
	subscribe(listener: (event: AgentSessionEvent) => void) {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((value) => value !== listener);
		};
	}
	emit(event: AgentSessionEvent) {
		for (const listener of this.listeners) listener(event);
	}
	async prompt(text: string, options: unknown) {
		this.prompts.push({ text, options });
	}
	dispose() {
		this.disposed = true;
	}
}
const asSession = (session: FakeSession) => session as unknown as AgentSession;

function register(registry: ChildAgentRegistry, id: string, parentSessionId = "root", cancel = vi.fn()) {
	return registry.register({
		id,
		rootSessionId: "root",
		parentSessionId,
		depth: 1,
		task: `task ${id}`,
		model: "faux/model-a",
		maxTurns: 5,
		cancel,
	});
}

describe("ChildAgentRegistry", () => {
	it("generates unique names and links nested children by session", () => {
		const registry = new ChildAgentRegistry(() => 0);
		const parent = register(registry, "a");
		registry.attach("a", asSession(new FakeSession("session-a")), { followUps: true });
		const child = register(registry, "b", "session-a");
		expect(parent.name).toBe("AmberBadger");
		expect(child.name).not.toBe(parent.name);
		expect(registry.get("b")?.parentId).toBe("a");
	});

	it("tracks usage, turns, activity and busy state from the real session", () => {
		const registry = new ChildAgentRegistry();
		register(registry, "a");
		const session = new FakeSession("s");
		registry.attach("a", asSession(session), { followUps: true });
		registry.start("a");
		session.isStreaming = true;
		session.emit({ type: "agent_start" } as AgentSessionEvent);
		session.emit({
			type: "tool_execution_start",
			toolCallId: "1",
			toolName: "python",
			args: { code: "\n  print(read('x'))\nmore" },
		} as AgentSessionEvent);
		session.emit({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.25 } },
			},
		} as unknown as AgentSessionEvent);
		session.emit({ type: "turn_end" } as unknown as AgentSessionEvent);
		const info = registry.get("a")!;
		expect(info).toMatchObject({ busy: true, turns: 1, activity: "print(read('x'))", status: "running" });
		expect(info.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: 0.25 });
		session.isStreaming = false;
		session.emit({ type: "agent_end" } as unknown as AgentSessionEvent);
		expect(registry.get("a")?.busy).toBe(false);
	});

	it("steers a streaming child, prompts an idle one, and refuses a collected workspace child", async () => {
		const registry = new ChildAgentRegistry();
		register(registry, "a");
		const session = new FakeSession("s");
		registry.attach("a", asSession(session), { followUps: true });
		registry.start("a");
		session.isStreaming = true;
		await registry.prompt("a", "steer");
		expect(session.prompts[0].options).toMatchObject({ streamingBehavior: "steer" });
		session.isStreaming = false;
		registry.finish("a", { status: "done" });
		await registry.prompt("a", "follow up");
		expect(session.prompts[1]).toEqual({ text: "follow up", options: { expandPromptTemplates: false } });

		register(registry, "w");
		registry.attach("w", asSession(new FakeSession("w")), { followUps: false });
		registry.start("w");
		expect(registry.get("w")?.promptable).toBe(true);
		registry.finish("w", { status: "done" });
		expect(registry.get("w")?.promptable).toBe(false);
		await expect(registry.prompt("w", "more")).rejects.toThrow(/read-only/);
	});

	it("stops queued runs through their controller and idle follow-ups through the session", () => {
		const registry = new ChildAgentRegistry();
		const cancel = vi.fn();
		register(registry, "a", "root", cancel);
		expect(registry.stop("a")).toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
		const session = new FakeSession("s");
		registry.attach("a", asSession(session), { followUps: true });
		registry.finish("a", { status: "stopped" });
		expect(registry.stop("a")).toBe(false);
		session.isStreaming = true;
		expect(registry.stop("a")).toBe(true);
		expect(session.abort).toHaveBeenCalledOnce();
	});

	it("parks the oldest idle children after flushing their kernel snapshot and reopens them", async () => {
		const registry = new ChildAgentRegistry();
		const sessions: FakeSession[] = [];
		for (let i = 0; i <= CHILD_AGENT_LIVE_IDLE_LIMIT; i++) {
			const id = `a${i}`;
			register(registry, id);
			const session = new FakeSession(id, `/sessions/${id}.jsonl`);
			sessions.push(session);
			registry.attach(id, asSession(session), {
				followUps: true,
				reopen: async () => asSession(new FakeSession(id, `/sessions/${id}.jsonl`)),
			});
			registry.start(id);
			await new Promise((resolve) => setTimeout(resolve, 2));
			registry.finish(id, { status: "done" });
		}
		await vi.waitFor(() => expect(sessions[0].disposed).toBe(true));
		expect(sessions[0].flushRlmSnapshot).toHaveBeenCalledOnce();
		expect(sessions.slice(1).every((session) => !session.disposed)).toBe(true);
		expect(registry.get("a0")).toMatchObject({ parked: true, live: false, openable: true, promptable: true });
		const reopened = await registry.open("a0");
		expect(reopened).not.toBe(asSession(sessions[0]));
		expect(registry.get("a0")).toMatchObject({ parked: false, live: true });
		await vi.waitFor(() => expect(sessions.filter((session) => session.disposed)).toHaveLength(2));
	});

	it("waits for a park in progress before reopening, and never parks a child without a session file", async () => {
		const registry = new ChildAgentRegistry();
		let finishFlush = () => {};
		const sessions: FakeSession[] = [];
		const reopen = vi.fn();
		for (let i = 0; i <= CHILD_AGENT_LIVE_IDLE_LIMIT + 1; i++) {
			register(registry, `a${i}`);
			const session = new FakeSession(`a${i}`, i === 1 ? undefined : `/s/a${i}.jsonl`);
			if (i === 0)
				session.flushRlmSnapshot = vi.fn(
					() =>
						new Promise<void>((resolve) => {
							finishFlush = resolve;
						}),
				);
			sessions.push(session);
			registry.attach(`a${i}`, asSession(session), {
				followUps: true,
				reopen:
					i === 1
						? undefined
						: async () => {
								reopen(sessions[i].disposed);
								return asSession(new FakeSession(`a${i}`));
							},
			});
			await new Promise((resolve) => setTimeout(resolve, 2));
			registry.finish(`a${i}`, { status: "done" });
		}
		await vi.waitFor(() => expect(registry.get("a0")?.parked).toBe(true));
		const opening = registry.open("a0");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(reopen).not.toHaveBeenCalled();
		finishFlush();
		await opening;
		expect(reopen).toHaveBeenCalledWith(true);
		expect(sessions[1].disposed).toBe(false);
		expect(registry.get("a1")?.live).toBe(true);
	});

	it("never parks a child while a view retains it", async () => {
		const registry = new ChildAgentRegistry();
		const sessions: FakeSession[] = [];
		let release = () => {};
		for (let i = 0; i <= CHILD_AGENT_LIVE_IDLE_LIMIT; i++) {
			register(registry, `a${i}`);
			const session = new FakeSession(`a${i}`, `/s/a${i}.jsonl`);
			sessions.push(session);
			registry.attach(`a${i}`, asSession(session), { followUps: true, reopen: async () => asSession(session) });
			if (i === 0) release = registry.retain("a0");
			await new Promise((resolve) => setTimeout(resolve, 2));
			registry.finish(`a${i}`, { status: "done" });
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(sessions.some((session) => session.disposed)).toBe(false);
		release();
		await vi.waitFor(() => expect(sessions[0].disposed).toBe(true));
	});

	it("disposes the children of a disposed parent and isolates listener failures", () => {
		const registry = new ChildAgentRegistry();
		registry.subscribe(() => {
			throw new Error("view failure");
		});
		register(registry, "a");
		const session = new FakeSession("s");
		registry.attach("a", asSession(session), { followUps: true });
		register(registry, "other", "elsewhere");
		registry.disposeOwnedBy("root");
		expect(session.disposed).toBe(true);
		expect(registry.list("root").map((agent) => agent.id)).toEqual(["other"]);
	});
});
