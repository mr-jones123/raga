/**
 * Top-down tree chart of one session's subagents for `/agents-tui`: the session itself as the depth-0 box,
 * each subagent as a box under its parent, joined by connectors. Drawn on a cell canvas so colors never
 * split a box-drawing run, then styled with theme tokens when a viewport is rendered.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ChildAgentInfo } from "../../../core/rlm/child-agents.ts";
import type { Theme, ThemeBg, ThemeColor } from "../theme/theme.ts";
import { displayStatus, formatAgentCost, formatAgentTokens, modelId, oneLine, STATUS } from "./format.ts";

/** Columns of the pinned `D0`, `D1`, ... gutter left of the chart. */
export const CHART_GUTTER = 4;
const GAP = 2;
const BOX_MAX = 34;
const ROOT_ROWS = 3;
/** One bar row above each box, then a five-row box: border, name, status, usage, border. */
const BAND_ROWS = 6;
const BOX_ROWS = 5;

interface Cell {
	ch: string;
	fg?: ThemeColor;
	bg?: ThemeBg;
	bold?: boolean;
}
type Style = Omit<Cell, "ch">;

export interface ChartNode {
	/** Left column and top row of the box, in chart coordinates (gutter excluded). */
	x: number;
	y: number;
	w: number;
	h: number;
	/** 1 for children of the session; the session itself is depth 0 and has no node. */
	depth: number;
	parent?: string;
	children: string[];
}

export interface AgentTreeChart {
	/** Chart size without the gutter. */
	width: number;
	height: number;
	nodes: Map<string, ChartNode>;
	/** Ids of each depth left to right; index 0 holds the session's children (depth 1). */
	levels: string[][];
	/** The gutter plus `cols` chart columns from `scrollX` for `rows` rows from `scrollY`. */
	render(scrollX: number, scrollY: number, cols: number, rows: number): string[];
}

interface Layout {
	id?: string;
	info?: ChildAgentInfo;
	children: Layout[];
	boxW: number;
	treeW: number;
	x: number;
	depth: number;
}

/** Text reduced to single-column characters and cut to `max` columns. */
function cut(text: string, max: number): string {
	// ponytail: wide or zero-width graphemes become "?" so every canvas cell is one column; render them
	// properly if agent names start using non-Latin scripts.
	const chars = Array.from(oneLine(text), (ch) => (visibleWidth(ch) === 1 ? ch : "?"));
	if (chars.length <= max) return chars.join("");
	return max <= 0 ? "" : `${chars.slice(0, max - 1).join("")}…`;
}

function statusText(info: ChildAgentInfo): string {
	const status = displayStatus(info);
	return `${STATUS[status].glyph} ${status}${info.parked ? " (parked)" : ""} · ${modelId(info.model)}`;
}
function usageText(info: ChildAgentInfo): string {
	return `${formatAgentTokens(info.usage.totalTokens)} · ${formatAgentCost(info.usage.cost)} · ${info.turns}/${info.maxTurns}`;
}

