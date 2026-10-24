import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	formatVersion,
	insertSection,
	lintMessage,
	lintStagedPaths,
	main,
	nextVersion,
	parseCommit,
	parseVersion,
	renderSection,
} from "./raga-release.mjs";

const script = fileURLToPath(new URL("./raga-release.mjs", import.meta.url));
const hook = fileURLToPath(new URL("../.husky/commit-msg", import.meta.url));
const date = "2026-10-24";
const sha = "abcdef0123456789";

function raw(subject, body = "", hash = sha) {
	return { subject, body, sha: hash };
}

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
	function atDate(cwd, today, ...args) {
		return run(cwd, process.execPath, [
			"--input-type=module",
			"-e",
			`import { main } from ${JSON.stringify(script)}; process.exit(main(process.argv.slice(1), { today: ${JSON.stringify(today)} }));`,
			...args,
		]);
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
	function initialized(name = "repo") {
		const cwd = repo(name);
		ok(cwd, "init", "--base", "HEAD");
		return cwd;
	}
	function upstreamFork() {
		const upstream = repo("upstream");
		git(upstream, "tag", "-a", "v1.0.0", "-m", "pi release");
		const cwd = join(root, "fork");
		git(root, "clone", "-q", upstream, cwd);
		git(cwd, "remote", "rename", "origin", "upstream");
		git(cwd, "config", "user.name", "Raga Test");
		git(cwd, "config", "user.email", "raga@example.test");
		git(cwd, "config", "commit.gpgSign", "false");
		git(cwd, "config", "tag.gpgSign", "false");
		git(cwd, "config", "core.hooksPath", join(root, "empty-hooks"));
		ok(cwd, "init", "--base", "HEAD");
		return { cwd, upstream };
	}
	return { root, env, git, cli, atDate, ok, run, write, commit, repo, initialized, upstreamFork };
}

test("canonical versions compare numerically and reject noncanonical or unsafe numbers", () => {
	assert.deepEqual(parseVersion("10.20.30"), { major: 10, minor: 20, patch: 30 });
	assert.equal(formatVersion(parseVersion("0.1.2")), "0.1.2");
	for (const value of [
		"01.0.0",
		"1.00.0",
		"1.0.00",
		"v1.0.0",
		"1.0",
		"1.0.0-beta",
		"-1.0.0",
		"1.0.0\n",
		"9007199254740992.0.0",
	])
		assert.throws(() => parseVersion(value));
});

test("commit classification is one union with fixed sections and hidden types", () => {
	for (const [type, section] of [
		["feat", "added"],
		["fix", "fixed"],
		["perf", "changed"],
		["revert", "changed"],
	]) {
		assert.deepEqual(parseCommit(raw(`${type}(kernel): keep state`)), {
			kind: "entry",
			section,
			scope: "kernel",
			text: "keep state",
			breaking: false,
			note: null,
			sha,
		});
	}
	for (const type of ["refactor", "docs", "test", "build", "ci", "chore", "style"])
		assert.deepEqual(parseCommit(raw(`${type}: maintain`)), { kind: "hidden", type, sha });
	assert.equal(parseCommit(raw("chore(release): raga v0.1.0")).kind, "hidden");
	for (const subject of [
		"fixup! feat: x",
		"squash! fix: x",
		"amend! fix: x",
		"Feature: x",
		"feat: ",
		"feat(a b): x",
		"feat(a(b)): x",
		"feat:  x",
		"unknown: x",
		"just words",
	])
		assert.equal(parseCommit(raw(subject)).kind, "nonconforming", subject);
	assert.deepEqual(parseCommit(raw('Revert "feat(x): old feature"')), {
		kind: "entry",
		section: "changed",
		scope: null,
		text: "Reverted: feat(x): old feature",
		breaking: false,
		note: null,
		sha,
	});
});

test("breaking markers override visible and hidden types and preserve footer notes", () => {
	for (const subject of ["feat!: remove", "fix(api)!: remove", "chore!: remove"]) {
		const entry = parseCommit(raw(subject));
		assert.equal(entry.section, "breaking");
		assert.equal(entry.breaking, true);
	}
	for (const marker of ["BREAKING CHANGE", "BREAKING-CHANGE"]) {
		const entry = parseCommit(
			raw("refactor(api): remove", `Details.\n\n${marker}: Use the new API.\n  Migrate callers.\n\nRefs: #1`),
		);
		assert.equal(entry.note, "Use the new API. Migrate callers.");
		assert.equal(entry.section, "breaking");
	}
	assert.equal(parseCommit(raw("fix: repair", "An inline BREAKING CHANGE: mention")).breaking, false);
});

