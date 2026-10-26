/**
 * Model-backed Propose-Probe-Compose refinement and the `/refine` command.
 *
 * Each proposal or composition is one real agent session on the instance's accepted harness,
 * sandboxed so that the candidate checkout is its only writable harness path. Each probe replay is a
 * real solver session on the measured harness in a fresh project copy, followed by the operator's
 * fixed evaluator. Every model invocation of these session trees (turns, `llm_query`, `llm_batch`,
 * `rlm_query` children, compaction) goes through one metered runtime, so the operator's call limit is
 * exact rather than an estimate per driver call. Measurement, evidence, and activation stay with the
 * supervisor.
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	lazyStream,
	type Model,
	type ModelsApiStreamOptions,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "../agent-session.ts";
import { createAgentSessionServices } from "../agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "../auth-guidance.ts";
import type { ExtensionCommandContext, InlineExtension } from "../extensions/index.ts";
import { findInitialModel, resolveCliModel } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { parseCommandArgs } from "../prompt-templates.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import type { Settings, SettingsManager } from "../settings-manager.ts";
import { isVirtualModel } from "../virtual-models.ts";
import {
	type AttemptSummary,
	type CompositionRequest,
	type DriverReply,
	EDITABLE_SURFACE,
	type ModelCallMeter,
	materializeRevision,
	type ProbePreparation,
	type ProbeRun,
	type ProposalRequest,
	type RefinementDriver,
	RefinementInputError,
	type RefinementResult,
	type RemainingBudget,
	refineInstance,
} from "./refinement.ts";
import { instanceSandbox, instanceSettings } from "./session.ts";
import { type SkillValidation, validateSkill, verifySkillRevision } from "./skills.ts";
import { activateRevision, instancePaths, openInstance, readInstance } from "./store.ts";
import type { HarnessPin, InstanceManifest } from "./types.ts";

const MINUTE_MS = 60_000;
const LIMITS = {
	timeoutMs: { min: 1_000, max: 6 * 60 * MINUTE_MS },
	maxModelCalls: { min: 1, max: 2_000 },
	maxCandidates: { min: 1, max: 8 },
	repetitions: { min: 2, max: 10 },
	maxProbeRuns: { min: 1, max: 400 },
	probeTimeoutMs: { min: 1_000, max: 60 * MINUTE_MS },
} as const;
const DEFAULTS = {
	timeoutMs: 30 * MINUTE_MS,
	maxModelCalls: 40,
	maxCandidates: 2,
	repetitions: 2,
	probeTimeoutMs: 5 * MINUTE_MS,
} as const;

/** What every model-backed probe leaves unmeasured, recorded with its evidence. */
const NOT_COVERED = [
	"tasks and inputs other than the solver task and what the operator's check command exercises",
	"network-dependent behavior: solvers and probes run without network access",
	"live instance memory: solvers see only the frozen memory given to the run",
	"host extensions, settings, and the engine, which are outside the editable surface",
] as const;

const HYPOTHESIS_LIMIT = 2_000;
const OUTPUT_TAIL_LIMIT = 2_000;
const PATCH_LIMIT = 8_000;
const ATTEMPTS_LIMIT = 24_000;

export interface ModelRefinementOptions {
	/** The operator's refinement goal, given to proposal and composition sessions. */
	task: string;
	/** Operator-supplied evaluator: executable then arguments, run in the probe sandbox after the solver. A `RAGA_SCORE=n` stdout line sets the score; otherwise success scores 1. */
	command: string[];
	/** The task a solver session works in each probe's fresh project copy before the evaluator runs. Default: `task`. */
	probeTask?: string;
	/** Frozen memory text given verbatim to every solver; live instance memory is off for every refinement session. */
	probeMemory?: string;
	/** Recorded with the run and every evidence file. */
	probeMetadata?: Record<string, string>;
	/** Absolute trusted evaluator directory outside the instance, mounted read-only into the evaluator command only. */
	evaluatorRoot: string;
	/** Narrows the harness paths candidates may change. Each entry equals or lies under an entry of EDITABLE_SURFACE; a trailing `/` names a directory. */
	editableSurface?: string[];
	/** Wall time for the whole refinement. */
	timeoutMs?: number;
	/** Model invocations across every proposal, composition, solver, child, and sub-call. */
	maxModelCalls?: number;
	maxCandidates?: number;
	/** Replays per arm; at least 2, since one replay cannot detect nondeterminism. */
	repetitions?: number;
	/** Probe runs, baseline and composition included. Default: enough for the baseline, every candidate, and one composition. */
	maxProbeRuns?: number;
	/** Wall time for one probe's solver session, and separately for its evaluator command. */
	probeTimeoutMs?: number;
	/** Added to the built-in list of what the probe does not cover. */
	notCovered?: string[];
	/** Untracked project files to include in the probe snapshot. */
	includeUntracked?: string[];
	/** `provider/id`, with an optional `:thinking` suffix. Default: the harness settings, then the first authenticated model. */
	model?: string;
	/** Activate a measured improvement. Without it the candidate and evidence are returned and the active revision is unchanged. */
	approved?: boolean;
	/** Refuse to start unless the instance is at this revision. */
	expectedRevision?: string;
	/** Name of a Python skill under skills/ the refinement must acquire. Every candidate must change it and pass fresh-interpreter validation. */
	skill?: string;
	signal?: AbortSignal;
	/** Host model runtime that holds provider credentials. Default: the global runtime. */
	modelRuntime?: ModelRuntime;
}

