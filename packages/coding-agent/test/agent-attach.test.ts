import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChildAgentServerMessage } from "../src/core/rlm/child-agent-server.ts";
import type { ChildAgentInfo } from "../src/core/rlm/child-agents.ts";
import {
	AGENT_ATTACH_DISCONNECTED,
	AgentAttachView,
	AttachConnection,
	createLineReader,
	formatAttachFooter,
	formatAttachHeader,
	parseAgentAttachArgs,
	parseServerMessage,
	runAgentAttach,
	sanitizeTerminalText,
} from "../src/modes/agent-attach.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const agent: ChildAgentInfo = {
	id: "a1",
	name: "SwiftFalcon",
	rootSessionId: "0123456789abcdef",
	parentSessionId: "0123456789abcdef",
	depth: 1,
	task: "task",
	model: "anthropic/claude",
	status: "running",
	busy: true,
	createdAt: 0,
	lastActivityAt: 0,
	turns: 2,
	maxTurns: 8,
	usage: { input: 1500, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1700, cost: 0.0123 },
	live: true,
	parked: false,
	openable: true,
	promptable: true,
};

describe("agent-attach arguments", () => {
	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("parses --socket and --agent in any order", () => {
		expect(parseAgentAttachArgs(["--agent", "a1", "--socket", "/tmp/x/s"])).toEqual({
			socket: "/tmp/x/s",
			agent: "a1",
		});
	});

	it("rejects unknown, duplicate, and missing options", () => {
		expect(() => parseAgentAttachArgs(["--socket", "s", "--agent", "a", "--x"])).toThrow(/Unknown option/);
		expect(() => parseAgentAttachArgs(["--socket", "s", "--socket", "t", "--agent", "a"])).toThrow(/Duplicate/);
		expect(() => parseAgentAttachArgs(["--socket"])).toThrow(/Missing value/);
		expect(() => parseAgentAttachArgs(["--socket", "--agent", "a"])).toThrow(/Missing value/);
		expect(() => parseAgentAttachArgs(["--socket", "s"])).toThrow(/Missing --agent/);
	});

	it("prints usage and exits with code 2 on bad arguments", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await runAgentAttach(["--bogus\x1b[2J"]);
		expect(process.exitCode).toBe(2);
		const output = String(stderr.mock.calls[0]?.[0]);
		expect(output).toContain("Usage: raga agent-attach --socket <path> --agent <id>");
		expect(output).not.toContain("\x1b");
	});
});