test("pre-1.0 and post-1.0 bump table and explicit targets", () => {
	for (const [current, subject, expected] of [
		["0.2.3", "fix!: break", "0.3.0"],
		["0.2.3", "feat: add", "0.3.0"],
		["0.2.3", "fix: repair", "0.2.4"],
		["1.2.3", "fix!: break", "2.0.0"],
		["1.2.3", "feat: add", "1.3.0"],
		["1.2.3", "fix: repair", "1.2.4"],
	])
		assert.equal(formatVersion(nextVersion(parseVersion(current), [parseCommit(raw(subject))], [])), expected);
	const current = parseVersion("1.2.3");
	assert.equal(formatVersion(nextVersion(current, [], [{}])), "1.2.4");
	for (const [target, expected] of [
		["patch", "1.2.4"],
		["minor", "1.3.0"],
		["major", "2.0.0"],
		["1.10.0", "1.10.0"],
	])
		assert.equal(formatVersion(nextVersion(current, [], [{}], target)), expected);
	for (const target of ["1.2.3", "1.1.9", "01.3.0"]) assert.throws(() => nextVersion(current, [], [{}], target));
	assert.throws(() => nextVersion(current, [], [], "major"), /nothing to release/);
});

test("renderSection golden includes ordered sections, scopes, notes and sync counts", () => {
	const entries = [
		parseCommit(raw("fix: repair", "", "4444444a")),
		parseCommit(raw("feat(core): first", "", "1111111a")),
		parseCommit(raw("perf: speed up", "", "3333333a")),
		parseCommit(raw("feat: second", "", "2222222a")),
		parseCommit(raw("fix(api)!: remove old API.", "BREAKING CHANGE: Use the new API.", "0000000a")),
	];
	const plan = { next: parseVersion("0.3.0"), date, entries, syncs: [{ describe: "v1.5.0", count: 143 }] };
	const expected =
		"## [0.3.0] - 2026-10-24\n\n### Breaking Changes\n\n- **api**: remove old API. Use the new API. (0000000)\n\n### Added\n\n- **core**: first (1111111)\n- second (2222222)\n\n### Changed\n\n- speed up (3333333)\n\n### Fixed\n\n- repair (4444444)\n\n### Upstream\n\n- Merged pi v1.5.0 (143 commits)\n";
	assert.equal(renderSection(plan), expected);
	assert.equal(renderSection(plan), expected);
	assert.equal(
		renderSection({ ...plan, entries: [], syncs: [{ describe: "abcdef0", count: 1 }] }),
		"## [0.3.0] - 2026-10-24\n\n### Upstream\n\n- Merged pi abcdef0 (1 commits)\n",
	);
});

test("insertSection is idempotent and preserves released bytes", () => {
	const old = "## [0.1.0] - 2026-01-01\n\n### Added\n\n- old entry (1234567)\n\n";
	const header =
		"# Changelog\n\nGenerated by scripts/raga-release.mjs from conventional commits. Do not edit by hand.\n\n";
	const section = "## [0.2.0] - 2026-10-24\n\n### Fixed\n\n- repair (abcdef0)\n";
	assert.deepEqual(insertSection(null, old, "0.1.0"), { text: header + old, changed: true });
	const inserted = insertSection(header + old, section, "0.2.0");
	assert.equal(inserted.text, `${header}${section}\n${old}`);
	assert.deepEqual(insertSection(inserted.text, section, "0.2.0"), { text: inserted.text, changed: false });
});

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
	for (const text of ["", "# only comment", "bad header", "Merge branch 'main'", "feature: add"])
		assert.equal(lintMessage(text).length, 1, text);
	assert.deepEqual(lintMessage("Merge branch 'main'", { merging: true }), []);
	assert.deepEqual(lintStagedPaths(["CHANGELOG.md", "packages/x/src/CHANGELOG.md", "packages/x/changelog.md"]), []);
	assert.deepEqual(lintStagedPaths(["packages/x/CHANGELOG.md", "packages/y/CHANGELOG.md"]).length, 2);
});

test("unknown commands and bad arguments return usage and code 2", () => {
	for (const args of [
		[],
		["nope"],
		["version", "extra"],
		["check", "extra"],
		["init"],
		["init", "--base", "--help"],
		["release", "01.0.0"],
		["release", "--dry-run", "--dry-run"],
		["release", "major", "minor"],
		["lint-msg"],
	]) {
		let error = "";
		assert.equal(
			main(args, {
				stderr: {
					write: (text) => {
						error += text;
					},
				},
			}),
			2,
		);
		assert.match(error, /^Usage:/);
	}
});

