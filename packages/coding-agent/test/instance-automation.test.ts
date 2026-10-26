import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	AutomationInputError,
	type AutomationLimits,
	beginCheckpointRun,
	decidePromotion,
	disableAutomation,
	enableAutomaticPromotion,
	enableAutomation,
	finishCheckpointRun,
	type HoldoutReport,
	readAutomation,
	runCheckpointRefinement,
} from "../src/core/instances/automation.ts";
import type { RefinementOutcome, RefinementResult } from "../src/core/instances/refinement.ts";
import { checkSandbox } from "../src/core/instances/sandbox.ts";
import { activateRevision, instancePaths, readInstance } from "../src/core/instances/store.ts";
import { createRefinementFixture, type RefinementFixture, scriptedDriver } from "./refinement-fixtures.ts";

const sandbox = await checkSandbox();
const fixtures: RefinementFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function fixture(): Promise<RefinementFixture> {
	const created = await createRefinementFixture();
	fixtures.push(created);
	return created;
}

const LIMITS: AutomationLimits = {
	minIntervalMs: 60_000,
	maxRunsPerDay: 5,
	maxDriverCallsPerDay: 10,
	maxWallMsPerDay: 3_600_000,
	maxConsecutiveNoProgress: 3,
	run: { maxCandidates: 2, maxDriverCalls: 8, maxProbeRuns: 12, deadlineMs: 600_000 },
};

const T0 = Date.parse("2026-10-25T12:00:00Z");
const at = (ms: number): Date => new Date(T0 + ms);

function refinementResult(outcome: RefinementOutcome, driverCalls = 1): RefinementResult {
	return {
		schemaVersion: 1,
		id: "00000000-0000-4000-8000-000000000000",
		instanceId: "00000000-0000-4000-8000-000000000001",
		objective: "raise the score",
		baseRevision: "b".repeat(40),
		command: ["python3", "evaluate.py"],
		notCovered: [],
		budget: LIMITS.run,
		usage: { driverCalls, probeRuns: 4, wallMs: 1_000 },
		candidates: [],
		stopReason: "completed",
		outcome,
		startedAt: at(0).toISOString(),
		finishedAt: at(1_000).toISOString(),
	};
}

const IMPROVED: Extract<RefinementOutcome, { kind: "improved" }> = {
	kind: "improved",
	candidateId: "candidate",
	revision: "c".repeat(40),
	evidenceId: "e".repeat(64),
	viaComposition: false,
	changedFiles: ["lessons/score.md"],
};
const NO_IMPROVEMENT: RefinementOutcome = { kind: "no-improvement", reason: "neutral" };

function holdout(fx: RefinementFixture, adaptive: number, name = "holdout.json"): string {
	const report: HoldoutReport = {
		schemaVersion: 1,
		heldOut: true,
		refinerAccess: false,
		evaluatedAt: at(0).toISOString(),
		model: "test-model",
		taskFamilies: ["refactor", "bugfix"],
		arms: {
			fixed: { successes: 5, trials: 20 },
			equalBudget: { successes: 8, trials: 20 },
			adaptive: { successes: adaptive, trials: 20 },
		},
	};
	const path = join(fx.root, name);
	writeFileSync(path, JSON.stringify(report));
	return path;
}

