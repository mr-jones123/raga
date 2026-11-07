import { stripVTControlCharacters } from "node:util";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ChildAgentInfo } from "../src/core/rlm/child-agents.ts";
import {
	AgentsDashboard,
	type AgentsDashboardSource,
	formatAgentCost,
	formatAgentDuration,
	formatAgentTokens,
} from "../src/modes/interactive/agents/dashboard.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const NOW = 1_700_000_000_000;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function agent(id: string, overrides: Partial<ChildAgentInfo> = {}): ChildAgentInfo {
	return {
		id,
		name: id,
		rootSessionId: "root",
		parentSessionId: "root",
		depth: 1,
		task: `task of ${id}`,
		model: "anthropic/claude-sonnet-4-5",
		status: "done",
		busy: false,
		createdAt: NOW - 60_000,
		startedAt: NOW - 60_000,
		endedAt: NOW - 18_000,
		lastActivityAt: NOW - 18_000,
		turns: 3,
		maxTurns: 30,
		usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, totalTokens: 1700, cost: 0.0123 },
		sessionFile: `/sessions/${id}.jsonl`,
		live: true,
		parked: false,
		openable: true,
		promptable: true,
		...overrides,
	};
}

/** `view` is the view after opening: the dashboard starts in the chart, and `t` cycles chart, tree, flat. */
function fixture(agents: ChildAgentInfo[], rows = 30, view: "chart" | "tree" = "tree") {
	let list = agents;
	const listeners = new Set<() => void>();
	const source: AgentsDashboardSource = {
		list: () => list.map((info) => ({ ...info, usage: { ...info.usage } })),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		rootLabel: () => "main session",
	};
	const tui = { terminal: { rows }, requestRender: vi.fn() };
	const actions = { open: vi.fn(), stop: vi.fn(), close: vi.fn() };
	const dashboard = new AgentsDashboard(source, tui as unknown as TUI, theme, new KeybindingsManager(), actions);
	if (view === "tree") dashboard.handleInput("t");
	const lines = (width = 100) => dashboard.render(width).map(stripVTControlCharacters);
	const text = (width = 100) => lines(width).join("\n");
	const update = (next: ChildAgentInfo[]) => {
		list = next;
		for (const listener of [...listeners]) listener();
	};
	const selectedLine = (width = 100) => lines(width).find((line) => line.startsWith("▶")) ?? "";
	return { dashboard, tui, actions, lines, text, update, listeners, selectedLine };
}

