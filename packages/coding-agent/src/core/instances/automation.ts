/**
 * Opt-in, checkpoint-triggered refinement policy.
 *
 * Automation is off until the user enables it. Each checkpoint run reserves a slot under a lock, so
 * rate limits, daily call/time caps, and the no-progress stop hold across processes. Promotion stays
 * with the user unless held-out evidence from outside the instance shows the adaptive system beats
 * both the fixed harness and equal-budget retries; even then host extensions and settings changes
 * always need explicit approval. This module decides; the supervisor performs activation.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import lockfile from "proper-lockfile";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	type ModelCallMeter,
	type ProbePreparation,
	type ProbeSpec,
	type RefinementDriver,
	type RefinementResult,
	refineInstance,
} from "./refinement.ts";
import { instancePaths, readInstance } from "./store.ts";

const STATE_FILE = "refinement-automation.json";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A started run older than its deadline plus this grace is treated as abandoned by a crashed process. */
const ABANDON_GRACE_MS = 60_000;

const BudgetSchema = Type.Object({
	maxCandidates: Type.Integer({ minimum: 1 }),
	maxDriverCalls: Type.Integer({ minimum: 1 }),
	maxProbeRuns: Type.Integer({ minimum: 1 }),
	deadlineMs: Type.Integer({ minimum: 1 }),
});

const LimitsSchema = Type.Object({
	minIntervalMs: Type.Integer({ minimum: 0 }),
	maxRunsPerDay: Type.Integer({ minimum: 1 }),
	maxDriverCallsPerDay: Type.Integer({ minimum: 1 }),
	maxWallMsPerDay: Type.Integer({ minimum: 1 }),
	maxConsecutiveNoProgress: Type.Integer({ minimum: 1 }),
	run: BudgetSchema,
});

const HoldoutApprovalSchema = Type.Object({
	reportPath: Type.String({ minLength: 1 }),
	digest: Type.String({ minLength: 64, maxLength: 64 }),
	margin: Type.Number({ minimum: 0 }),
	minTrials: Type.Integer({ minimum: 1 }),
	enabledAt: Type.String(),
});

const PromotionPolicySchema = Type.Union([
	Type.Object({ mode: Type.Literal("approval") }),
	Type.Object({ mode: Type.Literal("automatic"), holdout: HoldoutApprovalSchema }),
]);

const AutomationRunSchema = Type.Object({
	token: Type.String(),
	startedAt: Type.String(),
	deadlineMs: Type.Integer({ minimum: 1 }),
	maxDriverCalls: Type.Integer({ minimum: 1 }),
	finishedAt: Type.Optional(Type.String()),
	refinementId: Type.Optional(Type.String()),
	outcome: Type.Optional(Type.String()),
	driverCalls: Type.Integer({ minimum: 0 }),
	wallMs: Type.Integer({ minimum: 0 }),
	progress: Type.Optional(Type.Boolean()),
});

const AutomationStateSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	enabled: Type.Boolean(),
	disabledReason: Type.Optional(Type.String()),
	limits: Type.Optional(LimitsSchema),
	promotion: PromotionPolicySchema,
	consecutiveNoProgress: Type.Integer({ minimum: 0 }),
	runs: Type.Array(AutomationRunSchema),
});

const ArmSchema = Type.Object({
	successes: Type.Integer({ minimum: 0 }),
	trials: Type.Integer({ minimum: 1 }),
});

/** External held-out comparison, produced by the benchmark harness the refiner cannot read. */
const HoldoutReportSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	heldOut: Type.Literal(true),
	refinerAccess: Type.Literal(false),
	evaluatedAt: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
	taskFamilies: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	arms: Type.Object({
		/** The unchanged harness. */
		fixed: ArmSchema,
		/** The unchanged harness with retries up to the adaptive arm's inference budget. */
		equalBudget: ArmSchema,
		/** Memory, skills, and refinement together. */
		adaptive: ArmSchema,
	}),
});

const validateLimits = Compile(LimitsSchema);
const validateState = Compile(AutomationStateSchema);
const validateHoldout = Compile(HoldoutReportSchema);

export type AutomationLimits = Static<typeof LimitsSchema>;
export type PromotionPolicy = Static<typeof PromotionPolicySchema>;
export type AutomationRun = Static<typeof AutomationRunSchema>;
export type AutomationState = Static<typeof AutomationStateSchema>;
export type HoldoutReport = Static<typeof HoldoutReportSchema>;

export type CheckpointBlock =
	| "disabled"
	| "in-progress"
	| "rate-limited"
	| "daily-run-limit"
	| "daily-call-limit"
	| "daily-time-limit";

export type CheckpointAdmission =
	| { allowed: true; token: string; budget: Static<typeof BudgetSchema> }
	| { allowed: false; reason: CheckpointBlock; detail: string };

