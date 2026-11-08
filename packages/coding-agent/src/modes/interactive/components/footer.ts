import { basename, resolve } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Cells in the footer's context bar. */
const CONTEXT_BAR_CELLS = 8;

/** `■■■□□□□□ 34%`: colored by how full the context window is. */
export function formatContextBar(percent: number | null | undefined): string {
	if (percent === null || percent === undefined) return theme.fg("dim", `${"□".repeat(CONTEXT_BAR_CELLS)} ?`);
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * CONTEXT_BAR_CELLS);
	const color = clamped > 90 ? "error" : clamped > 70 ? "warning" : "brand";
	return `${theme.fg(color, "■".repeat(filled))}${theme.fg("dim", "□".repeat(CONTEXT_BAR_CELLS - filled))} ${theme.fg("dim", `${Math.round(clamped)}%`)}`;
}

interface ContextStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	contextUsage: ContextUsage | undefined;
}

/**
 * One-line footer: folder, git branch, and context bar on the left; subscription or API billing,
 * model, and thinking level on the right. Extension statuses get a second line when any are set.
 */
export class FooterComponent implements Component {
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private contextStats?: ContextStats;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	/** No-op: the provider caches and invalidates the git branch. */
	invalidate(): void {}

	/** No-op: the provider owns the git watcher. */
	dispose(): void {}

	/**
	 * Context usage scans the session, and the footer renders on every frame. Entries are append-only
	 * and every append moves the leaf, so the result only changes with the session, leaf, entry count,
	 * or the model whose context window applies.
	 */
	private getContextUsage(): ContextUsage | undefined {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.contextStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached.contextUsage;
		}
		const contextUsage = this.session.getContextUsage();
		this.contextStats = { session: this.session, sessionId, leafId, entryCount, limitsModel, contextUsage };
		return contextUsage;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const sep = theme.fg("dim", " · ");

		const folder = sanitizeStatusText(basename(resolve(this.session.sessionManager.getCwd()))) || "/";
		const branch = this.footerData.getGitBranch();
		const leftParts = [folder];
		if (branch) leftParts.push(theme.fg("dim", sanitizeStatusText(branch)));
		leftParts.push(formatContextBar(this.getContextUsage()?.percent));
		const left = ` ${leftParts.join(sep)}`;

		const rightParts: string[] = [];
		if (state.model) {
			// Kimi Coding is subscription-backed despite using API-key authentication.
			const subscription =
				state.model.provider === "kimi-coding" ||
				this.session.modelRuntime.isUsingSubscription(state.model.provider);
			rightParts.push(subscription ? theme.fg("success", "sub") : theme.fg("warning", "api"));
		}
		let model = state.model?.id ?? "no-model";
		if (state.model?.reasoning) model += ` · ${state.thinkingLevel || "off"}`;
		// A virtual model routes each request; show where the latest response went.
		const routed = this.session.routedModel;
		if (routed) model += ` → ${routed.model.id}${routed.thinkingLevel ? ` · ${routed.thinkingLevel}` : ""}`;
		rightParts.push(theme.fg("dim", model));
		if (areExperimentalFeaturesEnabled()) rightParts.push(theme.bold(theme.fg("warning", "xp")));
		const right = `${rightParts.join(sep)} `;

		const leftWidth = visibleWidth(left);
		let line: string;
		if (leftWidth + 2 + visibleWidth(right) <= width) {
			line = left + " ".repeat(width - leftWidth - visibleWidth(right)) + right;
		} else if (leftWidth + 4 <= width) {
			const fitted = truncateToWidth(right, width - leftWidth - 2, "…");
			line = left + " ".repeat(width - leftWidth - visibleWidth(fitted)) + fitted;
		} else {
			line = truncateToWidth(left, width, "…");
		}
		const lines = [line];

		// Extension statuses on a second line, sorted by key.
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const statusLine = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join(" ");
			lines.push(truncateToWidth(` ${statusLine}`, width, theme.fg("dim", "...")));
		}
		return lines;
	}
}
