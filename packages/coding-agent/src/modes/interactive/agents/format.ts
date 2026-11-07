/** Formatting shared by the agents dashboard and its tree chart. */
import type { ChildAgentInfo } from "../../../core/rlm/child-agents.ts";
import type { ThemeColor } from "../theme/theme.ts";

export type DisplayStatus = "running" | "queued" | "done" | "partial" | "failed" | "stopped";

export const STATUS: Record<DisplayStatus, { glyph: string; color: ThemeColor }> = {
	running: { glyph: "●", color: "accent" },
	queued: { glyph: "◌", color: "muted" },
	done: { glyph: "✓", color: "success" },
	partial: { glyph: "◐", color: "warning" },
	failed: { glyph: "✗", color: "error" },
	stopped: { glyph: "■", color: "warning" },
};

// Task text, model output, and names come from agents; never let them drive the terminal.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export function safe(text: string): string {
	return text.replace(UNSAFE, (char) =>
		char === "\t" ? " " : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
export function oneLine(text: string): string {
	return safe(text.replace(/\s*[\r\n]+\s*/g, " "));
}

export function displayStatus(info: ChildAgentInfo): DisplayStatus {
	return info.busy ? "running" : info.status;
}
export function active(info: ChildAgentInfo): boolean {
	const status = displayStatus(info);
	return status === "running" || status === "queued";
}

export function formatAgentTokens(count: number): string {
	if (count < 1000) return String(Math.max(0, Math.round(count)));
	if (count < 999_950) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
export function formatAgentCost(cost: number): string {
	return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}
export function formatAgentDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}
export function modelId(model: string): string {
	const slash = model.indexOf("/");
	return slash < 0 ? model : model.slice(slash + 1);
}