test("init validates ancestry, creates only an annotated baseline and is idempotent", (t) => {
	const f = fixture(t),
		cwd = f.repo("repo");
	const base = f.git(cwd, "rev-parse", "HEAD");
	f.commit(cwd, "feat: add");
	f.ok(cwd, "init", "--base", base);
	const tagObject = f.git(cwd, "rev-parse", "raga-v0.0.0");
	f.ok(cwd, "init", "--base", base);
	assert.equal(f.git(cwd, "rev-parse", "raga-v0.0.0"), tagObject);
	assert.equal(f.git(cwd, "cat-file", "-t", "raga-v0.0.0"), "tag");
	assert.equal(f.git(cwd, "for-each-ref", "--format=%(contents)", "refs/tags/raga-v0.0.0"), "raga fork point");
	assert.match(f.cli(cwd, "init", "--base", "HEAD").stderr, /different commit/);
	f.git(cwd, "switch", "-q", "-c", "other", base);
	const other = f.commit(cwd, "feat: other", "other.txt");
	f.git(cwd, "switch", "-q", "main");
	assert.match(f.cli(cwd, "init", "--base", other).stderr, /ancestor/);
	assert.equal(f.git(cwd, "tag", "--list"), "raga-v0.0.0");
});

test("version chooses numeric maximum among ancestor tags and reports first-parent distance", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	assert.equal(f.ok(cwd, "version"), "0.0.0\n");
	f.git(cwd, "tag", "-a", "raga-v0.9.0", "-m", "old");
	f.git(cwd, "tag", "-a", "raga-v0.10.0", "-m", "new");
	f.git(cwd, "switch", "-q", "-c", "unreachable");
	f.commit(cwd, "feat: other", "other.txt");
	f.git(cwd, "tag", "-a", "raga-v9.0.0", "-m", "not ancestor");
	f.git(cwd, "switch", "-q", "main");
	const head = f.commit(cwd, "fix: current");
	assert.equal(f.ok(cwd, "version"), `0.10.0+1.g${head.slice(0, 7)}\n`);
});

