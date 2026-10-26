export interface InstanceManifest {
	schemaVersion: 1;
	id: string;
	projectRoot: string;
	activeRevision: string;
	createdAt: string;
	forkedFrom?: { instanceId: string; revision: string };
}

export interface InstancePaths {
	root: string;
	manifest: string;
	harness: string;
	worktrees: string;
	state: string;
	evidence: string;
}

export interface HarnessPin {
	instanceId: string;
	instanceRoot: string;
	projectRoot: string;
	revision: string;
	resourceRoot: string;
	stateRoot: string;
}

export interface HarnessCandidate {
	id: string;
	instanceRoot: string;
	baseRevision: string;
	path: string;
	createdAt: string;
	revision?: string;
}

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

export interface SandboxPolicy {
	workspace: string;
	workspaceReadOnly?: boolean;
	readOnly: string[];
	writable: string[];
	cwd?: string;
	network?: boolean;
	env?: Record<string, string>;
}

export interface SandboxCommand {
	command: string;
	args: string[];
	policy: SandboxPolicy;
	timeoutMs: number;
	signal?: AbortSignal;
	maxOutputBytes?: number;
}

export interface ProjectSnapshot {
	projectRoot: string;
	commit: string;
	originalHead: string;
}

export interface ChildWorkspace {
	id: string;
	path: string;
	baseCommit: string;
	projectRoot: string;
}

export interface ChildChange {
	workspaceId: string;
	baseCommit: string;
	commit: string;
	files: string[];
}

export type EvaluationVerdict = "passed" | "failed" | "inconclusive";

export interface RevisionEvidence {
	schemaVersion: 1;
	id: string;
	instanceId: string;
	baseRevision: string;
	candidateRevision: string;
	createdAt: string;
	verdict: EvaluationVerdict;
	command: string[];
	baseline: CommandResult;
	candidate: CommandResult;
	reason: string;
}
