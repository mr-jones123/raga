/**
 * Project snapshots, child workspaces, and supervised integration. See docs/INSTANCE-PLAN.md M11.
 *
 * A child workspace is a plain checkout with no `.git` entry. Only this supervisor runs Git on it,
 * with config-free supervisor Git metadata, the project's object store, and a private index.
 * Project and worker configuration cannot install filters or merge drivers in these operations.
 *
 * Refs owned here, all inside the project's Git common directory:
 *   refs/raga/snapshots/<commit>            snapshot commits usable as child bases
 *   refs/raga/workspaces/<id>/{base,head}   a live workspace's base and accepted integration head
 *   refs/raga/changes/<id>/<commit>         collected child changes, kept after workspace removal
 *   refs/raga/rejected/<id>/<commit>        workspace state preserved from a rejected integration
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import lockfile from "proper-lockfile";
import { sandboxCommand } from "./sandbox.ts";
import type { ChildChange, ChildWorkspace, CommandResult, ProjectSnapshot } from "./types.ts";

export type WorkspaceErrorCode = "not-repository" | "invalid-input" | "ownership" | "busy" | "git";

export class WorkspaceError extends Error {
	readonly code: WorkspaceErrorCode;

	constructor(code: WorkspaceErrorCode, message: string) {
		super(message);
		this.name = "WorkspaceError";
		this.code = code;
	}
}

export interface IntegrationVerification {
	command: string;
	args: string[];
	timeoutMs: number;
	/** Canonical read-only roots the verification needs beyond the system runtime (toolchains). */
	readOnly?: string[];
	env?: Record<string, string>;
}

export interface IntegrationResult {
	accepted: boolean;
	result: CommandResult;
	/** Accepted merge commit, now the workspace's integration head. */
	commit?: string;
	/** On rejection after a clean merge: commit holding the merged and verified workspace state. */
	preserved?: string;
	reason?: string;
}

interface Repository {
	root: string;
	gitDir: string;
	commonDir: string;
	objectGitDir: string;
}

interface WorkspaceRecord {
	schemaVersion: 1;
	id: string;
	path: string;
	baseCommit: string;
	projectRoot: string;
	createdAt: string;
}

/** Supervisor-side state for one owned workspace. */
interface OwnedWorkspace {
	record: WorkspaceRecord;
	repo: Repository;
	recordDir: string;
	refs: GitScope;
	recordFile: string;
	/** Git invocation scoped to the workspace's private index and work tree. */
	scope: GitScope;
}

interface GitScope {
	gitDir: string;
	workTree?: string;
	indexFile?: string;
	objectDirectory?: string;
}

const WORKSPACE_ID = /^[0-9a-f]{16}$/;
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const EXCLUDED_ROOTS = [".git", ".raga"];
const SUPERVISOR_IDENTITY = {
	GIT_AUTHOR_NAME: "raga",
	GIT_AUTHOR_EMAIL: "raga@localhost",
	GIT_COMMITTER_NAME: "raga",
	GIT_COMMITTER_EMAIL: "raga@localhost",
};
/** Configuration outside supervisor metadata must not supply executable Git helpers. */
const HARDENED_CONFIG = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.attributesFile=/dev/null",
	"-c",
	"gc.auto=0",
];

