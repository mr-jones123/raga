/**
 * Presentation for the RLM `python` tool. A finished cell is one line (status, cell number, first code
 * line, line counts, duration); the expand key shows its full code and output. A running cell draws the
 * braille wheel with its cell number, depth, and timer. Kept apart from `core/rlm/runtime.ts` so a
 * process that only displays tool output does not load the kernel.
 */

import { type Component, Container, foregroundAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import { WHEEL_FRAME_MS, WHEEL_PALETTE, wheelFrame } from "../../../modes/interactive/components/cell-wheel.ts";
import { highlightCode, theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolRenderContext, ToolRenderers } from "../../extensions/types.ts";
import { cellCodePreview } from "../../rlm/cell-events.ts";
import type { PythonToolDetails } from "../../rlm/runtime.ts";
import {
	formatToolDuration,
	getTextOutput,
	invalidArgText,
	replaceTabs,
	startToolTimer,
	str,
} from "../render-utils.ts";

const RESET_FG = "\x1b[39m";
/** Label lines the runtime puts before each part of a cell's output. */
const OUTPUT_LABEL = /^\[(stdout|stderr|result|error|background)\]$/;

/** One cell's row: everything is read at render time, so the wheel and timer move on each redraw. */
class PythonCell implements Component {
	code: string | null = "";
	started = false;
	final = false;
	isError = false;
	expanded = false;
	pad = 1;
	details: PythonToolDetails | undefined;
	output = "";
	startedAt: number | undefined;
	endedAt: number | undefined;
	durationMs: number | undefined;

	render(width: number): string[] {
		const pad = " ".repeat(this.pad);
		const fit = (line: string) => truncateToWidth(`${pad}${line}`, width, "…");
		const code = this.code ? replaceTabs(this.code.replace(/\s+$/, "")) : "";
		const firstLine =
			code
				.split("\n")
				.find((line) => line.trim())
				?.trim() ?? "";
		const lines: string[] = [];
		if (this.code === null) {
			lines.push(`${theme.fg("toolTitle", "python")} ${invalidArgText(theme)}`);
		} else if (this.final) {
			lines.push(this.head(code, firstLine));
		} else if (!this.started) {
			lines.push(theme.fg("muted", `python · ${firstLine || "..."}`));
		} else {
			const frame = wheelFrame(this.startedAt ?? Date.now(), Date.now());
			const color = foregroundAnsi(WHEEL_PALETTE[0], theme.getColorMode());
			const label = [
				this.details?.cell === undefined ? "cell" : `cell ${this.details.cell}`,
				this.details?.depth === undefined ? undefined : `depth ${this.details.depth}`,
				this.elapsed(),
				"running",
			]
				.filter(Boolean)
				.join(" · ");
			lines.push(`${color}${frame[0]}${RESET_FG}  ${theme.fg("muted", label)}`);
			lines.push(`${color}${frame[1]}${RESET_FG}  ${theme.fg("dim", cellCodePreview(code))}`);
			lines.push(`${color}${frame[2]}${RESET_FG}`);
		}
		if (this.expanded && this.code) {
			const gutter = theme.fg("muted", "│ ");
			lines.push(...highlightCode(code, "python").map((line) => `${gutter}${line}`));
			const output = this.output.trim();
			if (output) {
				lines.push(gutter.trimEnd());
				lines.push(...output.split("\n").map((line) => `${gutter}${theme.fg("toolOutput", line)}`));
			}
		}
		return lines.map(fit);
	}

	invalidate(): void {}

	private elapsed(): string {
		const ms =
			this.final && this.durationMs !== undefined
				? this.durationMs
				: this.startedAt === undefined
					? undefined
					: (this.endedAt ?? Date.now()) - this.startedAt;
		if (ms === undefined) return "";
		// A finished sub-second cell reads better as `5ms` than `0.0s`.
		return this.final && ms < 1000 ? `${Math.round(ms)}ms` : formatToolDuration(ms);
	}

	/** `✓ [3] python · <first line> · ↑ 2 ↓ 1 line · 4.0s · ToolError` */
	private head(code: string, firstLine: string): string {
		const failed = this.isError || this.details?.error !== undefined;
		const sep = theme.fg("muted", " · ");
		const number = this.details?.cell === undefined ? "" : `${theme.fg("muted", `[${this.details.cell}]`)} `;
		const codeLines = code ? code.split("\n").length : 0;
		const outputLines = this.output
			.trim()
			.split("\n")
			.filter((line) => line && !OUTPUT_LABEL.test(line)).length;
		const counts = `↑ ${codeLines} ↓ ${outputLines} line${outputLines === 1 ? "" : "s"}`;
		const parts = [
			`${failed ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${number}${theme.fg("toolTitle", "python")}`,
			highlightCode(firstLine, "python")[0] ?? "",
			theme.fg("muted", [counts, this.elapsed()].filter(Boolean).join(" · ")),
		];
		if (this.details?.error) parts.push(theme.fg("error", this.details.error));
		return parts.join(sep);
	}
}

interface PythonRenderState {
	cell?: PythonCell;
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

function cellFor(context: ToolRenderContext<PythonRenderState>): PythonCell {
	const state = context.state;
	state.cell ??= new PythonCell();
	const cell = state.cell;
	cell.started = context.executionStarted;
	cell.final = !context.isPartial;
	cell.isError = context.isError;
	cell.expanded = context.expanded;
	cell.pad = context.outputPad;
	cell.durationMs = context.durationMs;
	if (cell.final) state.endedAt ??= Date.now();
	cell.startedAt = state.startedAt;
	cell.endedAt = state.endedAt;
	// Redraw while running so the wheel spins; stop once the result is final.
	const running = cell.started && !cell.final;
	if (running && !state.interval) state.interval = setInterval(() => context.invalidate(), WHEEL_FRAME_MS);
	if (!running && state.interval) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
	return cell;
}

export const pythonRenderers: ToolRenderers = {
	renderShell: "self",
	renderCall(args, _theme, context) {
		startToolTimer(context);
		const cell = cellFor(context);
		cell.code = str((args as { code?: string } | undefined)?.code);
		return cell;
	},
	renderResult(result, _options, _theme, context) {
		const cell = cellFor(context);
		cell.details = result.details as PythonToolDetails | undefined;
		cell.output = getTextOutput(result, context.showImages);
		// The row is drawn by the call's component; the result slot stays empty.
		return (context.lastComponent as Container | undefined) ?? new Container();
	},
};