beforeEach(() => {
	initTheme("dark");
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("agents dashboard", () => {
	it("formats tokens, cost, and durations", () => {
		expect(formatAgentTokens(999)).toBe("999");
		expect(formatAgentTokens(1234)).toBe("1.2k");
		expect(formatAgentTokens(1_234_567)).toBe("1.2M");
		expect(formatAgentCost(0.4123)).toBe("$0.412");
		expect(formatAgentCost(12.345)).toBe("$12.35");
		expect(formatAgentDuration(41_000)).toBe("41s");
		expect(formatAgentDuration(134_000)).toBe("2m14s");
		expect(formatAgentDuration(3_780_000)).toBe("1h03m");
	});

	it("renders columns with the model id, tokens, cost, turns, and time", () => {
		const f = fixture([
			agent("SwiftFalcon", {
				status: "running",
				endedAt: undefined,
				startedAt: NOW - 134_000,
				turns: 7,
				usage: { input: 40_000, output: 8200, cacheRead: 0, cacheWrite: 0, totalTokens: 48_200, cost: 0.121 },
			}),
		]);
		const text = f.text();
		expect(text).toMatch(/NAME\s+STATUS\s+MODEL\s+TOKENS\s+COST\s+TURNS\s+TIME/);
		const row = f.selectedLine();
		expect(row).toMatch(/▶ SwiftFalcon\s+● running\s+claude-sonnet-4-5\s+48\.2k\s+\$0\.121\s+7\/30\s+2m14s/);
		expect(row).not.toContain("anthropic/");
	});

	it("maps statuses, including busy follow-ups and parked sessions", () => {
		const f = fixture([
			agent("Queued", { status: "queued", startedAt: undefined, endedAt: undefined }),
			agent("Busy", { status: "done", busy: true }),
			agent("Done"),
			agent("Partial", { status: "partial" }),
			agent("Failed", { status: "failed" }),
			agent("Stopped", { status: "stopped" }),
			agent("Parked", { parked: true, live: false }),
		]);
		const lines = f.lines(120);
		const status = (name: string) => lines.find((line) => line.slice(2).startsWith(`${name} `)) ?? "";
		expect(status("Queued")).toContain("◌ queued");
		expect(status("Busy")).toContain("● running");
		expect(status("Done")).toContain("✓ done");
		expect(status("Partial")).toContain("◐ partial");
		expect(status("Failed")).toContain("✗ failed");
		expect(status("Stopped")).toContain("■ stopped");
		expect(status("Parked")).toContain("✓ done (parked)");
	});

	it("shows header totals by display status", () => {
		const usage = (input: number, output: number, cacheRead: number, cost: number) => ({
			input,
			output,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + output + cacheRead,
			cost,
		});
		const f = fixture([
			agent("A", { status: "running", endedAt: undefined, usage: usage(100_000, 10_000, 50_000, 0.2) }),
			agent("B", { busy: true, usage: usage(20_000, 5_000, 12_400, 0.1) }),
			agent("C", { usage: usage(0, 6_000, 0, 0.112) }),
			agent("D", { status: "failed", usage: usage(0, 0, 0, 0) }),
		]);
		const header = f.lines(120)[0];
		expect(header).toContain("Agents  2 running · 1 done · 1 failed");
		expect(header).toContain("tokens 182.4k in / 21.0k out   $0.412");
	});

	it("orders the tree with branch prefixes, activity rails, and parent lookup", () => {
		const f = fixture([
			agent("Root", { status: "running", endedAt: undefined, activity: 'rg -n "parseArgs"' }),
			agent("Other"),
			agent("ChildA", { parentId: "Root", createdAt: NOW - 50_000 }),
			agent("ChildB", { parentId: "Root", createdAt: NOW - 40_000 }),
			agent("Grand", { parentId: "ChildA", createdAt: NOW - 30_000 }),
		]);
		const lines = f.lines(100);
		const index = (pattern: string) => lines.findIndex((line) => line.includes(pattern));
		expect(index("Root ")).toBeLessThan(index("│ cell: rg -n"));
		expect(lines[index("│ cell:")]).toMatch(/^ {2}│ cell: rg -n "parseArgs"/);
		expect(lines[index("ChildA")]).toMatch(/^ {2}├ ChildA/);
		expect(lines[index("Grand")]).toMatch(/^ {2}│ └ Grand/);
		expect(lines[index("ChildB")]).toMatch(/^ {2}└ ChildB/);
		expect(index("ChildB")).toBeLessThan(index("Other"));

		f.dashboard.handleInput(DOWN);
		f.dashboard.handleInput(DOWN);
		f.dashboard.handleInput("\t");
		expect(f.text(100)).toMatch(/Parent\s+ChildA/);
		f.dashboard.handleInput(ESC);
		f.dashboard.handleInput("\x1b[H");
		f.dashboard.handleInput("\t");
		expect(f.text(100)).toMatch(/Parent\s+main session/);
	});

	it("flat view puts running agents first, then newest", () => {
		const f = fixture([
			agent("Old", { createdAt: NOW - 90_000 }),
			agent("Run", { status: "running", endedAt: undefined, createdAt: NOW - 95_000 }),
			agent("New", { parentId: "Old", createdAt: NOW - 10_000 }),
		]);
		f.dashboard.handleInput("t");
		const names = f
			.lines()
			.slice(2)
			.map((line) => line.slice(2).split(/\s+/)[0])
			.filter((name) => ["Old", "Run", "New"].includes(name));
		expect(names).toEqual(["Run", "New", "Old"]);
		expect(f.text()).not.toContain("└");
	});

	it("keeps the selection on the same agent across reorders and removals", () => {
		const agents = [agent("A"), agent("B"), agent("C")];
		const f = fixture(agents);
		f.dashboard.handleInput(DOWN);
		expect(f.selectedLine()).toMatch(/^▶ B/);
		f.update([agents[2], agents[1], agents[0]].map((info) => ({ ...info })));
		expect(f.selectedLine()).toMatch(/^▶ B/);
		expect(f.tui.requestRender).toHaveBeenCalled();
		f.dashboard.handleInput("t");
		expect(f.selectedLine()).toMatch(/^▶ B/);
		f.update([agents[0], agents[2]]);
		expect(f.selectedLine()).toMatch(/^▶ (A|C)/);
		// Flat -> chart -> tree.
		f.dashboard.handleInput("t");
		f.dashboard.handleInput("t");
		f.dashboard.handleInput("\x1b[F");
		expect(f.selectedLine()).toMatch(/^▶ C/);
	});

	it("opens only openable agents", () => {
		const f = fixture([agent("Saved"), agent("Unsaved", { openable: false, sessionFile: undefined })]);
		f.dashboard.handleInput(ENTER);
		expect(f.actions.open).toHaveBeenCalledWith("Saved");
		f.dashboard.handleInput(DOWN);
		f.dashboard.handleInput(ENTER);
		expect(f.actions.open).toHaveBeenCalledOnce();
		expect(f.text(120)).toContain("Not saved to a session file; cannot be opened.");
		expect(f.text(120)).toMatch(/Session\s+not saved/);
	});

	it("asks for confirmation before stopping and cancels on another key", () => {
		const f = fixture([agent("Runner", { status: "running", endedAt: undefined }), agent("Finished")]);
		f.dashboard.handleInput("x");
		expect(f.lines().at(-1)).toContain("Press x again to stop Runner");
		f.dashboard.handleInput(ESC);
		expect(f.actions.close).not.toHaveBeenCalled();
		expect(f.text()).not.toContain("Press x again");
		f.dashboard.handleInput("x");
		f.dashboard.handleInput("x");
		expect(f.actions.stop).toHaveBeenCalledExactlyOnceWith("Runner");
		f.dashboard.handleInput(DOWN);
		f.dashboard.handleInput("x");
		f.dashboard.handleInput("x");
		expect(f.actions.stop).toHaveBeenCalledOnce();
		expect(f.text()).not.toContain("Press x again");
		// A key pressed during the confirmation only cancels it.
		f.dashboard.handleInput(UP);
		f.dashboard.handleInput("x");
		f.dashboard.handleInput(ENTER);
		expect(f.actions.open).not.toHaveBeenCalled();
		expect(f.text()).not.toContain("Press x again");
	});

	it("shows details beside the list on wide terminals and as a toggled view on narrow ones", () => {
		const f = fixture([
			agent("Viewer", {
				promptable: false,
				parked: true,
				status: "partial",
				stopReason: "turn budget",
				error: "boom",
			}),
		]);
		const wide = f.lines(140);
		expect(wide[1]).toMatch(/NAME.*│ Viewer/);
		expect(wide[2]).toMatch(/^▶ Viewer.*│ Status/);
		const wideText = f.text(200);
		expect(wideText).toContain("anthropic/claude-sonnet-4-5");
		expect(wideText).toContain("◐ partial (parked) · turn budget");
		expect(wideText).toContain("Read-only: its workspace result was already returned to the parent.");
		expect(wideText).toContain("Parked: opening reloads it from its session file.");
		expect(wideText).toMatch(/Tokens\s+in 1\.0k · out 200 · cache read 500 · cache write 0/);
		expect(wideText).toMatch(/Turns\s+3\/30/);
		expect(wideText).toMatch(/Elapsed\s+42s/);

		expect(f.text(80)).not.toContain("Read-only");
		f.dashboard.handleInput("\t");
		const narrow = f.text(80);
		expect(narrow).toContain("Read-only");
		expect(narrow).not.toContain("NAME");
		expect(f.lines(80).at(-1)).toContain("esc back");
		f.dashboard.handleInput(ESC);
		expect(f.actions.close).not.toHaveBeenCalled();
		expect(f.text(80)).toContain("NAME");
		f.dashboard.handleInput(ESC);
		expect(f.actions.close).toHaveBeenCalledOnce();
	});

	it("shows the steering hint for promptable agents", () => {
		const f = fixture([agent("Talk")]);
		expect(f.text(200)).toContain("Enter opens this session. Type to steer it; Esc returns.");
		expect(f.lines(140).at(-1)).toContain("enter open session · tab details · t flat view · esc close");
	});

	it("escapes control and bidi characters from agent text", () => {
		const evil = "\x1b]0;pwn\x07\x1b[2J\u202ehidden\u2066\x9b";
		const f = fixture([
			agent(`Name${evil}`, {
				id: "x",
				status: "running",
				endedAt: undefined,
				task: `Task${evil}`,
				activity: `act${evil}`,
				error: `err${evil}`,
				model: `p/m${evil}`,
				stopReason: `why${evil}`,
			}),
		]);
		for (const width of [60, 140]) {
			f.dashboard.handleInput("\t");
			const raw = [...f.dashboard.render(width), ...f.dashboard.render(80)].join("\n");
			expect(raw).not.toContain("\x1b]0;");
			expect(raw).not.toContain("\x1b[2J");
			expect(raw).not.toContain("\x07");
			expect(raw).not.toMatch(/[\u202a-\u202e\u2066-\u2069\x9b]/);
		}
		expect(f.text(140)).toContain("\\u001b]0;pwn");
	});

	it("shows an empty state", () => {
		const f = fixture([]);
		expect(f.text()).toContain("No subagents yet. Agents started by rlm_query appear here.");
		f.dashboard.handleInput(ENTER);
		f.dashboard.handleInput("x");
		f.dashboard.handleInput("\t");
		expect(f.actions.open).not.toHaveBeenCalled();
		expect(f.actions.stop).not.toHaveBeenCalled();
	});

	it("renders exactly rows lines of exactly width columns at every size", () => {
		const agents = Array.from({ length: 40 }, (_, index) =>
			agent(`Agent${index}`, {
				parentId: index > 0 && index % 3 ? `Agent${index - 1}` : undefined,
				status: index % 2 ? "running" : "done",
				endedAt: index % 2 ? undefined : NOW,
				activity: "long activity ".repeat(20),
				task: "wrapped task ".repeat(40),
				error: index % 5 ? undefined : "error ".repeat(50),
			}),
		);
		const f = fixture(agents);
		for (const rows of [0, 1, 2, 3, 4, 5, 12, 40]) {
			f.tui.terminal.rows = rows;
			for (const width of [0, 1, 2, 5, 13, 20, 60, 109, 110, 200]) {
				for (const mode of [false, true]) {
					if (mode) f.dashboard.handleInput("\t");
					const lines = f.dashboard.render(width);
					expect(lines).toHaveLength(rows);
					for (const line of lines) expect(visibleWidth(line)).toBe(width);
					if (mode) f.dashboard.handleInput("\t");
				}
				f.dashboard.handleInput("x");
				f.dashboard.handleInput("\x1b[6~");
				expect(f.dashboard.render(width).every((line) => visibleWidth(line) === width)).toBe(true);
			}
		}
	});

	it("scrolls to keep the selection visible", () => {
		const f = fixture(
			Array.from({ length: 30 }, (_, index) => agent(`A${String(index).padStart(2, "0")}`)),
			10,
		);
		f.dashboard.handleInput("\x1b[F");
		expect(f.selectedLine()).toMatch(/^▶ A29/);
		f.dashboard.handleInput(UP);
		expect(f.selectedLine()).toMatch(/^▶ A28/);
		f.dashboard.handleInput("\x1b[5~");
		expect(f.selectedLine()).toMatch(/^▶ A21/);
		f.dashboard.handleInput("\x1b[H");
		expect(f.selectedLine()).toMatch(/^▶ A00/);
	});

	it("re-renders while agents run, and dispose cleans up idempotently", () => {
		const f = fixture([agent("Run", { status: "running", endedAt: undefined })]);
		expect(f.listeners.size).toBe(1);
		f.tui.requestRender.mockClear();
		vi.advanceTimersByTime(3000);
		expect(f.tui.requestRender).toHaveBeenCalledTimes(3);
		f.update([agent("Run")]);
		f.tui.requestRender.mockClear();
		vi.advanceTimersByTime(3000);
		expect(f.tui.requestRender).not.toHaveBeenCalled();
		f.update([agent("Run", { busy: true })]);
		f.dashboard.dispose();
		f.dashboard.dispose();
		expect(f.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		f.tui.requestRender.mockClear();
		f.dashboard.handleInput(ENTER);
		f.dashboard.handleInput(ESC);
		vi.advanceTimersByTime(3000);
		expect(f.actions.open).not.toHaveBeenCalled();
		expect(f.actions.close).not.toHaveBeenCalled();
		expect(f.tui.requestRender).not.toHaveBeenCalled();
	});

	describe("chart view", () => {
		const LEFT = "\x1b[D";
		const RIGHT = "\x1b[C";
		const family = () => [
			agent("Alpha", { createdAt: NOW - 50_000 }),
			agent("Beta", { createdAt: NOW - 40_000 }),
			agent("Kid", { parentId: "Alpha", createdAt: NOW - 30_000 }),
			agent("Kid2", { parentId: "Alpha", createdAt: NOW - 20_000 }),
		];
		/** The name of the selected box: the details panel's first line names it. */
		const selected = (f: ReturnType<typeof fixture>) => {
			const line = f.lines(140).find((text) => /│ (Alpha|Beta|Kid2?)\s*$/.test(text)) ?? "";
			return /│ (\w+)\s*$/.exec(line)?.[1];
		};

		it("opens in the chart with the session as depth 0", () => {
			const f = fixture(family(), 40, "chart");
			const text = f.text(140);
			expect(text).toContain("main session · 4 agents");
			expect(f.lines(140).some((line) => line.startsWith("D0"))).toBe(true);
			expect(f.lines(140).some((line) => line.startsWith("D2"))).toBe(true);
			expect(f.lines(140).at(-1)).toContain("t tree view");
		});

		it("cycles chart, tree, and flat with t", () => {
			const f = fixture(family(), 40, "chart");
			f.dashboard.handleInput("t");
			expect(f.text(140)).toContain("└ Kid2");
			expect(f.lines(140).at(-1)).toContain("t flat view");
			f.dashboard.handleInput("t");
			expect(f.lines(140).at(-1)).toContain("t chart view");
			f.dashboard.handleInput("t");
			expect(f.text(140)).toContain("main session · 4 agents");
		});

		it("moves along the tree: down to a child, sideways at one depth, up to the parent", () => {
			const f = fixture(family(), 40, "chart");
			expect(selected(f)).toBe("Alpha");
			f.dashboard.handleInput(RIGHT);
			expect(selected(f)).toBe("Beta");
			f.dashboard.handleInput(DOWN);
			expect(selected(f)).toBe("Beta");
			f.dashboard.handleInput(LEFT);
			f.dashboard.handleInput(DOWN);
			expect(selected(f)).toBe("Kid");
			f.dashboard.handleInput(RIGHT);
			expect(selected(f)).toBe("Kid2");
			f.dashboard.handleInput(UP);
			expect(selected(f)).toBe("Alpha");
			f.dashboard.handleInput(UP);
			expect(selected(f)).toBe("Alpha");
			f.dashboard.handleInput(ENTER);
			expect(f.actions.open).toHaveBeenCalledWith("Alpha");
		});

		it("scrolls sideways to keep the selected box visible", () => {
			const agents = Array.from({ length: 8 }, (_, index) =>
				agent(`Agent${index}`, { createdAt: NOW - 1000 + index }),
			);
			const f = fixture(agents, 30, "chart");
			expect(f.text(80)).toContain("Agent0");
			f.dashboard.handleInput("\x1b[F");
			const text = f.text(80);
			expect(text).toContain("Agent7");
			expect(text).not.toContain("Agent0");
			expect(f.lines(80).every((line) => visibleWidth(line) <= 80)).toBe(true);
		});

		it("shows the session box and a hint when there are no subagents", () => {
			const f = fixture([], 30, "chart");
			const text = f.text(100);
			expect(text).toContain("main session · 0 agents");
			expect(text).toContain("No subagents yet");
		});
	});
});
