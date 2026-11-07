import { type Component, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { ChildAgentInfo } from "../../../core/rlm/child-agents.ts";
import type { Theme } from "../theme/theme.ts";
import {
	active,
	type DisplayStatus,
	displayStatus,
	formatAgentCost,
	formatAgentDuration,
	formatAgentTokens,
	modelId,
	oneLine,
	STATUS,
	safe,
} from "./format.ts";
import { type AgentTreeChart, buildAgentTreeChart, CHART_GUTTER } from "./tree-chart.ts";

export { formatAgentCost, formatAgentDuration, formatAgentTokens } from "./format.ts";

/** Live view of the child registry; `list()` returns copies, `subscribe()` fires on every change. */
export interface AgentsDashboardSource {
	list(): ChildAgentInfo[];
	subscribe(listener: () => void): () => void;
	/** The session's name for the chart's depth-0 box. */
	rootLabel(): string;
}

type View = "chart" | "tree" | "flat";
const NEXT_VIEW: Record<View, View> = { chart: "tree", tree: "flat", flat: "chart" };

export interface AgentsDashboardActions {
	/** Open the child's real session. Called only for openable children. */
	open(id: string): void;
	/** Stop the child's current work. Called only after a confirmed stop. */
	stop(id: string): void;
	close(): void;
}

interface Row {
	info: ChildAgentInfo;
	/** Tree branch drawn before the name, such as `│ └ `. Empty in flat view and for roots. */
	prefix: string;
	/** Rails continued below this row, used to indent its activity line. */
	rail: string;
}

interface Column {
	key: "status" | "model" | "tokens" | "cost" | "turns" | "time";
	label: string;
	right: boolean;
	width: number;
	cell: (row: Row) => string;
}

/** Width at which the details panel moves beside the list instead of replacing it. */
const SIDE_DETAILS_WIDTH = 110;
const NAME_MAX = 28;
const MODEL_MIN = 8;
const MODEL_MAX = 24;
const GAP = 2;
const MARKER = 2;
const LABEL = 10;

const STATUS_ORDER: DisplayStatus[] = ["running", "queued", "done", "partial", "stopped", "failed"];

function elapsed(info: ChildAgentInfo, now: number): number {
	const start = info.startedAt ?? info.createdAt;
	// The run's own time: a later user follow-up does not stretch it.
	const end = info.status === "queued" || info.status === "running" ? now : (info.endedAt ?? info.lastActivityAt);
	return Math.max(0, end - start);
}
function clock(time: number): string {
	const date = new Date(time);
	return [date.getHours(), date.getMinutes(), date.getSeconds()]
		.map((part) => String(part).padStart(2, "0"))
		.join(":");
}

/** Clip or pad styled text to exactly `width` columns. */
function fitWidth(text: string, width: number, right = false, ellipsis = "…"): string {
	if (width <= 0) return "";
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, ellipsis) : text;
	const space = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return right ? space + clipped : clipped + space;
}

/**
 * Fullscreen dashboard over the live child registry. Each row is a real child session; opening it hands
 * the id to `actions.open`, which shows that session itself.
 */
export class AgentsDashboard implements Component {
	private readonly source: AgentsDashboardSource;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly actions: AgentsDashboardActions;
	private agents: ChildAgentInfo[] = [];
	private rows: Row[] = [];
	private selectedId: string | undefined;
	private view: View = "chart";
	private chartScroll = { x: 0, y: 0 };
	private narrowDetails = false;
	private sideHidden = false;
	private confirmStopId: string | undefined;
	private scroll = 0;
	private lastWidth = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private unsubscribe: (() => void) | undefined;
	private disposed = false;

	constructor(
		source: AgentsDashboardSource,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		actions: AgentsDashboardActions,
	) {
		this.source = source;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.actions = actions;
		this.unsubscribe = source.subscribe(() => {
			if (this.disposed) return;
			this.refresh();
			this.tui.requestRender();
		});
		this.refresh();
	}

