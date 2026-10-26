import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { PROJECT_CONFIG_DIR_NAME } from "../../config.ts";
import type { HarnessCandidate, HarnessPin, InstanceManifest, InstancePaths, RevisionEvidence } from "./types.ts";

export type InstanceStoreErrorCode =
	| "invalid-argument"
	| "not-initialized"
	| "already-initialized"
	| "invalid-record"
	| "project-mismatch"
	| "invalid-resource"
	| "resource-conflict"
	| "unknown-revision"
	| "unaccepted-revision"
	| "unknown-candidate"
	| "revision-conflict"
	| "invalid-evidence"
	| "approval-required"
	| "git-failed";

export class InstanceStoreError extends Error {
	readonly code: InstanceStoreErrorCode;
	readonly details: readonly string[];

	constructor(code: InstanceStoreErrorCode, message: string, details: readonly string[] = []) {
		super(details.length > 0 ? `${message}:\n${details.map((detail) => `  - ${detail}`).join("\n")}` : message);
		this.name = "InstanceStoreError";
		this.code = code;
		this.details = details;
	}
}

/** Who approved an activation. Policy approval never activates host-code changes. */
export type ActivationApprover = "user" | "policy";

export interface ActivationOptions {
	expectedRevision: string;
	evidenceId: string;
	approved: boolean;
	approvedBy: ActivationApprover;
}

export interface InitializeInstanceOptions {
	/** Default bundle directory. Required unless forking. */
	harnessSource?: string;
	/** Copy an accepted revision of another instance instead of the bundle. */
	forkFrom?: { instanceRoot: string; revision?: string };
	/** Whether the project is trusted. Untrusted trust-requiring .raga resources stay in place and are not imported. */
	projectTrusted?: boolean;
}

export interface RevisionSummary {
	revision: string;
	message: string;
	active: boolean;
	accepted: boolean;
}

export interface CandidateInspection {
	candidate: HarnessCandidate;
	/** Tree id of the checkout's current harness content. */
	tree: string;
	/** Tree id of the candidate's committed revision, when committed. */
	committedTree?: string;
	/** Whether the checkout differs from its committed revision, or from its base before the first commit. */
	modified: boolean;
}

export type RevisionDecision =
	| {
			schemaVersion: 1;
			kind: "activate";
			instanceId: string;
			previousRevision: string;
			revision: string;
			createdAt: string;
			evidenceId: string;
			approvedBy: ActivationApprover;
	  }
	| {
			schemaVersion: 1;
			kind: "rollback";
			instanceId: string;
			previousRevision: string;
			revision: string;
			createdAt: string;
	  };

// Instance layout. InstancePaths names the public directories; the rest are supervisor records.
const MANIFEST_FILE = "instance.json";
const LOCK_FILE = "instance.lock";
const CANDIDATE_RECORDS_DIR = "candidates";
const PINS_DIR = "pins";
const CANDIDATE_CHECKOUTS_DIR = "candidates";
const DECISIONS_DIR = "decisions";
const STAGING_PREFIX = ".staging-";
const TEMPORARY_PREFIX = ".tmp-";
const HARNESS_OWNER = "instance-store";

const ACCEPTED_REFS = "refs/raga/accepted/";
const CANDIDATE_REFS = "refs/raga/candidates/";
const FORKED_REFS = "refs/raga/forked/";

const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Harness content. Every revision holds only these resources.
const HARNESS_ROOT_FILES = new Set([
	"AGENTS.md",
	"README.md",
	"AGENTS.override.md",
	"CLAUDE.md",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"settings.json",
	"bundle.json",
	"dependencies.json",
]);
const HARNESS_ROOT_DIRECTORIES = new Set([
	"skills",
	"prompts",
	"themes",
	"extensions",
	"agents",
	"lessons",
	"docs",
	"licenses",
]);
const LICENSE_FILE = /^(LICENSE|NOTICE|COPYING)(\.[A-Za-z0-9]+)?$/;
const FORBIDDEN_NAMES = new Set([
	".git",
	".gitmodules",
	".gitattributes",
	".ssh",
	".netrc",
	".npmrc",
	".pypirc",
	".env",
	"auth.json",
	"sessions",
]);
const SECRET_FILE = /^(\.env\..+|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|.+\.(pem|key|p12|pfx|kdbx))$/i;
const CACHE_NAMES = new Set([
	"node_modules",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".venv",
	".DS_Store",
]);
const CACHE_FILE = /\.py[co]$/;
const UNSAFE_NAME = /[\u0000-\u001f\u007f\\]/;

/**
 * Project .raga entries that initialization imports into the first revision. Trust-requiring entries
 * match trust-manager's list: without project trust they stay where they are, still gated by trust.
 */
const IMPORTABLE_PROJECT_RESOURCES: Record<string, { requiresTrust: boolean }> = {
	"AGENTS.md": { requiresTrust: false },
	"AGENTS.override.md": { requiresTrust: false },
	"CLAUDE.md": { requiresTrust: false },
	agents: { requiresTrust: false },
	lessons: { requiresTrust: false },
	"SYSTEM.md": { requiresTrust: true },
	"APPEND_SYSTEM.md": { requiresTrust: true },
	"settings.json": { requiresTrust: true },
	skills: { requiresTrust: true },
	prompts: { requiresTrust: true },
	themes: { requiresTrust: true },
	extensions: { requiresTrust: true },
};

// Settings that run or name host executables, or identify the user's installation.
const HOST_COMMAND_SETTINGS = ["shellPath", "shellCommandPrefix", "npmCommand", "externalEditor"];
const GLOBAL_IDENTITY_SETTINGS = ["deviceId", "trackingId"];
const RESOURCE_PATH_SETTINGS = ["extensions", "skills", "prompts", "themes"];

const GIT_CONFIG_ARGS = ["-c", `core.hooksPath=${devNull}`, "-c", "gc.auto=0", "-c", "commit.gpgSign=false"];
const GIT_ENV = {
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: devNull,
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "raga",
	GIT_AUTHOR_EMAIL: "raga@localhost",
	GIT_COMMITTER_NAME: "raga",
	GIT_COMMITTER_EMAIL: "raga@localhost",
};

