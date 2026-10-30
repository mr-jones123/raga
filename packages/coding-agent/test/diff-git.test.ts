import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitDiffClient, type GitDiffFile } from "../src/extensions/diff/git.ts";

describe("GitDiffClient", () => {
	let directory: string;
	let client: GitDiffClient;
	const working = { kind: "working" } as const;
	const staged = { kind: "staged" } as const;
	function git(...args: string[]): string {
		return execFileSync("git", args, {
			cwd: directory,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_AUTHOR_NAME: "Test Author",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test Author",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		}).trim();
	}
	async function commit(): Promise<string> {
		git("add", "--all");
		git("commit", "-qm", "test subject");
		return git("rev-parse", "HEAD");
	}
	function find(files: GitDiffFile[], path: string): GitDiffFile {
		const file = files.find((item) => item.path === path);
		if (!file) throw new Error(`Missing file ${path}`);
		return file;
	}
	beforeEach(async () => {
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		directory = await mkdtemp(join(tmpdir(), "diff-git-"));
		git("init", "-q", "--initial-branch=main");
		git("config", "core.autocrlf", "false");
		client = new GitDiffClient(directory);
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("handles unborn repositories and initial commits without writing objects", async () => {
		expect(await client.commits()).toEqual([]);
		expect(await client.files(working)).toEqual([]);
		expect(await client.files(staged)).toEqual([]);
		await writeFile(join(directory, "first"), "first\n");
		git("add", "first");
		expect(await client.file(find(await client.files(staged), "first"), staged)).toBe("first\n");
		const hash = await commit();
		const source = { kind: "commit", commit: hash } as const;
		const file = find(await client.files(source), "first");
		expect(file.status).toBe("A");
		expect(await client.diff(file, source)).toContain("+first");
		expect(await client.file(file, source)).toBe("first\n");
		expect(await client.commits()).toEqual([
			{
				hash,
				shortHash: hash.slice(0, 7),
				subject: "test subject",
				author: "Test Author",
				date: expect.stringMatching(/^\d{4}-/),
			},
		]);
		expect(await client.commits(1, 1)).toEqual([]);
		expect(await client.commits(0)).toEqual([]);
		await expect(client.commits(-1)).rejects.toThrow("non-negative");
	});

	it("separates index and worktree content, preserves state, and works from subdirectories", async () => {
		await writeFile(join(directory, "file"), "original\n");
		await commit();
		await writeFile(join(directory, "file"), "staged\n");
		git("add", "file");
		await writeFile(join(directory, "file"), "unstaged\n");
		await mkdir(join(directory, "sub"));
		client = new GitDiffClient(join(directory, "sub"));
		const index = await readFile(join(directory, ".git", "index"));
		const before = git("status", "--porcelain=v1");
		const a = find(await client.files(staged), "file");
		const b = find(await client.files(working), "file");
		expect(await client.file(a, staged)).toBe("staged\n");
		expect(await client.file(b, working)).toBe("unstaged\n");
		expect(await client.diff(a, staged)).toContain("-original\n+staged");
		expect(await client.diff(b, working)).toContain("-staged\n+unstaged");
		expect(await readFile(join(directory, ".git", "index"))).toEqual(index);
		expect(git("status", "--porcelain=v1")).toBe(before);
		expect(await client.root()).toBe(await new GitDiffClient(directory).root());
	});

	it("preserves tabs, newlines, spaces, option-like names, and literal pathspecs", async () => {
		const names = ["space name", "tab\tname", "line\nname", "--output=bad", ":(glob)*", 'quote"name'];
		for (const name of names) await writeFile(join(directory, name), `new ${name}\n`);
		const files = await client.files(working);
		expect(files.map((file) => file.path).sort()).toEqual([...names].sort());
		for (const name of names) {
			const file = find(files, name);
			expect(file.untracked).toBe(true);
			expect(await client.file(file, working)).toBe(`new ${name}\n`);
			expect(await client.diff(file, working)).toContain("--- /dev/null");
		}
		await commit();
		for (const name of names) await writeFile(join(directory, name), "changed\n");
		git("add", "--all");
		const stagedFiles = await client.files(staged);
		expect(stagedFiles.map((file) => file.path).sort()).toEqual([...names].sort());
		for (const file of stagedFiles) {
			expect(await client.file(file, staged)).toBe("changed\n");
			expect(await client.diff(file, staged)).toContain("+changed");
		}
	});

	it("handles rename records and deletion previews in each source", async () => {
		await writeFile(join(directory, "old\tname"), "rename content\n");
		await writeFile(join(directory, "deleted"), "prior content\n");
		await commit();
		await rename(join(directory, "old\tname"), join(directory, "new\nname"));
		await rm(join(directory, "deleted"));
		expect(await client.file(find(await client.files(working), "deleted"), working)).toBe("prior content\n");
		git("add", "--all");
		const files = await client.files(staged);
		const renamed = find(files, "new\nname");
		expect(renamed).toEqual({ path: "new\nname", oldPath: "old\tname", status: "R100" });
		expect(await client.file(renamed, staged)).toBe("rename content\n");
		expect(await client.diff(renamed, staged)).toContain("rename from");
		expect(await client.file(find(files, "deleted"), staged)).toBe("prior content\n");
		const hash = await commit();
		const source = { kind: "commit", commit: hash } as const;
		expect(await client.file(find(await client.files(source), "deleted"), source)).toBe("prior content\n");
		expect(await client.file(find(await client.files(source), "new\nname"), source)).toBe("rename content\n");
	});

	it("uses first-parent diffs for merges and resolves refs safely", async () => {
		await writeFile(join(directory, "base"), "base\n");
		await commit();
		git("checkout", "-qb", "topic");
		await writeFile(join(directory, "topic"), "topic\n");
		await commit();
		git("checkout", "-q", "main");
		await writeFile(join(directory, "main"), "main\n");
		await commit();
		git("merge", "--no-ff", "-qm", "merge", "topic");
		const hash = await client.resolveCommit("HEAD");
		const source = { kind: "commit", commit: hash } as const;
		expect((await client.files(source)).map((file) => file.path)).toEqual(["topic"]);
		expect(await client.file(find(await client.files(source), "topic"), source)).toBe("topic\n");
		await expect(client.resolveCommit("--all")).rejects.toThrow("Git:");
		await expect(client.files({ kind: "commit", commit: "--output=bad" })).rejects.toThrow("Git:");
		git("update-ref", "refs/heads/main", "HEAD~1");
		expect((await client.files(source)).map((file) => file.path)).toEqual(["topic"]);
	});

	it("does not follow symlinks and gives friendly binary and oversized diagnostics", async () => {
		await symlink("/etc/passwd", join(directory, "link"));
		await writeFile(join(directory, "binary"), Buffer.from([0, 1, 2]));
		await writeFile(join(directory, "large"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
		let files = await client.files(working);
		expect(await client.file(find(files, "link"), working)).toBe("/etc/passwd");
		expect(await client.diff(find(files, "link"), working)).toContain("+/etc/passwd");
		expect(await client.file(find(files, "binary"), working)).toContain("Binary file");
		expect(await client.diff(find(files, "binary"), working)).toContain("Binary file");
		await expect(client.file(find(files, "large"), working)).rejects.toThrow("8 MiB");
		await rm(join(directory, "large"));
		await commit();
		await writeFile(join(directory, "binary"), Buffer.from([0, 3, 4]));
		files = await client.files(working);
		expect(await client.diff(find(files, "binary"), working)).toContain("Binary files");
		const source = { kind: "commit", commit: "HEAD" } as const;
		expect(await client.file(find(await client.files(source), "link"), source)).toBe("/etc/passwd");
		expect(await client.file(find(await client.files(source), "binary"), source)).toContain("Binary file");
	});

	it("rejects forged paths, symlink ancestors, and non-repositories", async () => {
		for (const path of ["../secret", "/etc/passwd", "a/../../secret", "C:\\secret", ".git/config", "nul\0name"]) {
			await expect(client.file({ path, status: "?" }, working)).rejects.toThrow("Unsafe");
			await expect(client.diff({ path, status: "M" }, staged)).rejects.toThrow("Unsafe");
		}
		await symlink(tmpdir(), join(directory, "outside"));
		await expect(client.file({ path: "outside/file", status: "?" }, working)).rejects.toThrow("symbolic link");
		await expect(client.diff({ path: "valid", oldPath: "../secret", status: "R100" }, staged)).rejects.toThrow(
			"Unsafe",
		);
		await rm(join(directory, ".git"), { recursive: true });
		await expect(client.files(working)).rejects.toThrow("not a git repository");
		await expect(client.commits()).rejects.toThrow("not a git repository");
	});

	it("reads nested committed files and pages multiple commits", async () => {
		await mkdir(join(directory, "nested"));
		await writeFile(join(directory, "nested", "file"), "one\n");
		const first = await commit();
		await writeFile(join(directory, "nested", "file"), "two\n");
		const second = await commit();
		await writeFile(join(directory, "nested", "file"), "three\n");
		const third = await commit();
		expect((await client.commits()).map((item) => item.hash)).toEqual([third, second, first]);
		expect((await client.commits(1, 1)).map((item) => item.hash)).toEqual([second]);
		const source = { kind: "commit", commit: second } as const;
		const file = find(await client.files(source), "nested/file");
		expect(await client.file(file, source)).toBe("two\n");
		git("add", "--all");
		expect(await client.file({ path: "nested/file", status: "M" }, staged)).toBe("three\n");
	});

	it("bounds object and diff output and handles untracked files without a final newline", async () => {
		await writeFile(join(directory, "short"), "no newline");
		const short = find(await client.files(working), "short");
		expect(await client.diff(short, working)).toContain("+no newline\n\\ No newline at end of file\n");
		await writeFile(join(directory, "empty"), "");
		expect(await client.diff(find(await client.files(working), "empty"), working)).not.toContain("@@");
		await writeFile(join(directory, "large"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
		const hash = await commit();
		const source = { kind: "commit", commit: hash } as const;
		const large = find(await client.files(source), "large");
		await expect(client.file(large, source)).rejects.toThrow("8 MiB");
		await expect(client.diff(large, source)).rejects.toThrow("8 MiB");
	});

	it("ignores external diff, textconv, and color configuration", async () => {
		await writeFile(join(directory, "file"), "before\n");
		await writeFile(join(directory, ".gitattributes"), "file diff=unsafe\n");
		await commit();
		git("config", "diff.unsafe.command", "must-not-run");
		git("config", "diff.unsafe.textconv", "must-not-run");
		git("config", "color.ui", "always");
		await writeFile(join(directory, "file"), "after\n");
		const output = await client.diff(find(await client.files(working), "file"), working);
		expect(output).toContain("+after");
		expect(output).not.toContain("\u001b");
	});
});
