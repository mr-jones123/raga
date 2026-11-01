import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	AGENT_ROLE_BUDGETS,
	type AgentRoleBudget,
	type AgentRoleDefinition,
	type AgentRoleValue,
} from "../../../core/agent-roles.ts";
import type { Keybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme } from "../theme/theme.ts";

export interface AgentSetupState {
	budget?: AgentRoleBudget;
	roles: Record<string, AgentRoleValue | AgentRoleValue[]>;
}

export interface AgentSetupActions {
	/** Resolve undefined on cancel, null for inherit, or "provider/id". */
	pickModel(current: AgentRoleValue, title: string): Promise<AgentRoleValue | undefined>;
	save(state: AgentSetupState): void;
	cancel(): void;
	confirmDiscard(): Promise<boolean>;
}

export interface AgentSetupOptions {
	catalog: AgentRoleDefinition[];
	initial: AgentSetupState;
	/** "provider/id" selectors the user can pick. */
	available: string[];
	/** The parent session's model, "provider/id", shown beside inheriting roles. */
	parentModel?: string;
	/** The session is an instance: its children use the pinned agents/model-roles.json instead. */
	instance: boolean;
}

/** A selector that is not in the available model list. `seat` is the 1-based seat number of a panel role. */
export interface AgentSetupProblem {
	role: string;
	seat?: number;
	selector: string;
}

type Row =
	| { kind: "budget" }
	| { kind: "role"; role: AgentRoleDefinition }
	| { kind: "header"; role: AgentRoleDefinition }
	| { kind: "seat"; role: AgentRoleDefinition; seat: number };

const MAX_SEATS = 8;
const NAME_MAX = 34;
const VALUE_MAX = 48;
const DESCRIPTION_MIN = 8;
const GAP = 2;
const MARKER = 2;
const SEAT_INDENT = "  ";
const BUDGET_CYCLE: (AgentRoleBudget | undefined)[] = [undefined, ...AGENT_ROLE_BUDGETS.map((entry) => entry.budget)];
const DEFAULT_BUDGET_LABEL = "default — children use the parent's thinking level";

