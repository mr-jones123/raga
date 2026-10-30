import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { lintMessage, lintStagedPaths, main, parseVersion } from "./raga-release.mjs";

const script = fileURLToPath(new URL("./raga-release.mjs", import.meta.url));
const hook = fileURLToPath(new URL("../.husky/commit-msg", import.meta.url));
const date = "2026-10-24";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "raga-release-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = {
		...process.env,
		HOME: root,
		XDG_CONFIG_HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
		GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
		GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
		RAGA_UPSTREAM_REMOTE: "upstream",
	};
	for (const name of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
		"GIT_CONFIG_COUNT",
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
	])
		delete env[name];
	function run(cwd, command, args, options = {}) {
		return spawnSync(command, args, { cwd, env, encoding: "utf8", ...options });
	}
	function git(cwd, ...args) {
		const result = run(cwd, "git", args);
		assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
		return result.stdout.trim();
	}
	function cli(cwd, ...args) {
		return run(cwd, process.execPath, [script, ...args]);
	}
	function ok(cwd, ...args) {
		const result = cli(cwd, ...args);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	}
	function write(cwd, path, text) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), text);
	}
	function commit(cwd, subject, path = "work.txt", text = subject) {
		write(cwd, path, `${text}\n`);
		git(cwd, "add", path);
		git(cwd, "commit", "-m", subject);
		return git(cwd, "rev-parse", "HEAD");
	}
	function repo(name) {
		const cwd = join(root, name);
		mkdirSync(cwd);
		git(cwd, "init", "-q", "-b", "main");
		git(cwd, "config", "user.name", "Raga Test");
		git(cwd, "config", "user.email", "raga@example.test");
		git(cwd, "config", "commit.gpgSign", "false");
		git(cwd, "config", "tag.gpgSign", "false");
		git(cwd, "config", "core.hooksPath", join(root, "empty-hooks"));
		commit(cwd, "chore: seed", "seed.txt");
		return cwd;
	}
	return { root, env, git, cli, ok, run, write, commit, repo };
}

test("message and path lint enforce conventional headers and upstream changelog ownership", () => {
	for (const text of [
		"feat: add",
		"fix(core)!: remove",
		'Revert "feat: add"',
		'Reapply "feat: add"',
		"fixup! fix: repair",
		"squash! feat: add",
		"amend! fix: repair",
		"chore(release): raga v1.0.0",
		"# comment\n\nfix: repair\n\n# note",
	])
		assert.deepEqual(lintMessage(text), [], text);
	for (const text of ["", "# only comment", "bad header", "Merge branch 'main'", "feature: add", "feat(a b): add", "feat(a(b)): add", "feat:  add", "Feature: add"])
		assert.equal(lintMessage(text).length, 1, text);
	assert.deepEqual(lintMessage("Merge branch 'main'", { merging: true }), []);
	assert.deepEqual(lintStagedPaths(["CHANGELOG.md", "packages/x/src/CHANGELOG.md", "packages/x/changelog.md"]), []);
	assert.deepEqual(lintStagedPaths(["packages/x/CHANGELOG.md", "packages/y/CHANGELOG.md"]).length, 2);
});

test("removed commands and invalid arguments return usage", () => {
	for (const args of [[], ["init", "--base", "HEAD"], ["check"], ["release"], ["release", "--dry-run"], ["version", "extra"], ["lint-msg"], ["lint-msg", "--help"], ["lint-msg", "a", "b"]]) {
		let error = "";
		assert.equal(main(args, { stderr: { write: (text) => { error += text; } } }), 2);
		assert.equal(error, "Usage: node scripts/raga-release.mjs version | lint-msg <file>\n");
	}
});

test("version tags require canonical safe versions", () => {
	assert.deepEqual(parseVersion("10.20.30"), { major: 10, minor: 20, patch: 30 });
	for (const version of ["01.0.0", "1.00.0", "1.0.00", "v1.0.0", "1.0", "1.0.0-beta", "-1.0.0", "1.0.0\n", "9007199254740992.0.0"])
		assert.throws(() => parseVersion(version), /invalid version/);
});

for (const annotated of [false, true]) {
	test(`version accepts ${annotated ? "annotated" : "lightweight"} release tags and preserves unreleased suffix`, (t) => {
		const f = fixture(t), cwd = f.repo("repo");
		f.git(cwd, "tag", ...(annotated ? ["-a", "raga-v1.2.3", "-m", "release"] : ["raga-v1.2.3"]));
		assert.equal(f.ok(cwd, "version"), "1.2.3\n");
		f.commit(cwd, "fix: first");
		const head = f.commit(cwd, "fix: second");
		assert.equal(f.ok(cwd, "version"), `1.2.3+2.g${head.slice(0, 7)}\n`);
		assert.equal(f.git(cwd, "status", "--porcelain"), "");
	});
}

