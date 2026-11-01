import { describe, expect, it, vi } from "vitest";
import type { ChildAgentInfo } from "../src/core/rlm/child-agents.ts";
import { createRexWorkspaces, disposeRexWorkspace, inspectRex } from "../src/modes/interactive/agents/rex.ts";

vi.mock("../src/core/agent-command.ts", () => ({
	agentCommand: () => ({ executable: "/runtime", args: ["/same cli.ts"], version: "test" }),
}));
type ExecFileCallback = (
	error: (Error & { code?: number; killed?: boolean }) | null,
	stdout: string,
	stderr: string,
) => void;
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

type Node =
	| { block_id: string }
	| { split: { direction: "horizontal" | "vertical"; ratio: number; before: Node; after: Node } };
interface Window {
	window_id: string;
	label: string;
	layout: Node;
	labels: Map<string, string>;
}
type Rect = [number, number, number, number];

function render(node: Node, rect: Rect): unknown {
	if ("block_id" in node) return { rect, block_id: node.block_id };
	const [x, y, w, h] = rect;
	const { direction, ratio, before, after } = node.split;
	const first: Rect = direction === "horizontal" ? [x, y, w * ratio, h] : [x, y, w, h * ratio];
	const second: Rect =
		direction === "horizontal" ? [x + w * ratio, y, w * (1 - ratio), h] : [x, y + h * ratio, w, h * (1 - ratio)];
	return { rect, split: { direction, ratio, before: render(before, first), after: render(after, second) } };
}
function leaves(node: Node): string[] {
	return "block_id" in node ? [node.block_id] : [...leaves(node.split.before), ...leaves(node.split.after)];
}
function replace(node: Node, blockId: string, next: (leaf: Node) => Node | undefined): Node | undefined {
	if ("block_id" in node) return node.block_id === blockId ? next(node) : node;
	const before = replace(node.split.before, blockId, next);
	const after = replace(node.split.after, blockId, next);
	if (!before) return after;
	if (!after) return before;
	return { split: { ...node.split, before, after } };
}