// Role names and model selectors come from settings files; never let them drive the terminal.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
function oneLine(text: string): string {
	return text
		.replace(/\s*[\r\n]+\s*/g, " ")
		.replace(UNSAFE, (char) => (char === "\t" ? " " : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

/** Clip or pad styled text to exactly `width` columns. */
function fitWidth(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, ellipsis) : text;
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

const normalize = (value: unknown): AgentRoleValue =>
	typeof value === "string" && value.trim() && value.trim() !== "inherit" ? value.trim() : null;

/** Every assigned selector that is not in `available`, in role and seat order. */
export function validateAgentSetup(state: AgentSetupState, available: string[]): AgentSetupProblem[] {
	const known = new Set(available);
	const problems: AgentSetupProblem[] = [];
	for (const [role, value] of Object.entries(state.roles)) {
		if (Array.isArray(value)) {
			value.forEach((entry, index) => {
				const selector = normalize(entry);
				if (selector && !known.has(selector)) problems.push({ role, seat: index + 1, selector });
			});
		} else {
			const selector = normalize(value);
			if (selector && !known.has(selector)) problems.push({ role, selector });
		}
	}
	return problems;
}

/**
 * Fullscreen editor for the models subagent roles run on: a budget row, then one row per role, with
 * panel roles expanded into one row per seat. Saving hands the full state to `actions.save`.
 */
export class AgentSetupEditor implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly options: AgentSetupOptions;
	private readonly actions: AgentSetupActions;
	private readonly available: Set<string>;
	private budget: AgentRoleBudget | undefined;
	private readonly values = new Map<string, AgentRoleValue | AgentRoleValue[]>();
	private rows: Row[] = [];
	private selected = 0;
	private scroll = 0;
	private error: string | undefined;
	private pending = false;
	private disposed = false;
	private readonly initialSnapshot: string;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		options: AgentSetupOptions,
		actions: AgentSetupActions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.options = options;
		this.actions = actions;
		this.available = new Set(options.available);
		this.budget = options.initial.budget;
		for (const role of options.catalog) {
			const value = Object.hasOwn(options.initial.roles, role.name) ? options.initial.roles[role.name] : undefined;
			if (role.panel) {
				const seats = Array.isArray(value)
					? value.map(normalize)
					: value === undefined || value === null
						? []
						: [normalize(value)];
				const filled = seats.length ? seats : Array.from({ length: Math.max(1, role.defaultSeats) }, () => null);
				this.values.set(role.name, filled.slice(0, MAX_SEATS));
			} else {
				this.values.set(role.name, normalize(Array.isArray(value) ? value[0] : value));
			}
		}
		this.buildRows();
		this.initialSnapshot = this.snapshot();
	}

	invalidate(): void {
		// Styling is computed on every render; no cached state depends on the theme.
	}

	dispose(): void {
		this.disposed = true;
	}

	/** The state `actions.save` receives: every catalog role, panels as arrays. */
	private state(): AgentSetupState {
		const roles: Record<string, AgentRoleValue | AgentRoleValue[]> = {};
		for (const role of this.options.catalog) {
			const value = this.values.get(role.name) ?? null;
			roles[role.name] = Array.isArray(value) ? [...value] : value;
		}
		return this.budget === undefined ? { roles } : { budget: this.budget, roles };
	}

	private snapshot(): string {
		return JSON.stringify(this.state());
	}

	private dirty(): boolean {
		return this.snapshot() !== this.initialSnapshot;
	}

	private seats(role: AgentRoleDefinition): AgentRoleValue[] {
		const value = this.values.get(role.name);
		return Array.isArray(value) ? value : [value ?? null];
	}

	private single(role: AgentRoleDefinition): AgentRoleValue {
		const value = this.values.get(role.name);
		return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
	}

	private buildRows(): void {
		const rows: Row[] = [{ kind: "budget" }];
		for (const role of this.options.catalog) {
			if (!role.panel) {
				rows.push({ kind: "role", role });
				continue;
			}
			rows.push({ kind: "header", role });
			this.seats(role).forEach((_, seat) => {
				rows.push({ kind: "seat", role, seat });
			});
		}
		this.rows = rows;
		this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected));
	}

	private select(index: number): void {
		this.selected = Math.max(0, Math.min(this.rows.length - 1, index));
	}

	private rowIndex(role: string, seat: number | undefined): number {
		return this.rows.findIndex(
			(row) =>
				(row.kind === "role" && row.role.name === role && seat === undefined) ||
				(row.kind === "seat" && row.role.name === role && row.seat === seat),
		);
	}

	private height(): number {
		return Math.max(0, Math.floor(this.tui.terminal.rows));
	}

	/** Header, note, details, and footer lines that fit, with the rest left for the list. */
	private layout(): { note: boolean; details: boolean; footer: boolean; body: number } {
		const height = this.height();
		const footer = height >= 2;
		const details = height >= 5;
		const note = height >= 6;
		const body = Math.max(0, height - 1 - Number(footer) - Number(details) - Number(note));
		return { note, details, footer, body };
	}

	private page(): number {
		return Math.max(1, this.layout().body - 1);
	}

	handleInput(data: string): void {
		if (this.disposed || this.pending) return;
		const kb = this.keybindings;
		const row = this.rows[this.selected];
		if (kb.matches(data, "app.agentSetup.save")) {
			this.save();
			this.tui.requestRender();
			return;
		}
		this.error = undefined;
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (row?.kind === "budget") {
				this.budget = BUDGET_CYCLE[(BUDGET_CYCLE.indexOf(this.budget) + 1) % BUDGET_CYCLE.length];
			} else if (row?.kind === "role") {
				this.pick(row.role, undefined);
			} else if (row?.kind === "header" || row?.kind === "seat") {
				this.pick(row.role, row.kind === "seat" ? row.seat : 0);
			}
		} else if (kb.matches(data, "app.agentSetup.inherit")) {
			if (row?.kind === "role") this.values.set(row.role.name, null);
			else if (row?.kind === "seat") this.seats(row.role)[row.seat] = null;
		} else if (kb.matches(data, "app.agentSetup.addSeat")) {
			if (row?.kind === "header" || row?.kind === "seat") {
				const seats = this.seats(row.role);
				if (seats.length < MAX_SEATS) {
					seats.push(null);
					this.buildRows();
					this.select(this.rowIndex(row.role.name, seats.length - 1));
				} else {
					this.error = `${oneLine(row.role.name)} already has the maximum of ${MAX_SEATS} seats`;
				}
			}
		} else if (kb.matches(data, "app.agentSetup.removeSeat")) {
			if (row?.kind === "seat") {
				const seats = this.seats(row.role);
				if (seats.length > 1) {
					seats.splice(row.seat, 1);
					this.buildRows();
					this.select(this.rowIndex(row.role.name, Math.min(row.seat, seats.length - 1)));
				} else {
					this.error = `${oneLine(row.role.name)} needs at least one seat`;
				}
			}
		} else if (kb.matches(data, "tui.select.up")) this.select(this.selected - 1);
		else if (kb.matches(data, "tui.select.down")) this.select(this.selected + 1);
		else if (kb.matches(data, "tui.select.pageUp")) this.select(this.selected - this.page());
		else if (kb.matches(data, "tui.select.pageDown")) this.select(this.selected + this.page());
		else if (kb.matches(data, "app.agents.first")) this.select(0);
		else if (kb.matches(data, "app.agents.last")) this.select(this.rows.length - 1);
		this.tui.requestRender();
	}

	/** Ask for a model for a single role (`seat` undefined) or a panel seat, ignoring input until it answers. */
	private pick(role: AgentRoleDefinition, seat: number | undefined): void {
		const current = seat === undefined ? this.single(role) : this.seats(role)[seat];
		const title = seat === undefined ? oneLine(role.name) : `${oneLine(role.name)} seat ${seat + 1}`;
		this.pending = true;
		const finish = (result: AgentRoleValue | undefined) => {
			this.pending = false;
			if (this.disposed) return;
			if (result !== undefined) {
				const value = normalize(result);
				if (seat === undefined) this.values.set(role.name, value);
				else if (seat < this.seats(role).length) this.seats(role)[seat] = value;
			}
			this.tui.requestRender();
		};
		this.actions.pickModel(current ?? null, title).then(finish, () => finish(undefined));
	}

	private save(): void {
		const state = this.state();
		const problems = validateAgentSetup(state, this.options.available);
		if (!problems.length) {
			this.error = undefined;
			this.actions.save(state);
			return;
		}
		const first = problems[0];
		const index = this.rowIndex(first.role, first.seat === undefined ? undefined : first.seat - 1);
		if (index >= 0) this.select(index);
		const listed = problems
			.slice(0, 3)
			.map(
				(problem) =>
					`${oneLine(problem.role)}${problem.seat === undefined ? "" : ` seat ${problem.seat}`}: ${oneLine(problem.selector)} not available — pick another or inherit`,
			);
		const more = problems.length > 3 ? ` (+${problems.length - 3} more)` : "";
		this.error = `Cannot save: ${listed.join("; ")}${more}`;
	}

	private cancel(): void {
		if (!this.dirty()) {
			this.actions.cancel();
			return;
		}
		this.pending = true;
		const finish = (discard: boolean) => {
			this.pending = false;
			if (this.disposed) return;
			if (discard) this.actions.cancel();
			else this.tui.requestRender();
		};
		this.actions.confirmDiscard().then(finish, () => finish(false));
	}

	private key(action: Keybinding): string {
		const key = this.keybindings.getKeys(action)[0] ?? "unbound";
		return oneLine(key === "escape" ? "esc" : key);
	}

	private budgetLabel(): string {
		return AGENT_ROLE_BUDGETS.find((entry) => entry.budget === this.budget)?.label ?? DEFAULT_BUDGET_LABEL;
	}

	private value(value: AgentRoleValue): string {
		const t = this.theme;
		if (value === null) {
			const parent = this.options.parentModel;
			if (!parent) return t.fg("dim", "inherit");
			const slash = parent.indexOf("/");
			return t.fg("dim", `inherit (parent: ${oneLine(slash < 0 ? parent : parent.slice(slash + 1))})`);
		}
		if (!this.available.has(value)) return t.fg("warning", `⚠ ${oneLine(value)} not available`);
		const slash = value.indexOf("/");
		if (slash < 0) return t.fg("text", oneLine(value));
		return `${t.fg("text", oneLine(value.slice(slash + 1)))} ${t.fg("dim", oneLine(value.slice(0, slash)))}`;
	}

	/** Whether the seats span more than one provider; null seats count as the parent model's provider. */
	private diverse(role: AgentRoleDefinition): boolean {
		const parent = this.options.parentModel ?? "parent";
		return new Set(this.seats(role).map((seat) => (seat ?? parent).split("/")[0])).size > 1;
	}

	private name(row: Row): string {
		if (row.kind === "budget") return "Budget";
		if (row.kind === "seat") return `${SEAT_INDENT}seat ${row.seat + 1}`;
		const name = oneLine(row.role.name);
		if (row.kind === "role") return name;
		const count = this.seats(row.role).length;
		return `${name} · ${count} seat${count === 1 ? "" : "s"}`;
	}

	private cellValue(row: Row): string {
		if (row.kind === "budget") return this.budgetLabel();
		if (row.kind === "role") return this.value(this.single(row.role));
		if (row.kind === "seat") return this.value(this.seats(row.role)[row.seat] ?? null);
		return this.diverse(row.role) ? "" : this.theme.fg("dim", "not model-diverse");
	}

	private list(width: number, height: number): string[] {
		if (height <= 0) return [];
		const t = this.theme;
		const tableRows = this.rows.filter((row) => row.kind !== "budget");
		const names = tableRows.map((row) => visibleWidth(this.name(row)));
		const values = tableRows.map((row) => visibleWidth(this.cellValue(row)));
		let nameWidth = Math.min(NAME_MAX, Math.max(6, ...names));
		let valueWidth = Math.min(VALUE_MAX, Math.max(1, ...values));
		const room = width - MARKER;
		if (nameWidth + GAP + valueWidth > room) {
			valueWidth = Math.max(Math.min(valueWidth, 12), room - GAP - nameWidth);
			nameWidth = Math.max(1, Math.min(nameWidth, room - GAP - valueWidth));
			valueWidth = Math.max(0, Math.min(valueWidth, room - GAP - nameWidth));
		}
		const descriptionWidth = room - nameWidth - GAP - valueWidth - GAP;
		const lines = this.rows.map((row, index) => {
			const selected = index === this.selected;
			const marker = selected ? `${t.fg("accent", "▶")} ` : "  ";
			const rawName = this.name(row);
			const name =
				selected || row.kind === "header"
					? t.style(rawName, { fg: selected ? "accent" : "text", bold: true })
					: row.kind === "seat"
						? t.fg("muted", rawName)
						: t.fg("text", rawName);
			if (row.kind === "budget")
				return `${marker}${fitWidth(name, nameWidth)}${" ".repeat(GAP)}${t.fg("text", this.budgetLabel())}`;
			let line = `${marker}${fitWidth(name, nameWidth)}${" ".repeat(GAP)}${fitWidth(this.cellValue(row), valueWidth)}`;
			if (row.kind !== "seat" && descriptionWidth >= DESCRIPTION_MIN && row.role.description)
				line += `${" ".repeat(GAP)}${t.fg("dim", oneLine(row.role.description))}`;
			return line;
		});
		if (this.selected >= this.scroll + height) this.scroll = this.selected - height + 1;
		if (this.selected < this.scroll) this.scroll = this.selected;
		this.scroll = Math.max(0, Math.min(this.scroll, lines.length - height));
		return lines.slice(this.scroll, this.scroll + height);
	}

	private header(): string {
		const t = this.theme;
		const count = this.available.size;
		const budget = this.budget ?? "default";
		return ` ${t.style("Agent roles", { fg: "accent", bold: true })}${t.fg("dim", " · ")}${t.fg("muted", `${count} model${count === 1 ? "" : "s"} available`)}${t.fg("dim", " · ")}${t.fg("muted", `budget ${budget}`)}`;
	}

	private note(): string {
		const text = this.options.instance
			? "This session is an instance: its children use the pinned agents/model-roles.json. These settings apply to ordinary sessions."
			: "New subagents launched by role use these models. Null roles inherit the parent's model.";
		return ` ${this.theme.fg("dim", text)}`;
	}

	/** The line above the footer: a save or seat error, or what the selected row is. */
	private details(): string {
		const t = this.theme;
		if (this.error) return ` ${t.fg("error", this.error)}`;
		const row = this.rows[this.selected];
		if (!row) return "";
		if (row.kind === "budget")
			return ` ${t.fg("muted", `Reasoning budget for roles with an assigned model. ${this.key("tui.select.confirm")} cycles it.`)}`;
		const name = t.style(oneLine(row.role.name), { fg: "accent", bold: true });
		const seat = row.kind === "seat" ? t.fg("muted", ` seat ${row.seat + 1}`) : "";
		const description = row.role.description ? ` ${t.fg("muted", oneLine(row.role.description))}` : "";
		const value =
			row.kind === "role" ? this.single(row.role) : row.kind === "seat" ? this.seats(row.role)[row.seat] : undefined;
		const selector = value ? t.fg("dim", ` · ${oneLine(value)}`) : "";
		return ` ${name}${seat}${t.fg("dim", " —")}${description}${selector}`;
	}

	private footer(): string {
		const t = this.theme;
		if (this.pending) return ` ${t.fg("muted", "Waiting for a choice…")}`;
		const item = (keys: string, label: string) =>
			`${t.style(keys, { fg: "accent", bold: true })} ${t.fg("muted", label)}`;
		const items = [
			item(this.key("tui.select.confirm"), "pick model"),
			item(this.key("app.agentSetup.inherit"), "inherit"),
			item(`${this.key("app.agentSetup.addSeat")}/${this.key("app.agentSetup.removeSeat")}`, "add/remove seat"),
			item(this.key("app.agentSetup.save"), "save"),
			item(this.key("tui.select.cancel"), "cancel"),
		];
		const dirty = this.dirty() ? `  ${t.fg("warning", "• unsaved changes")}` : "";
		return ` ${items.join(t.fg("borderMuted", " · "))}${dirty}`;
	}

	render(width: number): string[] {
		width = Math.max(0, Math.floor(width));
		const height = this.height();
		if (height === 0) return [];
		const layout = this.layout();
		const lines = [this.header()];
		if (layout.note) lines.push(this.note());
		const list = this.list(width, layout.body);
		for (let index = 0; index < layout.body; index++) lines.push(list[index] ?? "");
		if (layout.details) lines.push(this.details());
		// Too short for the details line: an error replaces the key hints so it is never hidden.
		if (layout.footer) lines.push(this.error && !layout.details ? this.details() : this.footer());
		return lines.map((line) => fitWidth(line, width));
	}
}