export type PromotionDecision =
	| { kind: "none"; reason: string }
	| { kind: "approval-required"; reason: string; revision: string; evidenceId: string; expectedRevision: string }
	| { kind: "policy"; approvedBy: "policy"; revision: string; evidenceId: string; expectedRevision: string };

export class AutomationInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationInputError";
	}
}

const DEFAULT_STATE: AutomationState = {
	schemaVersion: 1,
	enabled: false,
	promotion: { mode: "approval" },
	consecutiveNoProgress: 0,
	runs: [],
};

// ---------------------------------------------------------------------------------------------
// Persistence

async function stateDir(instanceRoot: string): Promise<string> {
	const manifest = await readInstance(instanceRoot);
	const dir = instancePaths(manifest.projectRoot).state;
	await mkdir(dir, { recursive: true });
	return dir;
}

async function loadState(dir: string): Promise<AutomationState> {
	let text: string;
	try {
		text = await readFile(join(dir, STATE_FILE), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return structuredClone(DEFAULT_STATE);
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (!validateState.Check(parsed)) throw new AutomationInputError(`${STATE_FILE} is malformed`);
	return parsed;
}

/** Read-modify-write under an interprocess lock with an atomic rename. */
async function updateState<T>(
	instanceRoot: string,
	change: (state: AutomationState) => T,
): Promise<{ state: AutomationState; value: T }> {
	const dir = await stateDir(instanceRoot);
	const release = await lockfile.lock(dir, {
		lockfilePath: join(dir, "refinement-automation.lock"),
		stale: 10_000,
		retries: { retries: 50, factor: 1, minTimeout: 50, maxTimeout: 200 },
	});
	try {
		const state = await loadState(dir);
		const value = change(state);
		const temporary = join(dir, `${STATE_FILE}.${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(state, null, "\t")}\n`);
		await rename(temporary, join(dir, STATE_FILE));
		return { state, value };
	} finally {
		await release();
	}
}

export async function readAutomation(instanceRoot: string): Promise<AutomationState> {
	return loadState(await stateDir(instanceRoot));
}

// ---------------------------------------------------------------------------------------------
// Enablement

/** Opt in to checkpoint-triggered refinement with explicit limits. Promotion policy is unchanged. */
export async function enableAutomation(instanceRoot: string, limits: unknown): Promise<AutomationState> {
	if (!validateLimits.Check(limits)) {
		const errors = validateLimits
			.Errors(limits)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`)
			.join("; ");
		throw new AutomationInputError(`invalid automation limits: ${errors}`);
	}
	const { state } = await updateState(instanceRoot, (current) => {
		current.enabled = true;
		current.disabledReason = undefined;
		current.limits = limits;
		current.consecutiveNoProgress = 0;
	});
	return state;
}

export async function disableAutomation(instanceRoot: string, reason: string): Promise<AutomationState> {
	const { state } = await updateState(instanceRoot, (current) => {
		current.enabled = false;
		current.disabledReason = reason;
	});
	return state;
}

function rate(arm: { successes: number; trials: number }): number {
	return arm.successes / arm.trials;
}

/** Why a held-out report does not support automatic promotion, or undefined when it does. */
export function holdoutShortfall(report: HoldoutReport, margin: number, minTrials: number): string | undefined {
	const { fixed, equalBudget, adaptive } = report.arms;
	for (const [name, arm] of Object.entries(report.arms)) {
		if (arm.successes > arm.trials) return `${name} reports more successes than trials`;
		if (arm.trials < minTrials) return `${name} has ${arm.trials} trials; ${minTrials} required`;
	}
	const strongestControl = Math.max(rate(fixed), rate(equalBudget));
	const gain = rate(adaptive) - strongestControl;
	if (gain < margin || gain <= 0) {
		return `adaptive success ${rate(adaptive).toFixed(3)} does not beat the strongest control ${strongestControl.toFixed(3)} by ${margin}`;
	}
	return undefined;
}

async function readHoldout(
	reportPath: string,
	projectRoot: string,
): Promise<{ report: HoldoutReport; digest: string; path: string }> {
	if (!isAbsolute(reportPath)) throw new AutomationInputError("held-out report path must be absolute");
	const path = await realpath(reportPath);
	const project = await realpath(projectRoot);
	const rel = relative(project, path);
	if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
		throw new AutomationInputError("held-out evidence must live outside the project the refiner works in");
	}
	const content = await readFile(path);
	const parsed: unknown = JSON.parse(content.toString("utf8"));
	if (!validateHoldout.Check(parsed))
		throw new AutomationInputError("held-out report is malformed or not held out from the refiner");
	return { report: parsed, digest: createHash("sha256").update(content).digest("hex"), path };
}

/**
 * Allow policy promotion only when external held-out evidence supports it. A negative or weak
 * result leaves (or returns) promotion to user approval.
 */
export async function enableAutomaticPromotion(
	instanceRoot: string,
	options: { reportPath: string; margin: number; minTrials: number },
): Promise<{ enabled: boolean; reason: string; state: AutomationState }> {
	if (!(options.margin >= 0) || !Number.isInteger(options.minTrials) || options.minTrials < 1) {
		throw new AutomationInputError("margin must be >= 0 and minTrials a positive integer");
	}
	const manifest = await readInstance(instanceRoot);
	const holdout = await readHoldout(options.reportPath, manifest.projectRoot);
	const shortfall = holdoutShortfall(holdout.report, options.margin, options.minTrials);
	const { state } = await updateState(instanceRoot, (current) => {
		current.promotion = shortfall
			? { mode: "approval" }
			: {
					mode: "automatic",
					holdout: {
						reportPath: holdout.path,
						digest: holdout.digest,
						margin: options.margin,
						minTrials: options.minTrials,
						enabledAt: new Date().toISOString(),
					},
				};
	});
	return shortfall
		? { enabled: false, reason: shortfall, state }
		: { enabled: true, reason: "held-out evidence supports automatic promotion", state };
}

export async function disableAutomaticPromotion(instanceRoot: string): Promise<AutomationState> {
	const { state } = await updateState(instanceRoot, (current) => {
		current.promotion = { mode: "approval" };
	});
	return state;
}

// ---------------------------------------------------------------------------------------------
// Checkpoint runs

function settleAbandoned(state: AutomationState, now: number): void {
	for (const run of state.runs) {
		if (run.finishedAt || Date.parse(run.startedAt) + run.deadlineMs + ABANDON_GRACE_MS > now) continue;
		run.finishedAt = new Date(now).toISOString();
		run.outcome = "abandoned";
		run.driverCalls = run.maxDriverCalls;
		run.wallMs = run.deadlineMs;
		run.progress = false;
		state.consecutiveNoProgress++;
	}
}

/**
 * Reserve a checkpoint run when the policy allows one now. The returned budget is the per-run budget
 * clipped to what remains of the daily call and time caps.
 */
export async function beginCheckpointRun(instanceRoot: string, now: Date = new Date()): Promise<CheckpointAdmission> {
	const { value } = await updateState(instanceRoot, (state): CheckpointAdmission => {
		const at = now.getTime();
		settleAbandoned(state, at);
		state.runs = state.runs.filter((run) => !run.finishedAt || Date.parse(run.startedAt) > at - DAY_MS);
		const limits = state.limits;
		if (state.enabled && limits && state.consecutiveNoProgress >= limits.maxConsecutiveNoProgress) {
			state.enabled = false;
			state.disabledReason = `stopped after ${state.consecutiveNoProgress} runs without progress`;
		}
		if (!state.enabled || !limits) {
			return { allowed: false, reason: "disabled", detail: state.disabledReason ?? "automation is not enabled" };
		}
		if (state.runs.some((run) => !run.finishedAt)) {
			return { allowed: false, reason: "in-progress", detail: "another checkpoint refinement is running" };
		}
		const last = state.runs.reduce((latest, run) => Math.max(latest, Date.parse(run.startedAt)), 0);
		if (last > 0 && at - last < limits.minIntervalMs) {
			return {
				allowed: false,
				reason: "rate-limited",
				detail: `next run allowed after ${new Date(last + limits.minIntervalMs).toISOString()}`,
			};
		}
		const today = state.runs.filter((run) => Date.parse(run.startedAt) > at - DAY_MS);
		if (today.length >= limits.maxRunsPerDay) {
			return { allowed: false, reason: "daily-run-limit", detail: `${today.length} runs in the last 24 hours` };
		}
		const callsLeft = limits.maxDriverCallsPerDay - today.reduce((sum, run) => sum + run.driverCalls, 0);
		if (callsLeft < 1) return { allowed: false, reason: "daily-call-limit", detail: "daily model-call budget spent" };
		const timeLeft = limits.maxWallMsPerDay - today.reduce((sum, run) => sum + run.wallMs, 0);
		if (timeLeft < 1) return { allowed: false, reason: "daily-time-limit", detail: "daily wall-time budget spent" };

		const budget = {
			...limits.run,
			maxDriverCalls: Math.min(limits.run.maxDriverCalls, callsLeft),
			deadlineMs: Math.min(limits.run.deadlineMs, timeLeft),
		};
		const token = randomUUID();
		state.runs.push({
			token,
			startedAt: now.toISOString(),
			deadlineMs: budget.deadlineMs,
			maxDriverCalls: budget.maxDriverCalls,
			driverCalls: 0,
			wallMs: 0,
		});
		return { allowed: true, token, budget };
	});
	return value;
}

/** Record a reserved run's spend and outcome. Idempotent per token. */
export async function finishCheckpointRun(
	instanceRoot: string,
	token: string,
	result: RefinementResult | { error: string },
	now: Date = new Date(),
): Promise<AutomationState> {
	const { state } = await updateState(instanceRoot, (current) => {
		const run = current.runs.find((entry) => entry.token === token);
		if (!run || run.finishedAt) return;
		run.finishedAt = now.toISOString();
		if ("error" in result) {
			run.outcome = "error";
			run.driverCalls = run.maxDriverCalls;
			run.wallMs = Math.max(0, now.getTime() - Date.parse(run.startedAt));
			run.progress = false;
			current.consecutiveNoProgress++;
		} else {
			run.refinementId = result.id;
			run.outcome = result.outcome.kind;
			run.driverCalls = result.usage.driverCalls;
			run.wallMs = result.usage.wallMs;
			run.progress = result.outcome.kind === "improved";
			if (result.outcome.kind === "improved") current.consecutiveNoProgress = 0;
			else if (result.outcome.kind !== "cancelled") current.consecutiveNoProgress++;
			if (result.outcome.kind === "blocked") {
				current.enabled = false;
				current.disabledReason = `probe blocked: ${result.outcome.reason}`;
			}
		}
		const limits = current.limits;
		if (current.enabled && limits && current.consecutiveNoProgress >= limits.maxConsecutiveNoProgress) {
			current.enabled = false;
			current.disabledReason = `stopped after ${current.consecutiveNoProgress} runs without progress`;
		}
	});
	return state;
}

/** Decide who may approve promoting a refinement result. Activation itself stays with the supervisor. */
export async function decidePromotion(instanceRoot: string, result: RefinementResult): Promise<PromotionDecision> {
	const outcome = result.outcome;
	if (outcome.kind !== "improved") return { kind: "none", reason: `refinement outcome is ${outcome.kind}` };
	const target = { revision: outcome.revision, evidenceId: outcome.evidenceId, expectedRevision: result.baseRevision };
	// Host extensions and settings are executable host configuration; they always need the user.
	if (outcome.changedFiles.some((path) => path.startsWith("extensions/") || path === "settings.json")) {
		return { kind: "approval-required", reason: "the change touches host extensions or settings", ...target };
	}
	const state = await readAutomation(instanceRoot);
	if (state.promotion.mode !== "automatic") {
		return { kind: "approval-required", reason: "automatic promotion is not enabled", ...target };
	}
	const approval = state.promotion.holdout;
	try {
		const manifest = await readInstance(instanceRoot);
		const holdout = await readHoldout(approval.reportPath, manifest.projectRoot);
		if (holdout.digest !== approval.digest) {
			return { kind: "approval-required", reason: "held-out evidence changed since it was approved", ...target };
		}
		const shortfall = holdoutShortfall(holdout.report, approval.margin, approval.minTrials);
		if (shortfall) return { kind: "approval-required", reason: shortfall, ...target };
	} catch (error) {
		return {
			kind: "approval-required",
			reason: `held-out evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
			...target,
		};
	}
	return { kind: "policy", approvedBy: "policy", ...target };
}

export interface CheckpointRequest {
	objective: string;
	probe: ProbeSpec;
	driver: RefinementDriver;
	signal?: AbortSignal;
	includeUntracked?: string[];
	meter?: ModelCallMeter;
	prepareProbe?: (request: ProbePreparation) => Promise<void>;
	probeMetadata?: Record<string, string>;
}

export type CheckpointRefinement =
	| { ran: false; reason: CheckpointBlock; detail: string }
	| { ran: true; result: RefinementResult; decision: PromotionDecision; state: AutomationState };

/** Run one checkpoint-triggered refinement when policy admits it, and decide its promotion path. */
export async function runCheckpointRefinement(
	instanceRoot: string,
	request: CheckpointRequest,
	now: Date = new Date(),
): Promise<CheckpointRefinement> {
	const admission = await beginCheckpointRun(instanceRoot, now);
	if (!admission.allowed) return { ran: false, reason: admission.reason, detail: admission.detail };
	let result: RefinementResult;
	try {
		result = await refineInstance({
			instanceRoot,
			objective: request.objective,
			probe: request.probe,
			budget: admission.budget,
			driver: request.driver,
			signal: request.signal,
			includeUntracked: request.includeUntracked,
			meter: request.meter,
			prepareProbe: request.prepareProbe,
			probeMetadata: request.probeMetadata,
		});
	} catch (error) {
		await finishCheckpointRun(instanceRoot, admission.token, {
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
	const state = await finishCheckpointRun(instanceRoot, admission.token, result);
	return { ran: true, result, decision: await decidePromotion(instanceRoot, result), state };
}
