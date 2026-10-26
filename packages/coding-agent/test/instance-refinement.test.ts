import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	assessArms,
	type CandidateRecord,
	type ProbeRun,
	type RefinementEvidence,
	refineInstance,
} from "../src/core/instances/refinement.ts";
import { checkSandbox } from "../src/core/instances/sandbox.ts";
import {
	activateRevision,
	instancePaths,
	openInstance,
	readInstance,
	readRevisionEvidence,
} from "../src/core/instances/store.ts";
import {
	BUDGET,
	createRefinementFixture,
	type RefinementFixture,
	scriptedDriver,
	writeTree,
} from "./refinement-fixtures.ts";

const sandbox = await checkSandbox();
const fixtures: RefinementFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function fixture(harness: Record<string, string> = {}): Promise<RefinementFixture> {
	const created = await createRefinementFixture(harness);
	fixtures.push(created);
	return created;
}

function assessment(record: CandidateRecord | undefined): string {
	if (!record) return "missing";
	return record.status.kind === "assessed" ? record.status.assessment : `${record.status.kind}`;
}

function scores(record: CandidateRecord | undefined): Array<number | null> {
	return record?.status.kind === "assessed" ? record.status.runs.map((run) => run.score) : [];
}

function evidenceFile(fx: RefinementFixture, id: string): RefinementEvidence {
	return JSON.parse(readFileSync(join(instancePaths(fx.project).evidence, `${id}.json`), "utf8"));
}

function run(status: ProbeRun["status"], score: number | null, repetition = 0): ProbeRun {
	return {
		repetition,
		status,
		score,
		result: { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false },
	};
}

describe("assessArms", () => {
	test("requires every candidate run to beat every baseline run for an improvement", () => {
		expect(assessArms([run("ok", 1), run("ok", 1)], [run("ok", 2), run("ok", 2)], {})).toBe("improvement");
		expect(assessArms([run("ok", 1), run("ok", 2)], [run("ok", 2), run("ok", 3)], { noiseTolerance: 1 })).toBe(
			"neutral",
		);
		expect(assessArms([run("ok", 2)], [run("ok", 3)], { minImprovement: 1 })).toBe("neutral");
		expect(assessArms([run("ok", 2)], [run("ok", 4)], { minImprovement: 1 })).toBe("improvement");
	});

	test("treats unstable arms as flaky and lower scores as regressions", () => {
		expect(assessArms([run("ok", 1), run("ok", 1)], [run("ok", 1), run("ok", 2)], {})).toBe("flaky");
		expect(assessArms([run("ok", 1)], [run("timeout", 0)], {})).toBe("regression");
	});

	test("never calls a failing candidate run an improvement", () => {
		expect(assessArms([run("ok", -5)], [run("failed", 0)], {})).toBe("neutral");
	});
});

