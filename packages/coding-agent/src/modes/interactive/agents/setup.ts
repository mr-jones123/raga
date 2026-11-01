import { type Component, fuzzyFilter, Input, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
	save(state: AgentSetupState): void;
	cancel(): void;
}

/** A model the user can pick, from the authenticated model registry. */
export interface AgentSetupModel {
	/** "provider/id" */
	selector: string;
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	reasoning?: boolean;
}

export interface AgentSetupOptions {
	catalog: AgentRoleDefinition[];
	initial: AgentSetupState;
	/** Models the user can pick. */
	available: AgentSetupModel[];
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

/** The in-editor model picker: a filterable list grouped by provider, with "inherit" first. */
interface Picker {
	role: AgentRoleDefinition;
	seat: number | undefined;
	input: Input;
	selected: number;
	scroll: number;
}

type Choice = { kind: "inherit" } | { kind: "model"; model: AgentSetupModel };

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

const contextLabel = (tokens: number) =>
	tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(tokens / 1000)}k`;

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
	private picker: Picker | undefined;
	/** Esc was pressed with unsaved changes; a second Esc discards them. */
	private confirmingDiscard = false;
	private disposed = false;
	private readonly models: AgentSetupModel[];
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
		this.models = [...options.available].sort(
			(a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
		);
		this.available = new Set(this.models.map((model) => model.selector));
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
		if (this.disposed) return;
		if (this.picker) {
			this.pickerInput(this.picker, data);
			this.tui.requestRender();
			return;
		}
		const kb = this.keybindings;
		const row = this.rows[this.selected];
		if (this.confirmingDiscard) {
			this.confirmingDiscard = false;
			if (kb.matches(data, "tui.select.cancel")) {
				this.actions.cancel();
				return;
			}
		}
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

	/** Open the picker for a single role (`seat` undefined) or a panel seat. */
	private pick(role: AgentRoleDefinition, seat: number | undefined): void {
		const input = new Input({ prompt: "Search: ", placeholder: "type to filter models" });
		input.focused = true;
		const picker: Picker = { role, seat, input, selected: 0, scroll: 0 };
		const current = seat === undefined ? this.single(role) : (this.seats(role)[seat] ?? null);
		const index = this.choices(picker).choices.findIndex((choice) =>
			choice.kind === "inherit" ? current === null : choice.model.selector === current,
		);
		picker.selected = Math.max(0, index);
		this.picker = picker;
	}

	/**
	 * Models matching the search. Every word must appear in the provider, id, or name; the list then stays grouped by
	 * provider. When nothing matches that way, a looser fuzzy match is ranked best first, ungrouped.
	 */
	private choices(picker: Picker): { choices: Choice[]; grouped: boolean } {
		const query = picker.input.getValue().trim().toLowerCase();
		const text = (model: AgentSetupModel) => `${model.provider} ${model.id} ${model.name ?? ""}`.toLowerCase();
		const words = query.split(/\s+/).filter(Boolean);
		let models = this.models.filter((model) => words.every((word) => text(model).includes(word)));
		const grouped = models.length > 0 || !words.length;
		if (!grouped) models = fuzzyFilter(this.models, query, text);
		const inherit = !words.length || words.every((word) => "inherit parent".includes(word));
		return {
			choices: [
				...(inherit ? [{ kind: "inherit" as const }] : []),
				...models.map((model) => ({ kind: "model" as const, model })),
			],
			grouped,
		};
	}

	private pickerInput(picker: Picker, data: string): void {
		const kb = this.keybindings;
		const { choices } = this.choices(picker);
		const move = (index: number) => {
			picker.selected = Math.max(0, Math.min(choices.length - 1, index));
		};
		if (kb.matches(data, "tui.select.cancel")) {
			this.picker = undefined;
		} else if (kb.matches(data, "tui.select.confirm")) {
			const choice = choices[picker.selected];
			if (!choice) return;
			const value = choice.kind === "inherit" ? null : choice.model.selector;
			if (picker.seat === undefined) this.values.set(picker.role.name, value);
			else if (picker.seat < this.seats(picker.role).length) this.seats(picker.role)[picker.seat] = value;
			this.picker = undefined;
		} else if (kb.matches(data, "tui.select.up")) move(picker.selected - 1);
		else if (kb.matches(data, "tui.select.down")) move(picker.selected + 1);
		else if (kb.matches(data, "tui.select.pageUp")) move(picker.selected - this.page());
		else if (kb.matches(data, "tui.select.pageDown")) move(picker.selected + this.page());
		else {
			const before = picker.input.getValue();
			picker.input.handleInput(data);
			if (picker.input.getValue() !== before) {
				picker.selected = 0;
				picker.scroll = 0;
			}
		}
	}

	private save(): void {
		const state = this.state();
		const problems = validateAgentSetup(state, [...this.available]);
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
		if (this.dirty()) this.confirmingDiscard = true;
		else this.actions.cancel();
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
		if (this.confirmingDiscard)
			return ` ${t.fg("warning", "Unsaved changes.")} ${t.style(this.key("tui.select.cancel"), { fg: "accent", bold: true })} ${t.fg("muted", "discard ·")} ${t.style(this.key("app.agentSetup.save"), { fg: "accent", bold: true })} ${t.fg("muted", "save · any other key keeps editing")}`;
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

	private renderPicker(picker: Picker, width: number, height: number): string[] {
		const t = this.theme;
		const { choices, grouped } = this.choices(picker);
		const target =
			picker.seat === undefined
				? oneLine(picker.role.name)
				: `${oneLine(picker.role.name)} · seat ${picker.seat + 1}`;
		const current =
			picker.seat === undefined ? this.single(picker.role) : (this.seats(picker.role)[picker.seat] ?? null);
		const matches = choices.filter((choice) => choice.kind === "model").length;
		const title = ` ${t.style("Choose a model", { fg: "accent", bold: true })}${t.fg("dim", " for ")}${t.style(target, { fg: "text", bold: true })}`;
		const count = t.fg("muted", `${matches} of ${this.models.length} models `);
		const head =
			fitWidth(title, Math.max(0, width - visibleWidth(count))) + (width > visibleWidth(count) ? count : "");
		const sub = ` ${t.fg("muted", picker.role.description ? `${oneLine(picker.role.description)} · ` : "")}${t.fg("muted", "now: ")}${this.value(current)}`;
		const search = ` ${picker.input.render(Math.max(1, width - 1))[0] ?? ""}`;
		const rule = t.fg("borderMuted", "─".repeat(Math.max(0, width)));
		const footer = ` ${[
			[this.key("tui.select.up"), "/", this.key("tui.select.down"), " select"],
			[this.key("tui.select.confirm"), " choose"],
			[this.key("tui.select.cancel"), " back"],
		]
			.map(([key, ...rest]) => `${t.style(key, { fg: "accent", bold: true })}${t.fg("muted", rest.join(""))}`)
			.join(t.fg("borderMuted", " · "))}${t.fg("muted", " · type to filter")}`;

		const idWidth = Math.min(40, Math.max(8, ...this.models.map((model) => visibleWidth(oneLine(model.id)))));
		const nameWidth = Math.min(
			28,
			Math.max(0, ...this.models.map((model) => visibleWidth(oneLine(model.name ?? "")))),
		);
		const parent = this.options.parentModel;
		const display: { text: string; choice?: number }[] = [];
		let provider: string | undefined;
		choices.forEach((choice, index) => {
			const selected = index === picker.selected;
			const marker = selected ? t.fg("accent", "▶ ") : "  ";
			let text: string;
			if (choice.kind === "inherit") {
				const parentId = parent ? parent.slice(parent.indexOf("/") + 1) : undefined;
				text = `${marker}${fitWidth(t.style("inherit", { fg: "text", bold: selected }), idWidth + 2)}  ${t.fg("muted", `use the parent session's model${parentId ? ` (${oneLine(parentId)})` : ""}`)}`;
			} else {
				const model = choice.model;
				if (grouped && model.provider !== provider) {
					provider = model.provider;
					if (display.length) display.push({ text: "" });
					display.push({ text: `  ${t.style(oneLine(model.provider), { fg: "muted", bold: true })}` });
				}
				const meta = [
					model.contextWindow ? `${contextLabel(model.contextWindow)} context` : "",
					model.reasoning ? "reasoning" : "",
				]
					.filter(Boolean)
					.join(" · ");
				const isCurrent = model.selector === current;
				const tag = grouped ? "" : `${t.fg("dim", oneLine(model.provider))} `;
				text = `${marker}  ${tag}${fitWidth(t.style(oneLine(model.id), { fg: selected ? "accent" : "text", bold: selected }), idWidth)}  ${fitWidth(t.fg("muted", oneLine(model.name ?? "")), nameWidth)}  ${t.fg("dim", meta)}${isCurrent ? `  ${t.fg("success", "● current")}` : ""}`;
			}
			display.push({ text, choice: index });
		});
		if (!choices.length)
			display.push({
				text: `  ${t.fg("muted", "No models match. Clear the search or press ")}${t.style(this.key("tui.select.cancel"), { fg: "accent", bold: true })}${t.fg("muted", " to go back.")}`,
			});

		const fixed = [head, sub, search, rule];
		const top = fixed.slice(0, Math.max(1, Math.min(fixed.length, height - 1)));
		const footerRows = height >= 2 ? 1 : 0;
		const ruleRows = height >= 6 ? 1 : 0;
		const body = Math.max(0, height - top.length - footerRows - ruleRows);
		const selectedLine = Math.max(
			0,
			display.findIndex((line) => line.choice === picker.selected),
		);
		if (selectedLine >= picker.scroll + body) picker.scroll = selectedLine - body + 1;
		if (selectedLine < picker.scroll) picker.scroll = selectedLine;
		picker.scroll = Math.max(0, Math.min(picker.scroll, display.length - body));
		const lines = [...top];
		for (let index = 0; index < body; index++) {
			const line = display[picker.scroll + index];
			const selected = line?.choice !== undefined && line.choice === picker.selected;
			lines.push(selected ? t.bg("selectedBg", fitWidth(line.text, width)) : (line?.text ?? ""));
		}
		if (ruleRows) lines.push(rule);
		if (footerRows) lines.push(footer);
		while (lines.length < height) lines.push("");
		return lines.slice(0, height).map((line) => fitWidth(line, width));
	}

	render(width: number): string[] {
		width = Math.max(0, Math.floor(width));
		const height = this.height();
		if (height === 0) return [];
		if (this.picker) return this.renderPicker(this.picker, width, height);
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
