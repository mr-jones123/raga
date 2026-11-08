import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi as stripSgr } from "../src/utils/ansi.ts";

// Also drop the editor's fake-cursor APC markers.
const stripAnsi = (line: string) => stripSgr(line).replace(/\x1b_[^\x07]*\x07/g, "");

function editor(text: string, label?: string) {
	const component = new CustomEditor(
		new TuiMainScreen(new VirtualTerminal()),
		defaultEditorTheme,
		new KeybindingsManager(),
	);
	component.sessionLabel = () => label;
	component.focused = false;
	component.setText(text);
	return component;
}

beforeAll(() => initTheme("dark"));

describe("CustomEditor box", () => {
	it("draws a rounded box with the prompt and the session name in the top border", () => {
		const lines = editor("hello", "footer-redesign").render(40).map(stripAnsi);
		expect(lines).toEqual([
			"╭── footer-redesign ───────────────────╮",
			"│ › hello                              │",
			"╰──────────────────────────────────────╯",
		]);
	});

	it("keeps every row at the full width without a session name", () => {
		const lines = editor("one\ntwo").render(30);
		expect(lines.map(visibleWidth)).toEqual([30, 30, 30, 30]);
		expect(stripAnsi(lines[2])).toBe("│   two                      │");
	});

	it("falls back to the plain editor on very narrow terminals", () => {
		expect(stripAnsi(editor("hi").render(10)[0])).toBe("─".repeat(10));
	});
});