const RevisionSchema = Type.String({ pattern: "^[0-9a-f]{40}$" });
const UuidSchema = Type.String({ pattern: UUID_PATTERN.source });
const TimestampSchema = Type.String({ minLength: 1 });

const ManifestSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		id: UuidSchema,
		projectRoot: Type.String({ minLength: 1 }),
		activeRevision: RevisionSchema,
		createdAt: TimestampSchema,
		forkedFrom: Type.Optional(
			Type.Object({ instanceId: UuidSchema, revision: RevisionSchema }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);

const CandidateRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		id: UuidSchema,
		baseRevision: RevisionSchema,
		createdAt: TimestampSchema,
		revision: Type.Optional(RevisionSchema),
	},
	{ additionalProperties: false },
);

const CommandResultSchema = Type.Object({
	exitCode: Type.Integer(),
	stdout: Type.String(),
	stderr: Type.String(),
	timedOut: Type.Boolean(),
	aborted: Type.Boolean(),
});

// Evaluators may add fields; the id covers them too.
const EvidenceSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	id: Type.String({ pattern: EVIDENCE_ID_PATTERN.source }),
	instanceId: UuidSchema,
	baseRevision: RevisionSchema,
	candidateRevision: RevisionSchema,
	createdAt: TimestampSchema,
	verdict: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("inconclusive")]),
	command: Type.Array(Type.String(), { minItems: 1 }),
	baseline: CommandResultSchema,
	candidate: CommandResultSchema,
	reason: Type.String(),
});

const DecisionSchema = Type.Union([
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			kind: Type.Literal("activate"),
			instanceId: UuidSchema,
			previousRevision: RevisionSchema,
			revision: RevisionSchema,
			createdAt: TimestampSchema,
			evidenceId: Type.String({ pattern: EVIDENCE_ID_PATTERN.source }),
			approvedBy: Type.Union([Type.Literal("user"), Type.Literal("policy")]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			kind: Type.Literal("rollback"),
			instanceId: UuidSchema,
			previousRevision: RevisionSchema,
			revision: RevisionSchema,
			createdAt: TimestampSchema,
		},
		{ additionalProperties: false },
	),
]);

const validateManifest = Compile(ManifestSchema);
const validateCandidateRecord = Compile(CandidateRecordSchema);
const validateEvidence = Compile(EvidenceSchema);
const validateDecision = Compile(DecisionSchema);

interface CandidateRecord {
	schemaVersion: 1;
	id: string;
	baseRevision: string;
	createdAt: string;
	revision?: string;
}

interface SupervisorPaths extends InstancePaths {
	lock: string;
	candidateRecords: string;
	pins: string;
	candidateCheckouts: string;
	decisions: string;
}

interface HarnessFile {
	path: string;
	absolutePath: string;
	mode: "100644" | "100755";
}

interface TreeEntry {
	mode: string;
	object: string;
	path: string;
}

type PathVerdict = { kind: "include" } | { kind: "skip" } | { kind: "reject"; reason: string };

// ---------------------------------------------------------------------------
// Public API

export function instancePaths(projectRoot: string): InstancePaths {
	const { root, manifest, harness, worktrees, state, evidence } = supervisorPaths(
		join(resolve(projectRoot), PROJECT_CONFIG_DIR_NAME),
	);
	return { root, manifest, harness, worktrees, state, evidence };
}

/** Read and validate an instance manifest. Rejects a .raga directory copied away from its project. */
export async function readInstance(instanceRoot: string): Promise<InstanceManifest> {
	const root = resolve(instanceRoot);
	let text: string;
	try {
		text = await readFile(join(root, MANIFEST_FILE), "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			throw new InstanceStoreError("not-initialized", `No raga instance at ${root}`);
		}
		throw error;
	}
	const manifest = parseRecord(text, validateManifest, `${root}/${MANIFEST_FILE}`);
	const projectRoot = await realpath(dirname(root));
	if (manifest.projectRoot !== projectRoot) {
		throw new InstanceStoreError(
			"project-mismatch",
			`Instance ${manifest.id} belongs to ${manifest.projectRoot}, not ${projectRoot}. Fork it instead of copying .raga`,
		);
	}
	return {
		schemaVersion: 1,
		id: manifest.id,
		projectRoot: manifest.projectRoot,
		activeRevision: manifest.activeRevision,
		createdAt: manifest.createdAt,
		...(manifest.forkedFrom ? { forkedFrom: { ...manifest.forkedFrom } } : {}),
	};
}

/**
 * Create the instance and its first accepted revision: the bundle (or a fork's accepted revision)
 * plus importable project .raga configuration. Credentials, sessions, caches, state and evidence are
 * never copied. On failure nothing is published and every source file stays in place.
 */
