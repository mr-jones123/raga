/**
 * Supervised Propose-Probe-Compose refinement of an instance harness.
 *
 * The supervisor owns measurement. A driver (normally a model session) edits a candidate checkout;
 * the orchestrator commits it, materializes the exact commit, and probes it in the sandbox against
 * a fresh workspace built from one project snapshot. Baseline and candidates see equivalent project
 * state and fresh processes. Evidence is written under the instance's evidence directory, which no
 * probe or candidate checkout can reach. Refinement never activates a revision.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { sandboxCommand } from "./sandbox.ts";
import {
	commitCandidate,
	computeEvidenceId,
	createCandidate,
	inspectCandidate,
	instancePaths,
	readInstance,
	readRevisionEvidence,
} from "./store.ts";
import type {
	ChildWorkspace,
	CommandResult,
	EvaluationVerdict,
	HarnessCandidate,
	InstancePaths,
	ProjectSnapshot,
	RevisionEvidence,
} from "./types.ts";
import { createChildWorkspace, removeChildWorkspace, snapshotProject } from "./workspaces.ts";

const execFileAsync = promisify(execFile);

/** Harness paths a refinement candidate may change. Engine, evaluator, extensions, and settings are excluded. */
export const EDITABLE_SURFACE: readonly string[] = ["AGENTS.md", "lessons/", "skills/", "agents/"];

const SCORE_LINE = /^RAGA_SCORE=(-?\d+(?:\.\d+)?)$/;
const PATCH_CONTEXT_LIMIT = 64 * 1024;
const PROBE_OUTPUT_LIMIT = 256 * 1024;

// ---------------------------------------------------------------------------------------------
// Public types

export interface RefinementBudget {
	/** Proposals the driver may make. Composition is extra and only happens when it fits the remaining budget. */
	maxCandidates: number;
	/** Model calls across proposals and composition. */
	maxDriverCalls: number;
	/** Sandboxed probe executions, including baseline and composition. */
	maxProbeRuns: number;
	/** Wall time for the whole refinement. */
	deadlineMs: number;
}

/** Trusted measurement definition. Candidates cannot change any of it. */
export interface ProbeSpec {
	command: string;
	args: string[];
	/** Read-only trusted evaluator directory, outside the instance. Its digest is checked throughout the run. */
	evaluatorRoot?: string;
	timeoutMs: number;
	/** Identical replays per arm. One replay cannot detect nondeterminism. */
	repetitions: number;
	/** Largest score spread within an arm that still counts as stable. Default 0. */
	noiseTolerance?: number;
	/** Margin by which the worst candidate run must beat the best baseline run. Default 0. */
	minImprovement?: number;
	/** Probes with uncontrolled external side effects are blocked rather than measured. */
	externalEffects: "none" | "uncontrolled";
	/** What a bounded or checkpoint probe does not cover, recorded with the evidence. */
	notCovered: string[];
}

export type ProbeRunStatus = "ok" | "failed" | "timeout" | "aborted";

export interface ProbeRun {
	repetition: number;
	status: ProbeRunStatus;
	/** RAGA_SCORE from the last stdout line, else 1 for exit 0 and 0 for failure or timeout. Null when aborted. */
	score: number | null;
	result: CommandResult;
}

export interface ArmEvidence {
	revision: string;
	contentDigest: string;
	runs: ProbeRun[];
}

export type Assessment = "improvement" | "regression" | "neutral" | "flaky";

export interface RemainingBudget {
	driverCalls: number;
	probeRuns: number;
	ms: number;
}

export interface AttemptSummary {
	candidateId: string;
	hypothesis: string;
	status: CandidateStatus["kind"];
	assessment?: Assessment;
	scores: number[];
	patch: string;
}

export interface ProposalRequest {
	objective: string;
	baseRevision: string;
	/** Writable candidate checkout. Only edits here are committed and measured. */
	checkout: string;
	editableSurface: readonly string[];
	baseline: ArmEvidence;
	attempts: readonly AttemptSummary[];
	remaining: RemainingBudget;
	signal: AbortSignal;
}

export interface CompositionComponent {
	candidateId: string;
	revision: string;
	hypothesis: string;
	patch: string;
}

export interface CompositionRequest {
	objective: string;
	baseRevision: string;
	/** Already holds every file only one component changed. Conflicting files are at the base version. */
	checkout: string;
	editableSurface: readonly string[];
	components: readonly CompositionComponent[];
	conflicts: readonly string[];
	remaining: RemainingBudget;
	signal: AbortSignal;
}

export interface DriverReply {
	hypothesis: string;
	/** Model calls spent. Ignored when the run has a ModelCallMeter. */
	modelCalls: number;
}

/** Counts every model call made for this refinement, including children; the budget reads it directly. */
export interface ModelCallMeter {
	modelCalls(): number;
}

export interface RefinementDriver {
	propose(request: ProposalRequest): Promise<DriverReply>;
	compose(request: CompositionRequest): Promise<DriverReply>;
}