test("upstream merges produce one sync line and exclude second-parent entries", (t) => {
	const f = fixture(t),
		{ cwd, upstream } = f.upstreamFork();
	f.commit(cwd, "chore: local maintenance", "local.txt");
	f.commit(upstream, "feat: pi addition", "pi.txt");
	f.commit(upstream, "fix: pi repair", "pi.txt");
	f.git(upstream, "tag", "-a", "v1.1.0", "-m", "pi release");
	f.git(cwd, "fetch", "-q", "upstream", "--tags");
	f.git(cwd, "merge", "--no-ff", "upstream/main", "-m", "Merge pi");
	const dry = f.ok(cwd, "release", "--dry-run");
	assert.match(dry, /next version 0\.0\.1/);
	assert.match(dry, /### Upstream\n\n- Merged pi v1\.1\.0 \(2 commits\)/);
	assert.doesNotMatch(dry, /pi addition|pi repair|### Added|### Fixed/);
	assert.equal(f.ok(cwd, "check"), "ok\n");
	assert.equal(existsSync(join(cwd, "CHANGELOG.md")), false);
	f.git(cwd, "remote", "remove", "upstream");
	f.git(cwd, "tag", "-d", "v1.0.0", "v1.1.0");
	for (const command of ["check", "release"]) {
		const result = f.cli(cwd, command);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /stray merge/);
		assert.match(result.stderr, /restore the upstream remote or fetch pi's v\* tags/);
		assert.doesNotMatch(result.stderr, /pi addition|pi repair/);
		assert.doesNotMatch(result.stdout, /pi addition|pi repair|### Added|### Fixed/);
	}
});

test("upstream sync falls back to short sha without a covering pi tag", (t) => {
	const f = fixture(t),
		{ cwd, upstream } = f.upstreamFork();
	f.git(cwd, "tag", "-d", "v1.0.0");
	f.git(upstream, "tag", "-d", "v1.0.0");
	f.commit(cwd, "chore: local", "local.txt");
	const head = f.commit(upstream, "feat: pi addition", "pi.txt");
	f.git(cwd, "fetch", "-q", "upstream");
	f.git(cwd, "merge", "--no-ff", "upstream/main", "-m", "Merge pi");
	assert.match(f.ok(cwd, "release", "--dry-run"), new RegExp(`Merged pi ${head.slice(0, 7)} \\(1 commits\\)`));
});

test("fast-forwarded and rebased upstream commits are excluded by the remote boundary", async (t) => {
	for (const rebase of [false, true])
		await t.test(rebase ? "rebase" : "fast-forward", (t) => {
			const f = fixture(t),
				{ cwd, upstream } = f.upstreamFork();
			if (rebase) f.commit(cwd, "fix: local repair", "local.txt");
			f.commit(upstream, "feat: pi addition", "pi.txt");
			f.git(cwd, "fetch", "-q", "upstream");
			f.git(cwd, rebase ? "rebase" : "merge", ...(rebase ? ["upstream/main"] : ["--ff-only", "upstream/main"]));
			if (!rebase) {
				assert.match(f.cli(cwd, "release", "--dry-run").stderr, /boundary.*HEAD/);
				f.commit(cwd, "fix: local repair", "local.txt");
			}
			const dry = f.ok(cwd, "release", "--dry-run");
			assert.match(dry, /local repair/);
			assert.doesNotMatch(dry, /pi addition|### Upstream|### Added/);
		});
});

test("release creates one changelog-only commit and one annotated tag, and reruns do nothing", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	const first = f.commit(cwd, "feat(core): first", "first.txt");
	const second = f.commit(cwd, "feat(core): second", "second.txt");
	f.commit(cwd, "fix: repair", "fix.txt");
	const before = Number(f.git(cwd, "rev-list", "--count", "HEAD"));
	const head = f.git(cwd, "rev-parse", "HEAD");
	const status = f.git(cwd, "status", "--porcelain");
	const dry = f.ok(cwd, "release", "--dry-run");
	assert.match(dry, /next version 0\.1\.0/);
	assert.match(dry, /git add CHANGELOG\.md/);
	assert.equal(f.git(cwd, "rev-parse", "HEAD"), head);
	assert.equal(f.git(cwd, "status", "--porcelain"), status);
	assert.equal(f.git(cwd, "tag", "--list"), "raga-v0.0.0");
	assert.equal(existsSync(join(cwd, "CHANGELOG.md")), false);
	assert.equal(f.ok(cwd, "release"), "released 0.1.0\ngit push <raga-remote> HEAD raga-v0.1.0\n");
	assert.equal(Number(f.git(cwd, "rev-list", "--count", "HEAD")), before + 1);
	assert.equal(f.git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "CHANGELOG.md");
	assert.equal(f.git(cwd, "cat-file", "-t", "raga-v0.1.0"), "tag");
	const changelog = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
	const section = changelog.slice(changelog.indexOf("## ["));
	const tagObject = f.run(cwd, "git", ["cat-file", "-p", "raga-v0.1.0"]);
	assert.equal(tagObject.status, 0, tagObject.stderr);
	assert.equal(tagObject.stdout.slice(tagObject.stdout.indexOf("\n\n") + 2), section);
	assert.ok(changelog.indexOf(first.slice(0, 7)) < changelog.indexOf(second.slice(0, 7)));
	const released = f.git(cwd, "rev-parse", "HEAD");
	assert.equal(f.ok(cwd, "release"), "already released 0.1.0\n");
	assert.equal(f.git(cwd, "rev-parse", "HEAD"), released);
	assert.equal(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"), changelog);
	assert.equal(f.ok(cwd, "check"), "ok\n");
	assert.equal(f.ok(cwd, "version"), "0.1.0\n");
	for (const tag of f.git(cwd, "tag", "--list").split("\n")) assert.match(tag, /^raga-v\d+\.\d+\.\d+$/);
	f.commit(cwd, "fix: next", "next.txt");
	f.ok(cwd, "release");
	assert.ok(readFileSync(join(cwd, "CHANGELOG.md"), "utf8").endsWith(section));
	assert.equal(f.ok(cwd, "check"), "ok\n");
});

test("crash after commit recovers only the tag from the committed section", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "feat: add");
	f.ok(cwd, "release");
	const head = f.git(cwd, "rev-parse", "HEAD");
	const original = f.git(cwd, "for-each-ref", "--format=%(contents)", "refs/tags/raga-v0.1.0");
	f.git(cwd, "tag", "-d", "raga-v0.1.0");
	assert.match(f.ok(cwd, "release", "--dry-run"), /git tag -a raga-v0\.1\.0/);
	assert.equal(f.git(cwd, "tag", "--list", "raga-v0.1.0"), "");
	assert.match(f.ok(cwd, "release"), /recovered raga-v0\.1\.0/);
	assert.equal(f.git(cwd, "rev-parse", "HEAD"), head);
	assert.equal(f.git(cwd, "for-each-ref", "--format=%(contents)", "refs/tags/raga-v0.1.0"), original);
	assert.equal(f.ok(cwd, "check"), "ok\n");
});

test("crash after write accepts identical bytes, including an already staged changelog", async (t) => {
	for (const staged of [false, true])
		await t.test(staged ? "staged" : "unstaged", (t) => {
			const f = fixture(t),
				cwd = f.initialized();
			f.commit(cwd, "fix: repair");
			const dry = f.ok(cwd, "release", "--dry-run");
			const section = `${dry.slice(dry.indexOf("## ["), dry.indexOf("\nwrite CHANGELOG.md"))}\n`;
			const planned = insertSection(null, section, "0.0.1").text;
			f.write(cwd, "CHANGELOG.md", planned);
			if (staged) f.git(cwd, "add", "CHANGELOG.md");
			f.ok(cwd, "release");
			assert.equal(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"), planned);
			assert.equal(f.ok(cwd, "check"), "ok\n");
		});
});

test("release refuses unrelated dirt, edited changelog bytes, hidden-only plans and nonconforming commits", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "chore: maintenance");
	assert.match(f.cli(cwd, "release").stderr, /nothing to release/);
	f.commit(cwd, "fix: repair");
	f.write(cwd, "untracked.txt", "do not lose\n");
	assert.match(f.cli(cwd, "release").stderr, /worktree must be clean/);
	rmSync(join(cwd, "untracked.txt"));
	f.write(cwd, "CHANGELOG.md", "manual changes\n");
	assert.match(f.cli(cwd, "release").stderr, /does not equal the planned output/);
	rmSync(join(cwd, "CHANGELOG.md"));
	f.commit(cwd, "bad header");
	const failure = f.cli(cwd, "release");
	assert.equal(failure.status, 1);
	assert.match(failure.stderr, /nonconforming commit/);
	assert.equal(existsSync(join(cwd, "CHANGELOG.md")), false);
});

test("check reports every stray merge, missing heading tag and nonconforming commit", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.git(cwd, "switch", "-q", "-c", "topic");
	f.commit(cwd, "feat: topic", "topic.txt");
	f.git(cwd, "switch", "-q", "main");
	f.commit(cwd, "fix: main", "main.txt");
	f.git(cwd, "merge", "--no-ff", "topic", "-m", "Merge topic");
	f.commit(cwd, "bad header", "bad.txt");
	f.commit(cwd, "chore: record missing release", "CHANGELOG.md", "# Changelog\n\n## [0.4.0] - 2026-10-24\n");
	f.git(cwd, "tag", "-a", "raga-v0.2.0", "raga-v0.0.0^{commit}", "-m", "missing heading");
	const result = f.cli(cwd, "check");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /stray merge/);
	assert.match(result.stderr, /nonconforming commit.*bad header/);
	assert.match(result.stderr, /missing tag raga-v0\.4\.0/);
	assert.match(result.stderr, /missing CHANGELOG\.md heading for raga-v0\.2\.0/);
	assert.match(f.cli(cwd, "release").stderr, /stray merge/);
});