describe("checkpoint automation policy", () => {
	test("rejects held-out reports in project directories beginning with two dots", async () => {
		const fx = await fixture();
		mkdirSync(join(fx.project, "..holdout"));
		const reportPath = holdout(fx, 18, "project/..holdout/report.json");
		await expect(enableAutomaticPromotion(fx.instanceRoot, { reportPath, margin: 0, minTrials: 10 })).rejects.toThrow(
			"outside the project",
		);
		expect((await readAutomation(fx.instanceRoot)).promotion.mode).toBe("approval");
	});

	test("is disabled until the user opts in", async () => {
		const fx = await fixture();
		expect((await readAutomation(fx.instanceRoot)).enabled).toBe(false);
		expect(await beginCheckpointRun(fx.instanceRoot, at(0))).toMatchObject({ allowed: false, reason: "disabled" });
		await expect(enableAutomation(fx.instanceRoot, { ...LIMITS, maxRunsPerDay: 0 })).rejects.toThrow(
			AutomationInputError,
		);
	});

	test("persists opt-in and enforces in-progress, rate, and daily call limits", async () => {
		const fx = await fixture();
		await enableAutomation(fx.instanceRoot, LIMITS);
		expect(existsSync(join(instancePaths(fx.project).state, "refinement-automation.json"))).toBe(true);

		const first = await beginCheckpointRun(fx.instanceRoot, at(0));
		expect(first).toMatchObject({ allowed: true, budget: { maxDriverCalls: 8 } });
		expect(await beginCheckpointRun(fx.instanceRoot, at(1_000))).toMatchObject({
			allowed: false,
			reason: "in-progress",
		});
		if (!first.allowed) return;
		await finishCheckpointRun(fx.instanceRoot, first.token, refinementResult(NO_IMPROVEMENT, 7), at(2_000));

		expect(await beginCheckpointRun(fx.instanceRoot, at(30_000))).toMatchObject({
			allowed: false,
			reason: "rate-limited",
		});
		const second = await beginCheckpointRun(fx.instanceRoot, at(61_000));
		expect(second).toMatchObject({ allowed: true, budget: { maxDriverCalls: 3 } });
		if (!second.allowed) return;
		await finishCheckpointRun(fx.instanceRoot, second.token, refinementResult(NO_IMPROVEMENT, 3), at(62_000));

		expect(await beginCheckpointRun(fx.instanceRoot, at(130_000))).toMatchObject({
			allowed: false,
			reason: "daily-call-limit",
		});
		expect(await beginCheckpointRun(fx.instanceRoot, at(24 * 3_600_000 + 1_000))).toMatchObject({ allowed: true });
	});

	test("stops itself after consecutive runs without progress", async () => {
		const fx = await fixture();
		await enableAutomation(fx.instanceRoot, { ...LIMITS, minIntervalMs: 0, maxConsecutiveNoProgress: 2 });
		const outcomes = [NO_IMPROVEMENT, IMPROVED, NO_IMPROVEMENT, NO_IMPROVEMENT];
		for (const [index, outcome] of outcomes.entries()) {
			const admission = await beginCheckpointRun(fx.instanceRoot, at(index * 1_000));
			expect(admission.allowed).toBe(true);
			if (admission.allowed) await finishCheckpointRun(fx.instanceRoot, admission.token, refinementResult(outcome));
		}
		const state = await readAutomation(fx.instanceRoot);
		expect(state.enabled).toBe(false);
		expect(state.disabledReason).toContain("without progress");
		expect(await beginCheckpointRun(fx.instanceRoot, at(10_000))).toMatchObject({
			allowed: false,
			reason: "disabled",
		});
	});

	test("recovers a run abandoned by a crashed process and charges its whole budget", async () => {
		const fx = await fixture();
		await enableAutomation(fx.instanceRoot, LIMITS);
		expect((await beginCheckpointRun(fx.instanceRoot, at(0))).allowed).toBe(true);
		const later = await beginCheckpointRun(fx.instanceRoot, at(LIMITS.run.deadlineMs + 61_000));
		expect(later).toMatchObject({ allowed: true, budget: { maxDriverCalls: 2 } });
		const state = await readAutomation(fx.instanceRoot);
		expect(state.runs[0]).toMatchObject({ outcome: "abandoned", driverCalls: 8 });
		expect(state.consecutiveNoProgress).toBe(1);
	});

	test("admits exactly one of two concurrent checkpoints", async () => {
		const fx = await fixture();
		await enableAutomation(fx.instanceRoot, LIMITS);
		const admissions = await Promise.all([
			beginCheckpointRun(fx.instanceRoot, at(0)),
			beginCheckpointRun(fx.instanceRoot, at(0)),
		]);
		expect(admissions.filter((admission) => admission.allowed)).toHaveLength(1);
	});

	test("a disabled policy reports the user's reason", async () => {
		const fx = await fixture();
		await enableAutomation(fx.instanceRoot, LIMITS);
		await disableAutomation(fx.instanceRoot, "paused by user");
		expect(await beginCheckpointRun(fx.instanceRoot, at(0))).toMatchObject({
			allowed: false,
			detail: "paused by user",
		});
	});
});