export async function initializeInstance(
	projectRoot: string,
	options: InitializeInstanceOptions = {},
): Promise<InstanceManifest> {
	const { harnessSource, forkFrom } = options;
	if (forkFrom && harnessSource !== undefined) {
		throw new InstanceStoreError("invalid-argument", "A fork keeps its source revision; do not pass harnessSource");
	}
	if (!forkFrom && harnessSource === undefined) {
		throw new InstanceStoreError("invalid-argument", "harnessSource is required unless forking");
	}
	const project = await realDirectory(projectRoot, "project root");
	const paths = supervisorPaths(join(project, PROJECT_CONFIG_DIR_NAME));
	const source = forkFrom ? await resolveForkSource(forkFrom) : undefined;
	const bundle = harnessSource === undefined ? undefined : await realDirectory(harnessSource, "harness source");
	if (source && source.paths.root === paths.root) {
		throw new InstanceStoreError("invalid-argument", "An instance cannot be forked into its own project");
	}

	return withInstanceLock(paths.root, async (assertLockHeld) => {
		if (await pathExists(paths.manifest)) {
			throw new InstanceStoreError("already-initialized", `A raga instance already exists at ${paths.root}`);
		}
		await clearInterruptedInitialization(paths);

		const staging = join(paths.root, `${STAGING_PREFIX}${randomUUID()}`);
		const stagedHarness = join(staging, "harness");
		const tree = join(staging, "tree");
		try {
			await mkdir(staging);
			await git(stagedHarness, ["init", "--bare", "--quiet"]);
			await git(stagedHarness, ["config", "raga.owner", HARNESS_OWNER]);

			let parent: string | undefined;
			if (source) {
				await git(
					stagedHarness,
					[
						"fetch",
						"--quiet",
						"--no-tags",
						source.paths.harness,
						`${source.revision}:${FORKED_REFS}${source.revision}`,
					],
					{
						config: ["uploadpack.allowAnySHA1InWant=true"],
					},
				);
				await validateRevisionTree(stagedHarness, source.revision);
				await materializeRevision(stagedHarness, source.revision, tree);
				parent = source.revision;
			} else if (bundle) {
				await mkdir(tree);
				await copyResources(bundle, tree, undefined, []);
			}

			const conflicts: string[] = [];
			const importNames = Object.entries(IMPORTABLE_PROJECT_RESOURCES)
				.filter(([, resource]) => options.projectTrusted === true || !resource.requiresTrust)
				.map(([name]) => name);
			await copyResources(paths.root, tree, importNames, conflicts);
			if (conflicts.length > 0) {
				throw new InstanceStoreError(
					"resource-conflict",
					"Project .raga resources collide with different harness files; rename or remove them, then retry",
					conflicts,
				);
			}

			const treeId = await hashDirectory(stagedHarness, tree);
			let revision: string;
			if (parent !== undefined && treeId === (await revisionTree(stagedHarness, parent))) {
				revision = parent;
			} else {
				revision = await commitTree(
					stagedHarness,
					treeId,
					parent === undefined ? [] : [parent],
					parent === undefined ? "Initialize harness" : "Import project configuration",
				);
			}
			await git(stagedHarness, ["update-ref", `${ACCEPTED_REFS}${revision}`, revision]);

			for (const directory of [
				paths.pins,
				paths.candidateCheckouts,
				paths.candidateRecords,
				paths.state,
				paths.decisions,
			]) {
				await mkdir(directory, { recursive: true });
			}
			const manifest: InstanceManifest = {
				schemaVersion: 1,
				id: randomUUID(),
				projectRoot: project,
				activeRevision: revision,
				createdAt: new Date().toISOString(),
				...(source ? { forkedFrom: { instanceId: source.manifest.id, revision: source.revision } } : {}),
			};
			assertLockHeld();
			await rename(stagedHarness, paths.harness);
			await writeJsonAtomic(paths.manifest, manifest);
			return manifest;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	});
}

/** Materialize an accepted revision as a read-only resource root. Instance state stays outside it. */
export async function openInstance(instanceRoot: string, revision?: string): Promise<HarnessPin> {
	const root = resolve(instanceRoot);
	const paths = supervisorPaths(root);
	const manifest = await readInstance(root);
	const target = revision ?? manifest.activeRevision;
	await requireCommit(paths.harness, target);
	if (!(await isAccepted(paths.harness, manifest, target))) {
		throw new InstanceStoreError("unaccepted-revision", `Revision ${target} has never been accepted`);
	}
	const resourceRoot = join(paths.pins, target);
	await withInstanceLock(root, () => ensurePin(paths, target, resourceRoot));
	return {
		instanceId: manifest.id,
		instanceRoot: root,
		projectRoot: manifest.projectRoot,
		revision: target,
		resourceRoot,
		stateRoot: paths.state,
	};
}

/** Check out the active revision into a new writable candidate checkout. */
export async function createCandidate(instanceRoot: string): Promise<HarnessCandidate> {
	const root = resolve(instanceRoot);
	const paths = supervisorPaths(root);
	return withInstanceLock(root, async () => {
		const manifest = await readInstance(root);
		await removeOrphanCheckouts(paths);
		const id = randomUUID();
		const staging = join(paths.candidateCheckouts, `${TEMPORARY_PREFIX}${id}`);
		await materializeRevision(paths.harness, manifest.activeRevision, staging);
		await rename(staging, join(paths.candidateCheckouts, id));
		const record: CandidateRecord = {
			schemaVersion: 1,
			id,
			baseRevision: manifest.activeRevision,
			createdAt: new Date().toISOString(),
		};
		await writeJsonAtomic(candidateRecordPath(paths, id), record);
		return toCandidate(root, paths, record);
	});
}

export async function getCandidate(instanceRoot: string, candidateId: string): Promise<HarnessCandidate> {
	const root = resolve(instanceRoot);
	const paths = supervisorPaths(root);
	return toCandidate(root, paths, await readCandidateRecord(paths, candidateId));
}

/** Hash a candidate checkout without committing it, to detect edits made during or after a probe. */
export async function inspectCandidate(instanceRoot: string, candidateId: string): Promise<CandidateInspection> {
	const root = resolve(instanceRoot);
	const paths = supervisorPaths(root);
	const record = await readCandidateRecord(paths, candidateId);
	const tree = await hashDirectory(paths.harness, candidateCheckoutPath(paths, record.id));
	const committedTree = record.revision === undefined ? undefined : await revisionTree(paths.harness, record.revision);
	const reference = committedTree ?? (await revisionTree(paths.harness, record.baseRevision));
	return {
		candidate: toCandidate(root, paths, record),
		tree,
		...(committedTree === undefined ? {} : { committedTree }),
		modified: tree !== reference,
	};
}

/**
 * Commit the candidate checkout's allowlisted content. Recommitting unchanged content returns the
 * existing revision; changed content gets a new revision, so evidence for the old one cannot cover it.
 */
export async function commitCandidate(
	instanceRoot: string,
	candidateId: string,
	message: string,
): Promise<HarnessCandidate> {
	const commitMessage = message.trim();
	if (commitMessage.length === 0 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(commitMessage)) {
		throw new InstanceStoreError(
			"invalid-argument",
			"Commit message must be non-empty text without control characters",
		);
	}
	const root = resolve(instanceRoot);
	const paths = supervisorPaths(root);
	return withInstanceLock(root, async () => {
		const record = await readCandidateRecord(paths, candidateId);
		const checkout = candidateCheckoutPath(paths, record.id);
		if (!(await pathExists(checkout))) {
			throw new InstanceStoreError("unknown-candidate", `Candidate ${record.id} has no checkout`);
		}
		const tree = await hashDirectory(paths.harness, checkout);
		if (record.revision !== undefined && tree === (await revisionTree(paths.harness, record.revision))) {
			return toCandidate(root, paths, record);
		}
		const revision = await commitTree(paths.harness, tree, [record.revision ?? record.baseRevision], commitMessage);
		await git(paths.harness, ["update-ref", `${CANDIDATE_REFS}${record.id}`, revision]);
		const committed: CandidateRecord = { ...record, revision };
		await writeJsonAtomic(candidateRecordPath(paths, record.id), committed);
		return toCandidate(root, paths, committed);
	});
}

/**
 * Publish a revision as active. Requires the caller's view of the active revision, explicit approval,
 * and passing supervisor evidence comparing exactly the active revision with this revision.
 */
export async function activateRevision(
	instanceRoot: string,
	revision: string,
	options: ActivationOptions,
): Promise<InstanceManifest> {
	if (options.approved !== true) {
		throw new InstanceStoreError("approval-required", "Activation requires explicit approval");
	}
	if (options.approvedBy !== "user" && options.approvedBy !== "policy") {
		throw new InstanceStoreError("invalid-argument", "approvedBy must be user or policy");
	}
	requireRevisionId(revision);
	requireRevisionId(options.expectedRevision);
	const root = resolve(instanceRoot);
	const paths = supervisorPaths(root);
	return withInstanceLock(root, async (assertLockHeld) => {
		const manifest = await readInstance(root);
		requireExpectedRevision(manifest, options.expectedRevision);
		await markAccepted(paths.harness, manifest.activeRevision);
		if (revision === manifest.activeRevision) {
			throw new InstanceStoreError("invalid-argument", `Revision ${revision} is already active`);
		}
		await requireCommit(paths.harness, revision);
		const evidence = await readRevisionEvidence(root, options.evidenceId);
		const problems = evidenceBindingProblems(evidence, manifest, revision);
		if (problems.length > 0) {
			throw new InstanceStoreError(
				"invalid-evidence",
				`Evidence ${evidence.id} does not support activation`,
				problems,
			);
		}
		const entries = await validateRevisionTree(paths.harness, revision);
		if (options.approvedBy === "policy") {
			const changed = changedHostPaths(await listTree(paths.harness, manifest.activeRevision), entries);
			if (changed.length > 0) {
				throw new InstanceStoreError(
					"approval-required",
					"Extension and settings changes require user approval",
					changed,
				);
			}
		}
		await recordDecision(paths, {
			schemaVersion: 1,
			kind: "activate",
			instanceId: manifest.id,
			previousRevision: manifest.activeRevision,
			revision,
			createdAt: new Date().toISOString(),
			evidenceId: evidence.id,
			approvedBy: options.approvedBy,
		});
		return publishActiveRevision(paths, manifest, revision, assertLockHeld);
	});
}

/** Return to a previously accepted revision. Project files and external side effects are not undone. */
export async function rollbackInstance(
	instanceRoot: string,
	revision: string,
	expectedRevision: string,
): Promise<InstanceManifest> {
	requireRevisionId(revision);
	requireRevisionId(expectedRevision);
	const root = resolve(instanceRoot);
	const paths = supervisorPaths(root);
	return withInstanceLock(root, async (assertLockHeld) => {
		const manifest = await readInstance(root);
		requireExpectedRevision(manifest, expectedRevision);
		await markAccepted(paths.harness, manifest.activeRevision);
		if (revision === manifest.activeRevision) return manifest;
		if (!(await refExists(paths.harness, `${ACCEPTED_REFS}${revision}`))) {
			throw new InstanceStoreError("unaccepted-revision", `Revision ${revision} was never accepted`);
		}
		await recordDecision(paths, {
			schemaVersion: 1,
			kind: "rollback",
			instanceId: manifest.id,
			previousRevision: manifest.activeRevision,
			revision,
			createdAt: new Date().toISOString(),
		});
		return publishActiveRevision(paths, manifest, revision, assertLockHeld);
	});
}

/** Accepted revisions, committed candidates and fork bases, newest first. */
export async function listRevisions(instanceRoot: string): Promise<RevisionSummary[]> {
	const root = resolve(instanceRoot);
	const paths = supervisorPaths(root);
	const manifest = await readInstance(root);
	const accepted = new Set(
		(await git(paths.harness, ["for-each-ref", "--format=%(objectname)", ACCEPTED_REFS.slice(0, -1)]))
			.split("\n")
			.filter((line) => line.length > 0),
	);
	accepted.add(manifest.activeRevision);
	const log = await git(paths.harness, [
		"log",
		"--no-walk",
		"--format=%H%x1f%B%x1e",
		"--glob=refs/raga/*",
		manifest.activeRevision,
		"--",
	]);
	return log
		.split("\x1e")
		.map((record) => record.replace(/^\n/, ""))
		.filter((record) => record.length > 0)
		.map((record) => {
			const [revision, message] = record.split("\x1f");
			return {
				revision,
				message: message.trimEnd(),
				active: revision === manifest.activeRevision,
				accepted: accepted.has(revision),
			};
		});
}

/** Activation and rollback decisions, oldest first. */
export async function listRevisionDecisions(instanceRoot: string): Promise<RevisionDecision[]> {
	const paths = supervisorPaths(resolve(instanceRoot));
	await readInstance(paths.root);
	const names = (await readdir(paths.decisions)).filter((name) => name.endsWith(".json")).sort();
	const decisions: RevisionDecision[] = [];
	for (const name of names) {
		const path = join(paths.decisions, name);
		decisions.push(parseRecord(await readFile(path, "utf8"), validateDecision, path));
	}
	return decisions;
}

/** Read supervisor evidence by id and verify that its id still matches its content. */
export async function readRevisionEvidence(instanceRoot: string, evidenceId: string): Promise<RevisionEvidence> {
	if (!EVIDENCE_ID_PATTERN.test(evidenceId)) {
		throw new InstanceStoreError("invalid-evidence", `Invalid evidence id ${JSON.stringify(evidenceId)}`);
	}
	const paths = supervisorPaths(resolve(instanceRoot));
	const path = join(paths.evidence, `${evidenceId}.json`);
	let info: Stats;
	try {
		info = await lstat(path);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			throw new InstanceStoreError("invalid-evidence", `No evidence ${evidenceId}`);
		}
		throw error;
	}
	if (!info.isFile()) {
		throw new InstanceStoreError("invalid-evidence", `Evidence ${evidenceId} is not a regular file`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new InstanceStoreError("invalid-evidence", `Evidence ${evidenceId} is not valid JSON`);
	}
	if (!validateEvidence.Check(raw)) {
		throw new InstanceStoreError(
			"invalid-evidence",
			`Evidence ${evidenceId} is malformed`,
			validateEvidence.Errors(raw).map(formatValidationError),
		);
	}
	if (raw.id !== evidenceId || computeEvidenceId(raw) !== evidenceId) {
		throw new InstanceStoreError("invalid-evidence", `Evidence ${evidenceId} was modified after it was recorded`);
	}
	return {
		schemaVersion: 1,
		id: raw.id,
		instanceId: raw.instanceId,
		baseRevision: raw.baseRevision,
		candidateRevision: raw.candidateRevision,
		createdAt: raw.createdAt,
		verdict: raw.verdict,
		command: [...raw.command],
		baseline: { ...raw.baseline },
		candidate: { ...raw.candidate },
		reason: raw.reason,
	};
}

/** Evidence id: SHA-256 hex of the evidence without `id`, as JSON with recursively sorted keys and no whitespace. */
export function computeEvidenceId(evidence: object): string {
	const content = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "id"));
	return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

