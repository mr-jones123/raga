import { beginCheckpointRun, decidePromotion, finishCheckpointRun } from "./automation.ts";
import {
	activationBlocker,
	type ModelRefinementOptions,
	type ModelRefinementResult,
	runModelRefinement,
} from "./model-refinement.ts";
import { activateRevision } from "./store.ts";

export async function runModelCheckpoint(instanceRoot: string, options: Omit<ModelRefinementOptions, "approved">) {
	const admission = await beginCheckpointRun(instanceRoot);
	if (!admission.allowed) return { ran: false as const, ...admission };
	let result: ModelRefinementResult;
	try {
		result = await runModelRefinement(instanceRoot, {
			...options,
			approved: false,
			timeoutMs: Math.min(options.timeoutMs ?? admission.budget.deadlineMs, admission.budget.deadlineMs),
			maxModelCalls: Math.min(
				options.maxModelCalls ?? admission.budget.maxDriverCalls,
				admission.budget.maxDriverCalls,
			),
			maxCandidates: Math.min(
				options.maxCandidates ?? admission.budget.maxCandidates,
				admission.budget.maxCandidates,
			),
			maxProbeRuns: Math.min(options.maxProbeRuns ?? admission.budget.maxProbeRuns, admission.budget.maxProbeRuns),
		});
	} catch (error) {
		await finishCheckpointRun(instanceRoot, admission.token, {
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
	const state = await finishCheckpointRun(instanceRoot, admission.token, result.refinement);
	const decision = await decidePromotion(instanceRoot, result.refinement);
	const blocker = activationBlocker(result);
	if (decision.kind === "policy" && !blocker) {
		const manifest = await activateRevision(instanceRoot, decision.revision, {
			expectedRevision: decision.expectedRevision,
			evidenceId: decision.evidenceId,
			approved: true,
			approvedBy: "policy",
		});
		return { ran: true as const, result, decision, state, activated: manifest.activeRevision };
	}
	return { ran: true as const, result, decision, state, blocker };
}
