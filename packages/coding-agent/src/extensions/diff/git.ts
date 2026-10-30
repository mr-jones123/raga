import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";

export type GitDiffSource = { kind: "working" } | { kind: "staged" } | { kind: "commit"; commit: string };
export interface GitDiffFile {
	path: string;
	oldPath?: string;
	status: string;
	untracked?: boolean;
}
export interface GitDiffCommit {
	hash: string;
	shortHash: string;
	subject: string;
	author: string;
	date: string;
}

const MAX_BYTES = 8 * 1024 * 1024;
const DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];

function validatePath(path: string): void {
	if (
		!path ||
		path.includes("\0") ||
		isAbsolute(path) ||
		win32.isAbsolute(path) ||
		path.split(/[\\/]/).some((part) => part === ".." || part === ".git")
	) {
		throw new Error(`Unsafe repository path: ${JSON.stringify(path)}`);
	}
}

function text(data: Buffer): string {
	return data.includes(0) ? "Binary file (preview unavailable).\n" : data.toString("utf8");
}

export class GitDiffClient {
	private readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	private async git(args: string[], cwd = this.cwd, allowedCodes: number[] = []): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const child = execFile(
				"git",
				["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-c", "core.fsmonitor=false", ...args],
				{
					cwd,
					encoding: "buffer",
					maxBuffer: MAX_BYTES,
					timeout: 10_000,
					killSignal: "SIGKILL",
					env: {
						...process.env,
						GIT_OPTIONAL_LOCKS: "0",
						GIT_TERMINAL_PROMPT: "0",
						GIT_PAGER: "cat",
						GIT_NO_LAZY_FETCH: "1",
					},
				},
				(error, stdout, stderr) => {
					if (error && !(typeof error.code === "number" && allowedCodes.includes(error.code))) {
						const reason =
							error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
								? "output exceeds 8 MiB limit"
								: error.killed
									? "command timed out (10 seconds)"
									: stderr.toString("utf8").trim() || error.message;
						reject(new Error(`Git: ${reason}`));
					} else resolve(stdout);
				},
			);
			child.stdin?.end();
		});
	}

	async root(): Promise<string> {
		const output = (await this.git(["rev-parse", "--show-toplevel"])).toString("utf8");
		return realpath(output.replace(/\n$/, ""));
	}

	async resolveCommit(ref: string): Promise<string> {
		return (await this.git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).toString("utf8").trim();
	}

	private async head(): Promise<string | undefined> {
		await this.root();
		const hash = (await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], this.cwd, [1]))
			.toString("utf8")
			.trim();
		if (hash) return hash;
		// Only a missing symbolic HEAD is an unborn repository; other failures are errors.
		const ref = (await this.git(["symbolic-ref", "HEAD"])).toString("utf8").trim();
		const existing = await this.git(["rev-parse", "--verify", "--quiet", ref], this.cwd, [1]);
		if (existing.length) throw new Error("Git: HEAD does not resolve to a commit");
		return undefined;
	}

	async commits(limit = 100, skip = 0): Promise<GitDiffCommit[]> {
		if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(skip) || skip < 0)
			throw new Error("Commit limit and skip must be non-negative integers");
		const head = await this.head();
		if (!head || limit === 0) return [];
		const fields = (
			await this.git([
				"log",
				"--no-show-signature",
				"--no-notes",
				`--max-count=${limit}`,
				`--skip=${skip}`,
				"--format=%H%x00%h%x00%s%x00%an%x00%aI",
				"-z",
				head,
				"--",
			])
		)
			.toString("utf8")
			.split("\0");
		fields.pop();
		const commits: GitDiffCommit[] = [];
		for (let i = 0; i < fields.length; i += 5) {
			commits.push({
				hash: fields[i],
				shortHash: fields[i + 1],
				subject: fields[i + 2],
				author: fields[i + 3],
				date: fields[i + 4],
			});
		}
		return commits;
	}

	private async revisions(source: GitDiffSource): Promise<string[]> {
		if (source.kind === "working") return [];
		if (source.kind === "staged") return ["--cached"];
		const hash = await this.resolveCommit(source.commit);
		const parents = (await this.git(["rev-list", "--parents", "-n", "1", hash, "--"]))
			.toString("utf8")
			.trim()
			.split(" ");
		// hash-object without -w computes the empty tree without writing an object.
		const base = parents[1] ?? (await this.git(["hash-object", "-t", "tree", "--stdin"])).toString("utf8").trim();
		return [base, hash];
	}

	async files(source: GitDiffSource): Promise<GitDiffFile[]> {
		const root = await this.root();
		const revisions = await this.revisions(source);
		const tokens = (await this.git(["diff", ...DIFF_OPTIONS, "--name-status", "-z", ...revisions, "--"], root))
			.toString("utf8")
			.split("\0");
		const files: GitDiffFile[] = [];
		for (let i = 0; i < tokens.length - 1; ) {
			const status = tokens[i++];
			const path = tokens[i++];
			if (status.startsWith("R") || status.startsWith("C")) files.push({ status, oldPath: path, path: tokens[i++] });
			else files.push({ status, path });
		}
		if (source.kind === "working") {
			const paths = (await this.git(["ls-files", "--others", "--exclude-standard", "-z"], root))
				.toString("utf8")
				.split("\0");
			for (const path of paths) if (path) files.push({ path, status: "?", untracked: true });
		}
		return files;
	}

	async diff(file: GitDiffFile, source: GitDiffSource): Promise<string> {
		validatePath(file.path);
		if (file.oldPath !== undefined) validatePath(file.oldPath);
		if (file.untracked && source.kind === "working") {
			const data = await this.worktree(file.path);
			if (data.includes(0)) return "Binary file (diff unavailable).\n";
			const content = data.toString("utf8");
			let count = content && !content.endsWith("\n") ? 1 : 0;
			for (let i = 0; i < content.length; i++) if (content[i] === "\n") count++;
			const name = JSON.stringify(`b/${file.path}`);
			const added = content ? `+${content.replace(/\n/g, "\n+")}` : "";
			const body = content.endsWith("\n") ? added.slice(0, -1) : `${added}\n\\ No newline at end of file\n`;
			const patch = `--- /dev/null\n+++ ${name}\n${count ? `@@ -0,0 +1,${count} @@\n${body}` : ""}`;
			if (Buffer.byteLength(patch) > MAX_BYTES) throw new Error("Diff exceeds 8 MiB output limit");
			return patch;
		}
		const root = await this.root();
		return (
			await this.git(
				[
					"diff",
					...DIFF_OPTIONS,
					...(await this.revisions(source)),
					"--",
					file.path,
					...(file.oldPath ? [file.oldPath] : []),
				],
				root,
			)
		).toString("utf8");
	}

	private async blob(path: string, revision?: string): Promise<Buffer> {
		const root = await this.root();
		const entry = (
			await this.git(
				revision ? ["ls-tree", "-z", revision, "--", path] : ["ls-files", "--stage", "-z", "--", path],
				root,
			)
		)
			.toString("utf8")
			.split("\0")
			.find((record) => {
				const tab = record.indexOf("\t");
				return (
					tab >= 0 &&
					record.slice(tab + 1) === path &&
					(revision !== undefined || record.slice(0, tab).endsWith(" 0"))
				);
			});
		if (!entry) throw new Error(`Git: file not found in ${revision ? "commit" : "index"}: ${JSON.stringify(path)}`);
		const [mode, typeOrHash, hashOrStage] = entry.slice(0, entry.indexOf("\t")).split(" ");
		if (mode === "160000") return Buffer.from("Submodule (file preview unavailable).\n");
		return this.git(["cat-file", "blob", revision ? hashOrStage : typeOrHash], root);
	}

	private async worktree(path: string): Promise<Buffer> {
		const root = await this.root();
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			if ((await lstat(join(root, ...parts.slice(0, i)))).isSymbolicLink())
				throw new Error("Cannot preview a path through a symbolic link");
		}
		const absolute = join(root, path);
		const stat = await lstat(absolute);
		if (stat.isSymbolicLink()) return Buffer.from(await readlink(absolute));
		if (!stat.isFile()) throw new Error("Cannot preview a non-regular file");
		const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const current = await handle.stat();
			if (!current.isFile()) throw new Error("Cannot preview a non-regular file");
			if (current.size > MAX_BYTES) throw new Error("File exceeds 8 MiB preview limit");
			const data = Buffer.alloc(MAX_BYTES + 1);
			let length = 0;
			while (length < data.length) {
				const { bytesRead } = await handle.read(data, length, data.length - length, null);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > MAX_BYTES) throw new Error("File exceeds 8 MiB preview limit");
			return data.subarray(0, length);
		} finally {
			await handle.close();
		}
	}

	async file(file: GitDiffFile, source: GitDiffSource): Promise<string> {
		validatePath(file.path);
		if (file.oldPath !== undefined) validatePath(file.oldPath);
		const deleted = file.status.startsWith("D");
		const path = deleted ? (file.oldPath ?? file.path) : file.path;
		if (source.kind === "working") return text(deleted ? await this.blob(path) : await this.worktree(path));
		if (source.kind === "staged") {
			if (!deleted) return text(await this.blob(path));
			const head = await this.head();
			if (!head) throw new Error("Git: deleted file has no prior commit");
			return text(await this.blob(path, head));
		}
		const revisions = await this.revisions(source);
		return text(await this.blob(path, revisions[deleted ? 0 : 1]));
	}
}