export type RejectionReason =
	| "driver-error"
	| "stale-base"
	| "commit-failed"
	| "empty"
	| "outside-surface"
	| "altered"
	| "probe-error";

export type CandidateStatus =
	| { kind: "rejected"; reason: RejectionReason; detail: string }
	| { kind: "interrupted"; detail: string }
	| {
			kind: "assessed";
			assessment: Assessment;
			evidenceId: string;
			verdict: EvaluationVerdict;
			baselineMean: number;
			candidateMean: number;
			runs: ProbeRun[];
	  };

export interface CandidateRecord {
	candidateId: string;
	role: "proposal" | "composition";
	hypothesis: string;
	revision?: string;
	changedFiles: string[];
	components?: string[];
	status: CandidateStatus;
}

export type StopReason =
	| "completed"
	| "candidate-limit"
	| "driver-call-limit"
	| "probe-limit"
	| "deadline"
	| "cancelled";

export type RefinementOutcome =
	| {
			kind: "improved";
			candidateId: string;
			revision: string;
			evidenceId: string;
			viaComposition: boolean;
			changedFiles: string[];
	  }
	| { kind: "no-improvement"; reason: string }
	| { kind: "insufficient-evidence"; reason: string }
	| { kind: "blocked"; reason: string }
	| { kind: "cancelled"; reason: string };

export interface RefinementUsage {
	driverCalls: number;
	probeRuns: number;
	wallMs: number;
}

export interface RefinementResult {
	schemaVersion: 1;
	id: string;
	instanceId: string;
	objective: string;
	baseRevision: string;
	snapshotCommit?: string;
	evaluatorDigest?: string;
	command: string[];
	notCovered: string[];
	probeMetadata?: Record<string, string>;
	budget: RefinementBudget;
	usage: RefinementUsage;
	baseline?: ArmEvidence;
	candidates: CandidateRecord[];
	stopReason: StopReason;
	outcome: RefinementOutcome;
	startedAt: string;
	finishedAt: string;
}

export interface ProbePreparation {
	workspace: ChildWorkspace;
	harnessRoot: string;
	revision: string;
	signal: AbortSignal;
	remaining: RemainingBudget;
}

export interface RefinementOptions {
	instanceRoot: string;
	objective: string;
	probe: ProbeSpec;
	budget: RefinementBudget;
	driver: RefinementDriver;
	prepareProbe?: (request: ProbePreparation) => Promise<void>;
	probeMetadata?: Record<string, string>;
	signal?: AbortSignal;
	/** Untracked project files to include in the probe snapshot. */
	includeUntracked?: string[];
	/** Authoritative model-call counter. Without it, driver replies are summed. */
	meter?: ModelCallMeter;
}

/** Evidence persisted by the supervisor. A superset of RevisionEvidence, content-addressed by the store's id scheme. */
export interface RefinementEvidence extends RevisionEvidence {
	refinementId: string;
	role: "proposal" | "composition";
	hypothesis: string;
	assessment: Assessment;
	snapshotCommit: string;
	evaluatorDigest?: string;
	baselineDigest: string;
	contentDigest: string;
	changedFiles: string[];
	baselineRuns: ProbeRun[];
	candidateRuns: ProbeRun[];
	notCovered: string[];
	probeMetadata?: Record<string, string>;
}

export class RefinementInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RefinementInputError";
	}
}

// ---------------------------------------------------------------------------------------------
// Pure assessment

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function spread(values: number[]): number {
	return Math.max(...values) - Math.min(...values);
}

/**
 * Compare complete arms. An improvement needs every candidate run to succeed and its worst score to
 * beat the best baseline score by the margin; a regression is the mirror image. Overlap is neutral.
 */
export function assessArms(
	baseline: readonly ProbeRun[],
	candidate: readonly ProbeRun[],
	spec: Pick<ProbeSpec, "noiseTolerance" | "minImprovement">,
): Assessment {
	const tolerance = spec.noiseTolerance ?? 0;
	const margin = spec.minImprovement ?? 0;
	const base = baseline.map(scoreOf);
	const cand = candidate.map(scoreOf);
	if (spread(base) > tolerance || spread(cand) > tolerance) return "flaky";
	if (candidate.every((run) => run.status === "ok") && Math.min(...cand) > Math.max(...base) + margin) {
		return "improvement";
	}
	if (Math.max(...cand) + margin < Math.min(...base)) return "regression";
	return "neutral";
}

function scoreOf(run: ProbeRun): number {
	if (run.score === null) throw new Error(`probe run ${run.repetition} has no measurement`);
	return run.score;
}

const VERDICTS: Record<Assessment, EvaluationVerdict> = {
	improvement: "passed",
	regression: "failed",
	neutral: "failed",
	flaky: "inconclusive",
};