export type SkillOutcome =
	| { kind: "no-candidate"; reason: string }
	| { kind: "validated"; revision: string; validation: SkillValidation };

export interface SkillAcquisition {
	skill: string;
	/** The skill as committed in the base revision. */
	baseline: SkillValidation;
	outcome: SkillOutcome;
}

export type RefinementActivation =
	| { kind: "not-requested"; reason: string }
	| { kind: "refused"; reason: string }
	| { kind: "failed"; reason: string }
	| { kind: "activated"; revision: string; evidenceId: string; manifest: InstanceManifest };

export interface ModelRefinementResult {
	refinement: RefinementResult;
	/** `provider/id` of the model that drove the sessions. */
	model: string;
	/** Model invocations actually started, children and sub-calls included. */
	modelCalls: number;
	maxModelCalls: number;
	skill?: SkillAcquisition;
	activation: RefinementActivation;
}

// ---------------------------------------------------------------------------------------------
// Shared model-call budget

/** A model invocation the refinement budget refused to start. */
export class ModelCallRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelCallRefusedError";
	}
}

function reasonText(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/** One refinement's allowance of model invocations, shared by every session and sub-call that uses its metered runtime. */
export class ModelCallBudget implements ModelCallMeter {
	readonly limit: number;
	/** Aborts on cancellation or deadline; every admitted request carries it. */
	readonly signal: AbortSignal;
	private used = 0;

	constructor(limit: number, signal: AbortSignal) {
		this.limit = limit;
		this.signal = signal;
	}

	modelCalls(): number {
		return this.used;
	}

	remaining(): number {
		return this.limit - this.used;
	}

	/** Count one invocation, or return why it may not start. */
	admit(model: Model<Api>): ModelCallRefusedError | undefined {
		if (this.signal.aborted)
			return new ModelCallRefusedError(`Refinement stopped: ${reasonText(this.signal.reason)}`);
		if (isVirtualModel(model)) {
			return new ModelCallRefusedError(
				`Virtual model ${model.provider}/${model.id} routes through code the refinement budget cannot meter`,
			);
		}
		if (this.used >= this.limit) {
			return new ModelCallRefusedError(`The refinement budget of ${this.limit} model calls is spent`);
		}
		this.used++;
		return undefined;
	}

	/** Provider retries would be uncounted invocations, and an admitted request must stop with the run. */
	controlled<T>(options: T | undefined): T {
		const callerSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
		const signal = callerSignal ? AbortSignal.any([callerSignal, this.signal]) : this.signal;
		return Object.assign({}, options, { maxRetries: 0, signal }) as T;
	}
}

function refusedStream(model: Model<Api>, error: ModelCallRefusedError): AssistantMessageEventStream {
	return lazyStream(model, () => Promise.reject(error));
}

/** Invocation paths that run code or requests outside the chat methods, so they cannot be counted. */
const UNMETERABLE: Record<string, true> = {
	resolveModel: true,
	streamDeferred: true,
	fetchDeferred: true,
	generateImages: true,
	classify: true,
};

/**
 * The runtime as seen by a refinement session tree. Chat invocations are admitted against the budget
 * and delegate to the original runtime's own method, so a caller's wrapper still sees every call and
 * internal delegation (completeSimple to streamSimple) is counted once. A refused invocation fails the
 * way a provider setup failure does: an error message, not a thrown exception.
 */
export function meterModelRuntime(runtime: ModelRuntime, budget: ModelCallBudget): ModelRuntime {
	const streamSimple = (
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): AssistantMessageEventStream => {
		const refused = budget.admit(model);
		return refused ? refusedStream(model, refused) : runtime.streamSimple(model, context, budget.controlled(options));
	};
	const completeSimple = (
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> => {
		const refused = budget.admit(model);
		return refused
			? refusedStream(model, refused).result()
			: runtime.completeSimple(model, context, budget.controlled(options));
	};
	const stream = <TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream => {
		const refused = budget.admit(model);
		return refused ? refusedStream(model, refused) : runtime.stream(model, context, budget.controlled(options));
	};
	const complete = <TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> => {
		const refused = budget.admit(model);
		return refused
			? refusedStream(model, refused).result()
			: runtime.complete(model, context, budget.controlled(options));
	};
	const metered: Record<string, unknown> = { streamSimple, completeSimple, stream, complete };
	return new Proxy(runtime, {
		get(target, property) {
			if (typeof property === "string" && Object.hasOwn(metered, property)) return metered[property];
			if (typeof property === "string" && Object.hasOwn(UNMETERABLE, property)) {
				return () => {
					throw new ModelCallRefusedError(`${property} is not available during refinement`);
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Option boundary

interface ResolvedLimits {
	timeoutMs: number;
	maxModelCalls: number;
	maxCandidates: number;
	repetitions: number;
	maxProbeRuns: number;
	probeTimeoutMs: number;
}

function boundedInteger(name: keyof typeof LIMITS, value: number): number {
	const { min, max } = LIMITS[name];
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new RefinementInputError(`${name} must be an integer from ${min} to ${max}`);
	}
	return value;
}

function resolveLimits(options: ModelRefinementOptions): ResolvedLimits {
	if (!options.task.trim()) throw new RefinementInputError("task must describe the refinement goal");
	if (typeof options.evaluatorRoot !== "string" || !options.evaluatorRoot.trim()) {
		throw new RefinementInputError("evaluatorRoot must identify the trusted external evaluator directory");
	}
	if (options.probeTask !== undefined && !options.probeTask.trim())
		throw new RefinementInputError("probeTask must not be empty");
	const { command } = options;
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		!command.every((part) => typeof part === "string" && part !== "" && !part.includes("\0"))
	) {
		throw new RefinementInputError("command must be a nonempty array of nonempty strings");
	}
	const timeoutMs = boundedInteger("timeoutMs", options.timeoutMs ?? DEFAULTS.timeoutMs);
	const maxCandidates = boundedInteger("maxCandidates", options.maxCandidates ?? DEFAULTS.maxCandidates);
	const repetitions = boundedInteger("repetitions", options.repetitions ?? DEFAULTS.repetitions);
	const limits: ResolvedLimits = {
		timeoutMs,
		maxModelCalls: boundedInteger("maxModelCalls", options.maxModelCalls ?? DEFAULTS.maxModelCalls),
		maxCandidates,
		repetitions,
		// The baseline, every proposal, and one composition.
		maxProbeRuns: boundedInteger("maxProbeRuns", options.maxProbeRuns ?? repetitions * (maxCandidates + 2)),
		probeTimeoutMs: boundedInteger(
			"probeTimeoutMs",
			options.probeTimeoutMs ?? Math.min(DEFAULTS.probeTimeoutMs, timeoutMs),
		),
	};
	if (limits.probeTimeoutMs > limits.timeoutMs)
		throw new RefinementInputError("probeTimeoutMs must not exceed timeoutMs");
	return limits;
}

function covers(entry: string, path: string): boolean {
	return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

/** A narrowing of EDITABLE_SURFACE; it can never widen what candidates may change. */
function resolveSurface(surface: readonly string[] | undefined): readonly string[] {
	if (surface === undefined) return EDITABLE_SURFACE;
	if (!Array.isArray(surface) || surface.length === 0)
		throw new RefinementInputError("editableSurface must be a nonempty array");
	for (const entry of surface) {
		const segments = typeof entry === "string" ? entry.replace(/\/$/, "").split("/") : [];
		if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
			throw new RefinementInputError(
				`editableSurface entry ${JSON.stringify(entry)} must be a relative harness path`,
			);
		}
		if (!EDITABLE_SURFACE.some((allowed) => covers(allowed, entry))) {
			throw new RefinementInputError(`editableSurface entry ${entry} lies outside ${EDITABLE_SURFACE.join(", ")}`);
		}
	}
	return [...new Set(surface)];
}

async function resolveRefinementModel(
	runtime: ModelRuntime,
	spec: string | undefined,
	settings: SettingsManager,
): Promise<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	if (spec) {
		const resolved = resolveCliModel({ cliModel: spec, modelRuntime: runtime });
		if (resolved.error || !resolved.model)
			throw new RefinementInputError(resolved.error ?? `Model "${spec}" not found`);
		model = resolved.model;
		thinkingLevel = resolved.thinkingLevel;
	} else {
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: settings.getDefaultProvider(),
			defaultModelId: settings.getDefaultModel(),
			defaultThinkingLevel: settings.getDefaultThinkingLevel(),
			modelThinkingLevels: settings.getAllModelThinkingLevels(),
			modelRuntime: runtime,
		});
		if (!initial.model) throw new RefinementInputError(formatNoModelsAvailableMessage());
		model = initial.model;
	}
	if (isVirtualModel(model)) {
		throw new RefinementInputError(
			`${model.provider}/${model.id} is a virtual model; its router cannot be metered. Choose a catalog model.`,
		);
	}
	if (!runtime.hasConfiguredAuth(model.provider)) {
		throw new RefinementInputError(`No credentials for ${model.provider}; sign in on the host before refining`);
	}
	return { model, thinkingLevel };
}

/**
 * Rewrite a private harness copy's settings to disable provider and agent retries and cache warming.
 * Child sessions reload settings from their pin, so the overrides must live in the pinned resources
 * rather than in one session's settings manager. settings.json is outside every editable surface, so
 * the override is identical for every arm.
 */
async function withSessionSettings(resourceRoot: string): Promise<string> {
	const path = join(resourceRoot, "settings.json");
	// The store validated this file when the revision was committed; SettingsManager reads it the same way.
	const settings = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Settings;
	const overridden: Settings = {
		...settings,
		cacheWarming: "off",
		retry: { ...settings.retry, enabled: false, provider: { ...settings.retry?.provider, maxRetries: 0 } },
	};
	await writeFile(path, `${JSON.stringify(overridden, null, "\t")}\n`);
	return resourceRoot;
}

/** Path to content hash for every file and symlink under `root`, to find what a session changed. */
async function contentMap(root: string, prefix = "", into = new Map<string, string>()): Promise<Map<string, string>> {
	for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		const absolute = join(root, path);
		if (entry.isDirectory()) {
			await contentMap(root, path, into);
		} else if (entry.isSymbolicLink()) {
			into.set(path, `link:${await readlink(absolute)}`);
		} else {
			const { mode } = await lstat(absolute);
			into.set(
				path,
				`${mode & 0o111 ? "x" : "f"}:${createHash("sha256")
					.update(await readFile(absolute))
					.digest("hex")}`,
			);
		}
	}
	return into;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

// ---------------------------------------------------------------------------------------------
// Prompts

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

function tail(text: string, limit: number): string {
	return text.length > limit ? `[truncated]\n${text.slice(-limit)}` : text;
}

function describeRuns(runs: readonly ProbeRun[]): string {
	const lines = runs.map(
		(run) => `- replay ${run.repetition}: ${run.status}, score ${run.score ?? "none"}, exit ${run.result.exitCode}`,
	);
	const first = runs[0];
	if (first?.result.stdout.trim())
		lines.push(`stdout of replay ${first.repetition}:\n${tail(first.result.stdout.trim(), OUTPUT_TAIL_LIMIT)}`);
	if (first?.result.stderr.trim())
		lines.push(`stderr of replay ${first.repetition}:\n${tail(first.result.stderr.trim(), OUTPUT_TAIL_LIMIT)}`);
	return lines.join("\n");
}

function describeAttempts(attempts: readonly AttemptSummary[]): string {
	if (attempts.length === 0) return "None yet.";
	const text = attempts
		.map((attempt) => {
			const assessment = attempt.assessment ? ` (${attempt.assessment})` : "";
			const scores = attempt.scores.length > 0 ? `, scores [${attempt.scores.join(", ")}]` : "";
			const patch = attempt.patch ? `\n\`\`\`diff\n${clip(attempt.patch, PATCH_LIMIT)}\n\`\`\`` : "";
			return `- ${attempt.candidateId}: ${attempt.status}${assessment}${scores}\n  hypothesis: ${attempt.hypothesis || "(none)"}${patch}`;
		})
		.join("\n");
	return clip(text, ATTEMPTS_LIMIT);
}

function describeSkillValidation(validation: SkillValidation): string {
	if (validation.accepted) return `passes validation (${validation.cases.length} cases)`;
	return validation.failures
		.map((failure) => `- ${failure.kind}${failure.case ? ` in ${failure.case}` : ""}: ${failure.message}`)
		.join("\n");
}

function skillSection(skill: SkillBrief): string {
	return `
This run acquires the Python skill skills/${skill.name}/. It needs SKILL.md and raga-skill.json:
{"schemaVersion": 1, "name": "${skill.name}", "description": "...", "module": "<file>.py", "function": "<entry function>", "dependencies": [{"module": "...", "version": "<exact installed version>"}], "sideEffects": {"writes": []}, "cases": [{"name": "...", "input": {"<arg>": ...}, "expect": {"result": ...}}]}
Before activation the exact committed skill runs case by case in fresh sandboxed interpreters. Every case must pass, with no undeclared imports or dependencies, no session globals, no network or subprocesses, and no writes beyond sideEffects.writes.
The skill at the base revision:
${describeSkillValidation(skill.baseline)}
`;
}

function sessionRules(context: SessionDriverContext, remaining: RemainingBudget): string {
	return `- Edit files with Python in your working directory. Changes outside ${context.surface.join(", ")} reject the candidate before it is measured.
- Do not create or commit candidates yourself. The supervisor commits this checkout after your final message.
- Measurement: for each replay, a fresh session on the committed harness works the task below in a fresh copy of the project, then a fixed evaluator chosen by the operator scores the project. You cannot see, run, or change the evaluator.
- Delegate only read-only analysis with rlm_query(..., read_only=True). Child edits do not reach this checkout.
- At most ${remaining.driverCalls} model calls remain for this run, counting your turns, llm_query, llm_batch, children, and the solver sessions of every measured replay together, and ${Math.floor(remaining.ms / 1000)} seconds.

Task the measured sessions work:
${context.probeTask}
${context.skill ? skillSection(context.skill) : ""}${
	context.rejections.length > 0
		? `\nChanges rejected before measurement in this run:\n${clip(context.rejections.map((reason) => `- ${reason}`).join("\n"), ATTEMPTS_LIMIT)}\n`
		: ""
}`;
}

function proposalPrompt(context: SessionDriverContext, request: ProposalRequest): string {
	return `You are refining this raga instance's harness. Your working directory is a writable candidate checkout of harness revision ${request.baseRevision}.

Operator goal:
${context.task}

Rules:
${sessionRules(context, request.remaining)}
Baseline evaluation of ${request.baseRevision}:
${describeRuns(request.baseline.runs)}

Earlier candidates in this run:
${describeAttempts(request.attempts)}

Make one focused change that should raise the evaluator's score, different from candidates that did not improve it. Finish with a short final message stating the change and why it should help. That message is recorded as the candidate's hypothesis.`;
}

function compositionPrompt(context: SessionDriverContext, request: CompositionRequest): string {
	const components = request.components
		.map(
			(component) =>
				`- ${component.candidateId} (${component.revision})\n  hypothesis: ${component.hypothesis}\n\`\`\`diff\n${clip(component.patch, PATCH_LIMIT)}\n\`\`\``,
		)
		.join("\n");
	return `You are composing improvements to this raga instance's harness. Your working directory is a writable candidate checkout based on revision ${request.baseRevision}.

Operator goal:
${context.task}

Rules:
${sessionRules(context, request.remaining)}
Each candidate below improved the evaluator's score on its own. The checkout already holds every file only one candidate changed. These files were changed by more than one candidate and are at the base version:
${request.conflicts.map((path) => `- ${path}`).join("\n")}

Merge each conflicting file so that every candidate's intent holds. Change nothing else.

Candidates:
${clip(components, ATTEMPTS_LIMIT)}

Finish with a short final message describing the combined change.`;
}

/** The solver sees only the task and the frozen memory, exactly as for every other arm. */
function solverPrompt(context: SessionDriverContext): string {
	if (context.probeMemory === undefined) return context.probeTask;
	return `${context.probeTask}

Memory recorded before this session (read-only):
${context.probeMemory}`;
}

// ---------------------------------------------------------------------------------------------
// Session driver

interface SkillBrief {
	name: string;
	baseline: SkillValidation;
}

interface SessionDriverContext {
	/** The opened accepted revision. Each session substitutes the harness it runs on. */
	pin: HarnessPin;
	/** Private copy of the accepted revision with session-only settings, for editing sessions. */
	editorHarness: string;
	/** Content of the accepted revision, to find what a candidate checkout changed. */
	baseContent: Map<string, string>;
	/** Private directory for solver harness copies and skill validation scratch. */
	runDir: string;
	/** Solver harness copy per measured revision. */
	solverHarnesses: Map<string, string>;
	/** Metered runtime shared by every session of this refinement. */
	runtime: ModelRuntime;
	budget: ModelCallBudget;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	task: string;
	probeTask: string;
	probeMemory?: string;
	probeTimeoutMs: number;
	surface: readonly string[];
	skill?: SkillBrief;
	/** Why earlier edits of this run were rejected before measurement, shown to later sessions. */
	rejections: string[];
}

interface SessionRun {
	/** Resource root, mounted read-only. */
	harness: string;
	revision: string;
	/** The only writable workspace. */
	cwd: string;
	prompt: string;
	signal: AbortSignal;
}

/** How a session ended. Its edits stay in its working directory either way. */
type SessionEnd = { kind: "finished"; text: string } | { kind: "budget-spent"; text: string };

/**
 * One fresh sandboxed session with live instance memory off, which its children inherit. Its kernel
 * snapshots go to a per-session directory that is removed with the session. The harness copy's
 * settings turn retries and cache warming off for the session and the children that reload them.
 */
async function runSession(context: SessionDriverContext, run: SessionRun): Promise<SessionEnd> {
	const { budget } = context;
	const pin: HarnessPin = { ...context.pin, revision: run.revision, resourceRoot: run.harness };
	// The refinement's own deadline and the budget's (started slightly earlier) both end the session.
	const stop = AbortSignal.any([run.signal, budget.signal]);
	const sessionManager = SessionManager.inMemory(run.cwd);
	const sandbox = instanceSandbox(pin, run.cwd, sessionManager);
	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			cwd: run.cwd,
			instance: pin,
			instanceMemory: false,
			sandbox,
			modelRuntime: context.runtime,
			sessionManager,
			model: context.model,
			thinkingLevel: context.thinkingLevel,
		}));
		const live = session;
		const abort = (): void => void live.abort();
		stop.addEventListener("abort", abort, { once: true });
		try {
			if (!stop.aborted) await live.prompt(run.prompt, { expandPromptTemplates: false });
		} finally {
			stop.removeEventListener("abort", abort);
		}
		if (stop.aborted) throw new Error(`model session stopped: ${reasonText(stop.reason)}`);
		const text = (live.getLastAssistantText() ?? "").trim();
		const last = live.messages.findLast((message) => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "error") {
			if (budget.remaining() === 0) return { kind: "budget-spent", text };
			throw new Error(`model session failed: ${last.errorMessage ?? "unknown error"}`);
		}
		return { kind: "finished", text };
	} finally {
		session?.dispose();
		await Promise.all(sandbox.writable.map((path) => rm(path, { recursive: true, force: true })));
	}
}

