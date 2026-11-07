import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pythonRenderers } from "../src/core/tools/renderers/python.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const CODE = "import random, asyncio\nprint(random.random())";

function cell(code = CODE) {
	const requestRender = vi.fn();
	const component = new ToolExecutionComponent(
		"python",
		"call-1",
		{ code },
		{},
		pythonRenderers,
		{ requestRender } as unknown as TUI,
		process.cwd(),
	);
	const lines = () =>
		component
			.render(120)
			.map((line) => stripAnsi(line).trimEnd())
			.filter((line) => line !== "");
	return { component, requestRender, lines };
}

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => vi.useRealTimers());

describe("python cell renderer", () => {
	it("shows the code muted before the cell starts", () => {
		const { lines } = cell();
		expect(lines()).toEqual([" python · import random, asyncio"]);
	});

	it("draws the spinning wheel with cell number, depth, and timer while running", () => {
		const { component, lines, requestRender } = cell();
		component.markExecutionStarted();
		component.updateResult(
			{ content: [], details: { cutCharacters: 0, restarted: false, cell: 5, depth: 0 }, isError: false },
			true,
		);
		vi.advanceTimersByTime(7800);
		const running = lines();
		expect(running).toHaveLength(3);
		expect(running[0]).toMatch(/cell 5 · depth 0 · 7\.8s · running$/);
		expect(running[1]).toMatch(/import random, asyncio$/);
		const wheel = running.map((line) => line.slice(0, 9)).join("|");
		vi.advanceTimersByTime(80);
		expect(
			lines()
				.map((line) => line.slice(0, 9))
				.join("|"),
		).not.toBe(wheel);
		expect(requestRender).toHaveBeenCalled();
	});

	it("collapses a finished cell to one line and stops redrawing", () => {
		const { component, lines, requestRender } = cell();
		component.markExecutionStarted();
		component.updateResult(
			{ content: [], details: { cutCharacters: 0, restarted: false, cell: 5, depth: 0 }, isError: false },
			true,
		);
		component.updateResult({
			content: [{ type: "text", text: "[stdout]\n0.42" }],
			details: { cutCharacters: 0, restarted: false, cell: 5, depth: 0 },
			isError: false,
			durationMs: 4000,
		});
		expect(lines()).toEqual([" ✓ [5] python · import random, asyncio · ↑ 2 ↓ 1 line · 4.0s"]);
		requestRender.mockClear();
		vi.advanceTimersByTime(1000);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("marks a failed cell with ✗ and its exception name", () => {
		const { component, lines } = cell();
		component.markExecutionStarted();
		component.updateResult({
			content: [{ type: "text", text: "[error]\nTraceback (most recent call last):\nToolError: exit code 1" }],
			details: { cutCharacters: 0, restarted: false, cell: 3, depth: 1, error: "ToolError" },
			isError: true,
			durationMs: 8700,
		});
		expect(lines()).toEqual([" ✗ [3] python · import random, asyncio · ↑ 2 ↓ 2 lines · 8.7s · ToolError"]);
	});

	it("shows the full code and output when expanded", () => {
		const { component, lines } = cell();
		component.markExecutionStarted();
		component.updateResult({
			content: [{ type: "text", text: "[stdout]\n0.42" }],
			details: { cutCharacters: 0, restarted: false, cell: 1, depth: 0 },
			isError: false,
			durationMs: 5,
		});
		component.setExpanded(true);
		expect(lines()).toEqual([
			" ✓ [1] python · import random, asyncio · ↑ 2 ↓ 1 line · 5ms",
			" │ import random, asyncio",
			" │ print(random.random())",
			" │",
			" │ [stdout]",
			" │ 0.42",
		]);
	});

	it("renders results recorded before cell numbers existed", () => {
		const { component, lines } = cell("x = 1");
		component.updateResult({
			content: [{ type: "text", text: "(no output)" }],
			details: { cutCharacters: 0, restarted: false },
			isError: false,
		});
		expect(lines()).toEqual([" ✓ python · x = 1 · ↑ 1 ↓ 1 line"]);
	});
});