export function buildAgentTreeChart(options: {
	agents: ChildAgentInfo[];
	rootLabel: string;
	selectedId?: string;
	theme: Theme;
}): AgentTreeChart {
	const { agents, selectedId, theme } = options;
	const ids = new Set(agents.map((info) => info.id));
	const kids = new Map<string | undefined, ChildAgentInfo[]>();
	for (const info of agents) {
		const parent = info.parentId && info.parentId !== info.id && ids.has(info.parentId) ? info.parentId : undefined;
		kids.set(parent, [...(kids.get(parent) ?? []), info]);
	}
	const rootLabel = `${cut(options.rootLabel, BOX_MAX)} · ${agents.length} agent${agents.length === 1 ? "" : "s"}`;
	const seen = new Set<string>();
	const boxWidth = (info: ChildAgentInfo) =>
		Math.min(
			BOX_MAX,
			4 + Math.max(visibleWidth(cut(info.name, 99)), statusText(info).length, usageText(info).length),
		);
	const build = (info: ChildAgentInfo | undefined, depth: number): Layout => {
		if (info) seen.add(info.id);
		const children = (kids.get(info?.id) ?? [])
			.filter((kid) => !seen.has(kid.id))
			.map((kid) => {
				seen.add(kid.id);
				return kid;
			})
			.map((kid) => build(kid, depth + 1));
		const boxW = info ? boxWidth(info) : Math.min(BOX_MAX + 12, rootLabel.length + 4);
		const span = children.reduce((sum, child) => sum + child.treeW, 0) + GAP * Math.max(0, children.length - 1);
		return { id: info?.id, info, children, boxW, treeW: Math.max(boxW, span), x: 0, depth };
	};
	const root = build(undefined, 0);
	// A parent cycle has no path from the session; show its members under the session rather than hide them.
	for (const info of agents) if (!seen.has(info.id)) root.children.push(build(info, 1));
	root.treeW = Math.max(
		root.boxW,
		root.children.reduce((sum, child) => sum + child.treeW, 0) + GAP * Math.max(0, root.children.length - 1),
	);

	const center = (node: Layout) => node.x + Math.floor(node.boxW / 2);
	const place = (node: Layout, left: number) => {
		const span = node.children.reduce((sum, child) => sum + child.treeW, 0) + GAP * (node.children.length - 1);
		let childLeft = left + Math.floor((node.treeW - span) / 2);
		for (const child of node.children) {
			place(child, childLeft);
			childLeft += child.treeW + GAP;
		}
		const wanted = node.children.length
			? Math.floor((center(node.children[0]) + center(node.children[node.children.length - 1])) / 2) -
				Math.floor(node.boxW / 2)
			: left + Math.floor((node.treeW - node.boxW) / 2);
		node.x = Math.max(left, Math.min(left + node.treeW - node.boxW, wanted));
	};
	place(root, 0);

	const levels: string[][] = [];
	const nodes = new Map<string, ChartNode>();
	let maxDepth = 0;
	const index = (node: Layout, parent?: string) => {
		maxDepth = Math.max(maxDepth, node.depth);
		if (node.id) {
			nodes.set(node.id, {
				x: node.x,
				y: boxTop(node.depth),
				w: node.boxW,
				h: BOX_ROWS,
				depth: node.depth,
				parent,
				children: node.children.map((child) => child.id ?? ""),
			});
			let level = levels[node.depth - 1];
			if (!level) {
				level = [];
				levels[node.depth - 1] = level;
			}
			level.push(node.id);
		}
		for (const child of node.children) index(child, node.id);
	};
	index(root);

	const width = root.treeW;
	const height = maxDepth === 0 ? ROOT_ROWS : boxTop(maxDepth) + BOX_ROWS;
	const canvas: Cell[][] = Array.from({ length: height }, () =>
		Array.from({ length: CHART_GUTTER + width }, () => ({ ch: " " })),
	);
	const put = (x: number, y: number, ch: string, style: Style = {}) => {
		const row = canvas[y];
		if (row && x >= 0 && x < width) row[CHART_GUTTER + x] = { ch, ...style };
	};
	const write = (x: number, y: number, text: string, style: Style = {}) => {
		Array.from(text).forEach((ch, offset) => {
			put(x + offset, y, ch, style);
		});
	};
	const gutter = (y: number, depth: number) => {
		Array.from(`D${depth}`).forEach((ch, offset) => {
			const row = canvas[y];
			if (row && offset < CHART_GUTTER - 1) row[offset] = { ch, fg: "dim" };
		});
	};
	const line = "borderMuted" as const;

	const drawBox = (node: Layout) => {
		const { x, boxW: w } = node;
		const info = node.info;
		if (!info) {
			const style: Style = { fg: "accent", bold: true };
			write(x, 0, `┏${"━".repeat(w - 2)}┓`, style);
			write(x, 1, "┃", style);
			write(x + w - 1, 1, "┃", style);
			write(x + 2, 1, cut(rootLabel, w - 4), { bold: true });
			write(x, 2, `┗${"━".repeat(w - 2)}┛`, style);
			if (node.children.length) put(center(node), 2, "┯", style);
			gutter(1, 0);
			return;
		}
		const y = boxTop(node.depth);
		const selected = info.id === selectedId;
		const color = STATUS[displayStatus(info)].color;
		const border: Style = { fg: color, bold: selected };
		const fill: Style = selected ? { bg: "selectedBg" } : {};
		write(x, y, `╭${"─".repeat(w - 2)}╮`, border);
		write(x, y + 4, `╰${"─".repeat(w - 2)}╯`, border);
		for (let row = 1; row <= 3; row++) {
			put(x, y + row, "│", border);
			put(x + w - 1, y + row, "│", border);
			write(x + 1, y + row, " ".repeat(w - 2), fill);
		}
		put(center(node), y, "┴", border);
		if (node.children.length) put(center(node), y + 4, "┬", border);
		const inner = w - 4;
		const centered = (row: number, parts: { text: string; style: Style }[]) => {
			let budget = inner;
			const cutParts = parts.map((part) => {
				const text = cut(part.text, budget);
				budget -= text.length;
				return { ...part, text };
			});
			let col = x + 2 + Math.floor((inner - (inner - budget)) / 2);
			for (const part of cutParts) {
				write(col, y + row, part.text, { ...fill, ...part.style });
				col += part.text.length;
			}
		};
		centered(1, [{ text: info.name, style: selected ? { fg: "accent", bold: true } : { fg: "text", bold: true } }]);
		const status = displayStatus(info);
		const head = `${STATUS[status].glyph} ${status}${info.parked ? " (parked)" : ""}`;
		centered(2, [
			{ text: head, style: { fg: color } },
			{ text: ` · ${modelId(info.model)}`, style: { fg: "muted" } },
		]);
		centered(3, [{ text: usageText(info), style: { fg: "muted" } }]);
		gutter(y + 1, node.depth);
	};

	const drawBar = (node: Layout) => {
		if (!node.children.length) return;
		const y = boxTop(node.depth + 1) - 1;
		const from = center(node);
		const centers = node.children.map(center);
		const left = Math.min(from, ...centers);
		const right = Math.max(from, ...centers);
		for (let col = left; col <= right; col++) put(col, y, "─", { fg: line });
		for (const col of centers) put(col, y, col === left ? "┌" : col === right ? "┐" : "┬", { fg: line });
		const down = centers.includes(from);
		const up = from === left ? (down ? "├" : "└") : from === right ? (down ? "┤" : "┘") : down ? "┼" : "┴";
		put(from, y, left === right ? "│" : up, { fg: line });
	};

	const draw = (node: Layout) => {
		drawBox(node);
		drawBar(node);
		for (const child of node.children) draw(child);
	};
	draw(root);

	const styled = (cells: Cell[]) => {
		let out = "";
		let run = "";
		let style: Style | undefined;
		const flush = () => {
			if (!run || !style) return;
			out += style.fg || style.bg || style.bold ? theme.style(run, style) : run;
			run = "";
		};
		for (const cell of cells) {
			const { ch, ...next } = cell;
			if (!style || style.fg !== next.fg || style.bg !== next.bg || style.bold !== next.bold) {
				flush();
				style = next;
			}
			run += ch;
		}
		flush();
		return out;
	};

	return {
		width,
		height,
		nodes,
		levels,
		render(scrollX, scrollY, cols, rows) {
			const view = Math.max(0, cols - CHART_GUTTER);
			return canvas.slice(scrollY, scrollY + rows).map((row) => {
				const body = row.slice(CHART_GUTTER + scrollX, CHART_GUTTER + scrollX + view);
				return styled([...row.slice(0, Math.min(CHART_GUTTER, cols)), ...body]);
			});
		},
	};
}

function boxTop(depth: number): number {
	return depth === 0 ? 0 : ROOT_ROWS + (depth - 1) * BAND_ROWS + 1;
}