// ---------------------------------------------------------------------------
// Activation helpers

function evidenceBindingProblems(evidence: RevisionEvidence, manifest: InstanceManifest, revision: string): string[] {
	const problems: string[] = [];
	if (evidence.instanceId !== manifest.id) problems.push(`recorded for instance ${evidence.instanceId}`);
	if (evidence.baseRevision !== manifest.activeRevision) {
		problems.push(`compares against ${evidence.baseRevision}, not the active revision ${manifest.activeRevision}`);
	}
	if (evidence.candidateRevision !== revision) problems.push(`tested ${evidence.candidateRevision}, not ${revision}`);
	if (evidence.verdict !== "passed") problems.push(`verdict is ${evidence.verdict}`);
	const { exitCode, timedOut, aborted } = evidence.candidate;
	if (exitCode !== 0 || timedOut || aborted) problems.push("candidate run did not complete successfully");
	return problems;
}

function requireExpectedRevision(manifest: InstanceManifest, expectedRevision: string): void {
	if (manifest.activeRevision !== expectedRevision) {
		throw new InstanceStoreError(
			"revision-conflict",
			`Active revision is ${manifest.activeRevision}, not the expected ${expectedRevision}`,
		);
	}
}

/** Publication point: the manifest rename. The accepted ref follows and is reconciled on the next transition. */
async function publishActiveRevision(
	paths: SupervisorPaths,
	manifest: InstanceManifest,
	revision: string,
	assertLockHeld: () => void,
): Promise<InstanceManifest> {
	const next: InstanceManifest = { ...manifest, activeRevision: revision };
	assertLockHeld();
	await writeJsonAtomic(paths.manifest, next);
	await markAccepted(paths.harness, revision);
	return next;
}