test("check uses committed changelog bytes rather than a dirty worktree", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "feat: add");
	f.ok(cwd, "release");
	f.write(cwd, "CHANGELOG.md", "manual deletion\n");
	assert.equal(f.ok(cwd, "check"), "ok\n");
});

test("upstream boundary sanity names an overridden remote and reports parity problems too", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "feat: add");
	f.ok(cwd, "release");
	f.git(cwd, "update-ref", "refs/remotes/pi/main", "HEAD");
	f.env.RAGA_UPSTREAM_REMOTE = "pi";
	f.commit(cwd, "chore: broken heading", "CHANGELOG.md", "# Changelog\n");
	const result = f.cli(cwd, "check");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /remote pi contains raga-v0\.1\.0/);
	assert.match(result.stderr, /missing CHANGELOG\.md heading/);
	assert.match(f.cli(cwd, "release").stderr, /pi points at raga itself/);
});

test("octopus merges are stray even with an upstream boundary", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	for (const branch of ["one", "two"]) {
		f.git(cwd, "switch", "-q", "-c", branch, "main");
		f.commit(cwd, `feat: ${branch}`, `${branch}.txt`);
	}
	f.git(cwd, "switch", "-q", "main");
	f.commit(cwd, "fix: local", "local.txt");
	f.git(cwd, "update-ref", "refs/remotes/upstream/main", "one");
	f.git(cwd, "merge", "--no-ff", "one", "two", "-m", "Merge branches");
	assert.match(f.cli(cwd, "check").stderr, /stray merge/);
	assert.match(f.cli(cwd, "release").stderr, /stray merge/);
});

