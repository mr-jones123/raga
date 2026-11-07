import { type Component, foregroundAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import {
	cellCodePreview,
	type RlmCellEvent,
	type RlmCellStatus,
	subscribeRlmCellEvents,
} from "../../../core/rlm/cell-events.ts";
import { theme } from "../theme/theme.ts";
import { WHEEL_FRAME_MS, WHEEL_PALETTE, wheelFrame } from "./cell-wheel.ts";

const LINGER_MS = 1200;
const MAX_VISIBLE = 4;

interface Cell {
	sessionId: string;
	/** The session's own cell number, as its transcript shows it. */
	cell: number;
	depth: number;
	code: string;
	startedAt: number;
	ordinal: number;
	color: number;
	endedAt?: number;
	status?: RlmCellStatus;
}

/**
 * Panel for running RLM cells of sessions other than the one in view; the viewed session draws its
 * own cells in the transcript. It subscribes to the process-wide cell bus, so it shows subagents'
 * cells while the root waits on them. Hidden while no such cell is running.
 */
export class RlmCellDashboard implements Component {
	private readonly cells = new Map<string, Cell>();
	private readonly unsubscribe: () => void;
	private readonly requestRender: () => void;
	private readonly viewedSessionId: () => string;
	private ordinal = 0;
	private timer: NodeJS.Timeout | undefined;

	constructor(requestRender: () => void, viewedSessionId: () => string) {
		this.requestRender = requestRender;
		this.viewedSessionId = viewedSessionId;
		this.unsubscribe = subscribeRlmCellEvents((event) => this.handle(event));
	}

	render(width: number): string[] {
		if (width < 10) return [];
		const now = Date.now();
		const viewed = this.viewedSessionId();
		const shown = [...this.cells.values()].filter((cell) => cell.sessionId !== viewed);
		const visible = shown
			.filter((cell) => cell.endedAt === undefined || now - cell.endedAt < LINGER_MS)
			.sort(
				(left, right) =>
					Number(left.endedAt !== undefined) - Number(right.endedAt !== undefined) || left.ordinal - right.ordinal,
			)
			.slice(0, MAX_VISIBLE);
		if (visible.length === 0) return [];
		const mode = theme.getColorMode();
		const lines: string[] = [];
		for (const cell of visible) {
			const color = foregroundAnsi(WHEEL_PALETTE[cell.color % WHEEL_PALETTE.length], mode);
			const frame = wheelFrame(cell.startedAt, cell.endedAt ? undefined : now, cell.color * 2);
			const elapsed = ((cell.endedAt ?? now) - cell.startedAt) / 1000;
			const state = cell.endedAt ? (cell.status === "ok" ? "ok" : cell.status) : "running";
			const textWidth = Math.max(1, width - 9);
			const label = `cell ${cell.cell} · depth ${cell.depth} · ${elapsed.toFixed(1)}s · ${state}`;
			lines.push(`${color}${frame[0]}  ${theme.fg("muted", truncateToWidth(label, textWidth, "…"))}`);
			lines.push(
				`${color}${frame[1]}  ${theme.fg("dim", truncateToWidth(cellCodePreview(cell.code), textWidth, "…"))}`,
			);
			lines.push(`${color}${frame[2]}`);
		}
		const hidden = shown.length - visible.length;
		if (hidden > 0) lines.push(theme.fg("dim", `  +${hidden} more cell${hidden === 1 ? "" : "s"}`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.cells.clear();
	}

	private handle(event: RlmCellEvent): void {
		const key = `${event.sessionId}:${event.cellId}`;
		if (event.type === "start") {
			this.cells.set(key, {
				sessionId: event.sessionId,
				cell: event.cell,
				depth: event.depth,
				code: event.code,
				startedAt: event.startedAt,
				ordinal: ++this.ordinal,
				color: this.nextColor(),
			});
			this.startTimer();
		} else {
			const cell = this.cells.get(key);
			if (!cell) return;
			cell.endedAt = Date.now();
			cell.status = event.status;
		}
		this.requestRender();
	}

	/** A color no visible cell uses, so concurrent wheels stay distinguishable. */
	private nextColor(): number {
		const used = new Set([...this.cells.values()].map((cell) => cell.color));
		for (let index = 0; index < WHEEL_PALETTE.length; index++) if (!used.has(index)) return index;
		return (this.ordinal - 1) % WHEEL_PALETTE.length;
	}

	private startTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), WHEEL_FRAME_MS);
		this.timer.unref();
	}

	private tick(): void {
		const now = Date.now();
		let removed = false;
		for (const [id, cell] of this.cells) {
			if (cell.endedAt !== undefined && now - cell.endedAt >= LINGER_MS) {
				this.cells.delete(id);
				removed = true;
			}
		}
		if (this.cells.size === 0) {
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			if (removed) this.requestRender();
			return;
		}
		this.requestRender();
	}
}
