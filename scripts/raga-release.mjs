import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TYPES = new Set(["feat", "fix", "perf", "revert", "refactor", "docs", "test", "build", "ci", "chore", "style"]);
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s]+)\))?(?<bang>!)?: (?<text>\S.*)$/;
const USAGE = "Usage: node scripts/raga-release.mjs version | lint-msg <file>";

export function parseVersion(text) {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(text)) {
		throw new Error(`invalid version: ${text}`);
	}
	const [major, minor, patch] = text.split(".").map(Number);
	if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`invalid version: ${text}`);
	return { major, minor, patch };
}

export function lintMessage(text, { merging = false } = {}) {
	const subject = text
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("#"))
		.join("\n")
		.trim()
		.split("\n")[0];
	if (
		(merging && /^Merge .+/.test(subject)) ||
		/^(fixup!|squash!|amend!) .+/.test(subject) ||
		/^(Revert|Reapply) ".+"$/.test(subject)
	)
		return [];
	const match = HEADER.exec(subject);
	const reason = !match
		? "expected a conventional commit header"
		: !TYPES.has(match.groups.type)
			? `unknown commit type ${match.groups.type}`
			: null;
	return reason ? [`${reason}: ${subject || "(empty message)"}`] : [];
}

export function lintStagedPaths(paths) {
	return paths
		.filter((path) => /^packages\/[^/]+\/CHANGELOG\.md$/.test(path))
		.map((path) => `upstream-owned changelog must not be staged: ${path}`);
}

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

export function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
	const [command, ...args] = argv;
	if (
		!(command === "version" && args.length === 0) &&
		!(command === "lint-msg" && args.length === 1 && !args[0].startsWith("-"))
	) {
		stderr.write(`${USAGE}\n`);
		return 2;
	}
	try {
		const messagePath = command === "lint-msg" ? resolve(cwd, args[0]) : null;
		cwd = git(cwd, ["rev-parse", "--show-toplevel"]);
		if (command === "lint-msg") {
			const merging = existsSync(resolve(cwd, git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"])));
			const errors = lintMessage(readFileSync(messagePath, "utf8"), { merging });
			if (!merging)
				errors.push(
					...lintStagedPaths(
						git(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z"]).split("\0").filter(Boolean),
					),
				);
			for (const error of errors) stderr.write(`${error}\n`);
			return errors.length ? 1 : 0;
		}
		// Both semantic-release's lightweight tags and historical annotated tags are releases.
		const tags = git(cwd, ["tag", "--merged", "HEAD", "--list", "raga-v*"])
			.split("\n")
			.filter(Boolean)
			.map((tag) => ({ tag, version: parseVersion(tag.slice(6)) }))
			.sort(
				(a, b) =>
					b.version.major - a.version.major ||
					b.version.minor - a.version.minor ||
					b.version.patch - a.version.patch,
			);
		const current = tags[0];
		if (!current) throw new Error("no reachable raga version tag (raga-vX.Y.Z)");
		const count = git(cwd, ["rev-list", "--first-parent", "--count", `${current.tag}..HEAD`]);
		const suffix = count === "0" ? "" : `+${count}.g${git(cwd, ["rev-parse", "HEAD"]).slice(0, 7)}`;
		stdout.write(`${current.tag.slice(6)}${suffix}\n`);
		return 0;
	} catch (error) {
		stderr.write(`${error.message}\n`);
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exit(main(process.argv.slice(2)));
}
