import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { type TenmoRecord, type TenmoStatus, tenmoAgo, tenmoPath } from "../../core/tenmo.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";

export interface TenmoDashboardActions {
	/** pid of the process showing the dashboard, marked as "this session". */
	self: number;
	focus(session: TenmoRecord): void;
	/** End the session and delete its history. Called only after a confirmed delete. */
	delete(session: TenmoRecord): Promise<void>;
	close(): void;
}

const POLL_MS = 1000;
const STATUS: Record<TenmoStatus, { glyph: string; color: ThemeColor }> = {
	working: { glyph: "●", color: "accent" },
	waiting: { glyph: "◆", color: "warning" },
	idle: { glyph: "○", color: "muted" },
};

// Prompts and replies come from models and users; never let them drive the terminal.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
function safe(text: string): string {
	return text.replace(/\s+/g, " ").replace(UNSAFE, "");
}

function clip(text: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
}

function pad(text: string, width: number): string {
	const clipped = clip(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Fullscreen list of running sessions. Enter jumps to a session's tmux pane; the delete key, pressed twice,
 * ends a session and deletes its history.
 */
export class TenmoDashboard implements Component {
	private readonly source: () => TenmoRecord[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly actions: TenmoDashboardActions;
	private sessions: TenmoRecord[] = [];
	private selected = 0;
	/** pid awaiting a second delete key press. */
	private confirmDeletePid: number | undefined;
	private deletingPid: number | undefined;
	private scroll = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	private disposed = false;

	constructor(
		source: () => TenmoRecord[],
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		actions: TenmoDashboardActions,
	) {
		this.source = source;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.actions = actions;
		this.refresh();
		this.timer = setInterval(() => this.refresh(), POLL_MS);
		this.timer.unref?.();
	}

	invalidate(): void {
		// Styling is computed on every render.
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}

	private refresh(): void {
		if (this.disposed) return;
		const selectedPid = this.sessions[this.selected]?.pid;
		this.sessions = this.source();
		const index = this.sessions.findIndex((session) => session.pid === selectedPid);
		this.selected = Math.max(0, Math.min(this.sessions.length - 1, index < 0 ? this.selected : index));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const session = this.sessions[this.selected];
		if (kb.matches(data, "app.tenmo.delete")) {
			if (!session || session.pid === this.actions.self || this.deletingPid !== undefined) {
				this.confirmDeletePid = undefined;
			} else if (this.confirmDeletePid === session.pid) {
				this.confirmDeletePid = undefined;
				this.deletingPid = session.pid;
				void this.actions.delete(session).finally(() => {
					this.deletingPid = undefined;
					this.refresh();
				});
			} else {
				this.confirmDeletePid = session.pid;
			}
			this.tui.requestRender();
			return;
		}
		if (this.confirmDeletePid !== undefined) {
			// Any other key only cancels the pending delete, as the footer says.
			this.confirmDeletePid = undefined;
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.actions.close();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (session && session.pid !== this.actions.self) this.actions.focus(session);
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down"))
			this.selected = Math.min(Math.max(0, this.sessions.length - 1), this.selected + 1);
		else return;
		this.tui.requestRender();
	}

	private key(action: Keybinding): string {
		const key = this.keybindings.getKeys(action)[0] ?? "unbound";
		return key === "escape" ? "esc" : key;
	}

	private sessionLines(session: TenmoRecord, selected: boolean, width: number, now: number): string[] {
		const t = this.theme;
		const { glyph, color } = STATUS[session.status] ?? STATUS.idle;
		const marker = selected ? t.fg("accent", "› ") : "  ";
		const status = t.fg(color, pad(`${glyph} ${session.status}`, 10));
		const self = session.pid === this.actions.self ? t.fg("dim", " (this session)") : "";
		const meta = t.fg("dim", `  ${session.model ?? ""}  ${tenmoAgo(now - session.updatedAt)}`);
		const title = safe(session.name ? `${session.name}  ${tenmoPath(session.cwd)}` : tenmoPath(session.cwd));
		const head = `${marker}${status}${selected ? t.bold(title) : title}${self}${meta}`;
		const indent = " ".repeat(12);
		const lines = [clip(head, width)];
		const detail = (label: string, value: string | undefined, valueColor: ThemeColor) => {
			if (!value) return;
			lines.push(clip(`${indent}${t.fg("dim", label.padEnd(8))}${t.fg(valueColor, safe(value))}`, width));
		};
		detail("intent", session.intent, "text");
		if (session.lastPrompt && session.lastPrompt !== session.intent) detail("latest", session.lastPrompt, "muted");
		detail("now", session.activity, "muted");
		return lines;
	}

	render(width: number): string[] {
		const t = this.theme;
		const height = Math.max(4, this.tui.terminal.rows);
		const now = Date.now();
		const count = (status: TenmoStatus) => this.sessions.filter((session) => session.status === status).length;
		const summary = `${this.sessions.length} sessions · ${count("working")} working · ${count("waiting")} waiting`;
		const header = clip(`${t.fg("accent", t.bold("tenmo"))}  ${t.fg("muted", summary)}`, width);
		const confirming = this.sessions.find((session) => session.pid === this.confirmDeletePid);
		const footer = clip(
			confirming
				? t.fg(
						"warning",
						`${this.key("app.tenmo.delete")} again ends ${tenmoPath(confirming.cwd)} and deletes its history, subagents, and forks · any other key cancels`,
					)
				: this.deletingPid !== undefined
					? t.fg("warning", `Deleting session ${this.deletingPid}…`)
					: t.fg(
							"dim",
							`${this.key("tui.select.up")}/${this.key("tui.select.down")} select · ${this.key("tui.select.confirm")} jump to tmux pane · ${this.key("app.tenmo.delete")} delete · ${this.key("tui.select.cancel")} close`,
						),
			width,
		);

		const body: string[] = [t.fg("accent", t.bold("Sessions"))];
		let selectedTop = 0;
		let selectedBottom = 0;
		if (!this.sessions.length) body.push(t.fg("dim", "  No running sessions."));
		this.sessions.forEach((session, index) => {
			if (index === this.selected) selectedTop = body.length;
			body.push(...this.sessionLines(session, index === this.selected, width, now));
			if (index === this.selected) selectedBottom = body.length;
			body.push("");
		});

		const room = height - 3;
		if (selectedTop < this.scroll) this.scroll = selectedTop;
		if (selectedBottom > this.scroll + room) this.scroll = selectedBottom - room;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - room)));
		const visible = body.slice(this.scroll, this.scroll + room);
		while (visible.length < room) visible.push("");
		return [header, "", ...visible, footer];
	}
}
