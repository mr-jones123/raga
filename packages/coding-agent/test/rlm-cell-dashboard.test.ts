import { beforeAll, describe, expect, it } from "vitest";
import { emitRlmCellEvent } from "../src/core/rlm/cell-events.ts";
import { RlmCellDashboard } from "../src/modes/interactive/components/rlm-cell-dashboard.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("RLM cell dashboard", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps cells apart when sessions reuse a call id", () => {
		const requestRender = () => {};
		const dashboard = new RlmCellDashboard(requestRender, () => "viewed");
		emitRlmCellEvent({
			type: "start",
			cellId: "same-call",
			cell: 1,
			sessionId: "root",
			depth: 0,
			code: "print('root')",
			startedAt: Date.now(),
		});
		emitRlmCellEvent({
			type: "start",
			cellId: "same-call",
			cell: 2,
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
		const dashboard = new RlmCellDashboard(
			() => {},
			() => "viewed",
		);
		emitRlmCellEvent({
			type: "start",
			cellId: "root-cell",
			cell: 1,
			sessionId: "root",
			depth: 0,
			code: "print('root')",
			startedAt: Date.now() - 1200,
		});
		emitRlmCellEvent({
			type: "start",
			cellId: "child-cell",
			cell: 2,
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
			cell: 3,
			sessionId: "root",
			depth: 0,
			code: "late()",
			startedAt: Date.now(),
		});
		expect(dashboard.render(100)).toEqual([]);
	});

	it("hides the viewed session's cells, which its transcript draws, and shows other sessions'", () => {
		let viewed = "root";
		const dashboard = new RlmCellDashboard(
			() => {},
			() => viewed,
		);
		for (const [sessionId, depth] of [
			["root", 0],
			["child", 1],
		] as const) {
			emitRlmCellEvent({
				type: "start",
				cellId: `${sessionId}-cell`,
				sessionId,
				cell: 7,
				depth,
				code: `print('${sessionId}')`,
				startedAt: Date.now(),
			});
		}
		let text = dashboard.render(100).join("\n");
		expect(text).toContain("cell 7 · depth 1");
		expect(text).not.toContain("depth 0");
		// Opening the child in the main view swaps them.
		viewed = "child";
		text = dashboard.render(100).join("\n");
		expect(text).toContain("cell 7 · depth 0");
		expect(text).not.toContain("depth 1");
		viewed = "other";
		expect(dashboard.render(100)).toHaveLength(6);
		dashboard.dispose();
	});
});