/** Validate the checkout's copy of the skill being acquired, in fresh sandboxed interpreters. */
async function checkoutSkillFailure(
	context: SessionDriverContext,
	skill: SkillBrief,
	checkout: string,
	changed: string[],
	signal: AbortSignal,
): Promise<string | undefined> {
	const prefix = `skills/${skill.name}/`;
	if (!changed.some((path) => path.startsWith(prefix)))
		return `the change does not touch ${prefix}, the skill this run acquires`;
	const source = join(checkout, "skills", skill.name);
	if (
		!(await lstat(source).then(
			(stat) => stat.isDirectory(),
			() => false,
		))
	)
		return `${prefix} was removed`;
	// The validator names the skill after its directory; a scratch copy keeps interpreter output out of the checkout.
	const scratch = await mkdtemp(join(tmpdir(), "raga-skill-candidate-"));
	try {
		await cp(source, join(scratch, skill.name), { recursive: true });
		const validation = await validateSkill(join(scratch, skill.name), { signal, timeoutMs: context.probeTimeoutMs });
		return validation.accepted ? undefined : `${prefix} failed validation:\n${describeSkillValidation(validation)}`;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/**
 * A proposal or composition: edit the candidate checkout on the accepted harness. A checkout that
 * changes paths outside the run's surface, or fails the acquired skill's validation, is refused here,
 * before it is committed or measured; the reason is shown to later sessions.
 */
async function editCandidate(
	context: SessionDriverContext,
	checkout: string,
	prompt: string,
	signal: AbortSignal,
): Promise<DriverReply> {
	const before = context.budget.modelCalls();
	const end = await runSession(context, {
		harness: context.editorHarness,
		revision: context.pin.revision,
		cwd: checkout,
		prompt,
		signal,
	});
	const changed = changedPaths(context.baseContent, await contentMap(checkout));
	const outside = changed.filter((path) => !context.surface.some((entry) => covers(entry, path)));
	const failure =
		outside.length > 0
			? `changed ${outside.join(", ")}, outside ${context.surface.join(", ")}`
			: context.skill && (await checkoutSkillFailure(context, context.skill, checkout, changed, signal));
	if (failure) {
		context.rejections.push(clip(failure, OUTPUT_TAIL_LIMIT));
		throw new Error(failure);
	}
	const hypothesis =
		end.text ||
		(end.kind === "budget-spent"
			? "(the model-call budget ran out before the model described its change)"
			: "(the model did not describe its change)");
	return { hypothesis: clip(hypothesis, HYPOTHESIS_LIMIT), modelCalls: context.budget.modelCalls() - before };
}

function createSessionDriver(context: SessionDriverContext): RefinementDriver {
	return {
		propose: (request) => editCandidate(context, request.checkout, proposalPrompt(context, request), request.signal),
		compose: (request) =>
			editCandidate(context, request.checkout, compositionPrompt(context, request), request.signal),
	};
}

/**
 * Before the fixed evaluator scores a replay, a solver session works the probe task in that replay's
 * fresh project workspace, on a private copy of exactly the harness content being measured plus the
 * session-only settings. The evaluator directory is never mounted. A solver cut off by the budget,
 * the deadline, or the probe timeout would leave a half-done project, so the replay fails instead.
 */
async function solveTask(context: SessionDriverContext, request: ProbePreparation): Promise<void> {
	let harness = context.solverHarnesses.get(request.revision);
	if (!harness) {
		harness = join(context.runDir, `solver-${request.revision}`);
		await rm(harness, { recursive: true, force: true });
		await cp(request.harnessRoot, harness, { recursive: true });
		await withSessionSettings(harness);
		context.solverHarnesses.set(request.revision, harness);
	}
	const end = await runSession(context, {
		harness,
		revision: request.revision,
		cwd: request.workspace.path,
		prompt: solverPrompt(context),
		signal: AbortSignal.any([request.signal, AbortSignal.timeout(context.probeTimeoutMs)]),
	});
	if (end.kind === "budget-spent") {
		throw new ModelCallRefusedError(
			"the model-call budget ran out before the solver finished, so this replay cannot be scored",
		);
	}
}

// ---------------------------------------------------------------------------------------------
// Orchestration and activation

async function checkSkill(
	instanceRoot: string,
	skill: SkillBrief,
	refinement: RefinementResult,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<SkillAcquisition> {
	const { outcome } = refinement;
	if (outcome.kind !== "improved") {
		return {
			skill: skill.name,
			baseline: skill.baseline,
			outcome: { kind: "no-candidate", reason: `refinement outcome is ${outcome.kind}` },
		};
	}
	if (!outcome.changedFiles.some((path) => path.startsWith(`skills/${skill.name}/`))) {
		return {
			skill: skill.name,
			baseline: skill.baseline,
			outcome: { kind: "no-candidate", reason: `the improved revision does not change skills/${skill.name}/` },
		};
	}
	const validation = await verifySkillRevision(instanceRoot, outcome.revision, skill.name, options);
	return {
		skill: skill.name,
		baseline: skill.baseline,
		outcome: { kind: "validated", revision: outcome.revision, validation },
	};
}

/** Why a result may not be activated, or undefined when it may. */
export function activationBlocker(result: ModelRefinementResult): string | undefined {
	const { outcome } = result.refinement;
	if (outcome.kind !== "improved") return `the outcome is ${outcome.kind}: ${outcome.reason}`;
	if (!result.skill) return undefined;
	const skill = result.skill.outcome;
	if (skill.kind === "no-candidate") return `skill ${result.skill.skill} was not acquired: ${skill.reason}`;
	if (!skill.validation.accepted) {
		return `skill ${result.skill.skill} failed validation: ${skill.validation.failures.map((failure) => `${failure.kind}: ${failure.message}`).join("; ")}`;
	}
	return undefined;
}

/**
 * Activate a measured improvement on the user's approval. The store checks the evidence against the
 * exact base and candidate commits and swaps the active revision only if it is still the base.
 */
export async function activateRefinement(
	instanceRoot: string,
	result: ModelRefinementResult,
): Promise<RefinementActivation> {
	const blocker = activationBlocker(result);
	const { outcome, baseRevision } = result.refinement;
	if (blocker || outcome.kind !== "improved") return { kind: "refused", reason: blocker ?? "no improvement" };
	try {
		const manifest = await activateRevision(instanceRoot, outcome.revision, {
			expectedRevision: baseRevision,
			evidenceId: outcome.evidenceId,
			approved: true,
			approvedBy: "user",
		});
		return { kind: "activated", revision: outcome.revision, evidenceId: outcome.evidenceId, manifest };
	} catch (error) {
		return { kind: "failed", reason: reasonText(error) };
	}
}

/**
 * Run one bounded model-backed refinement of an instance's harness. Every replay of every arm, the
 * baseline included, is a real solver session followed by the operator's evaluator. The baseline
 * stays eligible; without `approved` the active revision is never changed.
 */
export async function runModelRefinement(
	instanceRoot: string,
	options: ModelRefinementOptions,
): Promise<ModelRefinementResult> {
	const limits = resolveLimits(options);
	const surface = resolveSurface(options.editableSurface);
	if (options.skill !== undefined && !surface.some((entry) => covers(entry, `skills/${options.skill}/SKILL.md`))) {
		throw new RefinementInputError(
			`skills/${options.skill}/ lies outside the editable surface ${surface.join(", ")}`,
		);
	}
	const startedAt = Date.now();
	const deadline = AbortSignal.timeout(limits.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const manifest = await readInstance(instanceRoot);
	if (options.expectedRevision !== undefined && manifest.activeRevision !== options.expectedRevision) {
		throw new RefinementInputError(
			`The instance is at ${manifest.activeRevision}, not the expected ${options.expectedRevision}`,
		);
	}
	const pin = await openInstance(instanceRoot, manifest.activeRevision);
	const runtime =
		options.modelRuntime ??
		(
			await createAgentSessionServices({
				cwd: pin.projectRoot,
				instance: pin,
				modelRuntimeSignal: signal,
			})
		).modelRuntime;
	const runDir = join(pin.stateRoot, "refinement-sessions", randomUUID());
	await mkdir(runDir, { recursive: true, mode: 0o700 });
	try {
		const editorHarness = await materializeRevision(
			instancePaths(pin.projectRoot).harness,
			pin.revision,
			join(runDir, "editor"),
		);
		const baseContent = await contentMap(editorHarness);
		await withSessionSettings(editorHarness);
		const { model, thinkingLevel } = await resolveRefinementModel(runtime, options.model, instanceSettings(pin));
		const skill: SkillBrief | undefined =
			options.skill === undefined
				? undefined
				: {
						name: options.skill,
						baseline: await verifySkillRevision(instanceRoot, pin.revision, options.skill, {
							signal,
							timeoutMs: limits.probeTimeoutMs,
						}),
					};
		const budget = new ModelCallBudget(limits.maxModelCalls, signal);
		const context: SessionDriverContext = {
			pin,
			editorHarness,
			baseContent,
			runDir,
			solverHarnesses: new Map(),
			runtime: meterModelRuntime(runtime, budget),
			budget,
			model,
			thinkingLevel,
			task: options.task,
			probeTask: options.probeTask ?? options.task,
			probeMemory: options.probeMemory,
			probeTimeoutMs: limits.probeTimeoutMs,
			surface,
			skill,
			rejections: [],
		};
		const refinement = await refineInstance({
			instanceRoot,
			objective: options.task,
			probe: {
				command: options.command[0],
				args: options.command.slice(1),
				evaluatorRoot: options.evaluatorRoot,
				timeoutMs: limits.probeTimeoutMs,
				repetitions: limits.repetitions,
				externalEffects: "none",
				notCovered: [
					...NOT_COVERED,
					`nondeterminism beyond ${limits.repetitions} replays per arm`,
					...(options.notCovered ?? []),
				],
			},
			budget: {
				maxCandidates: limits.maxCandidates,
				maxDriverCalls: limits.maxModelCalls,
				maxProbeRuns: limits.maxProbeRuns,
				deadlineMs: Math.max(1, limits.timeoutMs - (Date.now() - startedAt)),
			},
			driver: createSessionDriver(context),
			prepareProbe: (request) => solveTask(context, request),
			probeMetadata: {
				...options.probeMetadata,
				solverModel: `${model.provider}/${model.id}`,
				editableSurface: surface.join(","),
			},
			signal: options.signal,
			includeUntracked: options.includeUntracked,
			meter: budget,
		});
		const result: ModelRefinementResult = {
			refinement,
			model: `${model.provider}/${model.id}`,
			modelCalls: budget.modelCalls(),
			maxModelCalls: limits.maxModelCalls,
			skill:
				skill &&
				(await checkSkill(instanceRoot, skill, refinement, {
					signal: options.signal,
					timeoutMs: limits.probeTimeoutMs,
				})),
			activation: {
				kind: "not-requested",
				reason: "activation needs explicit approval; the active revision is unchanged",
			},
		};
		if (options.approved) result.activation = await activateRefinement(instanceRoot, result);
		return result;
	} finally {
		await rm(runDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------------------------
// /refine

export const REFINE_USAGE =
	'/refine --goal TEXT --check \'["executable","arg"]\' --evaluator DIR [--probe-task TEXT] [--timeout-ms N] [--max-model-calls N] [--max-candidates N] [--repetitions N] [--max-probe-runs N] [--model PROVIDER/ID] [--skill NAME] [--approved]';

export type RefineCommand = Pick<
	ModelRefinementOptions,
	| "task"
	| "command"
	| "probeTask"
	| "timeoutMs"
	| "maxModelCalls"
	| "maxCandidates"
	| "repetitions"
	| "maxProbeRuns"
	| "model"
	| "skill"
	| "evaluatorRoot"
	| "approved"
>;

type RefineDraft = Partial<RefineCommand>;

function parseCheck(text: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new RefinementInputError("--check must be a JSON array of strings");
	}
	if (!Array.isArray(value) || !value.every((part): part is string => typeof part === "string")) {
		throw new RefinementInputError("--check must be a JSON array of strings");
	}
	return value;
}

const VALUE_FLAGS: Record<string, (draft: RefineDraft, value: string, cwd: string) => void> = {
	"--goal": (draft, value) => {
		draft.task = value;
	},
	"--probe-task": (draft, value) => {
		draft.probeTask = value;
	},
	"--check": (draft, value) => {
		draft.command = parseCheck(value);
	},
	"--timeout-ms": (draft, value) => {
		draft.timeoutMs = Number(value);
	},
	"--max-model-calls": (draft, value) => {
		draft.maxModelCalls = Number(value);
	},
	"--max-candidates": (draft, value) => {
		draft.maxCandidates = Number(value);
	},
	"--repetitions": (draft, value) => {
		draft.repetitions = Number(value);
	},
	"--max-probe-runs": (draft, value) => {
		draft.maxProbeRuns = Number(value);
	},
	"--model": (draft, value) => {
		draft.model = value;
	},
	"--skill": (draft, value) => {
		draft.skill = value;
	},
	"--evaluator": (draft, value, cwd) => {
		draft.evaluatorRoot = resolve(cwd, value);
	},
};

/** Parse `/refine` arguments. The goal and the evaluator command come from the operator, never the model. */
export function parseRefineCommand(text: string, cwd: string): RefineCommand {
	const args = parseCommandArgs(text);
	const draft: RefineDraft = {};
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (seen.has(flag)) throw new RefinementInputError(`${flag} was given more than once`);
		seen.add(flag);
		if (flag === "--approved") {
			draft.approved = true;
			continue;
		}
		if (!Object.hasOwn(VALUE_FLAGS, flag)) throw new RefinementInputError(`unknown argument ${flag}`);
		const apply = VALUE_FLAGS[flag];
		const value = args[++index];
		if (value === undefined) throw new RefinementInputError(`${flag} needs a value`);
		apply(draft, value, cwd);
	}
	const { task, command } = draft;
	if (task === undefined) throw new RefinementInputError("--goal is required");
	if (command === undefined) throw new RefinementInputError("--check is required");
	if (!draft.evaluatorRoot) throw new RefinementInputError("--evaluator is required");
	return { ...draft, task, command, evaluatorRoot: draft.evaluatorRoot };
}

function formatRefinementReport(result: ModelRefinementResult): string {
	const { refinement } = result;
	const { outcome } = refinement;
	const lines = [
		`Refinement ${refinement.id}: ${outcome.kind} (stopped: ${refinement.stopReason}).`,
		outcome.kind === "improved"
			? `Candidate revision ${outcome.revision}${outcome.viaComposition ? " (composition)" : ""}, evidence ${outcome.evidenceId}, changed ${outcome.changedFiles.join(", ")}.`
			: outcome.reason,
		`Model calls ${result.modelCalls}/${result.maxModelCalls} on ${result.model}; probe runs ${refinement.usage.probeRuns}; ${Math.round(refinement.usage.wallMs / 1000)}s.`,
	];
	if (refinement.baseline)
		lines.push(
			`Baseline ${refinement.baseRevision.slice(0, 12)} scores: ${refinement.baseline.runs.map((run) => run.score ?? run.status).join(", ")}.`,
		);
	for (const candidate of refinement.candidates) {
		const status = candidate.status;
		const detail =
			status.kind === "assessed"
				? `${status.assessment}, mean ${status.baselineMean} to ${status.candidateMean}`
				: status.kind === "rejected"
					? `rejected (${status.reason}): ${status.detail}`
					: `interrupted: ${status.detail}`;
		lines.push(
			`- ${candidate.role} ${candidate.candidateId.slice(0, 8)}: ${detail}. ${candidate.hypothesis.split("\n")[0]}`,
		);
	}
	if (result.skill) {
		const skill = result.skill.outcome;
		lines.push(
			skill.kind === "validated"
				? `Skill ${result.skill.skill}: ${skill.validation.accepted ? "passed" : "failed"} fresh-interpreter validation.`
				: `Skill ${result.skill.skill}: ${skill.reason}.`,
		);
	}
	lines.push(`Record: evidence/refinements/${refinement.id}.json in the instance.`);
	return lines.join("\n");
}

function formatActivation(activation: RefinementActivation, pin: HarnessPin): string {
	switch (activation.kind) {
		case "activated":
			return `Activated ${activation.revision}. This session stays on ${pin.revision}; new sessions load the new revision.`;
		case "refused":
			return `Not activated: ${activation.reason}`;
		case "failed":
			return `Activation failed and the active revision is unchanged: ${activation.reason}`;
		case "not-requested":
			return `Not activated: ${activation.reason}`;
	}
}

async function refineCommand(
	pin: HarnessPin,
	args: string,
	ctx: ExtensionCommandContext,
	runtime?: ModelRuntime,
): Promise<void> {
	let request: RefineCommand;
	try {
		request = parseRefineCommand(args, ctx.cwd);
	} catch (error) {
		ctx.ui.notify(`${reasonText(error)}\nUsage: ${REFINE_USAGE}`, "warning");
		return;
	}
	await ctx.waitForIdle();
	const model = request.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	ctx.ui.setStatus("raga-refine", "Refining the harness");
	let result: ModelRefinementResult;
	try {
		result = await runModelRefinement(pin.instanceRoot, {
			...request,
			model,
			approved: false,
			modelRuntime: runtime,
		});
	} catch (error) {
		ctx.ui.notify(`Refinement failed: ${reasonText(error)}`, "error");
		return;
	} finally {
		ctx.ui.setStatus("raga-refine", undefined);
	}
	ctx.ui.notify(formatRefinementReport(result), "info");
	const outcome = result.refinement.outcome;
	if (activationBlocker(result) || outcome.kind !== "improved") return;
	const approved = ctx.hasUI
		? await ctx.ui.confirm(
				"Activate the refined harness?",
				`Revision ${outcome.revision} improved the check (evidence ${outcome.evidenceId}). New sessions will load it; this session keeps ${pin.revision}.`,
			)
		: request.approved === true;
	if (!approved) {
		ctx.ui.notify(
			ctx.hasUI
				? "Not activated; the active revision is unchanged."
				: "Not activated; rerun with --approved to activate a measured improvement.",
			"info",
		);
		return;
	}
	const activation = await activateRefinement(pin.instanceRoot, result);
	ctx.ui.notify(formatActivation(activation, pin), activation.kind === "activated" ? "info" : "warning");
}

/**
 * The fixed engine extension that registers `/refine` for sessions pinned to `pin`. Interactive
 * activation asks for confirmation; without a UI it requires `--approved`. The running session never
 * reloads its resources.
 */
export function createRefinementExtension(pin: HarnessPin, runtime?: ModelRuntime): InlineExtension {
	return {
		name: "raga-refine",
		factory: (pi) => {
			pi.registerCommand("refine", {
				description:
					"Refine this instance's harness against an operator-supplied check, then optionally activate the measured improvement",
				handler: (args, ctx) => refineCommand(pin, args, ctx, runtime),
			});
		},
	};
}
