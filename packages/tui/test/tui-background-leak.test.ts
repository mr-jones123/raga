import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class MutableLines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function assertDefaultBackground(terminal: VirtualTerminal, row: number): void {
	const xterm = (terminal as unknown as { xterm: XtermTerminal }).xterm;
	const line = xterm.buffer.active.getLine(xterm.buffer.active.viewportY + row);
	assert.ok(line);
	for (let col = 0; col < terminal.columns; col++) {
		const cell: IBufferCell | undefined = line.getCell(col);
		assert.ok(cell);
		assert.ok(cell.isBgDefault(), `row ${row}, col ${col} inherited a background`);
		assert.equal(cell.isInverse(), 0, `row ${row}, col ${col} inherited inverse video`);
	}
}

describe("TUI tool backgrounds", () => {
	it("isolates clipped tool rows from the input and erased blank cells in alternate mode", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const content = new MutableLines([`\x1b[41;7m${"X".repeat(21)}\x1b[0m`, "INPUT", ""]);
		tui.addChild(content);
		tui.start();
		try {
			await terminal.waitForRender();
			assertDefaultBackground(terminal, 1);
			assertDefaultBackground(terminal, 2);

			content.lines = [`\x1b[42m${"Y".repeat(21)}\x1b[0m`, "EDIT", ""];
			tui.requestRender();
			await terminal.waitForRender();
			assertDefaultBackground(terminal, 1);
			assertDefaultBackground(terminal, 2);

			tui.requestRender();
			await terminal.waitForRender();
			assertDefaultBackground(terminal, 1);
		} finally {
			tui.stop();
		}
	});

	it("keeps clipped tool styles out of the transcript replayed on exit", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new MutableLines([`\x1b[41;7m${"X".repeat(21)}\x1b[0m`, "INPUT", "footer"]));
		tui.start();
		await terminal.waitForRender();
		tui.stop();
		await terminal.flush();
		const inputRow = terminal.getViewport().findIndex((line) => line.startsWith("INPUT"));
		assert.ok(inputRow >= 0, "exit should replay the input row");
		assertDefaultBackground(terminal, inputRow);
		assertDefaultBackground(terminal, inputRow + 1);
	});

	it("does not paint deleted rows with an inherited background in regular mode", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiMainScreen(terminal);
		const content = new MutableLines(["tool", "INPUT", "footer"]);
		tui.addChild(content);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.write("\x1b[41m");
			content.lines = ["tool", "INPUT"];
			tui.requestRender();
			await terminal.waitForRender();
			assertDefaultBackground(terminal, 2);
		} finally {
			tui.stop();
		}
	});
});
