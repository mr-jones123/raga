import { describe, expect, it } from "vitest";
import {
	cellCodePreview,
	emitRlmCellEvent,
	type RlmCellEvent,
	subscribeRlmCellEvents,
} from "../src/core/rlm/cell-events.ts";

describe("RLM cell events", () => {
	it("delivers start and end to every subscriber until unsubscribed", () => {
		const seen: RlmCellEvent[] = [];
		const unsubscribe = subscribeRlmCellEvents((event) => seen.push(event));
		emitRlmCellEvent({
			type: "start",
			cellId: "call-1",
			sessionId: "session-a",
			depth: 0,
			code: "print(1)",
			startedAt: 10,
		});
		emitRlmCellEvent({
			type: "end",
			cellId: "call-1",
			sessionId: "session-a",
			depth: 0,
			status: "ok",
			durationMs: 42,
		});
		unsubscribe();
		emitRlmCellEvent({
			type: "start",
			cellId: "call-2",
			sessionId: "session-a",
			depth: 0,
			code: "print(2)",
			startedAt: 20,
		});
		expect(seen.map((event) => `${event.type}:${event.cellId}`)).toEqual(["start:call-1", "end:call-1"]);
	});

	it("isolates a throwing listener from the cell and other listeners", () => {
		const seen: string[] = [];
		const unsubscribeBad = subscribeRlmCellEvents(() => {
			throw new Error("dashboard bug");
		});
		const unsubscribeGood = subscribeRlmCellEvents((event) => seen.push(event.type));
		expect(() =>
			emitRlmCellEvent({
				type: "start",
				cellId: "call-3",
				sessionId: "session-b",
				depth: 1,
				code: "x",
				startedAt: 1,
			}),
		).not.toThrow();
		expect(seen).toEqual(["start"]);
		unsubscribeBad();
		unsubscribeGood();
	});

	it("previews the first non-empty code line", () => {
		expect(cellCodePreview("\n\n  print(summary)  \nprint(other)")).toBe("print(summary)");
		expect(cellCodePreview("x".repeat(200))).toHaveLength(96);
	});
});
