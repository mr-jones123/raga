import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme } from "../theme/theme.ts";

export type AgentHubView = "tui" | "rex";
export type AgentHubChoice = AgentHubView | "retry" | "start-rex" | undefined;
export interface AgentsAvailability {
	status: "ready" | "missing" | "unavailable";
	message: string;
}

/** Rex is never installed or started as a side effect of opening this chooser. */
export class AgentsChooser implements Component {
	private selected: number;
	private closed = false;
	private readonly rows: { label: string; value: Exclude<AgentHubChoice, undefined>; enabled: boolean }[];

	constructor(
		privateTui: TUI,
		privateTheme: Theme,
		privateKeys: KeybindingsManager,
		privateDone: (choice: AgentHubChoice) => void,
		availability: AgentsAvailability,
		preferred: AgentHubView,
	) {
		this.tui = privateTui;
		this.theme = privateTheme;
		this.keys = privateKeys;
		this.done = privateDone;
		this.availability = availability;
		this.rows = [
			{ label: "TUI dashboard", value: "tui", enabled: true },
			{
				label: `Rex workspace${availability.status === "ready" ? "" : " (unavailable)"}`,
				value: "rex",
				enabled: availability.status === "ready",
			},
		];
		if (availability.status !== "ready") {
			this.rows.push({ label: "Check Rex again", value: "retry", enabled: true });
			if (availability.status === "unavailable")
				this.rows.push({ label: "Start Rex server", value: "start-rex", enabled: true });
		}
		this.selected = preferred === "rex" && availability.status === "ready" ? 1 : 0;
	}
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (choice: AgentHubChoice) => void;
	private readonly availability: AgentsAvailability;

	render(width: number): string[] {
		const message = this.availability.message.replace(
			/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/g,
			" ",
		);
		const labels = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		const [up, down, confirm, cancel] = labels.map((action) => this.keys.getKeys(action)[0] ?? "unbound");
		const lines = [
			this.theme.bold("Agent hub"),
			"Choose how to view this session's existing subagents.",
			"",
			...this.rows.map((row, index) => {
				const text = `${this.selected === index ? ">" : " "} ${row.label}`;
				return row.enabled
					? this.theme.fg(index === this.selected ? "accent" : "text", text)
					: this.theme.fg("dim", text);
			}),
			"",
			`Rex: ${message}`,
			"Views do not launch duplicate agents. Closing a view does not stop work.",
			`${up}/${down} select · ${confirm} open · ${cancel} cancel`,
		]
			.map((line) => truncateToWidth(line, Math.max(0, width)))
			.slice(0, Math.max(0, this.tui.terminal.rows));
		while (lines.length < this.tui.terminal.rows) lines.push("");
		return lines.map((line) => line + " ".repeat(Math.max(0, width - visibleWidth(line))));
	}
	invalidate(): void {}
	handleInput(data: string): void {
		if (this.closed) return;
		if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "app.interrupt")) {
			this.finish(undefined);
		} else if (this.keys.matches(data, "tui.select.confirm")) {
			const row = this.rows[this.selected];
			if (row?.enabled) this.finish(row.value);
		} else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) {
			const direction = this.keys.matches(data, "tui.select.up") ? -1 : 1;
			do {
				this.selected = (this.selected + direction + this.rows.length) % this.rows.length;
			} while (!this.rows[this.selected].enabled);
			this.tui.requestRender();
		}
	}
	private finish(choice: AgentHubChoice): void {
		this.closed = true;
		this.done(choice);
	}
}
