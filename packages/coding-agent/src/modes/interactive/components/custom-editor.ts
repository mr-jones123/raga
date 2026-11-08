import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/** Columns the box adds on each side: `│ › ` on the left, ` │` on the right. */
const BOX_LEFT = 4;
const BOX_RIGHT = 2;
/** Below this width the box and prompt cost too much room; draw the plain editor. */
const BOX_MIN_WIDTH = 16;

/**
 * Custom editor that handles app-level keybindings for coding-agent. Draws the input in a rounded
 * box with a `›` prompt, and the session name in the top border.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;
	/** Session name for the top border; hidden while a working status is shown there. */
	public sessionLabel?: () => string | undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	override render(width: number): string[] {
		if (width < BOX_MIN_WIDTH) return super.render(width);
		const lines = super.render(width - BOX_LEFT - BOX_RIGHT);
		const bottom = this.renderedVisibleLineCount + 1;
		const edge = (text: string) => this.borderColor(text);
		const prompt = theme.fg("brand", "›");
		return lines.map((line, index) => {
			if (index === 0) return `${edge("╭──")}${line}${edge("──╮")}`;
			if (index < bottom) return `${edge("│")} ${index === 1 ? prompt : " "} ${line} ${edge("│")}`;
			if (index === bottom) return `${edge("╰──")}${line}${edge("──╯")}`;
			// Autocomplete rows sit under the box, aligned with the text.
			return `${" ".repeat(BOX_LEFT)}${line}`;
		});
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.width < BOX_MIN_WIDTH) return super.handleMouse(event);
		return super.handleMouse({ ...event, x: event.x - BOX_LEFT, width: event.width - BOX_LEFT - BOX_RIGHT });
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		let status =
			this.embedWorkingStatus && this.workingStatusIndicator && width > 0
				? this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5))
				: "";
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) {
			const label = hiddenLineCount === 0 ? this.sessionLabel?.()?.replace(/\s+/g, " ").trim() : undefined;
			if (!label || width < 8) return super.renderTopBorder(width, hiddenLineCount);
			const text = ` ${truncateToWidth(label, width - 4, "…")} `;
			return theme.fg("brand", text) + this.borderColor("─".repeat(width - visibleWidth(text)));
		}
		if (!this.workingStatusIndicator) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