interface GitRun {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function gitEnv(scope: GitScope | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	Object.assign(env, SUPERVISOR_IDENTITY, {
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_LITERAL_PATHSPECS: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
	});
	if (scope) {
		env.GIT_DIR = scope.gitDir;
		if (scope.workTree) env.GIT_WORK_TREE = scope.workTree;
		if (scope.indexFile) env.GIT_INDEX_FILE = scope.indexFile;
		if (scope.objectDirectory) env.GIT_OBJECT_DIRECTORY = scope.objectDirectory;
	}
	return env;
}

function runGit(
	args: string[],
	options: { scope?: GitScope; cwd?: string; input?: string; okExitCodes?: number[] } = {},
): Promise<GitRun> {
	const { promise, resolve, reject } = Promise.withResolvers<GitRun>();
	const child = spawn("git", [...HARDENED_CONFIG, ...args], {
		cwd: options.cwd ?? options.scope?.workTree ?? options.scope?.gitDir,
		env: gitEnv(options.scope),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.on("error", reject);
	child.stdin.on("error", reject);
	child.on("close", (code) => {
		const run = {
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
			exitCode: code ?? -1,
		};
		if ((options.okExitCodes ?? [0]).includes(run.exitCode)) resolve(run);
		else reject(new WorkspaceError("git", `git ${args.join(" ")} failed (${run.exitCode}): ${run.stderr.trim()}`));
	});
	child.stdin.end(options.input);
	return promise;
}

async function git(scope: GitScope, ...args: string[]): Promise<string> {
	return (await runGit(args, { scope })).stdout.trim();
}

function isWithin(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function openRepository(projectRoot: string): Promise<Repository> {
	if (!isAbsolute(projectRoot))
		throw new WorkspaceError("invalid-input", `projectRoot must be absolute: ${projectRoot}`);
	let root: string;
	try {
		root = await realpath(projectRoot);
	} catch {
		throw new WorkspaceError("not-repository", `projectRoot does not exist: ${projectRoot}`);
	}
	const run = await runGit(
		["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
		{
			cwd: root,
			okExitCodes: [0, 128],
		},
	);
	const [toplevel, gitDir, commonDir] = run.stdout.split("\n");
	if (run.exitCode !== 0 || !toplevel || !gitDir || !commonDir) {
		throw new WorkspaceError("not-repository", `${projectRoot} is not a Git working tree: ${run.stderr.trim()}`);
	}
	if ((await realpath(toplevel)) !== root) {
		throw new WorkspaceError("not-repository", `${projectRoot} is not the top level of its repository (${toplevel})`);
	}
	const canonicalGitDir = await realpath(gitDir);
	const canonicalCommonDir = await realpath(commonDir);
	const objectGitDir = join(canonicalCommonDir, "raga", "supervisor.git");
	if (!existsSync(objectGitDir)) {
		await mkdir(dirname(objectGitDir), { recursive: true });
		const scratch = await mkdtemp(join(dirname(objectGitDir), "git-init-"));
		try {
			const format = await git({ gitDir: canonicalGitDir }, "rev-parse", "--show-object-format");
			await runGit(["init", "--bare", "--template=", `--object-format=${format}`, scratch], { cwd: scratch });
			try {
				await rename(scratch, objectGitDir);
			} catch (error) {
				if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			}
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}
	return { root, gitDir: canonicalGitDir, commonDir: canonicalCommonDir, objectGitDir };
}

function objectScope(repo: Repository, workTree?: string, indexFile?: string): GitScope {
	return {
		gitDir: repo.objectGitDir,
		objectDirectory: join(repo.commonDir, "objects"),
		workTree,
		indexFile,
	};
}

async function resolveCommit(scope: GitScope, rev: string): Promise<string | undefined> {
	const run = await runGit(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
		scope,
		okExitCodes: [0, 1],
	});
	return run.exitCode === 0 ? run.stdout.trim() : undefined;
}

async function treeOf(scope: GitScope, commit: string): Promise<string> {
	return git(scope, "rev-parse", "--verify", `${commit}^{tree}`);
}

async function commitTree(scope: GitScope, tree: string, parents: string[], message: string): Promise<string> {
	return git(scope, "commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message);
}

/** Stages the whole work tree into the scope's index, minus supervisor administration, and writes its tree. */
async function stageWorkTree(scope: GitScope, mode: "all" | "tracked"): Promise<string> {
	await git(scope, "add", mode === "all" ? "--all" : "--update");
	// Git never stages `.git`; `.raga` holds instance state and must not travel with project content.
	await git(scope, "rm", "-r", "--cached", "--force", "--quiet", "--ignore-unmatch", "--", ".raga");
	return git(scope, "write-tree");
}

function snapshotRef(commit: string): string {
	return `refs/raga/snapshots/${commit}`;
}

function workspaceRefs(id: string): { base: string; head: string; prefix: string } {
	const prefix = `refs/raga/workspaces/${id}/`;
	return { base: `${prefix}base`, head: `${prefix}head`, prefix };
}

/** Explicit untracked inputs: relative, inside the project, outside supervisor administration. */
function normalizeInclude(path: string): string {
	if (path === "" || isAbsolute(path))
		throw new WorkspaceError("invalid-input", `includeUntracked must be relative: ${path}`);
	const normalized = normalize(path).replace(/[/\\]+$/, "");
	if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
		throw new WorkspaceError("invalid-input", `includeUntracked escapes the project: ${path}`);
	}
	if (EXCLUDED_ROOTS.includes(normalized.split(sep)[0])) {
		throw new WorkspaceError("invalid-input", `includeUntracked may not name supervisor administration: ${path}`);
	}
	return normalized;
}

/**
 * Capture the effective state of the project's tracked files, plus explicitly named untracked
 * paths, as a commit whose parent is HEAD. The user's index, worktree, and HEAD are not modified:
 * staging happens in a private index without project-configured filters.
 */
export async function snapshotProject(
	projectRoot: string,
	options: { includeUntracked?: string[] } = {},
): Promise<ProjectSnapshot> {
	const repo = await openRepository(projectRoot);
	const includes = [...new Set((options.includeUntracked ?? []).map(normalizeInclude))];
	const repoScope: GitScope = { gitDir: repo.gitDir, workTree: repo.root };
	const head = await resolveCommit(repoScope, "HEAD");
	if (!head) throw new WorkspaceError("not-repository", `${projectRoot} has no commit at HEAD`);

	const scratch = await mkdtemp(join(tmpdir(), "raga-snapshot-"));
	try {
		const indexFile = join(scratch, "index");
		const scope = objectScope(repo, repo.root, indexFile);
		const userIndex = join(repo.gitDir, "index");
		if (existsSync(userIndex)) {
			await copyFile(userIndex, indexFile);
			// Expand a split index against the project metadata before moving to config-free Git.
			await git({ ...repoScope, indexFile }, "update-index", "--no-split-index");
		} else {
			await git(scope, "read-tree", head);
		}
		await stageWorkTree(scope, "tracked");

		for (const include of includes) {
			const absolute = join(repo.root, include);
			let stats: Stats;
			try {
				stats = await lstat(absolute);
			} catch {
				throw new WorkspaceError("invalid-input", `includeUntracked path does not exist: ${include}`);
			}
			const ignored =
				(
					await runGit(["--no-literal-pathspecs", "check-ignore", "--quiet", "--", include], {
						scope,
						okExitCodes: [0, 1],
					})
				).exitCode === 0;
			if (ignored && stats.isDirectory()) {
				throw new WorkspaceError(
					"invalid-input",
					`includeUntracked directory ${include} is ignored; name the individual files to include`,
				);
			}
			await git(scope, "add", ...(ignored ? ["--force"] : []), "--", include);
		}

		const tree = await git(scope, "write-tree");
		const commit = await commitTree(scope, tree, [head], "raga project snapshot");
		await git(repoScope, "update-ref", snapshotRef(commit), commit);
		return { projectRoot: repo.root, commit, originalHead: head };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

function recordLocation(repo: Repository, id: string): { recordDir: string; recordFile: string } {
	const recordDir = join(repo.commonDir, "raga", "workspaces", id);
	return { recordDir, recordFile: join(recordDir, "record.json") };
}

function ownedFromRecord(repo: Repository, record: WorkspaceRecord): OwnedWorkspace {
	const { recordDir, recordFile } = recordLocation(repo, record.id);
	return {
		record,
		repo,
		recordDir,
		recordFile,
		refs: { gitDir: repo.commonDir },
		scope: objectScope(repo, record.path, join(recordDir, "index")),
	};
}

async function readRecord(repo: Repository, id: string): Promise<WorkspaceRecord | undefined> {
	try {
		return JSON.parse(await readFile(recordLocation(repo, id).recordFile, "utf8")) as WorkspaceRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Resolves a caller-supplied workspace handle to the record this supervisor wrote for it. */
async function loadOwned(workspace: ChildWorkspace): Promise<OwnedWorkspace> {
	if (!WORKSPACE_ID.test(workspace.id))
		throw new WorkspaceError("invalid-input", `invalid workspace id: ${workspace.id}`);
	const repo = await openRepository(workspace.projectRoot);
	const record = await readRecord(repo, workspace.id);
	if (
		!record ||
		record.path !== workspace.path ||
		record.baseCommit !== workspace.baseCommit ||
		record.projectRoot !== repo.root
	) {
		throw new WorkspaceError(
			"ownership",
			`workspace ${workspace.id} at ${workspace.path} is not owned by this project`,
		);
	}
	if (existsSync(record.path) && (await realpath(record.path)) !== record.path) {
		throw new WorkspaceError("ownership", `workspace path ${record.path} was replaced by a symlink`);
	}
	return ownedFromRecord(repo, record);
}

async function withLock<T>(owned: OwnedWorkspace, action: () => Promise<T>): Promise<T> {
	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(owned.recordFile, { realpath: false, stale: 30_000 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
			throw new WorkspaceError("busy", `workspace ${owned.record.id} is in use by another supervisor operation`);
		}
		throw error;
	}
	try {
		return await action();
	} finally {
		await release();
	}
}

async function prepareDestination(repo: Repository, destination: string): Promise<{ path: string; created: boolean }> {
	if (!isAbsolute(destination))
		throw new WorkspaceError("invalid-input", `destination must be absolute: ${destination}`);
	let parent: string;
	try {
		parent = await realpath(dirname(destination));
	} catch {
		throw new WorkspaceError("invalid-input", `destination parent does not exist: ${dirname(destination)}`);
	}
	const path = join(parent, basename(destination));
	const insideProject = isWithin(path, repo.root) && !isWithin(path, join(repo.root, ".raga"));
	if (insideProject || isWithin(repo.root, path) || isWithin(path, repo.commonDir) || isWithin(path, repo.gitDir)) {
		throw new WorkspaceError("invalid-input", `destination ${path} overlaps the project checkout or Git directory`);
	}
	const stats = await lstat(path).catch(() => undefined);
	if (!stats) {
		await mkdir(path);
		return { path, created: true };
	}
	if (!stats.isDirectory() || (await readdir(path)).length > 0) {
		throw new WorkspaceError("invalid-input", `destination ${path} must be absent or an empty directory`);
	}
	return { path, created: false };
}

/** Materialize a snapshot as an owned checkout at `destination`, with no `.git` entry inside it. */
export async function createChildWorkspace(snapshot: ProjectSnapshot, destination: string): Promise<ChildWorkspace> {
	const repo = await openRepository(snapshot.projectRoot);
	const adminScope: GitScope = { gitDir: repo.commonDir };
	if (
		!OBJECT_ID.test(snapshot.commit) ||
		(await resolveCommit(adminScope, snapshotRef(snapshot.commit))) !== snapshot.commit
	) {
		throw new WorkspaceError("ownership", `commit ${snapshot.commit} is not a snapshot owned by ${repo.root}`);
	}
	const target = await prepareDestination(repo, destination);
	const id = randomBytes(8).toString("hex");
	const record: WorkspaceRecord = {
		schemaVersion: 1,
		id,
		path: target.path,
		baseCommit: snapshot.commit,
		projectRoot: repo.root,
		createdAt: new Date().toISOString(),
	};
	const owned = ownedFromRecord(repo, record);
	await mkdir(owned.recordDir, { recursive: true });
	await writeFile(`${owned.recordFile}.tmp`, `${JSON.stringify(record, null, "\t")}\n`);
	await rename(`${owned.recordFile}.tmp`, owned.recordFile);
	try {
		const refs = workspaceRefs(id);
		await git(owned.scope, "read-tree", snapshot.commit);
		await git(owned.scope, "checkout-index", "--all");
		await git(adminScope, "update-ref", refs.base, snapshot.commit);
		await git(adminScope, "update-ref", refs.head, snapshot.commit);
	} catch (error) {
		await deleteRefs(adminScope, workspaceRefs(id).prefix);
		if (target.created) await removeTree(target.path);
		else await emptyDirectory(target.path);
		await rm(owned.recordDir, { recursive: true, force: true });
		throw error;
	}
	return { id, path: target.path, baseCommit: snapshot.commit, projectRoot: repo.root };
}

async function collectCommit(owned: OwnedWorkspace): Promise<{ commit: string; tree: string }> {
	const tree = await stageWorkTree(owned.scope, "all");
	const commit = await commitTree(
		owned.scope,
		tree,
		[owned.record.baseCommit],
		`raga child change ${owned.record.id}`,
	);
	await git(owned.refs, "update-ref", `refs/raga/changes/${owned.record.id}/${commit}`, commit);
	return { commit, tree };
}

/** Record the workspace's current files as a commit on its base. The workspace is not modified. */
export async function collectChildChange(workspace: ChildWorkspace): Promise<ChildChange> {
	const owned = await loadOwned(workspace);
	return withLock(owned, async () => {
		const { commit } = await collectCommit(owned);
		const diff = await runGit(
			["diff-tree", "-r", "-z", "--name-only", "--no-renames", owned.record.baseCommit, commit],
			{ scope: owned.scope },
		);
		const files = diff.stdout;
		return {
			workspaceId: owned.record.id,
			baseCommit: owned.record.baseCommit,
			commit,
			files: files.split("\0").filter((file) => file !== ""),
		};
	});
}

/**
 * Snapshot a live workspace so a nested child starts from its parent's current task state rather
 * than the root's initial snapshot.
 */
export async function snapshotChildWorkspace(workspace: ChildWorkspace): Promise<ProjectSnapshot> {
	const owned = await loadOwned(workspace);
	return withLock(owned, async () => {
		const { commit } = await collectCommit(owned);
		await git(owned.refs, "update-ref", snapshotRef(commit), commit);
		return { projectRoot: owned.repo.root, commit, originalHead: owned.record.baseCommit };
	});
}

/** Confirms a caller-supplied change is a commit collected by this supervisor, on its recorded base. */
async function validateChange(scope: GitScope, change: ChildChange): Promise<void> {
	if (!WORKSPACE_ID.test(change.workspaceId) || !OBJECT_ID.test(change.commit) || !OBJECT_ID.test(change.baseCommit)) {
		throw new WorkspaceError("invalid-input", "malformed child change");
	}
	const ref = `refs/raga/changes/${change.workspaceId}/${change.commit}`;
	if ((await resolveCommit(scope, ref)) !== change.commit) {
		throw new WorkspaceError(
			"ownership",
			`change ${change.commit} was not collected from workspace ${change.workspaceId}`,
		);
	}
	const parents = (await git(scope, "rev-list", "--parents", "-n", "1", change.commit)).split(" ").slice(1);
	if (parents.length !== 1 || parents[0] !== change.baseCommit) {
		throw new WorkspaceError("invalid-input", `change ${change.commit} is not based on ${change.baseCommit}`);
	}
}

/**
 * Binary-safe patch of a collected change against its base, produced from the project repository.
 * The workspace may already be removed; the change must have been collected from it.
 */
export async function childChangePatch(workspace: ChildWorkspace, change: ChildChange): Promise<string> {
	if (change.workspaceId !== workspace.id || change.baseCommit !== workspace.baseCommit) {
		throw new WorkspaceError("ownership", `change ${change.commit} does not belong to workspace ${workspace.id}`);
	}
	const repo = await openRepository(workspace.projectRoot);
	const scope = objectScope(repo);
	await validateChange({ gitDir: repo.commonDir }, change);
	const diff = await runGit(
		[
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			"--binary",
			"--full-index",
			change.baseCommit,
			change.commit,
		],
		{ scope },
	);
	return diff.stdout;
}

function mergeResult(exitCode: number, stdout: string): CommandResult {
	return { exitCode, stdout, stderr: "", timedOut: false, aborted: false };
}

/**
 * Merge a child's change into an owned integration workspace and run the combined verification
 * inside the sandbox. The workspace's own uncommitted edits are first recorded on its integration
 * head, so they are never discarded. A conflict leaves the workspace untouched. A failed, timed
 * out, or aborted verification preserves the merged state under refs/raga/rejected and restores
 * the workspace to its previous head.
 */
export async function integrateChildChange(
	workspace: ChildWorkspace,
	change: ChildChange,
	verify: IntegrationVerification,
	signal?: AbortSignal,
): Promise<IntegrationResult> {
	const owned = await loadOwned(workspace);
	if (!existsSync(owned.record.path)) {
		throw new WorkspaceError("ownership", `integration workspace ${owned.record.path} no longer exists`);
	}
	return withLock(owned, async () => {
		if (change.workspaceId === owned.record.id) {
			throw new WorkspaceError("invalid-input", "a workspace cannot integrate its own change");
		}
		await validateChange(owned.refs, change);
		const refs = workspaceRefs(owned.record.id);
		const scope = owned.scope;
		let head = await git(owned.refs, "rev-parse", "--verify", refs.head);
		let headTree = await treeOf(scope, head);

		const currentTree = await stageWorkTree(scope, "all");
		if (currentTree !== headTree) {
			const ownerCommit = await commitTree(scope, currentTree, [head], "raga integration workspace edits");
			await git(owned.refs, "update-ref", refs.head, ownerCommit, head);
			head = ownerCommit;
			headTree = currentTree;
		}

		const merge = await runGit(
			[
				"merge-tree",
				"--write-tree",
				"--name-only",
				"--no-messages",
				"-z",
				`--merge-base=${change.baseCommit}`,
				head,
				change.commit,
			],
			{ scope, okExitCodes: [0, 1] },
		);
		const treeLine = /^([0-9a-f]+)[\n\0]/.exec(merge.stdout);
		if (!treeLine) throw new WorkspaceError("git", `unexpected merge-tree output: ${merge.stdout.slice(0, 200)}`);
		const mergedTree = treeLine[1];
		const conflicted = merge.stdout
			.slice(treeLine[0].length)
			.split("\0")
			.filter((entry) => entry !== "");
		if (merge.exitCode === 1) {
			const files = [...new Set(conflicted)];
			return {
				accepted: false,
				result: mergeResult(1, `${files.join("\n")}\n`),
				reason: `merge conflict in ${files.join(", ")}`,
			};
		}
		const merged = await commitTree(scope, mergedTree, [head, change.commit], `raga integrate ${change.workspaceId}`);

		const checkout = await runGit(["read-tree", "-m", "-u", headTree, mergedTree], { scope, okExitCodes: [0, 128] });
		if (checkout.exitCode !== 0) {
			return {
				accepted: false,
				result: mergeResult(checkout.exitCode, checkout.stderr),
				reason: "merged files would overwrite untracked workspace files",
			};
		}

		let result: CommandResult;
		try {
			result = await sandboxCommand({
				command: verify.command,
				args: verify.args,
				timeoutMs: verify.timeoutMs,
				signal,
				policy: { workspace: owned.record.path, readOnly: verify.readOnly ?? [], writable: [], env: verify.env },
			});
		} catch (error) {
			await git(scope, "read-tree", "--reset", "-u", headTree);
			throw error;
		}

		const verifiedTree = await stageWorkTree(scope, "all");
		if (result.exitCode === 0 && !result.timedOut && !result.aborted && verifiedTree === mergedTree) {
			await git(owned.refs, "update-ref", refs.head, merged, head);
			return { accepted: true, result, commit: merged };
		}

		const preserved = await commitTree(
			scope,
			verifiedTree,
			[merged],
			`raga rejected integration of ${change.workspaceId}`,
		);
		await git(owned.refs, "update-ref", `refs/raga/rejected/${owned.record.id}/${preserved}`, preserved);
		await git(scope, "read-tree", "--reset", "-u", headTree);
		const reason = result.timedOut
			? "combined verification timed out"
			: result.aborted
				? "combined verification was aborted"
				: result.exitCode !== 0
					? `combined verification failed with exit code ${result.exitCode}`
					: "combined verification changed the source tree";
		return { accepted: false, result, preserved, reason };
	});
}

async function deleteRefs(scope: GitScope, prefix: string): Promise<void> {
	const refs = (await git(scope, "for-each-ref", "--format=%(refname)", prefix))
		.split("\n")
		.filter((ref) => ref !== "");
	if (refs.length === 0) return;
	await runGit(["update-ref", "--stdin"], { scope, input: refs.map((ref) => `delete ${ref}\n`).join("") });
}

/** Grant the owner write access to directories (not following symlinks) so removal cannot stall on read-only trees. */
async function makeDirectoriesWritable(path: string): Promise<void> {
	const stats = await lstat(path).catch(() => undefined);
	if (!stats?.isDirectory()) return;
	await chmod(path, stats.mode | 0o700);
	for (const entry of await readdir(path)) await makeDirectoriesWritable(join(path, entry));
}

async function removeTree(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch {
		await makeDirectoriesWritable(path);
		await rm(path, { recursive: true, force: true });
	}
}

async function emptyDirectory(path: string): Promise<void> {
	await makeDirectoriesWritable(path);
	for (const entry of await readdir(path)) await rm(join(path, entry), { recursive: true, force: true });
}

/**
 * Delete an owned workspace's files, private index, record, and live refs. Unrecorded work is
 * first preserved as a change under refs/raga/changes so a crashed or cancelled child's result
 * stays inspectable. Collected changes and rejected states are retained.
 */
export async function removeChildWorkspace(workspace: ChildWorkspace): Promise<void> {
	const owned = await loadOwned(workspace);
	await withLock(owned, async () => {
		if (existsSync(owned.record.path)) {
			const tree = await stageWorkTree(owned.scope, "all");
			const changePrefix = `refs/raga/changes/${owned.record.id}/`;
			const collected = (await git(owned.refs, "for-each-ref", "--format=%(objectname)", changePrefix))
				.split("\n")
				.filter((commit) => commit !== "");
			const known = [owned.record.baseCommit, ...collected];
			const trees = await Promise.all(known.map((commit) => treeOf(owned.scope, commit)));
			if (!trees.includes(tree)) {
				const commit = await commitTree(
					owned.scope,
					tree,
					[owned.record.baseCommit],
					`raga unfinished ${owned.record.id}`,
				);
				await git(owned.refs, "update-ref", `${changePrefix}${commit}`, commit);
			}
			await removeTree(owned.record.path);
		}
		await deleteRefs(owned.refs, workspaceRefs(owned.record.id).prefix);
	});
	await rm(owned.recordDir, { recursive: true, force: true });
}

/** Workspaces recorded for a project, including ones left behind by a crashed supervisor. */
export async function listChildWorkspaces(projectRoot: string): Promise<ChildWorkspace[]> {
	const repo = await openRepository(projectRoot);
	const entries = await readdir(join(repo.commonDir, "raga", "workspaces")).catch(() => [] as string[]);
	const workspaces: ChildWorkspace[] = [];
	for (const id of entries.filter((entry) => WORKSPACE_ID.test(entry)).sort()) {
		const record = await readRecord(repo, id);
		if (record) {
			workspaces.push({
				id: record.id,
				path: record.path,
				baseCommit: record.baseCommit,
				projectRoot: record.projectRoot,
			});
		}
	}
	return workspaces;
}
