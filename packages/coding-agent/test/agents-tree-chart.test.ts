import { stripVTControlCharacters } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChildAgentInfo } from "../src/core/rlm/child-agents.ts";
import { buildAgentTreeChart, CHART_GUTTER } from "../src/modes/interactive/agents/tree-chart.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

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
		createdAt: 0,
		lastActivityAt: 0,
		turns: 3,
		maxTurns: 30,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1700, cost: 0.0123 },
		live: true,
		parked: false,
		openable: true,
		promptable: true,
		...overrides,
	};
}

function chart(agents: ChildAgentInfo[], selectedId?: string) {
	const built = buildAgentTreeChart({ agents, rootLabel: "main session", selectedId, theme });
	const raw = built.render(0, 0, CHART_GUTTER + built.width, built.height);
	return { built, raw, lines: raw.map(stripVTControlCharacters) };
}

/** The visible line holding `text`, and the column where it starts. */
function find(lines: string[], text: string): { row: number; col: number } {
	const row = lines.findIndex((line) => line.includes(text));
	return { row, col: row < 0 ? -1 : lines[row].indexOf(text) };
}

beforeEach(() => {
	initTheme("dark");
});

describe("agent tree chart", () => {
	it("draws the session as depth 0 and each generation in its own depth band", () => {
		const { lines, built } = chart([agent("Alpha"), agent("Beta"), agent("Gamma", { parentId: "Alpha", depth: 2 })]);
		const root = find(lines, "main session · 3 agents");
		const alpha = find(lines, "Alpha");
		const beta = find(lines, "Beta");
		const gamma = find(lines, "Gamma");
		expect(lines[root.row].startsWith("D0")).toBe(true);
		expect(lines[alpha.row].startsWith("D1")).toBe(true);
		expect(alpha.row).toBe(beta.row);
		expect(lines[gamma.row].startsWith("D2")).toBe(true);
		expect(root.row).toBeLessThan(alpha.row);
		expect(alpha.row).toBeLessThan(gamma.row);
		expect(built.levels).toEqual([["Alpha", "Beta"], ["Gamma"]]);
		expect(built.nodes.get("Gamma")?.parent).toBe("Alpha");
		expect(built.nodes.get("Alpha")?.children).toEqual(["Gamma"]);
	});

	it("joins a parent to its children through its center column", () => {
		const { lines, built } = chart([agent("Alpha"), agent("Beta"), agent("Gamma")]);
		const rootBottom = lines.findIndex((line) => line.includes("┗"));
		const joint = lines[rootBottom].indexOf("┯");
		expect(joint).toBeGreaterThan(0);
		// The bar row under the session meets it in the same column, and reaches every child's center.
		const bar = lines[rootBottom + 1];
		// `┼` when the middle child sits right under the parent.
		expect("┴┼".includes(bar[joint])).toBe(true);
		for (const id of ["Alpha", "Beta", "Gamma"]) {
			const node = built.nodes.get(id);
			if (!node) throw new Error(`no node for ${id}`);
			const center = CHART_GUTTER + node.x + Math.floor(node.w / 2);
			expect("┌┬┐┼".includes(bar[center])).toBe(true);
			expect(lines[node.y][center]).toBe("┴");
		}
	});

	it("shows status, model, tokens, cost, and turns inside each box", () => {
		const { lines } = chart([agent("Alpha", { status: "partial", turns: 30 })]);
		const text = lines.join("\n");
		expect(text).toContain("◐ partial · claude-sonnet-4-5");
		expect(text).toContain("1.7k · $0.012 · 30/30");
	});

	it("colors borders by status and highlights the selected box", () => {
		const { raw, built } = chart(
			[agent("Run", { busy: true }), agent("Bad", { status: "failed", parentId: "Run" })],
			"Bad",
		);
		const run = built.nodes.get("Run");
		const bad = built.nodes.get("Bad");
		if (!run || !bad) throw new Error("missing nodes");
		expect(raw[run.y]).toContain(theme.getFgAnsi("accent"));
		expect(raw[run.y]).not.toContain(theme.getFgAnsi("error"));
		expect(raw[bad.y]).toContain(theme.getFgAnsi("error"));
		expect(raw[bad.y + 1]).toContain(theme.getBgAnsi("selectedBg"));
		expect(raw[run.y + 1]).not.toContain(theme.getBgAnsi("selectedBg"));
	});

	it("attaches orphans and parent cycles to the session instead of hiding them", () => {
		const { built, lines } = chart([
			agent("Orphan", { parentId: "gone" }),
			agent("LoopA", { parentId: "LoopB" }),
			agent("LoopB", { parentId: "LoopA" }),
		]);
		const text = lines.join("\n");
		for (const name of ["Orphan", "LoopA", "LoopB"]) expect(text).toContain(name);
		expect(built.nodes.size).toBe(3);
	});

	it("escapes control characters in agent names", () => {
		const { raw } = chart([agent("Evil\x1b]0;pwned\x07Name")]);
		expect(raw.join("")).not.toContain("\x07");
		expect(raw.join("")).not.toContain("\x1b]0;");
	});

	it("renders a horizontal window and keeps the depth gutter pinned", () => {
		const agents = Array.from({ length: 6 }, (_, index) => agent(`Agent${index}`));
		const { built } = chart(agents);
		const last = built.nodes.get("Agent5");
		if (!last) throw new Error("no node for Agent5");
		const cols = 40;
		const view = built.render(last.x, 0, cols, built.height).map(stripVTControlCharacters);
		const nameRow = view[last.y + 1];
		expect(nameRow.startsWith("D1")).toBe(true);
		expect(nameRow).toContain("Agent5");
		expect(view.every((line) => line.length <= cols)).toBe(true);
	});
});