/** In-memory Rex: sessions, windows with tiled layouts, and the commands the adapter uses. */
function rex() {
	const sessions = new Map<string, Window[]>();
	let sequence = 0;
	let created = 0;
	let failure: string | undefined;
	let selectFails = false;
	/** Wraps every call; lets a test fail a call before or after Rex applied it. */
	let intercept: ((args: string[], run: () => Promise<string>) => Promise<string>) | undefined;
	const option = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
	const session = (id: string | undefined) => {
		const windows = id ? sessions.get(id) : undefined;
		if (!windows) throw new Error(`rex: session ${id} not found (status=404 code=session_not_found)`);
		return windows;
	};
	const findBlock = (windows: Window[], blockId: string) =>
		windows.find((window) => leaves(window.layout).includes(blockId));
	const split = (sessionId: string, anchor: string, direction: "right" | "below", label: string, ratio = 0.5) => {
		const window = findBlock(session(sessionId), anchor);
		if (!window) throw new Error("rex: block not found (status=404 code=not_found)");
		const blockId = `block:${++sequence}`;
		window.layout = replace(window.layout, anchor, (leaf) => ({
			split: {
				direction: direction === "right" ? "horizontal" : "vertical",
				ratio,
				before: leaf,
				after: { block_id: blockId },
			},
		}))!;
		window.labels.set(blockId, label);
		return blockId;
	};
	const handle = async (args: string[]): Promise<string> => {
		if (failure) throw new Error(failure);
		if (args[0] === "do" && args[1] === "session.select") {
			if (selectFails) throw new Error("rex: 2 apps connected");
			return "";
		}
		if (args[0] === "run") {
			const sessionId = option(args, "--session")!;
			const windows = session(sessionId);
			const label = option(args, "--label")!;
			const anchor = option(args, "--block");
			if (anchor) {
				const blockId = split(
					sessionId,
					anchor,
					option(args, "--split") === "--split=below" ? "below" : "right",
					label,
				);
				return JSON.stringify({ anchor_id: anchor, block_ids: [blockId], split_ids: [`split:${++sequence}`] });
			}
			const blockId = `block:${++sequence}`;
			const window: Window = {
				window_id: `window:${++sequence}`,
				label: "",
				layout: { block_id: blockId },
				labels: new Map([[blockId, label]]),
			};
			windows.push(window);
			return JSON.stringify({ window_id: window.window_id, block_ids: [blockId] });
		}
		if (args[0] !== "api" || args[1] !== "call") throw new Error(`unexpected: ${args.join(" ")}`);
		const params = JSON.parse(args[3] ?? "{}") as Record<string, string>;
		switch (args[2]) {
			case "session.create": {
				const id = `session:${++created}`;
				sessions.set(id, []);
				return JSON.stringify({ session_id: id, label: params.label });
			}
			case "session.view": {
				const windows = session(params.session_id);
				if (!windows.length) return JSON.stringify({ revision: 0, session_id: params.session_id, label: "x" });
				return JSON.stringify({
					revision: 1,
					session_id: params.session_id,
					windows: windows.map((window) => ({
						window_id: window.window_id,
						label: window.label,
						layers: [
							{
								layer_id: "layer:tiled",
								kind: "tiled",
								bounds: [0, 0, 1, 1],
								layout: render(window.layout, [0, 0, 1, 1]),
								blocks: leaves(window.layout).map((id) => ({ block_id: id, label: window.labels.get(id) })),
							},
						],
					})),
				});
			}
			case "session.set_block_label": {
				const window = findBlock(session(params.session_id), params.block_id);
				if (!window) throw new Error("rex: block not found (status=404 code=not_found)");
				window.labels.set(params.block_id, params.label);
				return "{}";
			}
			case "session.set_window_label": {
				const window = session(params.session_id).find((w) => w.window_id === params.window_id);
				if (window) window.label = params.label;
				return "{}";
			}
		}
		throw new Error(`unexpected: ${args.join(" ")}`);
	};
	const executor = vi.fn((args: string[]) => (intercept ? intercept(args, () => handle(args)) : handle(args)));
	return {
		executor,
		sessions,
		windows: (id: string) => session(id),
		split,
		close(sessionId: string, blockId: string) {
			const windows = session(sessionId);
			const window = findBlock(windows, blockId)!;
			const layout = replace(window.layout, blockId, () => undefined);
			if (layout) window.layout = layout;
			else windows.splice(windows.indexOf(window), 1);
		},
		setRatio(sessionId: string, ratio: number) {
			const window = session(sessionId)[0];
			if ("split" in window.layout) window.layout.split.ratio = ratio;
		},
		fail(message?: string) {
			failure = message;
		},
		failSelect() {
			selectFails = true;
		},
		intercept(next: typeof intercept) {
			intercept = next;
		},
		labelOf(sessionId: string, blockId: string) {
			return findBlock(session(sessionId), blockId)?.labels.get(blockId);
		},
		runs: () => executor.mock.calls.map(([args]) => args).filter((args) => args[0] === "run"),
		calls: (method: string) => executor.mock.calls.filter(([args]) => args[2] === method).length,
	};
}

function agent(id: string, patch: Partial<ChildAgentInfo> = {}): ChildAgentInfo {
	return {
		id,
		name: `Name${id}`,
		rootSessionId: "root",
		parentSessionId: "root",
		depth: 1,
		task: "task",
		model: "anthropic/claude-test",
		status: "running",
		busy: false,
		createdAt: 0,
		lastActivityAt: 0,
		turns: 0,
		maxTurns: 10,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1234, cost: 0.5 },
		live: true,
		parked: false,
		openable: true,
		promptable: true,
		...patch,
	};
}
const agents = (count: number) => Array.from({ length: count }, (_, i) => agent(`a${i}`));
const options = { rootSessionId: "root", title: "My session", socketPath: "/tmp/raga agents.sock", cwd: "/work" };
const splitOf = (args: string[]) => [
	args.includes("--block") ? args[args.indexOf("--block") + 1] : undefined,
	args.find((a) => a.startsWith("--split=")),
];

