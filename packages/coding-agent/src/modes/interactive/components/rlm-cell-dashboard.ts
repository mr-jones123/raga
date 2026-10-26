import { type Component, foregroundAnsi, rgbColor, truncateToWidth } from "@earendil-works/pi-tui";
import {
	cellCodePreview,
	type RlmCellEvent,
	type RlmCellStatus,
	subscribeRlmCellEvents,
} from "../../../core/rlm/cell-events.ts";
import { theme } from "../theme/theme.ts";

/** Eight frames of a 7x3 braille wheel; the gap rotates to read as spin. */
const FRAMES = [
	[" ⢴⣴⡶⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠗ "],
	[" ⢴⣴⡿⣦⡄ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠗ "],
	[" ⢴⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿ ", " ⠺⠻⣷⠟⠗ "],
	[" ⢴⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠃ "],
	[" ⢴⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⠷⠟⠗ "],
	[" ⢴⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠘⠻⣷⠟⠗ "],
	[" ⢴⣴⡿⣦⡦ ", " ⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠗ "],
	[" ⢠⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠗ "],
] as const;

const PALETTE = [
	rgbColor(228, 138, 122),
	rgbColor(79, 142, 179),
	rgbColor(234, 182, 93),
	rgbColor(126, 190, 122),
	rgbColor(200, 120, 200),
	rgbColor(90, 190, 190),
];

const FRAME_MS = 80;
const LINGER_MS = 1200;
const MAX_VISIBLE = 4;

interface Cell {
	cellId: string;
	depth: number;
	code: string;
	startedAt: number;
	ordinal: number;
	color: number;
	endedAt?: number;
	status?: RlmCellStatus;
}

/**
 * Fixed-height dashboard for running RLM cells. It subscribes to the process-wide cell
 * bus, so child sessions appear beside the root cell. Hidden while no cell is running.
 */
export class RlmCellDashboard implements Component {
	private readonly cells = new Map<string, Cell>();
	private readonly unsubscribe: () => void;
	private readonly requestRender: () => void;
	private ordinal = 0;
	private timer: NodeJS.Timeout | undefined;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
		this.unsubscribe = subscribeRlmCellEvents((event) => this.handle(event));
	}

	render(width: number): string[] {
		const now = Date.now();
		const visible = [...this.cells.values()]
			.filter((cell) => cell.endedAt === undefined || now - cell.endedAt < LINGER_MS)
			.slice(0, MAX_VISIBLE);
		if (visible.length === 0) return [];
		const mode = theme.getColorMode();
		const lines: string[] = [];
		for (const cell of visible) {
			const color = foregroundAnsi(PALETTE[cell.color % PALETTE.length], mode);
			const frame = cell.endedAt
				? FRAMES[0]
				: FRAMES[Math.floor((now - cell.startedAt) / FRAME_MS + cell.color * 2) % FRAMES.length];
			const elapsed = ((cell.endedAt ?? now) - cell.startedAt) / 1000;
			const state = cell.endedAt ? (cell.status === "ok" ? "ok" : cell.status) : "running";
			const textWidth = Math.max(1, width - 9);
			const label = `cell ${cell.ordinal} · depth ${cell.depth} · ${elapsed.toFixed(1)}s · ${state}`;
			lines.push(`${color}${frame[0]}  ${theme.fg("muted", truncateToWidth(label, textWidth, "…"))}`);
			lines.push(
				`${color}${frame[1]}  ${theme.fg("dim", truncateToWidth(cellCodePreview(cell.code), textWidth, "…"))}`,
			);
			lines.push(`${color}${frame[2]}`);
		}
		const hidden = this.cells.size - visible.length;
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
		if (event.type === "start") {
			this.cells.set(event.cellId, {
				cellId: event.cellId,
				depth: event.depth,
				code: event.code,
				startedAt: event.startedAt,
				ordinal: ++this.ordinal,
				color: this.ordinal - 1,
			});
			this.startTimer();
		} else {
			const cell = this.cells.get(event.cellId);
			if (!cell) return;
			cell.endedAt = Date.now();
			cell.status = event.status;
		}
		this.requestRender();
	}

	private startTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), FRAME_MS);
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