/** Written under the instance lock before publication, numbered so listing order is decision order. */
async function recordDecision(paths: SupervisorPaths, decision: RevisionDecision): Promise<void> {
	await mkdir(paths.decisions, { recursive: true });
	const sequence = (await readdir(paths.decisions)).filter((name) => name.endsWith(".json")).length;
	const name = `${String(sequence).padStart(8, "0")}-${randomUUID()}.json`;
	await writeJsonAtomic(join(paths.decisions, name), decision);
}

function changedHostPaths(base: readonly TreeEntry[], next: readonly TreeEntry[]): string[] {
	const isHostCode = (path: string) => path === "settings.json" || path.startsWith("extensions/");
	const before = new Map(base.filter((entry) => isHostCode(entry.path)).map((entry) => [entry.path, entry]));
	const changed: string[] = [];
	for (const entry of next.filter((candidate) => isHostCode(candidate.path))) {
		const previous = before.get(entry.path);
		if (!previous || previous.mode !== entry.mode || previous.object !== entry.object) changed.push(entry.path);
		before.delete(entry.path);
	}
	return [...changed, ...before.keys()].sort();
}

// ---------------------------------------------------------------------------
// Instance records

function supervisorPaths(instanceRoot: string): SupervisorPaths {
	const root = resolve(instanceRoot);
	const worktrees = join(root, "worktrees");
	const evidence = join(root, "evidence");
	return {
		root,
		manifest: join(root, MANIFEST_FILE),
		harness: join(root, "harness"),
		worktrees,
		state: join(root, "state"),
		evidence,
		lock: join(root, LOCK_FILE),
		candidateRecords: join(root, CANDIDATE_RECORDS_DIR),
		pins: join(worktrees, PINS_DIR),
		candidateCheckouts: join(worktrees, CANDIDATE_CHECKOUTS_DIR),
		decisions: join(evidence, DECISIONS_DIR),
	};
}

function candidateRecordPath(paths: SupervisorPaths, id: string): string {
	return join(paths.candidateRecords, `${id}.json`);
}

function candidateCheckoutPath(paths: SupervisorPaths, id: string): string {
	return join(paths.candidateCheckouts, id);
}

function toCandidate(root: string, paths: SupervisorPaths, record: CandidateRecord): HarnessCandidate {
	return {
		id: record.id,
		instanceRoot: root,
		baseRevision: record.baseRevision,
		path: candidateCheckoutPath(paths, record.id),
		createdAt: record.createdAt,
		...(record.revision === undefined ? {} : { revision: record.revision }),
	};
}

async function readCandidateRecord(paths: SupervisorPaths, candidateId: string): Promise<CandidateRecord> {
	if (!UUID_PATTERN.test(candidateId)) {
		throw new InstanceStoreError("unknown-candidate", `Unknown candidate ${JSON.stringify(candidateId)}`);
	}
	const path = candidateRecordPath(paths, candidateId);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			throw new InstanceStoreError("unknown-candidate", `Unknown candidate ${candidateId}`);
		}
		throw error;
	}
	const record = parseRecord(text, validateCandidateRecord, path);
	if (record.id !== candidateId) {
		throw new InstanceStoreError("invalid-record", `${path} describes candidate ${record.id}`);
	}
	return record;
}

