import { beforeAll, describe, expect, it } from "vitest";
import { emitRlmCellEvent } from "../src/core/rlm/cell-events.ts";
import { RlmCellDashboard } from "../src/modes/interactive/components/rlm-cell-dashboard.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("RLM cell dashboard", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps cells apart when sessions reuse a call id", () => {
		const requestRender = () => {};
		const dashboard = new RlmCellDashboard(requestRender);
		emitRlmCellEvent({
			type: "start",
			cellId: "same-call",
			sessionId: "root",
			depth: 0,
			code: "print('root')",
			startedAt: Date.now(),
		});
		emitRlmCellEvent({
			type: "start",
			cellId: "same-call",
			sessionId: "child",
			depth: 1,
			code: "print('child')",
			startedAt: Date.now(),
		});
		emitRlmCellEvent({
			type: "end",
			cellId: "same-call",
			sessionId: "child",
			depth: 1,
			status: "ok",
			durationMs: 10,
		});
		const text = dashboard.render(100).join("\n");
		expect(text).toContain("cell 1 · depth 0");
		expect(text).toContain("running");
		expect(text).toContain("cell 2 · depth 1");
		expect(text).toContain("ok");
		dashboard.dispose();
	});

	it("renders one row per running cell, keeps ended cells briefly, and unsubscribes on dispose", () => {
		const dashboard = new RlmCellDashboard(() => {});
		emitRlmCellEvent({
			type: "start",
			cellId: "root-cell",
			sessionId: "root",
			depth: 0,
			code: "print('root')",
			startedAt: Date.now() - 1200,
		});
		emitRlmCellEvent({
			type: "start",
			cellId: "child-cell",
			sessionId: "child",
			depth: 1,
			code: "print('child')",
			startedAt: Date.now() - 400,
		});
		const running = dashboard.render(100);
		expect(running).toHaveLength(6);
		expect(running.join("\n")).toContain("cell 1 · depth 0");
		expect(running.join("\n")).toContain("cell 2 · depth 1");
		expect(running.join("\n")).toContain("print('root')");
		expect(running.join("\n")).toContain("print('child')");
		expect(running[0]).not.toBe(running[3]);

		emitRlmCellEvent({
			type: "end",
			cellId: "root-cell",
			sessionId: "root",
			depth: 0,
			status: "ok",
			durationMs: 1200,
		});
		const ended = dashboard.render(100);
		expect(ended.join("\n")).toContain("cell 1 · depth 0 · 1.2s · ok");
		expect(ended.findIndex((line) => line.includes("cell 2"))).toBeLessThan(
			ended.findIndex((line) => line.includes("cell 1")),
		);
		expect(dashboard.render(9)).toEqual([]);

		dashboard.dispose();
		emitRlmCellEvent({
			type: "start",
			cellId: "late",
			sessionId: "root",
			depth: 0,
			code: "late()",
			startedAt: Date.now(),
		});
		expect(dashboard.render(100)).toEqual([]);
	});
});
