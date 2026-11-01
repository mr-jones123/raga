import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChildAgentInfo } from "../../../core/rlm/child-agents.ts";
import { theme } from "../theme/theme.ts";

const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/g, " ");

const tokens = (value: number) =>
	value >= 1_000_000
		? `${(value / 1_000_000).toFixed(1)}M`
		: value >= 1000
			? `${(value / 1000).toFixed(1)}k`
			: `${value}`;

/** One line above the footer while the main view shows a subagent's session. */
export class AgentFocusBanner implements Component {
	private readonly info: () => ChildAgentInfo | undefined;
	private readonly mainBusy: () => boolean;
	private readonly backKey: () => string;

	constructor(info: () => ChildAgentInfo | undefined, mainBusy: () => boolean, backKey: () => string) {
		this.info = info;
		this.mainBusy = mainBusy;
		this.backKey = backKey;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const info = this.info();
		if (!info || width < 1) return [];
		const status = info.busy ? "running" : info.status;
		const color =
			info.busy || status === "running"
				? "accent"
				: status === "failed"
					? "error"
					: status === "done"
						? "success"
						: "warning";
		const model = info.model.slice(info.model.indexOf("/") + 1);
		const parts = [
			theme.bold(theme.fg("accent", `◆ ${safe(info.name)}`)),
			theme.fg(color, status),
			theme.fg("muted", safe(model)),
			theme.fg(
				"muted",
				`${tokens(info.usage.totalTokens)} tok · $${info.usage.cost.toFixed(info.usage.cost < 1 ? 3 : 2)}`,
			),
			theme.fg("dim", info.promptable ? "type to steer" : "read-only"),
			theme.fg("dim", `main ${this.mainBusy() ? "working" : "idle"}`),
			theme.fg("dim", `${safe(this.backKey())} back to main`),
		];
		const line = truncateToWidth(` ${parts.join(theme.fg("dim", " · "))}`, width, "");
		return [line + " ".repeat(Math.max(0, width - visibleWidth(line)))];
	}
}