describe("promotion decisions", () => {
	test("held-out evidence that does not beat equal-budget retries keeps approval required", async () => {
		const fx = await fixture();
		const enabled = await enableAutomaticPromotion(fx.instanceRoot, {
			reportPath: holdout(fx, 8),
			margin: 0.05,
			minTrials: 10,
		});
		expect(enabled.enabled).toBe(false);
		expect(enabled.state.promotion.mode).toBe("approval");
		const decision = await decidePromotion(fx.instanceRoot, refinementResult(IMPROVED));
		expect(decision.kind).toBe("approval-required");
	});

	test("held-out evidence must live outside the project", async () => {
		const fx = await fixture();
		const inside = join(fx.project, "holdout.json");
		writeFileSync(inside, "{}");
		await expect(
			enableAutomaticPromotion(fx.instanceRoot, { reportPath: inside, margin: 0.05, minTrials: 10 }),
		).rejects.toThrow(AutomationInputError);
	});

	test("supportive held-out evidence allows policy promotion except for host changes or altered evidence", async () => {
		const fx = await fixture();
		const reportPath = holdout(fx, 14);
		const enabled = await enableAutomaticPromotion(fx.instanceRoot, { reportPath, margin: 0.1, minTrials: 10 });
		expect(enabled.enabled).toBe(true);

		expect(await decidePromotion(fx.instanceRoot, refinementResult(IMPROVED))).toMatchObject({
			kind: "policy",
			approvedBy: "policy",
			revision: IMPROVED.revision,
			expectedRevision: "b".repeat(40),
		});
		expect(
			await decidePromotion(
				fx.instanceRoot,
				refinementResult({ ...IMPROVED, changedFiles: ["extensions/auto.ts"] }),
			),
		).toMatchObject({ kind: "approval-required" });
		expect(await decidePromotion(fx.instanceRoot, refinementResult(NO_IMPROVEMENT))).toMatchObject({ kind: "none" });

		holdout(fx, 20);
		expect(await decidePromotion(fx.instanceRoot, refinementResult(IMPROVED))).toMatchObject({
			kind: "approval-required",
			reason: expect.stringContaining("changed"),
		});
	});
});

describe.runIf(sandbox.available)("runCheckpointRefinement", () => {
	test("a policy-approved improvement can be activated by the supervisor", { timeout: 120_000 }, async () => {
		const fx = await fixture();
		const before = await readInstance(fx.instanceRoot);
		await enableAutomation(fx.instanceRoot, { ...LIMITS, run: { ...LIMITS.run, maxCandidates: 1 } });
		await enableAutomaticPromotion(fx.instanceRoot, { reportPath: holdout(fx, 14), margin: 0.1, minTrials: 10 });

		const checkpoint = await runCheckpointRefinement(fx.instanceRoot, {
			objective: "raise the score",
			probe: fx.probe(),
			driver: scriptedDriver([{ "lessons/score.md": "3\n" }]),
		});

		expect(checkpoint.ran).toBe(true);
		if (!checkpoint.ran || checkpoint.decision.kind !== "policy") throw new Error("expected a policy decision");
		expect(checkpoint.state.runs.at(-1)).toMatchObject({ progress: true, outcome: "improved" });
		expect((await readInstance(fx.instanceRoot)).activeRevision).toBe(before.activeRevision);

		const activated = await activateRevision(fx.instanceRoot, checkpoint.decision.revision, {
			expectedRevision: checkpoint.decision.expectedRevision,
			evidenceId: checkpoint.decision.evidenceId,
			approved: true,
			approvedBy: checkpoint.decision.approvedBy,
		});
		expect(activated.activeRevision).toBe(checkpoint.decision.revision);
	});
});