	invalidate(): void {
		// Styling is computed on every render; no cached state depends on the theme.
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.stopTimer();
	}

	private refresh(): void {
		const previous = this.rows.findIndex((row) => row.info.id === this.selectedId);
		this.agents = this.source.list();
		this.order();
		if (!this.rows.some((row) => row.info.id === this.selectedId)) {
			const index = Math.max(0, Math.min(this.rows.length - 1, previous));
			this.selectedId = this.rows[index]?.info.id;
		}
		const confirming = this.agents.find((info) => info.id === this.confirmStopId);
		if (!confirming || !active(confirming)) this.confirmStopId = undefined;
		if (this.agents.some(active)) {
			if (!this.timer) {
				this.timer = setInterval(() => {
					if (!this.disposed) this.tui.requestRender();
				}, 1000);
				this.timer.unref?.();
			}
		} else this.stopTimer();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private order(): void {
		if (this.view === "flat") {
			const sorted = this.agents
				.map((info, index) => ({ info, index }))
				.sort(
					(a, b) =>
						Number(displayStatus(b.info) === "running") - Number(displayStatus(a.info) === "running") ||
						b.info.createdAt - a.info.createdAt ||
						b.index - a.index,
				);
			this.rows = sorted.map(({ info }) => ({ info, prefix: "", rail: "" }));
			return;
		}
		const ids = new Set(this.agents.map((info) => info.id));
		const children = new Map<string, ChildAgentInfo[]>();
		const roots: ChildAgentInfo[] = [];
		for (const info of this.agents) {
			if (info.parentId && info.parentId !== info.id && ids.has(info.parentId)) {
				const list = children.get(info.parentId) ?? [];
				list.push(info);
				children.set(info.parentId, list);
			} else roots.push(info);
		}
		const rows: Row[] = [];
		const seen = new Set<string>();
		const visit = (info: ChildAgentInfo, rails: string, branch: "" | "├ " | "└ ") => {
			if (seen.has(info.id)) return;
			seen.add(info.id);
			const rail = rails + (branch === "├ " ? "│ " : branch === "└ " ? "  " : "");
			rows.push({ info, prefix: rails + branch, rail });
			const kids = (children.get(info.id) ?? []).filter((kid) => !seen.has(kid.id));
			kids.forEach((kid, index) => {
				visit(kid, rail, index === kids.length - 1 ? "└ " : "├ ");
			});
		};
		for (const root of roots) visit(root, "", "");
		// A parent cycle has no root; show its members rather than hiding them.
		for (const info of this.agents) visit(info, "", "");
		this.rows = rows;
	}

	private selectedIndex(): number {
		return this.rows.findIndex((row) => row.info.id === this.selectedId);
	}

	private select(index: number): void {
		if (!this.rows.length) return;
		this.selectedId = this.rows[Math.max(0, Math.min(this.rows.length - 1, index))].info.id;
	}

	private wide(width = this.lastWidth): boolean {
		return width >= SIDE_DETAILS_WIDTH;
	}

	/** Lines between the header and the footer. */
	private mainHeight(): number {
		return Math.max(0, Math.floor(this.tui.terminal.rows) - 2);
	}

	private page(): number {
		return Math.max(1, this.mainHeight() - 1);
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.keybindings;
		const selected = this.rows[this.selectedIndex()]?.info;
		if (kb.matches(data, "app.agents.stop")) {
			if (!selected || !active(selected)) {
				this.confirmStopId = undefined;
			} else if (this.confirmStopId === selected.id) {
				this.confirmStopId = undefined;
				this.actions.stop(selected.id);
			} else {
				this.confirmStopId = selected.id;
			}
			this.tui.requestRender();
			return;
		}
		if (this.confirmStopId) {
			// Any other key only cancels the pending stop, as the footer says.
			this.confirmStopId = undefined;
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.narrowDetails && !this.wide()) {
				this.narrowDetails = false;
			} else {
				this.narrowDetails = false;
				this.actions.close();
				return;
			}
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (selected?.openable) {
				this.actions.open(selected.id);
				return;
			}
		} else if (kb.matches(data, "app.agents.details")) {
			if (this.wide()) this.sideHidden = !this.sideHidden;
			else this.narrowDetails = !this.narrowDetails;
		} else if (kb.matches(data, "app.agents.tree")) {
			this.view = NEXT_VIEW[this.view];
			this.order();
		} else if (this.view === "chart" && this.moveInChart(data)) {
			// Arrows follow the tree's shape in the chart.
		} else if (kb.matches(data, "tui.select.up")) this.select(this.selectedIndex() - 1);
		else if (kb.matches(data, "tui.select.down")) this.select(this.selectedIndex() + 1);
		else if (kb.matches(data, "tui.select.pageUp")) this.select(this.selectedIndex() - this.page());
		else if (kb.matches(data, "tui.select.pageDown")) this.select(this.selectedIndex() + this.page());
		else if (kb.matches(data, "app.agents.first")) this.select(0);
		else if (kb.matches(data, "app.agents.last")) this.select(this.rows.length - 1);
		this.tui.requestRender();
	}