function classifyRun(repetition: number, result: CommandResult): ProbeRun {
	if (result.aborted) return { repetition, status: "aborted", score: null, result };
	if (result.timedOut) return { repetition, status: "timeout", score: 0, result };
	if (result.exitCode !== 0) return { repetition, status: "failed", score: 0, result };
	const lines = result.stdout.trimEnd().split("\n");
	const match = SCORE_LINE.exec(lines[lines.length - 1]?.trim() ?? "");
	return { repetition, status: "ok", score: match ? Number(match[1]) : 1, result };
}

// ---------------------------------------------------------------------------------------------
// Git and content helpers shared with skills.ts

/** Ambient GIT_* variables and user/system config could redirect or filter harness reads. */
function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" };
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return env;
}

async function harnessGitBuffer(harness: string, args: string[]): Promise<Buffer> {
	const { stdout } = await execFileAsync("git", ["--git-dir", harness, ...args], {
		env: gitEnv(),
		maxBuffer: 256 * 1024 * 1024,
		encoding: "buffer",
	});
	return stdout;
}

async function harnessGit(harness: string, args: string[]): Promise<string> {
	return (await harnessGitBuffer(harness, args)).toString("utf8");
}

/** Write the exact content of a committed revision to a new directory, without Git metadata. */
export async function materializeRevision(harness: string, revision: string, destination: string): Promise<string> {
	const resolved = (await harnessGit(harness, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
	if (resolved !== revision) throw new RefinementInputError(`revision ${revision} is not a full commit hash`);
	await mkdir(destination, { recursive: true });
	const archive = `${destination}.tar`;
	await harnessGit(harness, ["archive", "--format=tar", "-o", archive, revision]);
	try {
		await execFileAsync("tar", ["-xf", archive, "-C", destination]);
	} finally {
		await rm(archive, { force: true });
	}
	return realpath(destination);
}

/** Digest of a directory tree: paths, file kinds, executable bits, contents, and symlink targets. */
export async function digestTree(root: string): Promise<string> {
	const hash = createHash("sha256");
	const walk = async (dir: string): Promise<void> => {
		const entries = (await readdir(dir)).sort();
		for (const name of entries) {
			const path = join(dir, name);
			const rel = relative(root, path).split(sep).join("/");
			const stat = await lstat(path);
			if (stat.isSymbolicLink()) {
				hash.update(`L ${rel} ${await readlink(path)}\n`);
			} else if (stat.isDirectory()) {
				hash.update(`D ${rel}\n`);
				await walk(path);
			} else if (stat.isFile()) {
				const content = createHash("sha256")
					.update(await readFile(path))
					.digest("hex");
				hash.update(`F ${rel} ${stat.mode & 0o111 ? "x" : "-"} ${content}\n`);
			} else {
				hash.update(`O ${rel}\n`);
			}
		}
	};
	await walk(root);
	return hash.digest("hex");
}

async function changedFiles(harness: string, base: string, revision: string): Promise<string[]> {
	const output = await harnessGit(harness, ["diff", "--no-renames", "--name-only", "-z", base, revision]);
	return output.split("\0").filter((path) => path.length > 0);
}

/** Write supervisor evidence exclusively and read-only. The id is the store's content address. */
export async function writeEvidence<T extends RevisionEvidence>(paths: InstancePaths, evidence: T): Promise<T> {
	const addressed = { ...evidence, id: "" };
	addressed.id = computeEvidenceId(addressed);
	await mkdir(paths.evidence, { recursive: true });
	const file = join(paths.evidence, `${addressed.id}.json`);
	const handle = await open(file, "wx", 0o444).catch(async (error: unknown) => {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		await readRevisionEvidence(paths.root, addressed.id);
		return undefined;
	});
	if (handle) {
		try {
			await handle.writeFile(`${JSON.stringify(addressed, null, "\t")}\n`);
		} finally {
			await handle.close();
		}
	}
	return addressed;
}

// ---------------------------------------------------------------------------------------------
// Budget

class Budget {
	readonly limits: RefinementBudget;
	readonly startedAt: number;
	readonly meter: ModelCallMeter | undefined;
	readonly meterStart: number;
	reportedCalls = 0;
	probeRuns = 0;
	proposals = 0;

	constructor(limits: RefinementBudget, meter: ModelCallMeter | undefined) {
		this.limits = limits;
		this.startedAt = Date.now();
		this.meter = meter;
		this.meterStart = meter?.modelCalls() ?? 0;
	}

	/** Model calls spent: the meter when one is supplied, otherwise what driver replies reported. */
	get driverCalls(): number {
		return this.meter ? this.meter.modelCalls() - this.meterStart : this.reportedCalls;
	}

	remaining(): RemainingBudget {
		return {
			driverCalls: Math.max(0, this.limits.maxDriverCalls - this.driverCalls),
			probeRuns: this.limits.maxProbeRuns - this.probeRuns,
			ms: Math.max(0, this.limits.deadlineMs - (Date.now() - this.startedAt)),
		};
	}

	/** The first limit that prevents spending `calls` model calls and `runs` probe runs, if any. */
	shortfall(calls: number, runs: number): StopReason | undefined {
		const left = this.remaining();
		if (left.ms <= 0) return "deadline";
		if (left.driverCalls < calls) return "driver-call-limit";
		if (left.probeRuns < runs) return "probe-limit";
		return undefined;
	}

	/** Without a meter, a malformed count is charged as one call and a failed driver call as one call. */
	charge(reply: DriverReply | undefined): void {
		if (this.meter) return;
		const calls = reply?.modelCalls;
		this.reportedCalls += calls !== undefined && Number.isInteger(calls) && calls >= 0 ? calls : 1;
	}

	usage(): RefinementUsage {
		return { driverCalls: this.driverCalls, probeRuns: this.probeRuns, wallMs: Date.now() - this.startedAt };
	}
}

// ---------------------------------------------------------------------------------------------
// Orchestration

function validateOptions(options: RefinementOptions): void {
	const { probe, budget } = options;
	const positiveInteger = (value: number, name: string): void => {
		if (!Number.isInteger(value) || value < 1) throw new RefinementInputError(`${name} must be a positive integer`);
	};
	positiveInteger(probe.repetitions, "probe.repetitions");
	positiveInteger(probe.timeoutMs, "probe.timeoutMs");
	positiveInteger(budget.maxCandidates, "budget.maxCandidates");
	positiveInteger(budget.maxDriverCalls, "budget.maxDriverCalls");
	positiveInteger(budget.maxProbeRuns, "budget.maxProbeRuns");
	positiveInteger(budget.deadlineMs, "budget.deadlineMs");
	if (!probe.command) throw new RefinementInputError("probe.command is required");
	if ((probe.noiseTolerance ?? 0) < 0 || (probe.minImprovement ?? 0) < 0) {
		throw new RefinementInputError("probe tolerances must not be negative");
	}
	if (probe.evaluatorRoot !== undefined && !isAbsolute(probe.evaluatorRoot)) {
		throw new RefinementInputError("probe.evaluatorRoot must be absolute");
	}
	if (!options.objective.trim()) throw new RefinementInputError("objective is required");
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Thrown inside a run when the trusted evaluator or measured content changes underneath it. */
class MeasurementAltered extends Error {}
class ProbePreparationFailure extends Error {}

class RefinementRun {
	readonly options: RefinementOptions;
	readonly paths: InstancePaths;
	readonly instanceId: string;
	readonly baseRevision: string;
	readonly id: string;
	readonly runDir: string;
	readonly budget: Budget;
	readonly signal: AbortSignal;
	readonly userSignal: AbortSignal | undefined;
	readonly candidates: CandidateRecord[] = [];
	readonly evidenceIds: string[] = [];
	readonly patches = new Map<string, string>();
	snapshot?: ProjectSnapshot;
	evaluatorRoot?: string;
	evaluatorDigest?: string;
	baseline?: ArmEvidence;
	harnessCounter = 0;

	constructor(options: RefinementOptions, paths: InstancePaths, instanceId: string, baseRevision: string) {
		this.options = options;
		this.paths = paths;
		this.instanceId = instanceId;
		this.baseRevision = baseRevision;
		this.id = randomUUID();
		this.runDir = join(paths.worktrees, "refinement", this.id);
		this.budget = new Budget(options.budget, options.meter);
		this.userSignal = options.signal;
		const deadline = AbortSignal.timeout(options.budget.deadlineMs);
		this.signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	}

	interruption(): StopReason | undefined {
		if (this.userSignal?.aborted) return "cancelled";
		if (this.signal.aborted) return "deadline";
		return undefined;
	}

	async prepare(): Promise<void> {
		const { probe } = this.options;
		if (probe.evaluatorRoot !== undefined) {
			this.evaluatorRoot = await realpath(probe.evaluatorRoot);
			if (isInside(this.evaluatorRoot, this.paths.root) || isInside(this.paths.root, this.evaluatorRoot)) {
				throw new RefinementInputError("probe.evaluatorRoot must lie outside the instance");
			}
			this.evaluatorDigest = await digestTree(this.evaluatorRoot);
		}
		await mkdir(this.runDir, { recursive: true });
		this.snapshot = await snapshotProject((await readInstance(this.options.instanceRoot)).projectRoot, {
			includeUntracked: this.options.includeUntracked,
		});
	}

	async checkEvaluator(): Promise<void> {
		if (this.evaluatorRoot && (await digestTree(this.evaluatorRoot)) !== this.evaluatorDigest) {
			throw new MeasurementAltered("trusted evaluator changed during refinement");
		}
	}

	async probeOnce(harnessDir: string, revision: string, repetition: number): Promise<ProbeRun> {
		const snapshot = this.snapshot;
		if (!snapshot) throw new Error("refinement run is not prepared");
		const remainingMs = this.budget.remaining().ms;
		if (remainingMs <= 0 || this.signal.aborted) {
			return classifyRun(repetition, { exitCode: -1, stdout: "", stderr: "", timedOut: false, aborted: true });
		}
		this.budget.probeRuns++;
		const workspace = await createChildWorkspace(snapshot, join(this.runDir, `project-${randomUUID()}`));
		try {
			if (this.options.prepareProbe) {
				if (this.budget.remaining().driverCalls === 0)
					throw new ProbePreparationFailure("model-call budget exhausted before the probe solver");
				try {
					await this.options.prepareProbe({
						workspace,
						harnessRoot: harnessDir,
						revision,
						signal: this.signal,
						remaining: this.budget.remaining(),
					});
				} catch (error) {
					throw new ProbePreparationFailure(`probe solver failed: ${errorText(error)}`);
				}
			}
			if (this.signal.aborted || this.budget.remaining().ms <= 0) {
				return classifyRun(repetition, {
					exitCode: -1,
					stdout: "",
					stderr: "probe deadline or cancellation",
					timedOut: false,
					aborted: true,
				});
			}
			const projectDir = await realpath(workspace.path);
			const readOnly = this.evaluatorRoot ? [harnessDir, this.evaluatorRoot] : [harnessDir];
			const env: Record<string, string> = {
				RAGA_HARNESS: harnessDir,
				RAGA_PROJECT: projectDir,
				RAGA_PROBE_REPETITION: String(repetition),
			};
			if (this.evaluatorRoot) env.RAGA_EVALUATOR = this.evaluatorRoot;
			const result = await sandboxCommand({
				command: this.options.probe.command,
				args: this.options.probe.args,
				policy: { workspace: projectDir, readOnly, writable: [projectDir], cwd: projectDir, network: false, env },
				timeoutMs: Math.min(this.options.probe.timeoutMs, this.budget.remaining().ms),
				signal: this.signal,
				maxOutputBytes: PROBE_OUTPUT_LIMIT,
			});
			return classifyRun(repetition, result);
		} finally {
			await removeChildWorkspace(workspace);
		}
	}

	/** Probe an exact revision in a fresh materialization, checking its content is unchanged by the runs. */
	async measure(revision: string): Promise<ArmEvidence> {
		const harnessDir = await materializeRevision(
			this.paths.harness,
			revision,
			join(this.runDir, `harness-${this.harnessCounter++}`),
		);
		const before = await digestTree(harnessDir);
		await this.checkEvaluator();
		const runs: ProbeRun[] = [];
		for (let repetition = 0; repetition < this.options.probe.repetitions; repetition++) {
			const run = await this.probeOnce(harnessDir, revision, repetition);
			runs.push(run);
			if (run.status === "aborted") break;
		}
		if ((await digestTree(harnessDir)) !== before) {
			throw new MeasurementAltered(`probed content of ${revision} changed during measurement`);
		}
		await this.checkEvaluator();
		await rm(harnessDir, { recursive: true, force: true });
		return { revision, contentDigest: before, runs };
	}

	attempts(): AttemptSummary[] {
		return this.candidates.map((record) => ({
			candidateId: record.candidateId,
			hypothesis: record.hypothesis,
			status: record.status.kind,
			assessment: record.status.kind === "assessed" ? record.status.assessment : undefined,
			scores: record.status.kind === "assessed" ? record.status.runs.map(scoreOf) : [],
			patch: record.revision ? (this.patches.get(record.revision) ?? "") : "",
		}));
	}

	async patch(revision: string): Promise<string> {
		const full = await harnessGit(this.paths.harness, ["diff", "--no-renames", this.baseRevision, revision]);
		const bounded =
			full.length > PATCH_CONTEXT_LIMIT ? `${full.slice(0, PATCH_CONTEXT_LIMIT)}\n[patch truncated]\n` : full;
		this.patches.set(revision, bounded);
		return bounded;
	}

	/** The checkout's content tree when it equals its commit; otherwise why it does not. */
	async inspect(candidateId: string): Promise<string | { detail: string }> {
		try {
			const inspected = await inspectCandidate(this.options.instanceRoot, candidateId);
			return inspected.modified ? { detail: "uncommitted edits" } : inspected.tree;
		} catch (error) {
			return { detail: errorText(error) };
		}
	}

	/**
	 * Commit the candidate's checkout, confine it to the editable surface, and measure the exact commit.
	 * Returns the record; never throws for candidate faults.
	 */
	async evaluate(
		candidate: HarnessCandidate,
		role: "proposal" | "composition",
		hypothesis: string,
		components?: string[],
	): Promise<CandidateRecord> {
		const record: CandidateRecord = {
			candidateId: candidate.id,
			role,
			hypothesis,
			changedFiles: [],
			components,
			status: { kind: "interrupted", detail: "not evaluated" },
		};
		const reject = (reason: RejectionReason, detail: string): CandidateRecord => {
			record.status = { kind: "rejected", reason, detail };
			return record;
		};
		if (candidate.baseRevision !== this.baseRevision) {
			return reject("stale-base", `candidate starts from ${candidate.baseRevision}, not the measured baseline`);
		}
		let committed: HarnessCandidate;
		try {
			const summary = hypothesis
				.split("\n")[0]
				.replace(/\p{Cc}/gu, " ")
				.slice(0, 120);
			committed = await commitCandidate(
				this.options.instanceRoot,
				candidate.id,
				`refine ${this.id.slice(0, 8)}: ${summary}`,
			);
		} catch (error) {
			return reject("commit-failed", errorText(error));
		}
		const revision = committed.revision;
		if (!revision) return reject("commit-failed", "commit produced no revision");
		record.revision = revision;
		record.changedFiles = await changedFiles(this.paths.harness, this.baseRevision, revision);
		if (record.changedFiles.length === 0) return reject("empty", "candidate does not change the harness");
		const outside = record.changedFiles.filter(
			(path) => !EDITABLE_SURFACE.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry)),
		);
		if (outside.length > 0)
			return reject("outside-surface", `edits outside the editable surface: ${outside.join(", ")}`);
		await this.patch(revision);

		const before = await this.inspect(candidate.id);
		if (typeof before !== "string")
			return reject("altered", `checkout differs from its commit before probing: ${before.detail}`);

		let arm: ArmEvidence;
		try {
			arm = await this.measure(revision);
		} catch (error) {
			if (error instanceof MeasurementAltered) throw error;
			return reject("probe-error", errorText(error));
		}
		if (arm.runs.length < this.options.probe.repetitions || arm.runs.some((run) => run.status === "aborted")) {
			record.status = { kind: "interrupted", detail: `measurement stopped by ${this.interruption() ?? "abort"}` };
			return record;
		}
		const after = await this.inspect(candidate.id);
		if (after !== before) {
			return reject("altered", "checkout changed while its commit was being measured");
		}

		const baseline = this.requireBaseline();
		const assessment = assessArms(baseline.runs, arm.runs, this.options.probe);
		const evidence = await writeEvidence<RefinementEvidence>(this.paths, {
			schemaVersion: 1,
			id: "",
			instanceId: this.instanceId,
			baseRevision: this.baseRevision,
			candidateRevision: revision,
			createdAt: new Date().toISOString(),
			verdict: VERDICTS[assessment],
			command: [this.options.probe.command, ...this.options.probe.args],
			baseline: baseline.runs[0].result,
			candidate: arm.runs[0].result,
			reason: describeAssessment(assessment, baseline.runs, arm.runs),
			refinementId: this.id,
			role,
			hypothesis,
			assessment,
			snapshotCommit: this.requireSnapshot().commit,
			evaluatorDigest: this.evaluatorDigest,
			baselineDigest: baseline.contentDigest,
			contentDigest: arm.contentDigest,
			changedFiles: record.changedFiles,
			baselineRuns: baseline.runs,
			candidateRuns: arm.runs,
			notCovered: this.options.probe.notCovered,
			probeMetadata: this.options.probeMetadata,
		});
		this.evidenceIds.push(evidence.id);
		record.status = {
			kind: "assessed",
			assessment,
			evidenceId: evidence.id,
			verdict: evidence.verdict,
			baselineMean: mean(baseline.runs.map(scoreOf)),
			candidateMean: mean(arm.runs.map(scoreOf)),
			runs: arm.runs,
		};
		return record;
	}

	requireBaseline(): ArmEvidence {
		if (!this.baseline) throw new Error("baseline not measured");
		return this.baseline;
	}

	requireSnapshot(): ProjectSnapshot {
		if (!this.snapshot) throw new Error("refinement run is not prepared");
		return this.snapshot;
	}

	async propose(): Promise<StopReason | undefined> {
		const baseline = this.requireBaseline();
		const candidate = await createCandidate(this.options.instanceRoot);
		this.budget.proposals++;
		let reply: DriverReply;
		try {
			reply = await this.options.driver.propose({
				objective: this.options.objective,
				baseRevision: this.baseRevision,
				checkout: candidate.path,
				editableSurface: EDITABLE_SURFACE,
				baseline,
				attempts: this.attempts(),
				remaining: this.budget.remaining(),
				signal: this.signal,
			});
		} catch (error) {
			this.budget.charge(undefined);
			const stop = this.interruption();
			this.candidates.push({
				candidateId: candidate.id,
				role: "proposal",
				hypothesis: "",
				changedFiles: [],
				status: stop
					? { kind: "interrupted", detail: `driver stopped by ${stop}` }
					: { kind: "rejected", reason: "driver-error", detail: errorText(error) },
			});
			return stop;
		}
		this.budget.charge(reply);
		const stop = this.interruption();
		if (stop) {
			this.candidates.push({
				candidateId: candidate.id,
				role: "proposal",
				hypothesis: reply.hypothesis,
				changedFiles: [],
				status: { kind: "interrupted", detail: `stopped by ${stop} before probing` },
			});
			return stop;
		}
		const record = await this.evaluate(candidate, "proposal", reply.hypothesis);
		this.candidates.push(record);
		return record.status.kind === "interrupted" ? (this.interruption() ?? "deadline") : undefined;
	}

	/** Union the improving components' files into one candidate; the driver merges files several touched. */
	async compose(components: CandidateRecord[]): Promise<CandidateRecord | StopReason> {
		const byFile = new Map<string, string[]>();
		for (const component of components) {
			for (const path of component.changedFiles) {
				byFile.set(path, [...(byFile.get(path) ?? []), component.revision ?? ""]);
			}
		}
		const conflicts = [...byFile].filter(([, revisions]) => revisions.length > 1).map(([path]) => path);
		const shortfall = this.budget.shortfall(conflicts.length > 0 ? 1 : 0, this.options.probe.repetitions);
		if (shortfall) return shortfall;

		const candidate = await createCandidate(this.options.instanceRoot);
		for (const [path, revisions] of byFile) {
			if (revisions.length === 1) await this.copyFromRevision(revisions[0], path, candidate.path);
		}
		const hypotheses = components.map((component) => component.hypothesis);
		let hypothesis = `composition of: ${hypotheses.join(" | ")}`;
		if (conflicts.length > 0) {
			const patches: CompositionComponent[] = [];
			for (const component of components) {
				const revision = component.revision ?? "";
				patches.push({
					candidateId: component.candidateId,
					revision,
					hypothesis: component.hypothesis,
					patch: this.patches.get(revision) ?? (await this.patch(revision)),
				});
			}
			try {
				const reply = await this.options.driver.compose({
					objective: this.options.objective,
					baseRevision: this.baseRevision,
					checkout: candidate.path,
					editableSurface: EDITABLE_SURFACE,
					components: patches,
					conflicts,
					remaining: this.budget.remaining(),
					signal: this.signal,
				});
				this.budget.charge(reply);
				hypothesis = reply.hypothesis || hypothesis;
			} catch (error) {
				this.budget.charge(undefined);
				const stop = this.interruption();
				if (stop) return stop;
				return {
					candidateId: candidate.id,
					role: "composition",
					hypothesis,
					changedFiles: [],
					components: components.map((component) => component.candidateId),
					status: { kind: "rejected", reason: "driver-error", detail: errorText(error) },
				};
			}
			const stop = this.interruption();
			if (stop) return stop;
		}
		return this.evaluate(
			candidate,
			"composition",
			hypothesis,
			components.map((component) => component.candidateId),
		);
	}

	/** Copy one path's committed content. Harness revisions hold only regular files (the store rejects symlinks). */
	async copyFromRevision(revision: string, path: string, checkout: string): Promise<void> {
		const target = join(checkout, ...path.split("/"));
		const entry = (await harnessGit(this.paths.harness, ["ls-tree", "-z", revision, "--", path])).split("\0")[0];
		await rm(target, { recursive: true, force: true });
		if (!entry) return;
		const [mode, , object] = entry.split(/\s+/);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, await harnessGitBuffer(this.paths.harness, ["cat-file", "blob", object]));
		await chmod(target, mode === "100755" ? 0o755 : 0o644);
	}

	/** The store rejects evidence whose content no longer matches its id. */
	async verifyEvidence(): Promise<string | undefined> {
		for (const id of this.evidenceIds) {
			try {
				await readRevisionEvidence(this.paths.root, id);
			} catch (error) {
				return `evidence ${id} failed verification: ${errorText(error)}`;
			}
		}
		return undefined;
	}

	result(stopReason: StopReason, outcome: RefinementOutcome, startedAt: string): RefinementResult {
		return {
			schemaVersion: 1,
			id: this.id,
			instanceId: this.instanceId,
			objective: this.options.objective,
			baseRevision: this.baseRevision,
			snapshotCommit: this.snapshot?.commit,
			evaluatorDigest: this.evaluatorDigest,
			command: [this.options.probe.command, ...this.options.probe.args],
			notCovered: this.options.probe.notCovered,
			probeMetadata: this.options.probeMetadata,
			budget: this.options.budget,
			usage: this.budget.usage(),
			baseline: this.baseline,
			candidates: this.candidates,
			stopReason,
			outcome,
			startedAt,
			finishedAt: new Date().toISOString(),
		};
	}
}