describe("agent-attach protocol helpers", () => {
	it("escapes controls, escape sequences, and bidi characters", () => {
		expect(sanitizeTerminalText("a\x1b[31mb\u202ec\u2066\x9b\x07")).toBe("a\\x1b[31mb\\u202ec\\u2066\\x9b\\x07");
		expect(sanitizeTerminalText("l1\r\nl2\tx\ry", true)).toBe("l1\nl2\tx\\x0dy");
		expect(sanitizeTerminalText("l1\nl2")).toBe("l1 l2");
		expect(sanitizeTerminalText("a\r\n\t b\u2028")).toBe("a  b\\u2028");
	});

	it("validates the nested fields the view dereferences", () => {
		const event = (value: unknown) => parseServerMessage(JSON.stringify({ type: "event", event: value }));
		expect(event({ type: "queue_update", steering: "x", followUp: [] })).toBeUndefined();
		expect(event({ type: "queue_update", steering: [1], followUp: [] })).toBeUndefined();
		expect(event({ type: "queue_update", steering: ["a"], followUp: [] })).toBeDefined();
		expect(event({ type: "message_start", message: { content: "no role" } })).toBeUndefined();
		expect(event({ type: "message_update", message: { role: "assistant", content: "text" } })).toBeUndefined();
		expect(
			event({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }] } }),
		).toBeUndefined();
		expect(
			event({ type: "tool_execution_update", toolCallId: "c", partialResult: { content: "x" } }),
		).toBeUndefined();
		expect(event({ type: "tool_execution_end", toolCallId: "c", result: null })).toBeUndefined();
		const agentMessage = (value: unknown) => parseServerMessage(JSON.stringify({ type: "agent", agent: value }));
		expect(agentMessage({ ...agent, usage: { ...agent.usage, cost: "1" } })).toBeUndefined();
		expect(agentMessage({ ...agent, usage: undefined })).toBeUndefined();
		expect(agentMessage({ ...agent, rootSessionId: 5 })).toBeUndefined();
		const welcome = (value: Record<string, unknown>) =>
			parseServerMessage(JSON.stringify({ type: "welcome", agent, messages: [], pendingToolCallIds: [], ...value }));
		expect(welcome({ messages: [{ role: "user", content: 5 }] })).toBeUndefined();
		expect(welcome({ pendingToolCallIds: [1] })).toBeUndefined();
		// A missing streaming key (JSON drops undefined) means nothing is streaming.
		expect(welcome({})).toMatchObject({ type: "welcome", streaming: null });
	});

	it("strips complete ANSI sequences from tool and bash output and escapes leftover controls", () => {
		const result = {
			content: [{ type: "text", text: "\x1b[32mgreen\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07 bell\x07" }],
		};
		const welcome = parseServerMessage(
			JSON.stringify({
				type: "welcome",
				agent,
				messages: [
					{ role: "toolResult", toolCallId: "c", toolName: "python", ...result, isError: false, timestamp: 1 },
					{ role: "bashExecution", command: "ls", output: "\x1b[1mbold\x1b[0m", exitCode: 0, timestamp: 1 },
					{ role: "user", content: "\x1b[31muser\x1b[0m", timestamp: 1 },
				],
				streaming: null,
				pendingToolCallIds: [],
			}),
		);
		const json = JSON.stringify(welcome);
		expect(json).toContain("green link bell\\\\x07");
		expect(json).toContain('"output":"bold"');
		// Only tool output is stripped; other text keeps its escapes visible.
		expect(json).toContain("\\\\x1b[31muser");
		const end = parseServerMessage(
			JSON.stringify({
				type: "event",
				event: { type: "tool_execution_end", toolCallId: "c", result, isError: false },
			}),
		);
		expect(JSON.stringify(end)).toContain("green link bell");
	});

	it("frames lines across chunks in linear time and stops at the size limit", () => {
		const lines: string[] = [];
		const push = createLineReader(10, (line) => lines.push(line));
		expect(push("ab")).toBe(true);
		expect(push("c\nde\n")).toBe(true);
		expect(push("f")).toBe(true);
		expect(push("\n")).toBe(true);
		expect(lines).toEqual(["abc", "de", "f"]);
		expect(push("0123456789x")).toBe(false);
		expect(createLineReader(10, () => {})("01234\n0123456789x\n")).toBe(false);

		const long: string[] = [];
		const pushLong = createLineReader(64 * 1024 * 1024, (line) => long.push(line));
		const chunk = "x".repeat(64 * 1024);
		const started = Date.now();
		for (let n = 0; n < 480; n++) pushLong(chunk);
		pushLong("\n");
		expect(Date.now() - started).toBeLessThan(2000);
		expect(long.map((line) => line.length)).toEqual([480 * 64 * 1024]);
	});

	it("parses and sanitizes server messages, rejecting invalid ones", () => {
		const parsed = parseServerMessage(
			JSON.stringify({ type: "agent", agent: { ...agent, name: "Evil\x1b]0;x\x07" } }),
		);
		expect(parsed?.type === "agent" && parsed.agent.name).toBe("Evil\\x1b]0;x\\x07");
		expect(parseServerMessage("not json")).toBeUndefined();
		expect(
			parseServerMessage(JSON.stringify({ type: "event", event: { type: "compaction_start" } })),
		).toBeUndefined();
		expect(parseServerMessage(JSON.stringify({ type: "welcome", agent, messages: {} }))).toBeUndefined();
		expect(parseServerMessage(JSON.stringify({ type: "error", message: "x" }))).toEqual({
			type: "error",
			message: "x",
		});
	});

	it("formats the header and footer from agent info", () => {
		expect(formatAttachHeader(agent)).toBe("SwiftFalcon · running · anthropic/claude · subagent of 01234567");
		expect(formatAttachFooter({ ...agent, status: "done" })).toBe(
			"anthropic/claude · ↑1.5k ↓200 tokens · $0.012 · turns 2/8 · done, responding",
		);
	});
});