test("version chooses the highest numeric reachable tag, ignoring upstream and unreachable tags", (t) => {
	const f = fixture(t), cwd = f.repo("repo");
	f.git(cwd, "tag", "-a", "raga-v0.10.0", "-m", "release");
	f.git(cwd, "tag", "raga-v0.9.0");
	f.git(cwd, "tag", "v99.0.0");
	f.git(cwd, "switch", "-q", "-c", "other");
	f.commit(cwd, "feat: other");
	f.git(cwd, "tag", "raga-v9.0.0");
	f.git(cwd, "switch", "-q", "main");
	const head = f.commit(cwd, "fix: current");
	assert.equal(f.ok(cwd, "version"), `0.10.0+1.g${head.slice(0, 7)}\n`);
	f.git(cwd, "tag", "raga-v0.11.0");
	assert.equal(f.ok(cwd, "version"), "0.11.0\n");
});

test("version counts only first-parent commits after merges", (t) => {
	const f = fixture(t), cwd = f.repo("repo");
	f.git(cwd, "tag", "raga-v1.0.0");
	f.git(cwd, "switch", "-q", "-c", "topic");
	f.commit(cwd, "feat: one", "topic.txt");
	f.commit(cwd, "feat: two", "topic.txt");
	f.git(cwd, "switch", "-q", "main");
	f.commit(cwd, "fix: local");
	f.git(cwd, "merge", "--no-ff", "topic", "-m", "Merge topic");
	const head = f.git(cwd, "rev-parse", "HEAD");
	assert.equal(f.ok(cwd, "version"), `1.0.0+2.g${head.slice(0, 7)}\n`);
});

test("version reports missing or malformed reachable release tags", (t) => {
	const f = fixture(t), cwd = f.repo("repo");
	let result = f.cli(cwd, "version");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no reachable raga version tag/);
	assert.equal(result.stdout, "");
	f.git(cwd, "tag", "raga-v01.0.0");
	result = f.cli(cwd, "version");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /invalid version/);
});

test("lint-msg hook rejects bad headers and staged package changelogs, but allows merge resolutions", (t) => {
	const f = fixture(t),
		cwd = f.repo("repo");
	mkdirSync(join(cwd, "scripts"));
	mkdirSync(join(cwd, ".husky"));
	copyFileSync(script, join(cwd, "scripts/raga-release.mjs"));
	copyFileSync(hook, join(cwd, ".husky/commit-msg"));
	chmodSync(join(cwd, ".husky/commit-msg"), 0o755);
	const message = join(f.root, "message.txt");
	writeFileSync(message, "bad header\n");
	let result = f.run(cwd, "sh", [".husky/commit-msg", message]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /conventional commit header/);
	f.write(cwd, "packages/x/CHANGELOG.md", "upstream notes\n");
	f.git(cwd, "add", "packages/x/CHANGELOG.md");
	writeFileSync(message, "fix: repair\n# comment\n");
	result = f.run(cwd, "sh", [".husky/commit-msg", message]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /upstream-owned.*packages\/x\/CHANGELOG\.md/);
	writeFileSync(join(cwd, ".git/MERGE_HEAD"), `${f.git(cwd, "rev-parse", "HEAD")}\n`);
	writeFileSync(message, "Merge upstream/main\n");
	result = f.run(cwd, "sh", [".husky/commit-msg", message]);
	assert.equal(result.status, 0, result.stderr);
});

test("lint-msg rejects renaming an upstream-owned changelog out of its package", (t) => {
	const f = fixture(t),
		cwd = f.repo("repo");
	f.commit(cwd, "chore: seed pi notes", "packages/x/CHANGELOG.md", "upstream notes");
	f.git(cwd, "mv", "packages/x/CHANGELOG.md", "old-pi-notes.md");
	const message = join(f.root, "message.txt");
	writeFileSync(message, "chore: move notes\n");
	const result = f.cli(cwd, "lint-msg", message);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /upstream-owned.*packages\/x\/CHANGELOG\.md/);
});

test("lint-msg permits merge headers only during merges and resolves message paths from the caller", (t) => {
	const f = fixture(t), cwd = f.repo("repo");
	f.write(cwd, "nested/message.txt", "Merge upstream/main\n");
	assert.equal(f.cli(join(cwd, "nested"), "lint-msg", "message.txt").status, 1);
	writeFileSync(join(cwd, ".git/MERGE_HEAD"), `${f.git(cwd, "rev-parse", "HEAD")}\n`);
	assert.equal(f.cli(join(cwd, "nested"), "lint-msg", "message.txt").status, 0);
});