test("lint-msg hook rejects bad headers and staged package changelogs, but allows merge resolutions", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
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

test("release runs the commit hook and leaves a retryable planned file on hook failure", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "feat: add");
	const hooks = join(f.root, "hooks");
	mkdirSync(hooks);
	writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho expected-hook-failure >&2\nexit 1\n", { mode: 0o755 });
	f.git(cwd, "config", "core.hooksPath", hooks);
	const before = f.git(cwd, "rev-parse", "HEAD");
	const result = f.cli(cwd, "release");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /expected-hook-failure/);
	assert.equal(f.git(cwd, "rev-parse", "HEAD"), before);
	assert.equal(f.git(cwd, "tag", "--list"), "raga-v0.0.0");
	const planned = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
	writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
	f.ok(cwd, "release");
	assert.equal(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"), planned);
});

test("release refuses HEAD movement during the release commit before creating a tag", async (t) => {
	for (const subject of ["fix: concurrent unlisted fix", "chore(release): raga v0.1.0"])
		await t.test(subject, (t) => {
			const f = fixture(t),
				cwd = f.initialized();
			f.commit(cwd, "feat: ready to ship");
			const hooks = join(f.root, "hooks");
			mkdirSync(hooks);
			writeFileSync(
				join(hooks, "post-commit"),
				`#!/bin/sh\ngit -c core.hooksPath=/dev/null commit --allow-empty -m "${subject}"\n`,
				{ mode: 0o755 },
			);
			f.git(cwd, "config", "core.hooksPath", hooks);
			const result = f.cli(cwd, "release");
			assert.equal(result.status, 1);
			assert.match(result.stderr, /HEAD moved/);
			assert.equal(f.git(cwd, "tag", "--list", "raga-v0.1.0"), "");
		});
});

test("crash after write preserves the planned date across midnight and still rejects altered bytes", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "fix: repair");
	const dry = f.atDate(cwd, "2026-10-24", "release", "--dry-run");
	assert.equal(dry.status, 0, dry.stderr);
	const section = `${dry.stdout.slice(dry.stdout.indexOf("## ["), dry.stdout.indexOf("\nwrite CHANGELOG.md"))}\n`;
	const planned = insertSection(null, section, "0.0.1").text;
	f.write(cwd, "CHANGELOG.md", planned.replace("repair", "manual edit"));
	const refused = f.atDate(cwd, "2026-10-25", "release");
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /does not equal the planned output/);
	f.write(cwd, "CHANGELOG.md", planned);
	f.git(cwd, "add", "CHANGELOG.md");
	const recovered = f.atDate(cwd, "2026-10-25", "release");
	assert.equal(recovered.status, 0, recovered.stderr);
	assert.equal(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"), planned);
	assert.match(f.git(cwd, "show", "raga-v0.0.1:CHANGELOG.md"), /## \[0\.0\.1\] - 2026-10-24/);
});

test("Revert and Reapply breaking footers drive the major bump and retain migration notes", async (t) => {
	for (const verb of ["Revert", "Reapply"])
		await t.test(verb, (t) => {
			const f = fixture(t),
				cwd = f.initialized();
			f.commit(cwd, "feat: initial API");
			f.ok(cwd, "release", "1.0.0");
			f.git(
				cwd,
				"commit",
				"--allow-empty",
				"-m",
				`${verb} "fix: compatible output"`,
				"-m",
				"BREAKING CHANGE: Switch output formats.",
			);
			const dry = f.ok(cwd, "release", "--dry-run");
			assert.match(dry, /next version 2\.0\.0/);
			assert.match(dry, /### Breaking Changes/);
			assert.match(dry, /(?:Reverted|Reapplied): fix: compatible output\. Switch output formats\./);
			assert.doesNotMatch(dry, /### Changed/);
		});
});

test("lint-msg rejects renaming an upstream-owned changelog out of its package", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "chore: seed pi notes", "packages/x/CHANGELOG.md", "upstream notes");
	f.git(cwd, "mv", "packages/x/CHANGELOG.md", "old-pi-notes.md");
	const message = join(f.root, "message.txt");
	writeFileSync(message, "chore: move notes\n");
	const result = f.cli(cwd, "lint-msg", message);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /upstream-owned.*packages\/x\/CHANGELOG\.md/);
});