describe("AgentAttachView", () => {
	beforeAll(() => initTheme("dark"));
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const text = (view: AgentAttachView) => stripAnsi(view.chat.render(100).join("\n"));
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistant = (content: unknown[], stopReason = "toolUse") => ({
		role: "assistant",
		content,
		api: "x",
		provider: "x",
		model: "x",
		usage,
		stopReason,
		timestamp: 1,
	});

	it("renders a welcome transcript with python cells like the main TUI", () => {
		const view = new AgentAttachView(ui);
		const welcome = parseServerMessage(
			JSON.stringify({
				type: "welcome",
				agent,
				messages: [
					{ role: "user", content: "Count the files", timestamp: 1 },
					assistant([{ type: "toolCall", id: "c1", name: "python", arguments: { code: "print(len(files))" } }]),
					{
						role: "toolResult",
						toolCallId: "c1",
						toolName: "python",
						content: [{ type: "text", text: "42" }],
						isError: false,
						timestamp: 1,
					},
					assistant([{ type: "toolCall", id: "c2", name: "python", arguments: { code: "slow()" } }]),
				],
				streaming: null,
				pendingToolCallIds: ["c2"],
			}),
		);
		if (!welcome) throw new Error("invalid welcome");
		view.apply(welcome);
		const output = text(view);
		expect(output).toContain("Count the files");
		expect(output).toContain("python");
		expect(output).toContain("print(len(files))");
		expect(output).toContain("42");
		expect(output).toContain("slow()");
		expect(stripAnsi(view.header.render(200).join(""))).toContain("SwiftFalcon · running");

		// The pending call c2 receives its live result.
		for (const event of [
			{
				type: "tool_execution_update",
				toolCallId: "c2",
				toolName: "python",
				args: {},
				partialResult: { content: [{ type: "text", text: "partial out" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "c2",
				toolName: "python",
				result: { content: [{ type: "text", text: "final out" }] },
				isError: false,
			},
		]) {
			const message = parseServerMessage(JSON.stringify({ type: "event", event }));
			if (message) view.apply(message);
		}
		expect(text(view)).toContain("final out");
	});

	it("streams assistant messages and new tool calls from events", () => {
		const view = new AgentAttachView(ui);
		view.apply({ type: "welcome", agent, messages: [], streaming: null, pendingToolCallIds: [] });
		const events = [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "user", content: "steer\x1b[2J", timestamp: 1 } },
			{ type: "message_start", message: assistant([]) },
			{
				type: "message_update",
				message: assistant([{ type: "text", text: "Working on it" }]),
				assistantMessageEvent: {},
			},
			{
				type: "message_update",
				message: assistant([
					{ type: "text", text: "Working on it" },
					{ type: "toolCall", id: "c3", name: "python", arguments: { code: "x = 1" } },
				]),
				assistantMessageEvent: {},
			},
			{
				type: "message_end",
				message: assistant([
					{ type: "text", text: "Working on it" },
					{ type: "toolCall", id: "c3", name: "python", arguments: { code: "x = 1" } },
				]),
			},
			{ type: "tool_execution_start", toolCallId: "c3", toolName: "python", args: { code: "x = 1" } },
			{ type: "queue_update", steering: ["later"], followUp: [] },
		];
		for (const event of events) {
			const message = parseServerMessage(JSON.stringify({ type: "event", event }));
			if (!message) throw new Error(`invalid ${event.type}`);
			view.apply(message);
		}
		const output = text(view);
		expect(output).toContain("steer\\x1b[2J");
		expect(output).not.toContain("\x1b[2J");
		expect(output).toContain("Working on it");
		expect(output.match(/x = 1/g)).toHaveLength(1);
		expect(stripAnsi(view.pending.render(100).join("\n"))).toContain("Steering: later");
	});

	it("shows the disconnect notice and deduplicates repeated errors", () => {
		const view = new AgentAttachView(ui);
		view.setConnected(false);
		expect(stripAnsi(view.status.render(200).join(""))).toBe(AGENT_ATTACH_DISCONNECTED);
		view.apply({ type: "error", message: "Unknown subagent." });
		view.apply({ type: "error", message: "Unknown subagent." });
		expect(text(view).match(/Unknown subagent/g)).toHaveLength(1);
		view.setConnected(true);
		view.setNotice("read-only");
		expect(stripAnsi(view.status.render(200).join(""))).toBe("read-only");
	});
	it("turns a message the view cannot show into an error notice", () => {
		const view = new AgentAttachView(ui);
		const bad = { type: "event", event: { type: "queue_update" } } as unknown as ChildAgentServerMessage;
		expect(() => view.apply(bad)).not.toThrow();
		expect(stripAnsi(view.status.render(200).join(""))).toMatch(/^Could not show a server event message: /);
	});

	it("collapses newlines and tabs in single-line widgets", () => {
		const view = new AgentAttachView(ui);
		for (const line of [
			JSON.stringify({
				type: "event",
				event: { type: "queue_update", steering: ["a\nb\tc"], followUp: ["d\r\ne"] },
			}),
			JSON.stringify({ type: "error", message: "first\nsecond" }),
		]) {
			const message = parseServerMessage(line);
			if (!message) throw new Error("invalid");
			view.apply(message);
		}
		const pending = stripAnsi(view.pending.render(100).join("\n"));
		expect(pending).toContain("Steering: a b c");
		expect(pending).toContain("Follow-up: d e");
		expect(text(view)).toContain("Error: first second");
	});

	it("shows a fatal error in the status line instead of the disconnect notice", () => {
		const view = new AgentAttachView(ui);
		view.setFailed("Unknown subagent.\nx");
		view.setConnected(false);
		expect(stripAnsi(view.status.render(200).join(""))).toBe("Error: Unknown subagent. x");
	});
});

describe("AttachConnection", () => {
	const servers: Server[] = [];
	const connections: AttachConnection[] = [];
	afterEach(async () => {
		for (const connection of connections.splice(0)) connection.close();
		for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const dirs: string[] = [];
	const tempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "attach-"));
		dirs.push(dir);
		return dir;
	};
	const socketPath = () => join(tempDir(), "s");

	async function serve(path: string, onHello: (socket: Socket, count: number) => void): Promise<() => number> {
		let count = 0;
		const server = createServer((socket) => {
			count++;
			const current = count;
			socket.setEncoding("utf8");
			socket.once("data", () => onHello(socket, current));
			socket.on("error", () => {});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(path, resolve));
		return () => count;
	}

	function open(path: string) {
		const events = { messages: [] as ChildAgentServerMessage[], connected: [] as boolean[], failed: [] as string[] };
		const connection = new AttachConnection(
			{ socket: path, agent: "a1" },
			{
				message: (message) => events.messages.push(message),
				connected: (connected) => events.connected.push(connected),
				failed: (message) => events.failed.push(message),
			},
			20,
		);
		connections.push(connection);
		connection.connect();
		return events;
	}

	const welcome = JSON.stringify({ type: "welcome", agent, messages: [], streaming: null, pendingToolCallIds: [] });

	it("treats an error before the first welcome as fatal and stops reconnecting", async () => {
		const path = socketPath();
		const count = await serve(path, (socket) =>
			socket.end(`${JSON.stringify({ type: "error", message: "Unknown subagent." })}\n`),
		);
		const events = open(path);
		await vi.waitFor(() => expect(events.failed).toEqual(["Unknown subagent."]));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(count()).toBe(1);
		expect(events.messages).toEqual([]);
	});

	it("passes errors after a welcome to the view and reconnects when the socket closes", async () => {
		const path = socketPath();
		const count = await serve(path, (socket, n) => {
			socket.write(`${welcome}\n${JSON.stringify({ type: "error", message: "read-only" })}\n`);
			if (n === 1) socket.end();
		});
		const events = open(path);
		await vi.waitFor(() => expect(count()).toBe(2));
		await vi.waitFor(() => expect(events.messages.filter((m) => m.type === "welcome")).toHaveLength(2));
		expect(events.messages.filter((m) => m.type === "error")).toHaveLength(2);
		expect(events.connected.slice(0, 3)).toEqual([true, false, true]);
		expect(events.failed).toEqual([]);
	});

	it("keeps retrying while the socket does not exist", async () => {
		const path = socketPath();
		const events = open(path);
		await vi.waitFor(() => expect(events.connected.filter((c) => !c).length).toBeGreaterThanOrEqual(3));
		expect(events.failed).toEqual([]);
		await serve(path, (socket) => socket.write(`${welcome}\n`));
		await vi.waitFor(() => expect(events.messages.map((m) => m.type)).toEqual(["welcome"]));
	});

	it("fails on connect errors other than a missing or refusing socket", async () => {
		// A path below a regular file fails with ENOTDIR on every platform.
		const file = join(tempDir(), "file");
		writeFileSync(file, "");
		const events = open(join(file, "s"));
		await vi.waitFor(() => expect(events.failed).toHaveLength(1));
		expect(events.failed[0]).toMatch(/Cannot connect/);
	});
});
