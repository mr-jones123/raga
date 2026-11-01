import { stripVTControlCharacters } from "node:util";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type AgentHubView, type AgentsAvailability, AgentsChooser } from "../src/modes/interactive/agents/chooser.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => initTheme("dark"));
function fixture(status: AgentsAvailability["status"], preferred: AgentHubView = "tui") {
	const done = vi.fn();
	const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
	const chooser = new AgentsChooser(
		tui as unknown as TUI,
		theme,
		new KeybindingsManager(),
		done,
		{ status, message: status === "missing" ? "Rex is not installed or is not on PATH." : status },
		preferred,
	);
	const text = () => chooser.render(100).map(stripVTControlCharacters).join("\n");
	return { chooser, done, tui, text };
}

describe("agent hub chooser", () => {
	it("offers TUI and Rex and highlights the last available choice", () => {
		const f = fixture("ready", "rex");
		expect(f.text()).toContain("> Rex workspace");
		f.chooser.handleInput("\r");
		expect(f.done).toHaveBeenCalledWith("rex");
	});
	it("disables absent Rex, explains why, and skips it during navigation", () => {
		const f = fixture("missing", "rex");
		expect(f.text()).toContain("> TUI dashboard");
		expect(f.text()).toContain("Rex workspace (unavailable)");
		expect(f.text()).toContain("not installed");
		expect(f.text()).not.toContain("Start Rex server");
		f.chooser.handleInput("\x1b[B");
		f.chooser.handleInput("\r");
		expect(f.done).toHaveBeenCalledWith("retry");
	});
	it("offers an explicit server-start action only when Rex is installed", () => {
		const f = fixture("unavailable");
		f.chooser.handleInput("\x1b[B");
		f.chooser.handleInput("\x1b[B");
		f.chooser.handleInput("\r");
		expect(f.done).toHaveBeenCalledWith("start-rex");
	});
	it("cancels without selecting a view", () => {
		const f = fixture("ready");
		f.chooser.handleInput("\x1b");
		f.chooser.handleInput("\r");
		expect(f.done).toHaveBeenCalledOnce();
		expect(f.done).toHaveBeenCalledWith(undefined);
	});
	it("fits narrow and short terminals", () => {
		const f = fixture("missing");
		for (const rows of [0, 1, 4, 24]) {
			f.tui.terminal.rows = rows;
			for (const width of [0, 1, 5, 20, 80]) {
				const lines = f.chooser.render(width);
				expect(lines).toHaveLength(rows);
				for (const line of lines) expect(visibleWidth(line)).toBe(width);
			}
		}
	});
});