async function resolveForkSource(forkFrom: { instanceRoot: string; revision?: string }): Promise<{
	paths: SupervisorPaths;
	manifest: InstanceManifest;
	revision: string;
}> {
	const paths = supervisorPaths(await realDirectory(forkFrom.instanceRoot, "fork source"));
	const manifest = await readInstance(paths.root);
	const revision = forkFrom.revision ?? manifest.activeRevision;
	await requireCommit(paths.harness, revision);
	if (!(await isAccepted(paths.harness, manifest, revision))) {
		throw new InstanceStoreError("unaccepted-revision", `Revision ${revision} was never accepted by the source`);
	}
	return { paths, manifest, revision };
}

/** Remove what an interrupted initialization left behind: staging directories and an unpublished harness. */
async function clearInterruptedInitialization(paths: SupervisorPaths): Promise<void> {
	for (const name of await readdir(paths.root)) {
		if (name.startsWith(STAGING_PREFIX)) await rm(join(paths.root, name), { recursive: true, force: true });
	}
	if (!(await pathExists(paths.harness))) return;
	const owner = await runGit(paths.harness, ["config", "--get", "raga.owner"]);
	if (owner.code !== 0 || owner.stdout.trim() !== HARNESS_OWNER) {
		throw new InstanceStoreError("resource-conflict", `${paths.harness} exists and is not a raga harness`);
	}
	await rm(paths.harness, { recursive: true, force: true });
}

/** Remove candidate checkouts whose record was never published. Called under the instance lock. */
async function removeOrphanCheckouts(paths: SupervisorPaths): Promise<void> {
	await mkdir(paths.candidateCheckouts, { recursive: true });
	await mkdir(paths.candidateRecords, { recursive: true });
	const records = new Set(
		(await readdir(paths.candidateRecords)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)),
	);
	for (const name of await readdir(paths.candidateCheckouts)) {
		if (!records.has(name)) await rm(join(paths.candidateCheckouts, name), { recursive: true, force: true });
	}
}

/** Converge a pin directory to the exact revision content. Called under the instance lock. */
async function ensurePin(paths: SupervisorPaths, revision: string, destination: string): Promise<void> {
	await mkdir(paths.pins, { recursive: true });
	for (const name of await readdir(paths.pins)) {
		if (name.startsWith(TEMPORARY_PREFIX)) await rm(join(paths.pins, name), { recursive: true, force: true });
	}
	if (await pathExists(destination)) {
		const expected = await revisionTree(paths.harness, revision);
		let actual: string | undefined;
		try {
			actual = await hashDirectory(paths.harness, destination);
		} catch (error) {
			if (!(error instanceof InstanceStoreError && error.code === "invalid-resource")) throw error;
		}
		if (actual === expected) return;
		const stale = join(paths.pins, `${TEMPORARY_PREFIX}${randomUUID()}`);
		await rename(destination, stale);
		await rm(stale, { recursive: true, force: true });
	}
	const staging = join(paths.pins, `${TEMPORARY_PREFIX}${randomUUID()}`);
	await materializeRevision(paths.harness, revision, staging);
	await rename(staging, destination);
}

async function withInstanceLock<T>(root: string, fn: (assertLockHeld: () => void) => Promise<T>): Promise<T> {
	await mkdir(root, { recursive: true });
	let compromised: Error | undefined;
	const release = await lockfile.lock(root, {
		lockfilePath: join(root, LOCK_FILE),
		realpath: false,
		stale: 30_000,
		retries: { retries: 300, factor: 1.2, minTimeout: 10, maxTimeout: 250 },
		onCompromised: (error) => {
			compromised = error;
		},
	});
	const assertLockHeld = () => {
		if (compromised) {
			throw new InstanceStoreError("revision-conflict", `Lost the instance lock: ${compromised.message}`);
		}
	};
	try {
		return await fn(assertLockHeld);
	} finally {
		if (!compromised) await release();
	}
}

// ---------------------------------------------------------------------------
// Harness content

/** Decide whether a harness-relative path may be part of a revision. */
function classifyHarnessPath(segments: readonly string[], isDirectory: boolean): PathVerdict {
	const name = segments[segments.length - 1];
	if (segments.some((segment) => UNSAFE_NAME.test(segment))) {
		return { kind: "reject", reason: "control character or backslash in name" };
	}
	if (FORBIDDEN_NAMES.has(name) || SECRET_FILE.test(name)) {
		return { kind: "reject", reason: "credential, session or Git administration file" };
	}
	if (CACHE_NAMES.has(name) || (!isDirectory && CACHE_FILE.test(name))) return { kind: "skip" };
	if (segments.length === 1) {
		const allowed = isDirectory
			? HARNESS_ROOT_DIRECTORIES.has(name)
			: HARNESS_ROOT_FILES.has(name) || LICENSE_FILE.test(name);
		if (!allowed) return { kind: "reject", reason: "not an allowlisted harness resource" };
	}
	return { kind: "include" };
}

function settingsProblems(text: string): string[] {
	let settings: unknown;
	try {
		settings = JSON.parse(text);
	} catch {
		return ["settings.json: invalid JSON"];
	}
	if (!isRecord(settings)) return ["settings.json: must contain a JSON object"];
	const problems: string[] = [];
	const packages = settings.packages;
	if (packages !== undefined && !(Array.isArray(packages) && packages.length === 0)) {
		problems.push("settings.json: packages references unresolved external executable sources");
	}
	for (const key of HOST_COMMAND_SETTINGS) {
		if (settings[key] !== undefined) problems.push(`settings.json: ${key} names a host executable`);
	}
	for (const key of GLOBAL_IDENTITY_SETTINGS) {
		if (settings[key] !== undefined) problems.push(`settings.json: ${key} is a global identity setting`);
	}
	for (const key of RESOURCE_PATH_SETTINGS) {
		const value = settings[key];
		if (value === undefined) continue;
		const entries = Array.isArray(value) ? value : isRecord(value) ? (value.customDirectories ?? []) : value;
		if (!Array.isArray(entries)) {
			problems.push(`settings.json: ${key} has an unsupported shape`);
			continue;
		}
		for (const entry of entries) {
			if (typeof entry !== "string") {
				problems.push(`settings.json: ${key} entries must be strings`);
				continue;
			}
			const path = entry.replace(/^[!+-]/, "");
			const normalized = posix.normalize(path);
			if (
				path.startsWith("~") ||
				isAbsolute(path) ||
				/^[A-Za-z]:/.test(path) ||
				/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
				normalized === ".." ||
				normalized.startsWith("../")
			) {
				problems.push(`settings.json: ${key} entry ${JSON.stringify(entry)} is outside the harness`);
			}
		}
	}
	return problems;
}

