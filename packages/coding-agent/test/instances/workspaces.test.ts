import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSandbox, sandboxCommand } from "../../src/core/instances/sandbox.ts";
import type { ChildWorkspace, ProjectSnapshot } from "../../src/core/instances/types.ts";
import {
	childChangePatch,
	collectChildChange,
	createChildWorkspace,
	integrateChildChange,
	listChildWorkspaces,
	removeChildWorkspace,
	snapshotChildWorkspace,
	snapshotProject,
	WorkspaceError,
} from "../../src/core/instances/workspaces.ts";

const sandbox = await checkSandbox();

function gitIn(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
	});
}

function write(root: string, path: string, content: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), content);
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path), "utf8");
}

async function expectWorkspaceError(promise: Promise<unknown>, code: WorkspaceError["code"]): Promise<void> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(WorkspaceError);
	expect((error as WorkspaceError).code).toBe(code);
}

describe("project workspaces", () => {
	let base: string;
	let project: string;
	let counter = 0;
	const destination = () => join(base, `ws-${++counter}`);

	const configureGitHelpers = (processFilter = false) => {
		const marker = join(base, "git-helper-ran");
		const helper = join(base, "git-helper.sh");
		writeFileSync(helper, `printf '%s\\n' "$1" >> '${marker}'\nif [ "$1" = process ]; then exit 1; fi\ncat\n`);
		write(project, ".gitattributes", "* filter=tripwire merge=tripwire\n");
		gitIn(project, "add", ".gitattributes");
		gitIn(project, "commit", "-q", "-m", "attributes");
		for (const operation of ["clean", "smudge"]) {
			gitIn(project, "config", `filter.tripwire.${operation}`, `sh '${helper}' ${operation}`);
		}
		if (processFilter) gitIn(project, "config", "filter.tripwire.process", `sh '${helper}' process`);
		gitIn(project, "config", "filter.tripwire.required", "true");
		gitIn(project, "config", "merge.tripwire.driver", `sh '${helper}' merge`);
		return marker;
	};

	beforeEach(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), "raga-workspaces-test-")));
		project = join(base, "project");
		mkdirSync(project);
		gitIn(project, "init", "-q", "-b", "main");
		write(project, ".gitignore", "cache/\n.raga/\n");
		write(project, "app.txt", "line one\nline two\n");
		write(project, "lib.sh", "add() { echo $(($1 + $2)); }\n");
		write(project, "callers/main.sh", "add 1 2 >/dev/null\n");
		write(project, "check.sh", 'set -e\n. ./lib.sh\nfor f in callers/*.sh; do . "./$f"; done\n');
		gitIn(project, "add", "-A");
		gitIn(project, "commit", "-q", "-m", "base");
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	describe("snapshotProject", () => {
		it("captures dirty tracked state and named untracked files without touching the user's index", async () => {
			write(project, "app.txt", "line one\nedited\n");
			write(project, "staged.txt", "staged\n");
			gitIn(project, "add", "staged.txt");
			write(project, "notes.txt", "task input\n");
			write(project, ".env", "API_KEY=secret\n");
			write(project, "cache/blob", "cache\n");
			write(project, ".raga/instance.json", "{}\n");
			const statusBefore = gitIn(project, "status", "--porcelain");
			const stagedBefore = gitIn(project, "diff", "--cached", "--name-only");
			const head = gitIn(project, "rev-parse", "HEAD").trim();

			const snapshot = await snapshotProject(project, { includeUntracked: ["notes.txt"] });

			expect(gitIn(project, "status", "--porcelain")).toBe(statusBefore);
			expect(gitIn(project, "diff", "--cached", "--name-only")).toBe(stagedBefore);
			expect(gitIn(project, "rev-parse", "HEAD").trim()).toBe(head);
			expect(snapshot).toMatchObject({ projectRoot: project, originalHead: head });
			const files = gitIn(project, "ls-tree", "-r", "--name-only", snapshot.commit).trim().split("\n");
			expect(files.sort()).toEqual(
				[".gitignore", "app.txt", "callers/main.sh", "check.sh", "lib.sh", "notes.txt", "staged.txt"].sort(),
			);
			expect(gitIn(project, "show", `${snapshot.commit}:app.txt`)).toBe("line one\nedited\n");
		});

		it.each([false, true])(
			"does not execute configured filters while snapshotting, process=%s",
			async (processFilter) => {
				const marker = configureGitHelpers(processFilter);
				write(project, "app.txt", "dirty filtered input\n");
				write(project, "notes.txt", "explicit filtered input\n");
				const indexBefore = readFileSync(join(project, ".git", "index"));
				const headBefore = gitIn(project, "rev-parse", "HEAD");

				const snapshot = await snapshotProject(project, { includeUntracked: ["notes.txt"] });

				expect(existsSync(marker)).toBe(false);
				expect(gitIn(project, "show", `${snapshot.commit}:app.txt`)).toBe("dirty filtered input\n");
				expect(gitIn(project, "show", `${snapshot.commit}:notes.txt`)).toBe("explicit filtered input\n");
				expect(readFileSync(join(project, ".git", "index"))).toEqual(indexBefore);
				expect(gitIn(project, "rev-parse", "HEAD")).toBe(headBefore);
			},
		);

		it("captures staged additions and dirty files from a split index without changing it", async () => {
			write(project, "staged.txt", "staged input\n");
			gitIn(project, "add", "staged.txt");
			gitIn(project, "update-index", "--split-index");
			write(project, "app.txt", "dirty split-index input\n");
			const indexBefore = readFileSync(join(project, ".git", "index"));
			const headBefore = gitIn(project, "rev-parse", "HEAD");

			const snapshot = await snapshotProject(project);
			const child = await createChildWorkspace(snapshot, destination());

			expect(read(child.path, "app.txt")).toBe("dirty split-index input\n");
			expect(read(child.path, "staged.txt")).toBe("staged input\n");
			expect(readFileSync(join(project, ".git", "index"))).toEqual(indexBefore);
			expect(gitIn(project, "rev-parse", "HEAD")).toBe(headBefore);
		});

		it("requires naming individual files inside an ignored directory", async () => {
			write(project, "cache/input.json", "{}\n");
			await expectWorkspaceError(snapshotProject(project, { includeUntracked: ["cache"] }), "invalid-input");
			const snapshot = await snapshotProject(project, { includeUntracked: ["cache/input.json"] });
			expect(gitIn(project, "show", `${snapshot.commit}:cache/input.json`)).toBe("{}\n");
		});

		it("rejects untracked paths that escape the project or name supervisor state", async () => {
			await expectWorkspaceError(snapshotProject(project, { includeUntracked: ["../outside"] }), "invalid-input");
			await expectWorkspaceError(
				snapshotProject(project, { includeUntracked: [".raga/instance.json"] }),
				"invalid-input",
			);
			await expectWorkspaceError(snapshotProject(join(project, "callers")), "not-repository");
		});
	});

	describe("child workspaces", () => {
		let snapshot: ProjectSnapshot;

		beforeEach(async () => {
			write(project, "app.txt", "line one\ndirty parent\n");
			snapshot = await snapshotProject(project);
		});

		it("materializes the snapshot without any Git administration inside", async () => {
			const child = await createChildWorkspace(snapshot, destination());
			expect(read(child.path, "app.txt")).toBe("line one\ndirty parent\n");
			expect(readdirSync(child.path).sort()).toEqual([".gitignore", "app.txt", "callers", "check.sh", "lib.sh"]);
			expect(await listChildWorkspaces(project)).toContainEqual(child);
		});

		it("refuses destinations inside the project checkout and unknown snapshots", async () => {
			await expectWorkspaceError(createChildWorkspace(snapshot, join(project, "child")), "invalid-input");
			const head = gitIn(project, "rev-parse", "HEAD").trim();
			await expectWorkspaceError(createChildWorkspace({ ...snapshot, commit: head }, destination()), "ownership");
		});

		it("accepts destinations under the project's .raga directory", async () => {
			mkdirSync(join(project, ".raga", "worktrees"), { recursive: true });
			const child = await createChildWorkspace(snapshot, join(project, ".raga", "worktrees", "child"));
			expect(read(child.path, "app.txt")).toBe("line one\ndirty parent\n");
		});

		it("collects edits, additions, and deletions relative to the base", async () => {
			const child = await createChildWorkspace(snapshot, destination());
			write(child.path, "app.txt", "child edit\n");
			write(child.path, "new/file.txt", "new\n");
			await rm(join(child.path, "callers", "main.sh"));

			const change = await collectChildChange(child);

			expect(change).toMatchObject({ workspaceId: child.id, baseCommit: snapshot.commit });
			expect(change.files.sort()).toEqual(["app.txt", "callers/main.sh", "new/file.txt"]);
			expect(gitIn(project, "show", `${change.commit}:new/file.txt`)).toBe("new\n");
			expect(read(project, "app.txt")).toBe("line one\ndirty parent\n");
		});

		it("produces an applicable patch only for the owning workspace", async () => {
			const child = await createChildWorkspace(snapshot, destination());
			const other = await createChildWorkspace(snapshot, destination());
			write(child.path, "app.txt", "patched\n");
			const change = await collectChildChange(child);

			const patch = await childChangePatch(child, change);
			const target = await createChildWorkspace(snapshot, destination());
			execFileSync("git", ["apply", "-"], { cwd: target.path, input: patch });
			expect(read(target.path, "app.txt")).toBe("patched\n");
			await expectWorkspaceError(childChangePatch(other, change), "ownership");
			await expectWorkspaceError(childChangePatch(child, { ...change, commit: snapshot.commit }), "ownership");
		});

		it("removes owned workspaces while preserving unfinished work", async () => {
			const child = await createChildWorkspace(snapshot, destination());
			write(child.path, "unfinished.txt", "partial result\n");

			await removeChildWorkspace(child);

			expect(existsSync(child.path)).toBe(false);
			expect(await listChildWorkspaces(project)).not.toContainEqual(child);
			const preserved = gitIn(project, "for-each-ref", "--format=%(objectname)", `refs/raga/changes/${child.id}/`)
				.trim()
				.split("\n");
			expect(preserved).toHaveLength(1);
			expect(gitIn(project, "show", `${preserved[0]}:unfinished.txt`)).toBe("partial result\n");
		});

		it.each([false, true])(
			"keeps configured helpers out of checkout, collection, and cleanup, process=%s",
			async (processFilter) => {
				const marker = configureGitHelpers(processFilter);
				const filteredSnapshot = await snapshotProject(project);
				const child = await createChildWorkspace(filteredSnapshot, destination());
				expect(existsSync(marker)).toBe(false);
				expect(existsSync(join(child.path, ".git"))).toBe(false);
				expect(read(child.path, "app.txt")).toBe("line one\ndirty parent\n");
				write(child.path, "app.txt", "collected filtered edit\n");
				const change = await collectChildChange(child);
				expect(existsSync(marker)).toBe(false);
				expect(gitIn(project, "show", `${change.commit}:app.txt`)).toBe("collected filtered edit\n");

				const nestedSnapshot = await snapshotChildWorkspace(child);
				const nested = await createChildWorkspace(nestedSnapshot, destination());
				expect(read(nested.path, "app.txt")).toBe("collected filtered edit\n");
				write(child.path, "unfinished.txt", "preserved filtered input\n");
				await removeChildWorkspace(child);
				await removeChildWorkspace(nested);

				expect(existsSync(marker)).toBe(false);
				expect(existsSync(child.path)).toBe(false);
				const commits = gitIn(project, "for-each-ref", "--format=%(objectname)", `refs/raga/changes/${child.id}/`)
					.trim()
					.split("\n");
				const preserved = commits.find((commit) =>
					gitIn(project, "ls-tree", "--name-only", commit).includes("unfinished.txt"),
				);
				expect(preserved).toBeDefined();
				expect(gitIn(project, "show", `${preserved}:unfinished.txt`)).toBe("preserved filtered input\n");
				const recovered = await createChildWorkspace(nestedSnapshot, destination());
				expect(read(recovered.path, "app.txt")).toBe("collected filtered edit\n");
				expect(existsSync(marker)).toBe(false);
			},
		);

		it("refuses to remove a workspace handle it does not own", async () => {
			const child = await createChildWorkspace(snapshot, destination());
			const victim = join(base, "victim");
			mkdirSync(victim);
			write(victim, "keep.txt", "keep\n");
			await expectWorkspaceError(removeChildWorkspace({ ...child, path: victim }), "ownership");
			await expectWorkspaceError(removeChildWorkspace({ ...child, id: "0123456789abcdef" }), "ownership");
			expect(read(victim, "keep.txt")).toBe("keep\n");
			expect(existsSync(child.path)).toBe(true);
		});

		it("detects a workspace path replaced by a symlink", async () => {
			const child = await createChildWorkspace(snapshot, destination());
			const moved = `${child.path}-moved`;
			renameSync(child.path, moved);
			execFileSync("ln", ["-s", moved, child.path]);
			await expectWorkspaceError(collectChildChange(child), "ownership");
		});
	});

	describe("supervised integration", () => {
		let snapshot: ProjectSnapshot;
		let integration: ChildWorkspace;
		const verify = { command: "sh", args: ["check.sh"], timeoutMs: 20_000 };

		const childWith = async (from: ProjectSnapshot, edit: (root: string) => void) => {
			const child = await createChildWorkspace(from, destination());
			edit(child.path);
			return { child, change: await collectChildChange(child) };
		};

		beforeEach(async (ctx) => {
			if (!sandbox.available) ctx.skip("bubblewrap unavailable");
			snapshot = await snapshotProject(project);
			integration = await createChildWorkspace(snapshot, destination());
		});

		it("rejects same-file conflicts without changing the integration workspace", async () => {
			const a = await childWith(snapshot, (root) => write(root, "app.txt", "line one\nfrom A\n"));
			const b = await childWith(snapshot, (root) => write(root, "app.txt", "line one\nfrom B\n"));

			const first = await integrateChildChange(integration, a.change, verify);
			expect(first.accepted).toBe(true);
			const second = await integrateChildChange(integration, b.change, verify);

			expect(second.accepted).toBe(false);
			expect(second.reason).toMatch(/merge conflict/);
			expect(second.result.stdout).toContain("app.txt");
			expect(read(integration.path, "app.txt")).toBe("line one\nfrom A\n");
			expect(read(project, "app.txt")).toBe("line one\nline two\n");
		});

		it("rejects conflicting renames", async () => {
			const a = await childWith(snapshot, (root) => renameSync(join(root, "app.txt"), join(root, "renamed-a.txt")));
			const b = await childWith(snapshot, (root) => renameSync(join(root, "app.txt"), join(root, "renamed-b.txt")));
			expect((await integrateChildChange(integration, a.change, verify)).accepted).toBe(true);

			const second = await integrateChildChange(integration, b.change, verify);

			expect(second.accepted).toBe(false);
			expect(second.reason).toMatch(/merge conflict/);
			expect(readdirSync(integration.path)).toContain("renamed-a.txt");
			expect(readdirSync(integration.path)).not.toContain("renamed-b.txt");
		});

		it("runs combined verification after a clean merge and rolls back a semantic conflict", async () => {
			const a = await childWith(snapshot, (root) => {
				write(root, "lib.sh", "sum() { echo $(($1 + $2)); }\n");
				write(root, "callers/main.sh", "sum 1 2 >/dev/null\n");
			});
			const b = await childWith(snapshot, (root) => write(root, "callers/extra.sh", "add 3 4 >/dev/null\n"));
			for (const { child } of [a, b]) {
				const own = await sandboxCommand({
					command: verify.command,
					args: verify.args,
					timeoutMs: verify.timeoutMs,
					policy: { workspace: child.path, readOnly: [], writable: [] },
				});
				expect(own.exitCode).toBe(0);
			}

			const first = await integrateChildChange(integration, a.change, verify);
			expect(first.accepted).toBe(true);
			const second = await integrateChildChange(integration, b.change, verify);

			expect(second.accepted).toBe(false);
			expect(second.result.exitCode).not.toBe(0);
			expect(second.reason).toMatch(/combined verification failed/);
			expect(existsSync(join(integration.path, "callers", "extra.sh"))).toBe(false);
			expect(read(integration.path, "lib.sh")).toBe("sum() { echo $(($1 + $2)); }\n");
			expect(second.preserved).toBeDefined();
			expect(gitIn(project, "show", `${second.preserved}:callers/extra.sh`)).toBe("add 3 4 >/dev/null\n");
			const head = gitIn(project, "rev-parse", `refs/raga/workspaces/${integration.id}/head`).trim();
			expect(head).toBe(first.commit);
		});

		it("keeps the owner's uncommitted edits through acceptance and rollback", async () => {
			write(integration.path, "owner.txt", "owner work\n");
			const clean = await childWith(snapshot, (root) => write(root, "clean.txt", "clean\n"));
			const breaking = await childWith(snapshot, (root) => write(root, "callers/broken.sh", "missing_function\n"));

			const accepted = await integrateChildChange(integration, clean.change, verify);
			expect(accepted.accepted).toBe(true);
			expect(gitIn(project, "show", `${accepted.commit}:owner.txt`)).toBe("owner work\n");
			write(integration.path, "owner.txt", "more owner work\n");

			const rejected = await integrateChildChange(integration, breaking.change, verify);

			expect(rejected.accepted).toBe(false);
			expect(read(integration.path, "owner.txt")).toBe("more owner work\n");
			expect(read(integration.path, "clean.txt")).toBe("clean\n");
			expect(existsSync(join(integration.path, "callers", "broken.sh"))).toBe(false);
		});

		it("rejects successful verification that rewrites the merged source tree", async () => {
			write(integration.path, "owner.txt", "owner progress\n");
			const { change } = await childWith(snapshot, (root) => write(root, "app.txt", "child source\n"));

			const rejected = await integrateChildChange(integration, change, {
				command: "sh",
				args: ["-c", "printf 'rewritten by verification\\n' > app.txt; printf 'generated\\n' > generated.txt"],
				timeoutMs: 20_000,
			});

			expect(rejected).toMatchObject({
				accepted: false,
				reason: "combined verification changed the source tree",
				result: { exitCode: 0 },
			});
			expect(rejected.commit).toBeUndefined();
			expect(rejected.preserved).toBeDefined();
			expect(gitIn(project, "show", `${rejected.preserved}:app.txt`)).toBe("rewritten by verification\n");
			expect(gitIn(project, "show", `${rejected.preserved}:generated.txt`)).toBe("generated\n");
			expect(read(integration.path, "app.txt")).toBe("line one\nline two\n");
			expect(read(integration.path, "owner.txt")).toBe("owner progress\n");
			expect(existsSync(join(integration.path, "generated.txt"))).toBe(false);
			const head = gitIn(project, "rev-parse", `refs/raga/workspaces/${integration.id}/head`).trim();
			expect(gitIn(project, "show", `${head}:owner.txt`)).toBe("owner progress\n");
			expect(gitIn(project, "show", `${head}:app.txt`)).toBe("line one\nline two\n");
		});

		it("does not run project filters or merge drivers during integration and rollback", async () => {
			const marker = configureGitHelpers();
			const filteredSnapshot = await snapshotProject(project);
			const target = await createChildWorkspace(filteredSnapshot, destination());
			const a = await childWith(filteredSnapshot, (root) => write(root, "app.txt", "from A\nline two\n"));
			const b = await childWith(filteredSnapshot, (root) => write(root, "app.txt", "line one\nfrom B\n"));

			expect((await integrateChildChange(target, a.change, verify)).accepted).toBe(true);
			const conflict = await integrateChildChange(target, b.change, verify);
			expect(conflict.accepted).toBe(false);
			expect(conflict.reason).toMatch(/merge conflict/);
			const broken = await childWith(filteredSnapshot, (root) =>
				write(root, "callers/broken.sh", "missing_function\n"),
			);
			const rejected = await integrateChildChange(target, broken.change, verify);
			expect(rejected.accepted).toBe(false);
			expect(rejected.reason).toMatch(/combined verification failed/);
			expect(read(target.path, "app.txt")).toBe("from A\nline two\n");
			expect(existsSync(join(target.path, "callers", "broken.sh"))).toBe(false);
			expect(existsSync(marker)).toBe(false);
		});

		it("restores the workspace when verification is cancelled", async () => {
			const change = (await childWith(snapshot, (root) => write(root, "slow.txt", "slow\n"))).change;
			const controller = new AbortController();
			controller.abort();

			const result = await integrateChildChange(integration, change, verify, controller.signal);

			expect(result).toMatchObject({ accepted: false, reason: "combined verification was aborted" });
			expect(result.result.aborted).toBe(true);
			expect(existsSync(join(integration.path, "slow.txt"))).toBe(false);
		});

		it("starts nested children from the parent's current task state", async () => {
			const parent = await createChildWorkspace(snapshot, destination());
			write(parent.path, "parent.txt", "parent progress\n");
			const parentSnapshot = await snapshotChildWorkspace(parent);
			const grandchild = await childWith(parentSnapshot, (root) => {
				expect(read(root, "parent.txt")).toBe("parent progress\n");
				write(root, "grandchild.txt", "nested\n");
			});

			const nested = await integrateChildChange(parent, grandchild.change, verify);
			expect(nested.accepted).toBe(true);
			const parentChange = await collectChildChange(parent);
			expect(parentChange.files.sort()).toEqual(["grandchild.txt", "parent.txt"]);

			const root = await integrateChildChange(integration, parentChange, verify);
			expect(root.accepted).toBe(true);
			expect(read(integration.path, "grandchild.txt")).toBe("nested\n");
		});

		it("does not expose Git administration or the project to the worker", async () => {
			const child = await createChildWorkspace(snapshot, destination());
			const result = await sandboxCommand({
				command: "sh",
				args: [
					"-c",
					`git status >/dev/null 2>&1 && echo git-works; test -e ${project}/app.txt && echo project-visible; echo done`,
				],
				policy: { workspace: child.path, readOnly: [], writable: [] },
				timeoutMs: 10_000,
			});
			expect(result.stdout).toBe("done\n");
		});

		it("rejects changes that were not collected by the supervisor", async () => {
			const { change } = await childWith(snapshot, (root) => write(root, "x.txt", "x\n"));
			await expectWorkspaceError(
				integrateChildChange(integration, { ...change, workspaceId: "fedcba9876543210" }, verify),
				"ownership",
			);
			await expectWorkspaceError(
				integrateChildChange(integration, { ...change, workspaceId: integration.id }, verify),
				"invalid-input",
			);
		});
	});
});