test("first-release boundary sanity detects raga HEAD and nothing-to-release counts excluded commits", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "feat: local work");
	f.commit(cwd, "fix: local repair");
	f.git(cwd, "update-ref", "refs/remotes/pi/main", "HEAD");
	f.env.RAGA_UPSTREAM_REMOTE = "pi";
	for (const args of [["check"], ["release", "--dry-run"], ["release"]]) {
		const result = f.cli(cwd, ...args);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /boundary.*remote pi.*HEAD/);
		assert.match(result.stderr, /point pi at pi/);
	}
	f.commit(cwd, "chore: local maintenance");
	const result = f.cli(cwd, "release", "--dry-run");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /nothing to release.*2 first-parent commits.*excluded/);
});

test("tag collisions on another branch fail dry-run and release before any write", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.git(cwd, "switch", "-q", "-c", "other");
	f.commit(cwd, "feat: other work");
	f.git(cwd, "tag", "-a", "raga-v0.1.0", "-m", "other release");
	const tag = f.git(cwd, "rev-parse", "raga-v0.1.0");
	f.git(cwd, "switch", "-q", "main");
	const head = f.commit(cwd, "feat: mainline work");
	for (const args of [["release", "--dry-run"], ["release"]]) {
		const result = f.cli(cwd, ...args);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /raga-v0\.1\.0.*already exists/);
		assert.equal(f.git(cwd, "rev-parse", "HEAD"), head);
		assert.equal(f.git(cwd, "rev-parse", "raga-v0.1.0"), tag);
		assert.equal(f.git(cwd, "status", "--porcelain"), "");
		assert.equal(existsSync(join(cwd, "CHANGELOG.md")), false);
	}
});

test("recovery finds an untagged release below HEAD and uses that commit's section without writes", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "feat: initial");
	f.ok(cwd, "release");
	const release = f.git(cwd, "rev-parse", "HEAD");
	const original = f.git(cwd, "for-each-ref", "--format=%(contents)", "refs/tags/raga-v0.1.0");
	f.git(cwd, "tag", "-d", "raga-v0.1.0");
	f.commit(cwd, "fix: later");
	const head = f.commit(
		cwd,
		"chore: adjust committed notes",
		"CHANGELOG.md",
		"# Changelog\n\n## [0.1.0] - 2026-10-25\n\nAltered later.\n",
	);
	f.write(cwd, "CHANGELOG.md", "uncommitted bytes must survive\n");
	const before = f.git(cwd, "status", "--porcelain");
	const dry = f.ok(cwd, "release", "--dry-run");
	assert.match(dry, /git tag -a raga-v0\.1\.0/);
	assert.ok(dry.includes(original));
	assert.doesNotMatch(dry, /write CHANGELOG|git add|git commit|Altered later/);
	assert.equal(f.git(cwd, "tag", "--list", "raga-v0.1.0"), "");
	assert.match(f.ok(cwd, "release"), /recovered raga-v0\.1\.0/);
	assert.equal(f.git(cwd, "rev-parse", "raga-v0.1.0^{commit}"), release);
	assert.equal(f.git(cwd, "rev-parse", "HEAD"), head);
	assert.equal(f.git(cwd, "status", "--porcelain"), before);
	assert.equal(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"), "uncommitted bytes must survive\n");
	assert.equal(f.git(cwd, "for-each-ref", "--format=%(contents)", "refs/tags/raga-v0.1.0"), original);
});

test("release refuses a duplicate planned heading before staging or committing", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "feat: add");
	const head = f.commit(
		cwd,
		"chore: existing heading",
		"CHANGELOG.md",
		"# Changelog\n\n## [0.1.0] - 2026-10-24\n\nExisting.\n",
	);
	for (const args of [["release", "--dry-run"], ["release"]]) {
		const result = f.cli(cwd, ...args);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /heading.*0\.1\.0.*already exists/);
		assert.equal(f.git(cwd, "rev-parse", "HEAD"), head);
		assert.equal(f.git(cwd, "status", "--porcelain"), "");
	}
});

test("git failures retain diagnostics printed only to stdout", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	f.commit(cwd, "feat: add");
	const hooks = join(f.root, "hooks");
	mkdirSync(hooks);
	writeFileSync(
		join(hooks, "pre-commit"),
		'#!/bin/sh\ngit -c core.hooksPath=/dev/null commit -m "chore: hook consumes staged changes" >/dev/null\n',
		{ mode: 0o755 },
	);
	f.git(cwd, "config", "core.hooksPath", hooks);
	const result = f.cli(cwd, "release");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /nothing added to commit|nothing to commit/);
});