	private chart(): AgentTreeChart {
		return buildAgentTreeChart({
			agents: this.agents,
			rootLabel: this.source.rootLabel(),
			selectedId: this.selectedId,
			theme: this.theme,
		});
	}

	/** Up: parent. Down: first child. Left and right: the neighbor at the same depth. */
	private moveInChart(data: string): boolean {
		const kb = this.keybindings;
		const { nodes, levels } = this.chart();
		const node = this.selectedId ? nodes.get(this.selectedId) : undefined;
		if (!node) return false;
		let target: string | undefined;
		if (kb.matches(data, "tui.select.up")) target = node.parent;
		else if (kb.matches(data, "tui.select.down")) target = node.children[0];
		else if (kb.matches(data, "app.agents.left") || kb.matches(data, "app.agents.right")) {
			const level = levels[node.depth - 1] ?? [];
			const index = level.indexOf(this.selectedId ?? "");
			target = level[index + (kb.matches(data, "app.agents.left") ? -1 : 1)];
		} else return false;
		if (target) this.selectedId = target;
		return true;
	}

	/** The chart scrolled so the selected box is visible; the gutter stays pinned. */
	private chartView(width: number, height: number): string[] {
		const chart = this.chart();
		const cols = Math.max(0, width - CHART_GUTTER);
		const box = this.selectedId ? chart.nodes.get(this.selectedId) : undefined;
		const scroll = this.chartScroll;
		if (box) {
			if (box.x + box.w > scroll.x + cols) scroll.x = box.x + box.w - cols;
			if (box.x < scroll.x) scroll.x = box.x;
			// Keep the bar row above the box in view so the link to the parent shows.
			if (box.y + box.h > scroll.y + height) scroll.y = box.y + box.h - height;
			if (box.y - 1 < scroll.y) scroll.y = Math.max(0, box.y - 1);
		}
		scroll.x = Math.max(0, Math.min(scroll.x, chart.width - cols));
		scroll.y = Math.max(0, Math.min(scroll.y, chart.height - height));
		const lines = chart.render(scroll.x, scroll.y, width, height);
		if (!this.agents.length && lines.length < height)
			lines.push("", this.theme.fg("muted", "  No subagents yet. Agents started by rlm_query appear here."));
		return lines;
	}

	private key(action: Keybinding): string {
		const key = this.keybindings.getKeys(action)[0] ?? "unbound";
		return oneLine(key === "escape" ? "esc" : key);
	}

