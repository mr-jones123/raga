/**
 * The no-mistakes stepper drawn under the python cell that drove a run:
 *
 *   ╭─ no-mistakes · feat/json-flag · a1b2c3d ─────────── 3m12s · running ─╮
 *   │ ✔ review ── ✔ test ── ● docs ── ○ lint ── ⊘ push ── ⊘ PR ── ⊘ CI    │
 *   │                       └ fixing                                       │
 *   ╰─ push, PR, CI skipped (not authorized) ──────────────────────────────╯
 *
 * Intent and rebase are not drawn as steps; while they run or after they fail, the detail line names them.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../../modes/interactive/theme/theme.ts";
import {
	type NoMistakesProgress,
	type NoMistakesStep,
	noMistakesAnchor,
} from "../../instances/no-mistakes-progress.ts";
import { formatToolDuration } from "../render-utils.ts";

const LABELS: Record<string, string> = { document: "docs", pr: "PR", ci: "CI" };
const PREP = new Set(["intent", "rebase"]);
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const ACTIVE = new Set(["running", "fixing", "fix_review"]);

function label(name: string): string {
	if (name.startsWith("gate.")) return name.split(".").slice(2).join(".") || name;
	return LABELS[name] ?? name;
}

function glyph(status: string, now: number, live: boolean): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✔");
		case "failed":
			return theme.fg("error", "✖");
		case "skipped":
			return theme.fg("dim", "⊘");
		case "awaiting_approval":
			return theme.fg("warning", "⏸");
		case "running":
			return theme.fg("accent", live ? SPINNER[Math.floor(now / 80) % SPINNER.length] : "●");
		case "fixing":
		case "fix_review":
			return theme.fg("warning", live ? SPINNER[Math.floor(now / 80) % SPINNER.length] : "●");
		default:
			return theme.fg("muted", "○");
	}
}

function detail(step: NoMistakesStep): string {
	const findings = step.findings ? ` · ${step.findings} finding${step.findings === 1 ? "" : "s"}` : "";
	switch (step.status) {
		case "awaiting_approval":
			return theme.fg("warning", `waiting for your decision${findings}`);
		case "failed":
			return theme.fg("error", `${label(step.name)} failed${findings}`);
		case "fix_review":
			return theme.fg("warning", "reviewing fix");
		case "fixing":
			return theme.fg("warning", `fixing${findings}`);
		default:
			return theme.fg("muted", PREP.has(step.name) ? `preparing · ${step.name}` : step.status);
	}
}

/** The run's state word and its color: a pass with skips or overrides is never green. */
function verdict(progress: NoMistakesProgress, final: boolean): string {
	if (progress.outcome) {
		const color =
			progress.outcome === "passed" || progress.outcome === "checks-passed"
				? "success"
				: progress.outcome.startsWith("passed")
					? "warning"
					: "error";
		return theme.fg(color, progress.outcome);
	}
	if (progress.state === "gate") return theme.fg("warning", "gate");
	if (progress.state === "failed") return theme.fg("error", "failed");
	if (progress.state && progress.state !== "running") return theme.fg("warning", progress.state);
	if (final && progress.endedAt === undefined) return theme.fg("error", "interrupted");
	if (progress.state === "running") return theme.fg("warning", "still running · raga no-mistakes status");
	return theme.fg("accent", "running");
}

/** Draw the boxed stepper. `final` means the python cell has ended. */
export function renderNoMistakesStepper(
	progress: NoMistakesProgress,
	width: number,
	options: { final: boolean; now?: number },
): string[] {
	const now = options.now ?? Date.now();
	const live = !options.final && progress.endedAt === undefined;
	const visible = progress.steps.filter((step) => !PREP.has(noMistakesAnchor(step.name)));
	const focus =
		progress.steps.find((step) => step.status === "failed" || step.status === "awaiting_approval") ??
		progress.steps.find((step) => ACTIVE.has(step.status));

	// Each pill is `<glyph> <label>`; columns record where each starts so the detail line can point at one.
	const connector = theme.fg("dim", " ── ");
	const columns: number[] = [];
	let row = "";
	let rowWidth = 0;
	for (const step of visible) {
		if (row) {
			row += connector;
			rowWidth += 4;
		}
		columns.push(rowWidth);
		const name = label(step.name);
		const text = step.status === "pending" || step.status === "skipped" ? theme.fg("muted", name) : name;
		row += `${glyph(step.status, now, live)} ${text}`;
		rowWidth += 2 + visibleWidth(name);
	}

	const title = [
		theme.fg("toolTitle", "no-mistakes"),
		progress.branch,
		progress.head && theme.fg("muted", progress.head),
	]
		.filter(Boolean)
		.join(theme.fg("muted", " · "));
	const elapsed = formatToolDuration(
		(progress.endedAt ?? (options.final ? progress.startedAt : now)) - progress.startedAt,
	);
	const status = [
		progress.endedAt !== undefined || !options.final ? theme.fg("muted", elapsed) : "",
		verdict(progress, options.final),
	]
		.filter(Boolean)
		.join(theme.fg("muted", " · "));

	const notes: string[] = [];
	if (progress.skipped.length) notes.push(`${progress.skipped.map(label).join(", ")} skipped (not authorized)`);
	if (focus?.status === "awaiting_approval") notes.push("respond: raga no-mistakes respond");
	if (progress.pr) notes.push(progress.pr);
	const footer = theme.fg("muted", notes.join(" · "));
	// Wide enough for the steps, the title line, and the footer, but never wider than the terminal.
	const titleWidth = visibleWidth(title) + visibleWidth(status) + 9;
	const footerWidth = visibleWidth(footer) + 6;
	const boxWidth = Math.max(Math.min(width, Math.max(rowWidth + 4, titleWidth, footerWidth, 60)), 20);
	const inner = boxWidth - 4;
	if (rowWidth > inner) {
		// Too narrow for labels: glyphs only, then the focused step's name.
		row = visible.map((step) => glyph(step.status, now, live)).join("");
		if (focus) row += ` ${label(focus.name)}`;
		columns.length = 0;
	}

	const border = (text: string) => theme.fg("borderMuted", text);
	const line = (content: string) => {
		const fitted = truncateToWidth(content, inner, "…");
		return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
	};
	// `╭─ title ─────── right ─╮`; the title and right text shrink before the corners do.
	const rule = (left: string, title: string, right: string, end: string) => {
		const head = title ? `${border("─")} ${title} ` : "";
		const tail = right ? ` ${right} ${border("─")}` : "";
		const room = boxWidth - 2;
		const fill = room - visibleWidth(head) - visibleWidth(tail);
		const middle =
			fill >= 1 ? `${head}${border("─".repeat(fill))}${tail}` : truncateToWidth(`${head}${tail}`, room, "…");
		return `${border(left)}${middle}${" ".repeat(Math.max(0, room - visibleWidth(middle)))}${border(end)}`;
	};

	const lines = [rule("╭", title, status, "╮"), line(row)];
	if (focus) {
		const index = visible.indexOf(focus);
		const column = index === -1 || columns.length === 0 ? 0 : columns[index];
		lines.push(line(`${" ".repeat(column)}${theme.fg("dim", "└")} ${detail(focus)}`));
	}
	lines.push(rule("╰", notes.length ? footer : "", "", "╯"));
	return lines;
}