describe.runIf(sandbox.available)("refineInstance", () => {
	test(
		"an improvement yields passing evidence for the exact commit without activating it",
		{ timeout: 120_000 },
		async () => {
			const fx = await fixture();
			const before = await readInstance(fx.instanceRoot);
			const driver = scriptedDriver([{ "lessons/score.md": "3\n" }]);

			const result = await refineInstance({
				instanceRoot: fx.instanceRoot,
				objective: "raise the score",
				probe: fx.probe(),
				budget: { ...BUDGET, maxCandidates: 1 },
				driver,
			});

			expect(result.baseline?.runs.map((entry) => entry.score)).toEqual([1, 1]);
			expect(scores(result.candidates[0])).toEqual([3, 3]);
			expect(result.outcome.kind).toBe("improved");
			if (result.outcome.kind !== "improved") return;
			expect(result.outcome.changedFiles).toEqual(["lessons/score.md"]);
			expect((await readInstance(fx.instanceRoot)).activeRevision).toBe(before.activeRevision);

			const evidence = await readRevisionEvidence(fx.instanceRoot, result.outcome.evidenceId);
			expect(evidence).toMatchObject({
				verdict: "passed",
				baseRevision: before.activeRevision,
				candidateRevision: result.outcome.revision,
			});
			expect(evidenceFile(fx, result.outcome.evidenceId).notCovered).toEqual(["full task replay"]);
			expect(driver.proposals[0].baseline.runs.map((entry) => entry.score)).toEqual([1, 1]);

			await expect(
				activateRevision(fx.instanceRoot, result.outcome.revision, {
					expectedRevision: before.activeRevision,
					evidenceId: result.outcome.evidenceId,
					approved: false,
					approvedBy: "user",
				}),
			).rejects.toThrow();
			expect((await readInstance(fx.instanceRoot)).activeRevision).toBe(before.activeRevision);

			const activated = await activateRevision(fx.instanceRoot, result.outcome.revision, {
				expectedRevision: before.activeRevision,
				evidenceId: result.outcome.evidenceId,
				approved: true,
				approvedBy: "user",
			});
			expect(activated.activeRevision).toBe(result.outcome.revision);
			const pin = await openInstance(fx.instanceRoot);
			expect(readFileSync(join(pin.resourceRoot, "lessons/score.md"), "utf8")).toBe("3\n");
		},
	);

	test(
		"regression, neutral, and flaky candidates keep the baseline and are persisted",
		{ timeout: 180_000 },
		async () => {
			const fx = await fixture();
			const before = await readInstance(fx.instanceRoot);
			const driver = scriptedDriver([
				{ "lessons/score.md": "0\n" },
				{ "AGENTS.md": "# Base instructions\n\nPrefer small diffs.\n" },
				{ "lessons/score.md": "flaky\n" },
			]);

			const result = await refineInstance({
				instanceRoot: fx.instanceRoot,
				objective: "raise the score",
				probe: fx.probe(),
				budget: { ...BUDGET, maxCandidates: 3 },
				driver,
			});

			expect(result.candidates.map(assessment)).toEqual(["regression", "neutral", "flaky"]);
			expect(result.outcome.kind).toBe("no-improvement");
			expect(result.stopReason).toBe("candidate-limit");
			const verdicts = result.candidates.map((record) =>
				record.status.kind === "assessed" ? evidenceFile(fx, record.status.evidenceId).verdict : "none",
			);
			expect(verdicts).toEqual(["failed", "failed", "inconclusive"]);
			expect(driver.proposals[2].attempts.map((attempt) => attempt.assessment)).toEqual(["regression", "neutral"]);
			expect((await readInstance(fx.instanceRoot)).activeRevision).toBe(before.activeRevision);

			const record = JSON.parse(
				readFileSync(join(instancePaths(fx.project).evidence, "refinements", `${result.id}.json`), "utf8"),
			);
			expect(record.candidates.map(assessment)).toEqual(["regression", "neutral", "flaky"]);
		},
	);

	test("a composition that regresses is rejected in favour of the best component", { timeout: 180_000 }, async () => {
		const fx = await fixture();
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe(),
			budget: { ...BUDGET, maxCandidates: 2 },
			driver: scriptedDriver([{ "lessons/a.md": "on\n" }, { "lessons/b.md": "on\n" }]),
		});

		expect(result.candidates.map(assessment)).toEqual(["improvement", "improvement", "regression"]);
		const composition = result.candidates[2];
		expect(composition.role).toBe("composition");
		expect(composition.changedFiles.sort()).toEqual(["lessons/a.md", "lessons/b.md"]);
		expect(result.outcome).toMatchObject({
			kind: "improved",
			viaComposition: false,
			candidateId: result.candidates[1].candidateId,
		});
	});

	test("a passing composition is measured as its own commit and selected", { timeout: 180_000 }, async () => {
		const fx = await fixture();
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe(),
			budget: { ...BUDGET, maxCandidates: 2 },
			driver: scriptedDriver([{ "lessons/a.md": "on\n" }, { "lessons/c.md": "on\n" }]),
		});

		expect(scores(result.candidates[2])).toEqual([5, 5]);
		expect(result.outcome).toMatchObject({ kind: "improved", viaComposition: true });
		if (result.outcome.kind !== "improved") return;
		const evidence = await readRevisionEvidence(fx.instanceRoot, result.outcome.evidenceId);
		expect(evidence.candidateRevision).toBe(result.outcome.revision);
		expect(evidence.verdict).toBe("passed");
	});

	test(
		"conflicting components are merged by the driver before the composition is probed",
		{ timeout: 180_000 },
		async () => {
			const fx = await fixture();
			const driver = scriptedDriver([{ "lessons/score.md": "2\n" }, { "lessons/score.md": "3\n" }], (request) => {
				writeTree(request.checkout, { "lessons/score.md": "4\n" });
				return { hypothesis: "take both improvements", modelCalls: 1 };
			});
			const result = await refineInstance({
				instanceRoot: fx.instanceRoot,
				objective: "raise the score",
				probe: fx.probe(),
				budget: { ...BUDGET, maxCandidates: 2 },
				driver,
			});

			expect(driver.compositions[0].conflicts).toEqual(["lessons/score.md"]);
			expect(driver.compositions[0].components.map((component) => component.patch)).toEqual([
				expect.stringContaining("+2"),
				expect.stringContaining("+3"),
			]);
			expect(scores(result.candidates[2])).toEqual([4, 4]);
			expect(result.outcome).toMatchObject({ kind: "improved", viaComposition: true });
			expect(result.usage.driverCalls).toBe(3);
		},
	);

	test("a probe that exceeds its time limit counts as a regression", { timeout: 120_000 }, async () => {
		const fx = await fixture();
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe({ timeoutMs: 3_000, repetitions: 1 }),
			budget: { ...BUDGET, maxCandidates: 1 },
			driver: scriptedDriver([{ "lessons/score.md": "slow\n" }]),
		});

		const candidate = result.candidates[0];
		expect(candidate.status.kind === "assessed" && candidate.status.runs.map((entry) => entry.status)).toEqual([
			"timeout",
		]);
		expect(assessment(candidate)).toBe("regression");
		expect(result.outcome.kind).toBe("no-improvement");
	});

	test(
		"cancelling during a probe stops the run and leaves the active revision intact",
		{ timeout: 120_000 },
		async () => {
			const fx = await fixture();
			const before = await readInstance(fx.instanceRoot);
			const controller = new AbortController();
			const started = Date.now();
			const result = await refineInstance({
				instanceRoot: fx.instanceRoot,
				objective: "raise the score",
				probe: fx.probe({ timeoutMs: 60_000, repetitions: 1 }),
				budget: BUDGET,
				signal: controller.signal,
				driver: scriptedDriver([
					(request) => {
						writeTree(request.checkout, { "lessons/score.md": "slow\n" });
						// A real sandboxed process must be running when cancellation arrives, so fake timers cannot stand in.
						setTimeout(() => controller.abort(), 1_500);
						return { hypothesis: "slow down", modelCalls: 1 };
					},
				]),
			});

			expect(Date.now() - started).toBeLessThan(30_000);
			expect(result.stopReason).toBe("cancelled");
			expect(result.outcome.kind).toBe("cancelled");
			expect(result.candidates[0].status.kind).toBe("interrupted");
			expect((await readInstance(fx.instanceRoot)).activeRevision).toBe(before.activeRevision);
		},
	);

	test("the shared model-call budget stops further proposals", { timeout: 120_000 }, async () => {
		const fx = await fixture();
		const driver = scriptedDriver([
			(request) => {
				writeTree(request.checkout, { "lessons/score.md": "0\n" });
				return { hypothesis: "expensive idea", modelCalls: 2 };
			},
			{ "lessons/score.md": "3\n" },
		]);
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe(),
			budget: { ...BUDGET, maxDriverCalls: 2 },
			driver,
		});

		expect(driver.proposals).toHaveLength(1);
		expect(result.stopReason).toBe("driver-call-limit");
		expect(result.usage.driverCalls).toBe(2);
		expect(result.outcome.kind).toBe("no-improvement");
	});

	test("the probe budget can refuse even the baseline", async () => {
		const fx = await fixture();
		const driver = scriptedDriver([]);
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe({ repetitions: 3 }),
			budget: { ...BUDGET, maxProbeRuns: 2 },
			driver,
		});
		expect(result.outcome.kind).toBe("insufficient-evidence");
		expect(result.stopReason).toBe("probe-limit");
		expect(driver.proposals).toHaveLength(0);
	});

	test("evidence altered after it was written invalidates the improvement", { timeout: 180_000 }, async () => {
		const fx = await fixture();
		const evidenceDir = instancePaths(fx.project).evidence;
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe(),
			budget: { ...BUDGET, maxCandidates: 2 },
			driver: scriptedDriver([
				{ "lessons/score.md": "3\n" },
				() => {
					const [file] = readdirSync(evidenceDir).filter((name) => name.endsWith(".json"));
					const path = join(evidenceDir, file);
					chmodSync(path, 0o644);
					const evidence = JSON.parse(readFileSync(path, "utf8"));
					writeFileSync(path, JSON.stringify({ ...evidence, reason: "trust me" }));
					return { hypothesis: "edit the measurement", modelCalls: 1 };
				},
			]),
		});

		expect(assessment(result.candidates[0])).toBe("improvement");
		expect(result.outcome.kind).toBe("insufficient-evidence");
		expect(result.outcome.kind !== "improved" && result.outcome.reason).toContain("failed verification");
	});

	test("changing the trusted evaluator mid-run invalidates the measurement", { timeout: 120_000 }, async () => {
		const fx = await fixture();
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe(),
			budget: BUDGET,
			driver: scriptedDriver([
				(request) => {
					writeTree(request.checkout, { "lessons/score.md": "3\n" });
					writeFileSync(join(fx.evaluator, "evaluate.py"), 'print("RAGA_SCORE=100")\n');
					return { hypothesis: "rewrite the evaluator", modelCalls: 1 };
				},
			]),
		});

		expect(result.outcome.kind).toBe("insufficient-evidence");
		expect(result.outcome.kind !== "improved" && result.outcome.reason).toContain("measurement altered");
	});

	test("a probe cannot write the harness it measures", { timeout: 120_000 }, async () => {
		const fx = await fixture();
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe(),
			budget: { ...BUDGET, maxCandidates: 1 },
			driver: scriptedDriver([{ "lessons/score.md": "tamper\n" }]),
		});

		expect(scores(result.candidates[0])).toEqual([0, 0]);
		expect(result.outcome.kind).toBe("no-improvement");
	});

	test("edits outside the editable surface are rejected without probing", { timeout: 120_000 }, async () => {
		const fx = await fixture();
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe(),
			budget: { ...BUDGET, maxCandidates: 1 },
			driver: scriptedDriver([{ "extensions/auto.ts": "export default () => {};\n", "lessons/score.md": "3\n" }]),
		});

		expect(result.candidates[0].status).toMatchObject({ kind: "rejected", reason: "outside-surface" });
		expect(result.usage.probeRuns).toBe(2);
		expect(result.outcome.kind).toBe("insufficient-evidence");
	});

	test("an unstable baseline yields insufficient evidence before any proposal", { timeout: 120_000 }, async () => {
		const fx = await fixture({ "lessons/score.md": "flaky\n" });
		const driver = scriptedDriver([]);
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe(),
			budget: BUDGET,
			driver,
		});

		expect(result.outcome.kind).toBe("insufficient-evidence");
		expect(driver.proposals).toHaveLength(0);
	});

	test("probes with uncontrolled external effects are blocked", async () => {
		const fx = await fixture();
		const driver = scriptedDriver([]);
		const result = await refineInstance({
			instanceRoot: fx.instanceRoot,
			objective: "raise the score",
			probe: fx.probe({ externalEffects: "uncontrolled" }),
			budget: BUDGET,
			driver,
		});

		expect(result.outcome.kind).toBe("blocked");
		expect(result.usage.probeRuns).toBe(0);
		expect(driver.proposals).toHaveLength(0);
		expect(existsSync(join(instancePaths(fx.project).evidence, "refinements", `${result.id}.json`))).toBe(true);
	});
});
