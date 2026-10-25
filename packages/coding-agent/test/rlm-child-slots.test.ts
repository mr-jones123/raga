import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { RLM_TREE_CHILD_LIMIT, type RlmChildParent, RlmChildSlots } from "../src/core/rlm/children.ts";

/** Let every resolved promise and its continuations run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await setImmediate();
}

/** A promise that settles when the test calls the resolver it pushes to `barrier`. */
function parked(barrier: Array<() => void>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	barrier.push(resolve);
	return promise;
}

describe("RlmChildSlots", () => {
	it("never runs more than 8 children across a tree of 9 requested over two levels", async () => {
		const slots = new RlmChildSlots();
		const signal = new AbortController().signal;
		let live = 0;
		let maxLive = 0;
		let finished = 0;
		const barrier: Array<() => void> = [];
		/** A counter handler: counts itself live while `body` runs. */
		const child = async (body: () => Promise<void>) => {
			live++;
			maxLive = Math.max(maxLive, live);
			try {
				await body();
			} finally {
				live--;
				finished++;
			}
		};
		const root: RlmChildParent = { running: 0 };
		// Three depth-1 children, each asking for two depth-2 children: 9 requests, all live at once without the cap.
		const run = Promise.all(
			Array.from({ length: 3 }, () =>
				slots.run(root, 1, 2, signal, () =>
					child(async () => {
						const parent: RlmChildParent = { running: 0 };
						await Promise.all(
							Array.from({ length: 2 }, () =>
								slots.run(parent, 2, 2, signal, () => child(() => parked(barrier))),
							),
						);
					}),
				),
			),
		);

		await settle();
		expect(live).toBe(RLM_TREE_CHILD_LIMIT);
		expect(barrier).toHaveLength(5);
		while (finished < 9) {
			expect(barrier.length).toBeGreaterThan(0);
			barrier.shift()?.();
			await settle();
			expect(live).toBeLessThanOrEqual(RLM_TREE_CHILD_LIMIT);
		}
		await run;
		expect(maxLive).toBe(RLM_TREE_CHILD_LIMIT);
	});

	it("keeps 4 children per parent", async () => {
		const slots = new RlmChildSlots();
		const signal = new AbortController().signal;
		const parent: RlmChildParent = { running: 0 };
		const barrier: Array<() => void> = [];
		const run = Promise.all(Array.from({ length: 6 }, () => slots.run(parent, 1, 1, signal, () => parked(barrier))));
		await settle();
		expect(barrier).toHaveLength(4);
		while (barrier.length > 0) {
			barrier.shift()?.();
			await settle();
		}
		await run;
		expect(parent.running).toBe(0);
	});

	it("leaves slots for deeper children, so parents waiting on their children never fill the tree", async () => {
		// With rlm.maxDepth 3, four chains of depth 1 -> 2 -> 3 would hold all 8 slots at depths 1 and 2 and
		// wait forever for depth 3 without the reserve.
		const slots = new RlmChildSlots();
		const signal = new AbortController().signal;
		const chain = (parent: RlmChildParent, depth: number): Promise<void> =>
			slots.run(parent, depth, 3, signal, async () => {
				if (depth < 3) await chain({ running: 0 }, depth + 1);
			});
		const root: RlmChildParent = { running: 0 };
		await Promise.all(Array.from({ length: 4 }, () => chain(root, 1)));
		expect(root.running).toBe(0);
	});

	it("rejects a waiting child when its signal aborts", async () => {
		const slots = new RlmChildSlots(1);
		const parent: RlmChildParent = { running: 0 };
		const barrier: Array<() => void> = [];
		const first = slots.run(parent, 1, 1, new AbortController().signal, () => parked(barrier));
		const controller = new AbortController();
		const second = slots.run(parent, 1, 1, controller.signal, async () => "ran");
		controller.abort();
		await expect(second).rejects.toThrow("rlm_query was aborted");
		barrier.shift()?.();
		await first;
		await expect(slots.run(parent, 1, 1, new AbortController().signal, async () => "ran")).resolves.toBe("ran");
	});
});