/**
 * Copy resources from a source directory into a staging tree. Symlinks are followed only inside the
 * source. `names` limits the top-level entries; others are left alone. Differing existing files are
 * reported as conflicts instead of being overwritten.
 */
async function copyResources(
	sourceRoot: string,
	destinationRoot: string,
	names: readonly string[] | undefined,
	conflicts: string[],
): Promise<void> {
	const realSourceRoot = await realpath(sourceRoot);
	const problems: string[] = [];
	const activeDirectories = new Set<string>([realSourceRoot]);

	const visit = async (sourceDirectory: string, segments: readonly string[], children: readonly string[]) => {
		for (const name of [...children].sort()) {
			const entrySegments = [...segments, name];
			const label = entrySegments.join("/");
			const sourcePath = join(sourceDirectory, name);
			let target: string;
			try {
				target = await realpath(sourcePath);
			} catch {
				problems.push(`${label}: dangling symbolic link`);
				continue;
			}
			if (target !== realSourceRoot && !target.startsWith(`${realSourceRoot}${sep}`)) {
				problems.push(`${label}: symbolic link leaves the source`);
				continue;
			}
			const info = await stat(target);
			if (!info.isDirectory() && !info.isFile()) {
				problems.push(`${label}: unsupported file type`);
				continue;
			}
			const verdict = classifyHarnessPath(entrySegments, info.isDirectory());
			if (verdict.kind === "reject") {
				problems.push(`${label}: ${verdict.reason}`);
				continue;
			}
			if (verdict.kind === "skip") continue;
			const destination = join(destinationRoot, ...entrySegments);
			if (info.isDirectory()) {
				if (activeDirectories.has(target)) {
					problems.push(`${label}: symbolic link cycle`);
					continue;
				}
				activeDirectories.add(target);
				await visit(target, entrySegments, await readdir(target));
				activeDirectories.delete(target);
				continue;
			}
			if (await pathExists(destination)) {
				const [existing, incoming] = await Promise.all([readFile(destination), readFile(target)]);
				if (!existing.equals(incoming)) conflicts.push(label);
				continue;
			}
			await mkdir(dirname(destination), { recursive: true });
			await copyFile(target, destination);
			await chmod(destination, info.mode & 0o111 ? 0o755 : 0o644);
		}
	};

	const topLevel = await readdir(realSourceRoot);
	await visit(realSourceRoot, [], names ? topLevel.filter((name) => names.includes(name)) : topLevel);
	if (problems.length > 0) {
		throw new InstanceStoreError(
			"invalid-resource",
			`${sourceRoot} contains resources a harness cannot hold`,
			problems,
		);
	}
}

/** List a checkout's harness files. Symlinks and disallowed paths are errors; caches are skipped. */
async function collectHarnessFiles(root: string): Promise<HarnessFile[]> {
	const files: HarnessFile[] = [];
	const problems: string[] = [];
	const visit = async (directory: string, segments: readonly string[]) => {
		const children: Dirent[] = await readdir(directory, { withFileTypes: true });
		children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const child of children) {
			const entrySegments = [...segments, child.name];
			const label = entrySegments.join("/");
			const absolutePath = join(directory, child.name);
			if (child.isSymbolicLink()) {
				problems.push(`${label}: symbolic links are not allowed`);
				continue;
			}
			if (!child.isDirectory() && !child.isFile()) {
				problems.push(`${label}: unsupported file type`);
				continue;
			}
			const verdict = classifyHarnessPath(entrySegments, child.isDirectory());
			if (verdict.kind === "reject") {
				problems.push(`${label}: ${verdict.reason}`);
				continue;
			}
			if (verdict.kind === "skip") continue;
			if (child.isDirectory()) {
				await visit(absolutePath, entrySegments);
				continue;
			}
			const { mode } = await lstat(absolutePath);
			files.push({ path: label, absolutePath, mode: mode & 0o111 ? "100755" : "100644" });
		}
	};
	await visit(root, []);
	const settings = files.find((file) => file.path === "settings.json");
	if (settings) problems.push(...settingsProblems(await readFile(settings.absolutePath, "utf8")));
	if (problems.length > 0) {
		throw new InstanceStoreError("invalid-resource", "Harness contains resources a revision cannot hold", problems);
	}
	return files;
}

// ---------------------------------------------------------------------------
// Git

interface GitOptions {
	input?: string;
	indexFile?: string;
	workTree?: string;
	config?: readonly string[];
}

interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run git against one repository with a hermetic environment. Inherited GIT_* variables (for example
 * GIT_DIR or GIT_INDEX_FILE from a hook) could otherwise redirect writes into the user's repository.
 */
function runGit(gitDir: string, args: readonly string[], options: GitOptions = {}): Promise<GitRun> {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
	}
	Object.assign(env, GIT_ENV);
	if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
	const fullArgs = [
		...GIT_CONFIG_ARGS,
		...(options.config ?? []).flatMap((setting) => ["-c", setting]),
		`--git-dir=${gitDir}`,
		...(options.workTree ? [`--work-tree=${options.workTree}`] : []),
		...args,
	];
	const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<GitRun>();
	const child = spawn("git", fullArgs, { cwd: dirname(gitDir), env, stdio: ["pipe", "pipe", "pipe"] });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.stdin.on("error", () => {});
	child.on("error", reject);
	child.on("close", (code) => {
		resolvePromise({
			code: code ?? 1,
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
		});
	});
	child.stdin.end(options.input ?? "");
	return promise;
}

