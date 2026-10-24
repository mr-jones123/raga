/**
 * Presentation for the RLM `python` tool: the cell's code as the call, its output as the result,
 * collapsed like bash. Kept apart from `core/rlm/runtime.ts` so a process that only displays tool
 * output does not load the kernel.
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../../modes/interactive/components/visual-truncate.ts";
import { highlightCode, theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions } from "../../extensions/types.ts";
import { getTextOutput, invalidArgText, replaceTabs, startToolTimer, str, toolTimerText } from "../render-utils.ts";

const PYTHON_PREVIEW_LINES = 5;
const PYTHON_CALL_PREVIEW_LINES = 10;

function formatPythonCall(args: { code?: string } | undefined, expanded: boolean): string {
	const code = str(args?.code);
	const title = theme.fg("toolTitle", theme.bold("python"));
	if (code === null) return `${title} ${invalidArgText(theme)}`;
	if (!code) return `${title} ${theme.fg("toolOutput", "...")}`;
	const lines = highlightCode(replaceTabs(code.replace(/\s+$/, "")), "python");
	const shown = expanded ? lines : lines.slice(0, PYTHON_CALL_PREVIEW_LINES);
	const hidden = lines.length - shown.length;
	const more = hidden > 0 ? `\n${theme.fg("muted", `... (${hidden} more lines)`)}` : "";
	return `${title}\n${shown.join("\n")}${more}`;
}

function rebuildPythonResultRenderComponent(
	component: Container,
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	options: ToolRenderResultOptions,
	showImages: boolean,
	timerText: string | undefined,
): void {
	component.clear();
	const output = getTextOutput(result, showImages).trim();
	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild(new Spacer(1));
			component.addChild(
				new VisualLinePreview({
					text: styledOutput,
					maxVisualLines: PYTHON_PREVIEW_LINES,
					keep: "end",
					formatHint: (hidden) =>
						theme.fg("muted", `... (${hidden} earlier lines,`) +
						` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				}),
			);
		}
	}
	if (timerText) component.addChild(new Text(`\n${theme.fg("muted", timerText)}`, 0, 0));
}

export const pythonRenderers: ToolRenderers = {
	renderCall(args, _theme, context) {
		startToolTimer(context);
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatPythonCall(args as { code?: string } | undefined, context.expanded));
		return text;
	},
	renderResult(result, options, _theme, context) {
		const timerText = toolTimerText(context, options.isPartial);
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		rebuildPythonResultRenderComponent(component, result, options, context.showImages, timerText);
		component.invalidate();
		return component;
	},
};