function describeAssessment(assessment: Assessment, baseline: ProbeRun[], candidate: ProbeRun[]): string {
	const scores = (runs: ProbeRun[]): string =>
		runs.map((run) => `${run.score}${run.status === "ok" ? "" : `(${run.status})`}`).join(",");
	return `${assessment}: baseline [${scores(baseline)}] vs candidate [${scores(candidate)}]`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function selectOutcome(candidates: CandidateRecord[]): RefinementOutcome {
	const assessed = candidates.filter(
		(record): record is CandidateRecord & { status: Extract<CandidateStatus, { kind: "assessed" }> } =>
			record.status.kind === "assessed",
	);
	const improvements = assessed.filter((record) => record.status.assessment === "improvement");
	const proposals = improvements.filter((record) => record.role === "proposal");
	const composition = improvements.find((record) => record.role === "composition");
	const bestProposal = proposals.reduce<(typeof proposals)[number] | undefined>(
		(best, record) => (!best || record.status.candidateMean > best.status.candidateMean ? record : best),
		undefined,
	);
	const chosen =
		composition && (!bestProposal || composition.status.candidateMean >= bestProposal.status.candidateMean)
			? composition
			: bestProposal;
	if (chosen?.revision) {
		return {
			kind: "improved",
			candidateId: chosen.candidateId,
			revision: chosen.revision,
			evidenceId: chosen.status.evidenceId,
			viaComposition: chosen.role === "composition",
			changedFiles: chosen.changedFiles,
		};
	}
	if (assessed.length > 0 && assessed.every((record) => record.status.assessment === "flaky")) {
		return { kind: "insufficient-evidence", reason: "every measured candidate was unstable across replays" };
	}
	if (assessed.length === 0) {
		return { kind: "insufficient-evidence", reason: "no candidate completed measurement; the baseline stays active" };
	}
	return { kind: "no-improvement", reason: "no candidate beat the baseline; the baseline stays active" };
}

/**
 * Run one bounded refinement. The baseline is always eligible: only a measured improvement whose
 * evidence verifies is reported as `improved`, and even then nothing is activated here.
 */
export async function refineInstance(options: RefinementOptions): Promise<RefinementResult> {
	validateOptions(options);
	const startedAt = new Date().toISOString();
	const manifest = await readInstance(options.instanceRoot);
	const paths = instancePaths(manifest.projectRoot);
	const run = new RefinementRun(options, paths, manifest.id, manifest.activeRevision);
	const finish = async (stopReason: StopReason, outcome: RefinementOutcome): Promise<RefinementResult> => {
		const result = run.result(stopReason, outcome, startedAt);
		await persistResult(paths, result);
		await rm(run.runDir, { recursive: true, force: true });
		return result;
	};

	if (options.probe.externalEffects !== "none") {
		return finish("completed", {
			kind: "blocked",
			reason: "the probe has uncontrolled external side effects and cannot be replayed",
		});
	}

	try {
		await run.prepare();
		const baselineShortfall = run.budget.shortfall(0, options.probe.repetitions);
		if (baselineShortfall) {
			return finish(baselineShortfall, {
				kind: "insufficient-evidence",
				reason: "the budget cannot cover a baseline",
			});
		}
		run.baseline = await run.measure(run.baseRevision);
		const baselineStop = run.interruption();
		if (baselineStop || run.baseline.runs.length < options.probe.repetitions) {
			const reason = "baseline measurement did not complete";
			return finish(
				baselineStop ?? "deadline",
				baselineStop === "cancelled" ? { kind: "cancelled", reason } : { kind: "insufficient-evidence", reason },
			);
		}
		const baselineScores = run.baseline.runs.map(scoreOf);
		if (spread(baselineScores) > (options.probe.noiseTolerance ?? 0)) {
			return finish("completed", {
				kind: "insufficient-evidence",
				reason: `baseline is unstable across replays (scores ${baselineScores.join(", ")})`,
			});
		}

		let stopReason: StopReason = "completed";
		for (;;) {
			if (run.budget.proposals >= options.budget.maxCandidates) {
				stopReason = "candidate-limit";
				break;
			}
			const shortfall = run.interruption() ?? run.budget.shortfall(1, options.probe.repetitions);
			if (shortfall) {
				stopReason = shortfall;
				break;
			}
			const stop = await run.propose();
			if (stop) {
				stopReason = stop;
				break;
			}
		}

		const improving = run.candidates.filter(
			(record) => record.status.kind === "assessed" && record.status.assessment === "improvement",
		);
		if (improving.length >= 2 && !run.interruption()) {
			const composed = await run.compose(improving);
			if (typeof composed === "string") stopReason = composed;
			else run.candidates.push(composed);
		}

		const tampered = await run.verifyEvidence();
		if (tampered) return finish(stopReason, { kind: "insufficient-evidence", reason: tampered });
		if (run.interruption() === "cancelled") {
			return finish("cancelled", { kind: "cancelled", reason: "refinement cancelled; the baseline stays active" });
		}
		return finish(stopReason, selectOutcome(run.candidates));
	} catch (error) {
		if (error instanceof ProbePreparationFailure) {
			const stop = run.interruption() ?? run.budget.shortfall(1, 0) ?? "completed";
			return finish(stop, { kind: "insufficient-evidence", reason: error.message });
		}
		if (error instanceof MeasurementAltered) {
			return finish("completed", { kind: "insufficient-evidence", reason: `measurement altered: ${error.message}` });
		}
		await rm(run.runDir, { recursive: true, force: true });
		throw error;
	}
}

/** Persist the whole run, failures and confounds included, beside the evidence it produced. */
async function persistResult(paths: InstancePaths, result: RefinementResult): Promise<void> {
	const file = join(paths.evidence, "refinements", `${result.id}.json`);
	await mkdir(dirname(file), { recursive: true });
	const handle = await open(file, "wx", 0o444);
	try {
		await handle.writeFile(`${JSON.stringify(result, null, "\t")}\n`);
	} finally {
		await handle.close();
	}
}