test("check stays within its deadline with many upstream boundary refs", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	const base = f.git(cwd, "rev-parse", "HEAD");
	for (let i = 0; i < 100; i++) f.git(cwd, "update-ref", `refs/remotes/upstream/branch-${i}`, base);
	f.commit(cwd, "feat: initial");
	f.ok(cwd, "release");
	const realGit = f.run(cwd, "sh", ["-c", "command -v git"]).stdout.trim();
	const bin = join(f.root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 0.05\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
	f.env.PATH = `${bin}:${f.env.PATH}`;
	const result = f.run(cwd, process.execPath, [script, "check"], { timeout: 4500 });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "ok\n");
});

test("lint-msg permits merge headers only during merges and accepts autosquash messages without releasing them", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	const message = join(f.root, "message.txt");
	writeFileSync(message, "Merge the two config loaders\n");
	assert.equal(f.cli(cwd, "lint-msg", message).status, 1);
	writeFileSync(join(cwd, ".git/MERGE_HEAD"), `${f.git(cwd, "rev-parse", "HEAD")}\n`);
	assert.equal(f.cli(cwd, "lint-msg", message).status, 0);
	rmSync(join(cwd, ".git/MERGE_HEAD"));
	f.commit(cwd, 'Reapply "feat: add"');
	assert.equal(f.ok(cwd, "check"), "ok\n");
	assert.match(f.ok(cwd, "release", "--dry-run"), /### Changed/);
	for (const prefix of ["fixup!", "squash!", "amend!"]) {
		writeFileSync(message, `${prefix} fix: repair\n`);
		assert.equal(f.cli(cwd, "lint-msg", message).status, 0);
		f.git(cwd, "commit", "--allow-empty", "-m", `${prefix} fix: repair`);
	}
	const checked = f.cli(cwd, "check");
	assert.equal(checked.status, 1);
	for (const prefix of ["fixup!", "squash!", "amend!"]) assert.ok(checked.stderr.includes(prefix));
	assert.equal(f.cli(cwd, "release", "--dry-run").status, 1);
});

test("dry-run lists the write, add, commit, verify and explicit-target tag operations executed by release", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	const parent = f.commit(cwd, "feat: plan");
	const dry = f.ok(cwd, "release", "--dry-run");
	const operations = dry.slice(dry.indexOf("write CHANGELOG.md")).trim().split("\n");
	assert.match(operations[0], /^write CHANGELOG\.md$/);
	assert.match(operations[1], /^git add CHANGELOG\.md$/);
	assert.match(operations[2], /^git commit -m "chore\(release\): raga v0\.1\.0"$/);
	assert.match(operations[3], /^verify release commit/);
	assert.match(operations[4], /^git tag -a raga-v0\.1\.0 <release-commit> -F - --cleanup=verbatim$/);
	assert.equal(existsSync(join(cwd, "CHANGELOG.md")), false);
	f.ok(cwd, "release");
	const release = f.git(cwd, "rev-parse", "raga-v0.1.0^{commit}");
	assert.equal(f.git(cwd, "rev-parse", `${release}^`), parent);
	assert.equal(f.git(cwd, "show", "-s", "--format=%s", release), "chore(release): raga v0.1.0");
	assert.equal(f.git(cwd, "status", "--porcelain"), "");
});

test("release tags the verified commit explicitly when HEAD moves at tag creation", (t) => {
	const f = fixture(t),
		cwd = f.initialized();
	const parent = f.commit(cwd, "feat: initial");
	const realGit = f.run(cwd, "sh", ["-c", "command -v git"]).stdout.trim();
	const bin = join(f.root, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\nif [ "$1" = tag ] && [ "$2" = -a ] && [ "$3" = raga-v0.1.0 ]; then\n  ${JSON.stringify(realGit)} -c core.hooksPath=/dev/null commit --allow-empty -m "fix: concurrent at tag" >/dev/null || exit 1\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
		{ mode: 0o755 },
	);
	f.env.PATH = `${bin}:${f.env.PATH}`;
	f.ok(cwd, "release");
	const released = f.git(cwd, "rev-parse", "raga-v0.1.0^{commit}");
	assert.equal(f.git(cwd, "show", "-s", "--format=%s", released), "chore(release): raga v0.1.0");
	assert.equal(f.git(cwd, "rev-parse", `${released}^`), parent);
	assert.notEqual(f.git(cwd, "rev-parse", "HEAD"), released);
	assert.match(f.ok(cwd, "release", "--dry-run"), /concurrent at tag/);
});
