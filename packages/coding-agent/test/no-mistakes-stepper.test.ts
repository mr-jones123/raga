import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	applyNoMistakesOutput,
	applyNoMistakesProgressLine,
	initialNoMistakesProgress,
} from "../src/core/instances/no-mistakes-progress.ts";
import { renderNoMistakesStepper } from "../src/core/tools/renderers/no-mistakes-stepper.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line));

describe("no-mistakes progress", () => {
	it("follows axi run stderr transitions and the final run object", () => {
		const progress = initialNoMistakesProgress(["push", "pr", "ci"], 0);
		expect(applyNoMistakesProgressLine(progress, "run: running")).toBe(true);
		expect(applyNoMistakesProgressLine(progress, "  review: running")).toBe(true);
		expect(applyNoMistakesProgressLine(progress, "  review: running")).toBe(false);
		expect(
			applyNoMistakesProgressLine(progress, "review: protected-path refusal requires an explicit response"),
		).toBe(false);
		applyNoMistakesProgressLine(progress, "  gate.test.flaky: pending");
		expect(progress.steps.map((step) => step.name)).toEqual([
			"intent",
			"rebase",
			"review",
			"test",
			"gate.test.flaky",
			"document",
			"lint",
			"push",
			"pr",
			"ci",
		]);

		applyNoMistakesOutput(
			progress,
			[
				"run:",
				"  id: run-1",
				"  branch: feature/x",
				"  status: running",
				"  head: abcdef12",
				"  findings: 1 info",
				"  steps[2]{step,status,findings,duration_ms}:",
				"    review,completed,1,1200",
				"    test,awaiting_approval,2,0",
				"gate:",
				"  step: test",
			].join("\n"),
		);
		expect(progress).toMatchObject({ branch: "feature/x", head: "abcdef12", runStatus: "running" });
		expect(progress.steps.find((step) => step.name === "test")).toEqual({
			name: "test",
			status: "awaiting_approval",
			findings: 2,
		});
	});
});

describe("no-mistakes stepper", () => {
	it("draws one box with the steps in order and points at the active step", () => {
		const progress = initialNoMistakesProgress(["push", "pr", "ci"], 0);
		progress.branch = "feat/json-flag";
		progress.head = "a1b2c3d";
		for (const line of ["  intent: completed", "  rebase: completed", "  review: completed", "  test: completed"])
			applyNoMistakesProgressLine(progress, line);
		applyNoMistakesProgressLine(progress, "  document: fixing");

		const lines = renderNoMistakesStepper(progress, 100, { final: false, now: 192_000 });
		const text = plain(lines);
		expect(lines.every((line) => visibleWidth(line) === visibleWidth(lines[0]))).toBe(true);
		expect(text[0]).toMatch(/^╭─ no-mistakes · feat\/json-flag · a1b2c3d ─+ 3m 12s · running ─╮$/);
		expect(text[1]).toMatch(/^│ ✔ review ── ✔ test ── \S docs ── ○ lint ── ⊘ push ── ⊘ PR ── ⊘ CI +│$/);
		expect(text[2].indexOf("└")).toBe(text[1].indexOf("docs") - 2);
		expect(text[2]).toContain("└ fixing");
		expect(text[3]).toMatch(/^╰─ push, PR, CI skipped \(not authorized\) ─+╯$/);
	});

	it("reports a gate, a pass with skips, and an interrupted cell", () => {
		const progress = initialNoMistakesProgress(["push", "pr", "ci"], 0);
		applyNoMistakesProgressLine(progress, "  review: awaiting_approval");
		expect(plain(renderNoMistakesStepper(progress, 100, { final: false, now: 1000 }))[2]).toContain(
			"└ waiting for your decision",
		);
		expect(plain(renderNoMistakesStepper(progress, 100, { final: true }))[0]).toContain("interrupted");

		applyNoMistakesProgressLine(progress, "  review: completed");
		progress.outcome = "passed-with-skips";
		progress.endedAt = 5000;
		const done = plain(renderNoMistakesStepper(progress, 100, { final: true }));
		expect(done[0]).toContain("5.0s · passed-with-skips");
		expect(done).toHaveLength(3);
	});

	it("falls back to glyphs when the labels do not fit", () => {
		const progress = initialNoMistakesProgress([], 0);
		applyNoMistakesProgressLine(progress, "  review: running");
		const lines = renderNoMistakesStepper(progress, 30, { final: false, now: 0 });
		expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
		expect(plain(lines)[1]).toMatch(/^│ \S○○○○○○ review +│$/);
	});
});