	private status(info: ChildAgentInfo): string {
		const status = displayStatus(info);
		const { glyph, color } = STATUS[status];
		const parked = info.parked ? this.theme.fg("dim", " (parked)") : "";
		return `${this.theme.fg(color, `${glyph} ${status}`)}${parked}`;
	}

	private header(width: number): string {
		const t = this.theme;
		const counts = new Map<DisplayStatus, number>();
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const info of this.agents) {
			const status = displayStatus(info);
			counts.set(status, (counts.get(status) ?? 0) + 1);
			input += info.usage.input + info.usage.cacheRead;
			output += info.usage.output;
			cost += info.usage.cost;
		}
		const summary = STATUS_ORDER.filter((status) => counts.get(status))
			.map((status) => t.fg(STATUS[status].color, `${counts.get(status)} ${status}`))
			.join(t.fg("dim", " · "));
		const left = ` ${t.style("Agents", { fg: "accent", bold: true })}  ${summary || t.fg("muted", "none")}`;
		const right = `${t.fg("muted", "tokens")} ${formatAgentTokens(input)} ${t.fg("muted", "in /")} ${formatAgentTokens(output)} ${t.fg("muted", "out")}   ${formatAgentCost(cost)} `;
		const space = width - visibleWidth(left) - visibleWidth(right);
		return space >= 2 ? left + " ".repeat(space) + right : left;
	}

	private columns(width: number): { nameWidth: number; columns: Column[] } {
		const now = Date.now();
		const t = this.theme;
		const nameNatural = Math.max(
			4,
			...this.rows.map((row) => visibleWidth(row.prefix) + visibleWidth(oneLine(row.info.name))),
		);
		let nameWidth = Math.min(NAME_MAX, nameNatural);
		const all: Column[] = [
			{ key: "status", label: "STATUS", right: false, width: 0, cell: (row) => this.status(row.info) },
			{
				key: "model",
				label: "MODEL",
				right: false,
				width: 0,
				cell: (row) => t.fg("muted", oneLine(modelId(row.info.model))),
			},
			{
				key: "tokens",
				label: "TOKENS",
				right: true,
				width: 0,
				cell: (row) => formatAgentTokens(row.info.usage.totalTokens),
			},
			{ key: "cost", label: "COST", right: true, width: 0, cell: (row) => formatAgentCost(row.info.usage.cost) },
			{
				key: "turns",
				label: "TURNS",
				right: true,
				width: 0,
				cell: (row) => t.fg("muted", `${row.info.turns}/${row.info.maxTurns}`),
			},
			{
				key: "time",
				label: "TIME",
				right: true,
				width: 0,
				cell: (row) => formatAgentDuration(elapsed(row.info, now)),
			},
		];
		for (const column of all) {
			column.width = Math.max(column.label.length, ...this.rows.map((row) => visibleWidth(column.cell(row))));
			if (column.key === "model") column.width = Math.min(MODEL_MAX, column.width);
		}
		const model = all[1];
		const natural = model.width;
		const need = (columns: Column[]) =>
			columns.reduce(
				(sum, column) => sum + GAP + (column === model ? Math.min(MODEL_MIN, natural) : column.width),
				0,
			);
		const available = width - MARKER - nameWidth;
		let columns = all;
		for (const drop of ["turns", "cost", "model", "time", "tokens"]) {
			if (need(columns) <= available) break;
			columns = columns.filter((column) => column.key !== drop);
		}
		if (columns.includes(model))
			model.width = Math.min(natural, Math.min(MODEL_MIN, natural) + available - need(columns));
		const used = columns.reduce((sum, column) => sum + GAP + column.width, 0);
		nameWidth = Math.max(1, Math.min(nameWidth, width - MARKER - used));
		return { nameWidth, columns };
	}

	private list(width: number, height: number): string[] {
		const t = this.theme;
		if (!this.rows.length)
			return [fitWidth(t.fg("muted", "  No subagents yet. Agents started by rlm_query appear here."), width)];
		const { nameWidth, columns } = this.columns(width);
		const cells = (marker: string, name: string, values: string[]) =>
			marker +
			fitWidth(name, nameWidth) +
			columns.map((column, index) => " ".repeat(GAP) + fitWidth(values[index], column.width, column.right)).join("");
		const heading = t.style(
			cells(
				"  ",
				"NAME",
				columns.map((column) => column.label),
			),
			{ fg: "muted", bold: true },
		);
		const lines: { id: string; text: string }[] = [];
		for (const row of this.rows) {
			const selected = row.info.id === this.selectedId;
			const name = `${t.fg("borderMuted", row.prefix)}${selected ? t.style(oneLine(row.info.name), { fg: "accent", bold: true }) : t.fg("text", oneLine(row.info.name))}`;
			const text = cells(
				selected ? `${t.fg("accent", "▶")} ` : "  ",
				name,
				columns.map((column) => column.cell(row)),
			);
			lines.push({ id: row.info.id, text: selected ? t.bg("selectedBg", fitWidth(text, width)) : text });
			if (active(row.info) && row.info.activity)
				lines.push({
					id: row.info.id,
					text: `  ${t.fg("borderMuted", row.rail)}${t.fg("dim", `│ cell: ${oneLine(row.info.activity)}`)}`,
				});
		}
		// Below two lines the column heading gives way to the selected row.
		const visible = height >= 2 ? height - 1 : height;
		const first = lines.findIndex((line) => line.id === this.selectedId);
		let last = first;
		while (last + 1 < lines.length && lines[last + 1].id === this.selectedId) last++;
		if (first >= 0) {
			if (last >= this.scroll + visible) this.scroll = last - visible + 1;
			if (first < this.scroll) this.scroll = first;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, lines.length - visible));
		const shown = lines.slice(this.scroll, this.scroll + visible).map((line) => line.text);
		return height >= 2 ? [heading, ...shown] : shown;
	}

	private details(width: number): string[] {
		const t = this.theme;
		const info = this.rows[this.selectedIndex()]?.info;
		if (!info) return [];
		const lines: string[] = [];
		const wrap = (text: string, indent: number) => wrapTextWithAnsi(text, Math.max(1, width - indent));
		/** `value` is styled; it wraps beside a label column, or below the label when narrow. */
		const field = (label: string, value: string) => {
			const indent = width > LABEL + 10 ? LABEL : 0;
			if (!indent) lines.push(t.fg("muted", label));
			wrap(value, indent).forEach((part, index) => {
				lines.push((indent ? (index === 0 ? t.fg("muted", label.padEnd(indent)) : " ".repeat(indent)) : "") + part);
			});
		};
		const paragraphs = (text: string) =>
			text
				.split(/\r\n|\r|\n/)
				.map(safe)
				.join("\n");
		lines.push(t.style(oneLine(info.name), { fg: "accent", bold: true }));
		field("Status", this.status(info) + (info.stopReason ? t.fg("muted", ` · ${oneLine(info.stopReason)}`) : ""));
		field("Model", oneLine(info.model));
		if (info.role) field("Role", oneLine(info.role));
		field("Task", paragraphs(info.task));
		const parent = info.parentId ? this.agents.find((agent) => agent.id === info.parentId) : undefined;
		field("Parent", parent ? oneLine(parent.name) : "main session");
		field("Session", info.sessionFile ? oneLine(info.sessionFile) : t.fg("muted", "not saved"));
		const usage = info.usage;
		field(
			"Tokens",
			`in ${formatAgentTokens(usage.input)} · out ${formatAgentTokens(usage.output)} · cache read ${formatAgentTokens(usage.cacheRead)} · cache write ${formatAgentTokens(usage.cacheWrite)}`,
		);
		field("Cost", formatAgentCost(usage.cost));
		field("Turns", `${info.turns}/${info.maxTurns}`);
		field("Started", info.startedAt === undefined ? "not yet" : clock(info.startedAt));
		field("Elapsed", formatAgentDuration(elapsed(info, Date.now())));
		if (info.activity) field("Activity", t.fg("dim", oneLine(info.activity)));
		if (info.error) field("Error", t.fg("error", paragraphs(info.error)));
		const confirm = this.key("tui.select.confirm");
		const cancel = this.key("tui.select.cancel");
		const cap = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
		const hints: string[] = [];
		if (!info.openable) hints.push("Not saved to a session file; cannot be opened.");
		else if (info.promptable)
			hints.push(`${cap(confirm)} opens this session. Type to steer it; ${cap(cancel)} returns.`);
		else
			hints.push(
				`${cap(confirm)} opens this session; ${cap(cancel)} returns.`,
				"Read-only: its workspace result was already returned to the parent.",
			);
		if (info.parked && info.openable) hints.push("Parked: opening reloads it from its session file.");
		lines.push("");
		for (const hint of hints) for (const part of wrap(hint, 0)) lines.push(t.fg("dim", part));
		return lines;
	}

	private footer(): string {
		const t = this.theme;
		const confirming = this.agents.find((info) => info.id === this.confirmStopId);
		if (confirming)
			return ` ${t.fg("warning", `Press ${this.key("app.agents.stop")} again to stop ${oneLine(confirming.name)}`)}${t.fg("dim", " · any other key cancels")}`;
		const selected = this.rows[this.selectedIndex()]?.info;
		const item = (action: Keybinding, label: string) =>
			`${t.style(this.key(action), { fg: "accent", bold: true })} ${t.fg("muted", label)}`;
		const items: string[] = [];
		if (selected?.openable) items.push(item("tui.select.confirm", "open session"));
		if (selected) items.push(item("app.agents.details", "details"));
		if (this.view === "chart" && selected) {
			const move = ["tui.select.up", "tui.select.down", "app.agents.left", "app.agents.right"] as const;
			items.push(
				`${t.style(move.map((action) => this.key(action)).join("/"), { fg: "accent", bold: true })} ${t.fg("muted", "move")}`,
			);
		}
		items.push(item("app.agents.tree", `${NEXT_VIEW[this.view]} view`));
		if (selected && active(selected)) items.push(item("app.agents.stop", "stop"));
		items.push(item("tui.select.cancel", this.narrowDetails && !this.wide() ? "back" : "close"));
		return ` ${items.join(t.fg("borderMuted", " · "))}`;
	}

	render(width: number): string[] {
		width = Math.max(0, Math.floor(width));
		this.lastWidth = width;
		const height = Math.max(0, Math.floor(this.tui.terminal.rows));
		if (height === 0) return [];
		const body = this.mainHeight();
		let main: string[];
		if (this.wide(width) && !this.sideHidden && this.rows.length) {
			const side = Math.floor(width * 0.4);
			const left = width - side - 1;
			const listLines = this.view === "chart" ? this.chartView(left - 1, body) : this.list(left - 1, body);
			const detailLines = this.details(side - 1).map((line) => ` ${line}`);
			const bar = this.theme.fg("borderMuted", "│");
			main = Array.from(
				{ length: body },
				(_, index) =>
					`${fitWidth(listLines[index] ?? "", left, false, "")}${bar}${fitWidth(detailLines[index] ?? "", side, false, "")}`,
			);
		} else if (this.narrowDetails && !this.wide(width) && this.rows.length) {
			main = this.details(Math.max(1, width - 1)).map((line) => ` ${line}`);
		} else {
			main = this.view === "chart" ? this.chartView(width, body) : this.list(width, body);
		}
		const lines = [this.header(width), ...main.slice(0, body)];
		while (lines.length < height - 1) lines.push("");
		if (height >= 2) lines.push(this.footer());
		return lines.map((line) => fitWidth(line, width, false, ""));
	}
}