describe("Rex workspace", () => {
	it("classifies missing and unreachable Rex without creating sessions", async () => {
		expect(
			(await inspectRex(vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })))).status,
		).toBe("missing");
		expect((await inspectRex(vi.fn().mockRejectedValue(new Error("connection refused")))).status).toBe("unavailable");
		const ready = vi.fn().mockResolvedValue("{}");
		expect((await inspectRex(ready)).status).toBe("ready");
		expect(ready).toHaveBeenCalledExactlyOnceWith(["api", "call", "server.status"]);
	});

	it("opens one attach pane per openable agent and handles an empty view", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		expect(workspace.sessionLabel).toBe("raga · My session");
		await workspace.sync([]);
		expect(r.runs()).toHaveLength(0);
		await workspace.sync([agent("a"), agent("hidden", { openable: false }), agent("b")]);
		const runs = r.runs();
		expect(runs).toHaveLength(2);
		for (const [index, args] of runs.entries()) {
			expect(args.slice(0, 5)).toEqual(["run", "--session", workspace.sessionId, "--cwd", "/work"]);
			expect(args).toContain("--shell=none");
			expect(args).toContain("--focus=false");
			expect(args).toContain("--json");
			expect(args.slice(args.indexOf("--") + 1)).toEqual([
				"/runtime",
				"/same cli.ts",
				"agent-attach",
				"--socket",
				"/tmp/raga agents.sock",
				"--agent",
				index === 0 ? "a" : "b",
			]);
		}
		const [firstBlock] = leaves(r.windows(workspace.sessionId)[0].layout);
		expect(r.labelOf(workspace.sessionId, firstBlock)).toBe("Namea · running · claude-test · 1.2k tok · $0.500");
		expect(r.windows(workspace.sessionId)).toHaveLength(1);
		expect(r.windows(workspace.sessionId)[0].label).toBe("raga · My session · 2 agents");
	});

	it("splits the largest owned pane, right when wide and below when tall", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		await workspace.sync(agents(4));
		expect(r.runs()).toHaveLength(4);
		const [first, second, third, fourth] = r.runs().map(splitOf);
		expect(first).toEqual([undefined, undefined]);
		const [b0, b1] = r.windows(workspace.sessionId)[0].labels.keys();
		expect(second).toEqual([b0, "--split=right"]);
		expect(third).toEqual([b0, "--split=below"]);
		expect(fourth).toEqual([b1, "--split=below"]);
	});

	it("chooses anchors from the rects in session.view", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		await workspace.sync(agents(2));
		const [b0, b1] = leaves(r.windows(workspace.sessionId)[0].layout);
		r.setRatio(workspace.sessionId, 0.2);
		await workspace.sync(agents(3));
		expect(splitOf(r.runs()[2])).toEqual([b1, "--split=below"]);
		r.setRatio(workspace.sessionId, 0.9);
		await workspace.sync(agents(4));
		expect(splitOf(r.runs()[3])[0]).toBe(b0);
	});

	it("never anchors on user blocks and starts a new window after nine owned panes", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		await workspace.sync(agents(1));
		const [owned] = leaves(r.windows(workspace.sessionId)[0].layout);
		const user = r.split(workspace.sessionId, owned, "right", "user shell", 0.1);
		await workspace.sync(agents(10));
		const anchors = r.runs().map((args) => splitOf(args)[0]);
		expect(anchors).not.toContain(user);
		const windows = r.windows(workspace.sessionId);
		expect(windows).toHaveLength(2);
		expect(leaves(windows[0].layout)).toHaveLength(10);
		expect(leaves(windows[1].layout)).toHaveLength(1);
		expect(splitOf(r.runs()[9])).toEqual([undefined, undefined]);
		expect(windows[0].labels.get(user)).toBe("user shell");
		expect(windows.map((w) => w.label)).toEqual(["raga · My session · 9 agents", "raga · My session · 1 agents"]);
	});

	it("serializes concurrent opens and syncs without duplicate sessions or panes", async () => {
		const r = rex();
		const open = createRexWorkspaces(r.executor);
		const [a, b, c] = await Promise.all([open(options), open(options), open(options)]);
		expect(a).toBe(b);
		expect(b).toBe(c);
		expect(r.sessions.size).toBe(1);
		await Promise.all([a.sync(agents(3)), a.sync(agents(3)), b.sync(agents(3))]);
		expect(r.runs()).toHaveLength(3);
		const other = await open({ ...options, rootSessionId: "other" });
		expect(other.sessionId).not.toBe(a.sessionId);
	});

	it("updates block and window labels only when they change", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		await workspace.sync([agent("a")]);
		// One label call replaces the per-attempt label set by `rex run`.
		expect(r.calls("session.set_block_label")).toBe(1);
		await workspace.sync([agent("a")]);
		expect(r.calls("session.set_block_label")).toBe(1);
		expect(r.calls("session.set_window_label")).toBe(1);
		await workspace.sync([
			agent("a", {
				status: "done",
				parked: true,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2_500_000, cost: 12.345 },
			}),
		]);
		expect(r.calls("session.set_block_label")).toBe(2);
		const [window] = r.windows(workspace.sessionId);
		expect(window.labels.get(leaves(window.layout)[0])).toBe(
			"Namea · done · parked · claude-test · 2.5M tok · $12.35",
		);
		await workspace.sync([agent("a", { status: "done", busy: true })]);
		expect(window.labels.get(leaves(window.layout)[0])).toContain("Namea · running ·");
		expect(r.calls("session.set_window_label")).toBe(1);
	});

	it("keeps user-closed panes closed until the user picks Rex again", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		await workspace.sync(agents(2));
		const [first] = leaves(r.windows(workspace.sessionId)[0].layout);
		r.close(workspace.sessionId, first);
		await workspace.sync(agents(2));
		await workspace.sync(agents(2));
		expect(r.runs()).toHaveLength(2);
		await workspace.sync(agents(2), { reopenClosed: true });
		expect(r.runs()).toHaveLength(3);
		expect(r.runs()[2].at(-1)).toBe("a0");
		await workspace.sync(agents(2));
		expect(r.runs()).toHaveLength(3);
	});

	it("recreates a deleted session only on an explicit open", async () => {
		const r = rex();
		const open = createRexWorkspaces(r.executor);
		const workspace = await open(options);
		await workspace.sync(agents(1));
		r.fail("connection refused");
		await expect(open(options)).rejects.toThrow("connection refused");
		r.fail();
		expect(await open(options)).toBe(workspace);
		r.sessions.delete(workspace.sessionId);
		await expect(workspace.sync(agents(1))).rejects.toThrow(/not found/);
		await expect(workspace.sync(agents(1))).rejects.toThrow(/Choose Rex again/);
		expect(r.sessions.size).toBe(0);
		const recreated = await open(options);
		expect(recreated.sessionId).not.toBe(workspace.sessionId);
		await recreated.sync(agents(1));
		expect(r.runs()).toHaveLength(2);
		expect(r.runs()[1][2]).toBe(recreated.sessionId);
	});

	it("reveals the session best-effort", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		await workspace.reveal();
		r.failSelect();
		await expect(workspace.reveal()).resolves.toBeUndefined();
		expect(r.executor.mock.calls.filter(([args]) => args[0] === "do")).toEqual([
			[["do", "session.select", `session_id=${workspace.sessionId}`]],
			[["do", "session.select", `session_id=${workspace.sessionId}`]],
		]);
	});

	it("sanitizes labels from titles and agent names", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)({
			...options,
			title: `evil\x1b]0;pwn\x07\n\u202etitle${"x".repeat(300)}`,
		});
		await workspace.sync([agent("a", { name: "Bad\x1b[31m\u2066Name\u0085\u200f", model: "p/m\x9bodel" })]);
		const unsafe = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
		const create = r.executor.mock.calls.find(([args]) => args[2] === "session.create")![0];
		const sessionLabel = (JSON.parse(create[3]) as { label: string }).label;
		expect(sessionLabel).toBe(workspace.sessionLabel);
		expect(sessionLabel).not.toMatch(unsafe);
		expect(Array.from(sessionLabel)).toHaveLength(128);
		const run = r.runs()[0];
		expect(run[run.indexOf("--label") + 1]).not.toMatch(unsafe);
		const [block] = leaves(r.windows(workspace.sessionId)[0].layout);
		const label = r.labelOf(workspace.sessionId, block)!;
		expect(label).not.toMatch(unsafe);
		expect(label.startsWith("Bad [31m Name")).toBe(true);
		expect(r.windows(workspace.sessionId)[0].label).not.toMatch(unsafe);
	});
	it("records a pane whose window ID is missing and never opens it twice", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		r.intercept(async (args, run) => {
			const text = await run();
			if (args[0] !== "run") return text;
			const { window_id: _, ...rest } = JSON.parse(text) as Record<string, unknown>;
			return JSON.stringify(rest);
		});
		await workspace.sync([agent("a")]);
		await workspace.sync([agent("a")]);
		expect(r.runs()).toHaveLength(1);
		const [window] = r.windows(workspace.sessionId);
		expect(window.label).toBe("raga · My session · 1 agents");
		expect(r.labelOf(workspace.sessionId, leaves(window.layout)[0])).toContain("Namea · running");
	});

	it("adopts the pane of a failed `rex run` by its attempt label instead of opening a duplicate", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		// Rex created the pane, then the CLI timed out or printed garbage.
		r.intercept(async (args, run) => {
			const text = await run();
			if (args[0] === "run") throw new Error("rex run failed: timed out");
			return text;
		});
		await workspace.sync([agent("a")]);
		r.intercept(async (args, run) => {
			const text = await run();
			return args[0] === "run" ? "not json" : text;
		});
		await workspace.sync([agent("a"), agent("b")]);
		r.intercept(undefined);
		await workspace.sync([agent("a"), agent("b")]);
		expect(r.runs()).toHaveLength(2);
		const [window] = r.windows(workspace.sessionId);
		expect(leaves(window.layout)).toHaveLength(2);
		expect(leaves(window.layout).map((id) => r.labelOf(workspace.sessionId, id))).toEqual([
			"Namea · running · claude-test · 1.2k tok · $0.500",
			"Nameb · running · claude-test · 1.2k tok · $0.500",
		]);
		expect(window.label).toBe("raga · My session · 2 agents");
		// Each attempt used a distinct label.
		const attempts = r.runs().map((args) => args[args.indexOf("--label") + 1]);
		expect(new Set(attempts).size).toBe(2);
		expect(attempts[0]).toMatch(/^Namea · [0-9a-f]{8}$/);
	});

	it("reports a `rex run` that created nothing and retries it on the next sync", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		r.intercept(async (args, run) => {
			if (args[0] === "run") throw new Error("rex run failed: connection reset");
			return run();
		});
		await expect(workspace.sync([agent("a")])).rejects.toThrow("connection reset");
		r.intercept(undefined);
		await workspace.sync([agent("a")]);
		expect(r.runs()).toHaveLength(2);
		expect(leaves(r.windows(workspace.sessionId)[0].layout)).toHaveLength(1);
	});

	it("marks the session gone only when session.view reports session_not_found", async () => {
		const r = rex();
		const open = createRexWorkspaces(r.executor);
		const workspace = await open(options);
		await workspace.sync([agent("a")]);
		for (const message of [
			"rex: block block:9 in session session:1 does not exist",
			"rex: block not found (status=404 code=not_found)",
			"rex: session session:1 not found (status=404 code=session_not_found)",
		]) {
			r.intercept(async (args, run) => {
				if (args[2] === "session.set_block_label") throw new Error(message);
				return run();
			});
			await expect(workspace.sync([agent("a", { status: "done" })])).rejects.toThrow(message);
		}
		r.intercept(async (args, run) => {
			if (args[2] === "session.view") throw new Error("rex: block block:9 in session session:1 does not exist");
			return run();
		});
		await expect(workspace.sync([agent("a")])).rejects.toThrow("does not exist");
		r.intercept(undefined);
		await workspace.sync([agent("a", { status: "done" })]);
		expect(await open(options)).toBe(workspace);
		expect(r.calls("session.create")).toBe(1);
		const [window] = r.windows(workspace.sessionId);
		expect(r.labelOf(workspace.sessionId, leaves(window.layout)[0])).toContain("Namea · done");
	});

	it("labels panes of unopenable or forgotten agents closed once and stops counting them", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		await workspace.sync(agents(3));
		const blockOf = (name: string) =>
			leaves(r.windows(workspace.sessionId)[0].layout).find((id) =>
				r.labelOf(workspace.sessionId, id)?.startsWith(`${name} `),
			)!;
		const [b0, b1, b2] = ["Namea0", "Namea1", "Namea2"].map(blockOf);
		const labels = r.calls("session.set_block_label");
		const list = [agent("a0", { openable: false, status: "done" }), agent("a2")];
		await workspace.sync(list);
		expect(r.labelOf(workspace.sessionId, b0)).toBe("Namea0 · closed");
		expect(r.labelOf(workspace.sessionId, b1)).toBe("Namea1 · closed");
		expect(r.labelOf(workspace.sessionId, b2)).toContain("Namea2 · running");
		expect(r.windows(workspace.sessionId)[0].label).toBe("raga · My session · 1 agents");
		expect(r.calls("session.set_block_label")).toBe(labels + 2);
		await workspace.sync(list);
		await workspace.sync([agent("a0"), agent("a2")]);
		expect(r.calls("session.set_block_label")).toBe(labels + 2);
		expect(r.runs()).toHaveLength(3);
		// The user can bring a released agent back by choosing Rex again.
		await workspace.sync([agent("a0"), agent("a2")], { reopenClosed: true });
		expect(r.runs()).toHaveLength(4);
		expect(r.runs()[3].at(-1)).toBe("a0");
		expect(r.windows(workspace.sessionId)[0].label).toBe("raga · My session · 2 agents");
	});

	it("formats token counts without printing 1000.0k", async () => {
		const r = rex();
		const workspace = await createRexWorkspaces(r.executor)(options);
		const usage = (totalTokens: number) => ({ ...agent("x").usage, totalTokens });
		await workspace.sync([agent("a", { usage: usage(999_949) }), agent("b", { usage: usage(999_950) })]);
		const blocks = leaves(r.windows(workspace.sessionId)[0].layout);
		expect(r.labelOf(workspace.sessionId, blocks[0])).toContain(" 999.9k tok ");
		expect(r.labelOf(workspace.sessionId, blocks[1])).toContain(" 1.0M tok ");
	});

	it("sanitizes and truncates Rex stderr in errors and availability messages", async () => {
		const stderr = `Error: \x1b]0;pwn\x07\u202eevil\x9b31m\n${"y".repeat(5000)}`;
		execFileMock.mockImplementation(
			(_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
				callback(Object.assign(new Error(`Command failed: rex\n${stderr}`), { code: 1 }), "", stderr);
			},
		);
		const unsafe = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
		const availability = await inspectRex();
		expect(availability.status).toBe("unavailable");
		expect(availability.message).not.toMatch(unsafe);
		expect(availability.message).toContain("rex server.status failed: Error: ]0;pwn evil 31m yyy");
		expect(availability.message.length).toBeLessThan(700);
		const [, args] = execFileMock.mock.calls[0] as [string, string[]];
		expect(args.slice(0, 3)).toEqual(["--autostart=false", "--timeout=3s", "--color=never"]);
		execFileMock.mockReset();
	});

	it("forgets a disposed root and drops an open that was in flight", async () => {
		const r = rex();
		const open = createRexWorkspaces(r.executor);
		const workspace = await open(options);
		await workspace.sync([agent("a")]);
		open.dispose("root");
		const calls = r.executor.mock.calls.length;
		await workspace.sync([agent("a"), agent("b")]);
		await workspace.reveal();
		expect(r.executor.mock.calls.length).toBe(calls);
		const next = await open(options);
		expect(next.sessionId).not.toBe(workspace.sessionId);
		const inFlight = open({ ...options, rootSessionId: "other" });
		open.dispose("other");
		await expect(inFlight).rejects.toThrow("ended");
		expect(() => disposeRexWorkspace("unknown")).not.toThrow();
	});
});