async function git(gitDir: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
	const result = await runGit(gitDir, args, options);
	if (result.code !== 0) {
		throw new InstanceStoreError(
			"git-failed",
			`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
		);
	}
	return result.stdout;
}

async function withTemporaryIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "raga-index-"));
	try {
		return await fn(join(directory, "index"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Store a directory's harness files as objects and return their tree id. */
async function hashDirectory(gitDir: string, directory: string): Promise<string> {
	const files = await collectHarnessFiles(directory);
	const objects =
		files.length === 0
			? []
			: (
					await git(gitDir, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
						input: `${files.map((file) => file.absolutePath).join("\n")}\n`,
					})
				)
					.trim()
					.split("\n");
	return withTemporaryIndex(async (indexFile) => {
		await git(gitDir, ["update-index", "--add", "-z", "--index-info"], {
			indexFile,
			input: files.map((file, index) => `${file.mode} ${objects[index]}\t${file.path}\u0000`).join(""),
		});
		return (await git(gitDir, ["write-tree"], { indexFile })).trim();
	});
}

/** Write a revision's files into a new directory, without any Git administration inside it. */
async function materializeRevision(gitDir: string, revision: string, destination: string): Promise<void> {
	await mkdir(destination);
	await withTemporaryIndex(async (indexFile) => {
		await git(gitDir, ["read-tree", revision], { indexFile, workTree: destination });
		await git(gitDir, ["checkout-index", "--all", "--force"], { indexFile, workTree: destination });
	});
}

async function commitTree(gitDir: string, tree: string, parents: readonly string[], message: string): Promise<string> {
	const parentArgs = parents.flatMap((parent) => ["-p", parent]);
	return (await git(gitDir, ["commit-tree", tree, ...parentArgs, "-F", "-"], { input: `${message}\n` })).trim();
}

async function revisionTree(gitDir: string, revision: string): Promise<string> {
	return (await git(gitDir, ["rev-parse", `${revision}^{tree}`])).trim();
}

async function listTree(gitDir: string, revision: string): Promise<TreeEntry[]> {
	const output = await git(gitDir, ["ls-tree", "-r", "-z", "--full-tree", revision]);
	return output
		.split("\u0000")
		.filter((record) => record.length > 0)
		.map((record) => {
			const tab = record.indexOf("\t");
			const [mode, , object] = record.slice(0, tab).split(" ");
			return { mode, object, path: record.slice(tab + 1) };
		});
}

/** Re-check a committed revision against the harness rules, independently of how it was created. */
async function validateRevisionTree(gitDir: string, revision: string): Promise<TreeEntry[]> {
	const entries = await listTree(gitDir, revision);
	const problems: string[] = [];
	for (const entry of entries) {
		if (entry.mode !== "100644" && entry.mode !== "100755") {
			problems.push(`${entry.path}: mode ${entry.mode} is not a regular file`);
			continue;
		}
		const segments = entry.path.split("/");
		for (let depth = 1; depth <= segments.length; depth++) {
			const verdict = classifyHarnessPath(segments.slice(0, depth), depth < segments.length);
			if (verdict.kind !== "include") {
				problems.push(
					`${entry.path}: ${verdict.kind === "reject" ? verdict.reason : "cache files are not resources"}`,
				);
				break;
			}
		}
		if (entry.path === "settings.json") {
			problems.push(...settingsProblems(await git(gitDir, ["cat-file", "blob", entry.object])));
		}
	}
	if (problems.length > 0) {
		throw new InstanceStoreError(
			"invalid-resource",
			`Revision ${revision} contains resources a harness cannot hold`,
			problems,
		);
	}
	return entries;
}

function requireRevisionId(revision: string): void {
	if (!REVISION_PATTERN.test(revision)) {
		throw new InstanceStoreError("unknown-revision", `${JSON.stringify(revision)} is not a full revision id`);
	}
}

async function requireCommit(gitDir: string, revision: string): Promise<void> {
	requireRevisionId(revision);
	const result = await runGit(gitDir, ["cat-file", "-e", `${revision}^{commit}`]);
	if (result.code !== 0) throw new InstanceStoreError("unknown-revision", `Unknown revision ${revision}`);
}

async function refExists(gitDir: string, ref: string): Promise<boolean> {
	return (await runGit(gitDir, ["show-ref", "--verify", "--quiet", ref])).code === 0;
}

async function isAccepted(gitDir: string, manifest: InstanceManifest, revision: string): Promise<boolean> {
	return revision === manifest.activeRevision || (await refExists(gitDir, `${ACCEPTED_REFS}${revision}`));
}

/** Idempotently record a revision as accepted. The ref also keeps its commit from being collected. */
async function markAccepted(gitDir: string, revision: string): Promise<void> {
	await git(gitDir, ["update-ref", `${ACCEPTED_REFS}${revision}`, revision]);
}

// ---------------------------------------------------------------------------
// Files

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o644);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} catch (error) {
		if (!hasErrorCode(error, "EISDIR") && !hasErrorCode(error, "EINVAL") && !hasErrorCode(error, "EPERM"))
			throw error;
	} finally {
		await directory.close();
	}
}

function parseRecord<T>(
	text: string,
	validator: { Check(value: unknown): value is T; Errors(value: unknown): TLocalizedValidationError[] },
	label: string,
): T {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new InstanceStoreError("invalid-record", `${label} is not valid JSON`);
	}
	if (!validator.Check(value)) {
		throw new InstanceStoreError(
			"invalid-record",
			`${label} is malformed`,
			validator.Errors(value).map(formatValidationError),
		);
	}
	return value;
}

function formatValidationError(error: TLocalizedValidationError): string {
	return `${error.instancePath || "/"}: ${error.message}`;
}

async function realDirectory(path: string, label: string): Promise<string> {
	let real: string;
	try {
		real = await realpath(path);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT"))
			throw new InstanceStoreError("invalid-argument", `${label} ${path} does not exist`);
		throw error;
	}
	if (!(await stat(real)).isDirectory()) {
		throw new InstanceStoreError("invalid-argument", `${label} ${path} is not a directory`);
	}
	return real;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
