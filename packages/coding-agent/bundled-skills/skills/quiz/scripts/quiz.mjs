#!/usr/bin/env node
// Build a change report + quiz page from a spec. Diffs come from git, never from the spec.
// Usage: node quiz.mjs <spec.json> [-o out.html] [--repo dir] [--no-open]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_LINES = 400;
const GENERATED = [/package-lock\.json$/, /\.generated\.ts$/, /(^|\/)schemas\/[^/]+\.json$/, /\.lock$/];

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv.splice(i, 2)[1];
};
const out = flag("-o");
const repo = resolve(flag("--repo") ?? process.cwd());
const noOpen = argv.includes("--no-open");
const specPath = argv.find((a) => !a.startsWith("--"));
if (!specPath) die("usage: quiz.mjs <spec.json> [-o out.html] [--repo dir] [--no-open]");

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
const errors = [];

function parseDiff(text) {
	const files = [];
	let file, hunk, o, n;
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
			file = { path: m?.[2] ?? line, oldPath: m?.[1], status: "modified", add: 0, del: 0, hunks: [] };
			files.push(file);
			hunk = undefined;
		} else if (!file) continue;
		else if (!hunk && line.startsWith("new file mode")) file.status = "added";
		else if (!hunk && line.startsWith("deleted file mode")) file.status = "deleted";
		else if (!hunk && line.startsWith("rename from")) file.status = "renamed";
		else if (!hunk && line.startsWith("Binary files")) file.status = "binary";
		else if (line.startsWith("@@")) {
			const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
			o = Number(m[1]);
			n = Number(m[2]);
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
		} else if (hunk && (line[0] === "+" || line[0] === "-" || line[0] === " ")) {
			const t = line[0];
			hunk.lines.push({ t, s: line.slice(1), o: t === "+" ? null : o++, n: t === "-" ? null : n++ });
			if (t === "+") file.add++;
			if (t === "-") file.del++;
		}
	}
	return files;
}

const commits = (spec.commits ?? []).map((c, ci) => {
	const [sha, subject, author, date, body] = git("show", "-s", "--format=%H%x00%s%x00%an%x00%ad%x00%b", "--date=short", c.sha).split("\0");
	const files = parseDiff(git("show", "--format=", "--no-color", "-M", c.sha));
	const type = subject.match(/^(\w+)(\(([^)]*)\))?(!)?:/);
	let pin = 0;
	for (const note of c.notes ?? []) {
		const file = files.find((f) => f.path === note.file || f.path.endsWith(`/${note.file}`));
		const line = file?.hunks.flatMap((h) => h.lines).sort((a, b) => (b.t === "+") - (a.t === "+")).find((l) => l.s.includes(note.match));
		if (!line) {
			errors.push(`commits[${ci}] ${c.sha}: note "${note.match}" not found in ${note.file}`);
			continue;
		}
		line.pin = ++pin;
		line.note = note.text;
		file.pinned = true;
	}
	for (const f of files) {
		const total = f.hunks.reduce((s, h) => s + h.lines.length, 0);
		if (f.status === "deleted" || GENERATED.some((r) => r.test(f.path))) {
			f.collapsed = f.status === "deleted" ? "deleted" : "generated";
			f.hunks = [];
		} else if (total > MAX_FILE_LINES && !f.pinned) {
			f.truncated = total;
			let left = MAX_FILE_LINES;
			f.hunks = f.hunks.filter((h) => (left -= h.lines.length) + h.lines.length > 0);
		}
	}
	return {
		sha,
		short: sha.slice(0, 9),
		subject,
		type: type?.[1] ?? "change",
		scope: type?.[3] ?? "",
		author,
		date,
		upstream: body.match(/cherry picked from commit ([0-9a-f]{7,40})/)?.[1]?.slice(0, 9),
		what: c.what ?? "",
		why: c.why ?? "",
		files,
	};
});

const shas = new Set(commits.flatMap((c) => [c.sha, c.short]));
(spec.quiz ?? []).forEach((q, i) => {
	if (!q.q || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) errors.push(`quiz[${i}]: needs q and 2-6 options`);
	if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= (q.options?.length ?? 0)) errors.push(`quiz[${i}]: answer must index options`);
	if (!q.explain) errors.push(`quiz[${i}]: needs explain`);
	const see = q.see?.split("#")[0];
	if (see && ![...shas].some((s) => s.startsWith(see) || see.startsWith(s))) errors.push(`quiz[${i}]: see "${q.see}" is not a commit in this report`);
});
if (!commits.length) errors.push("spec.commits is empty");
if ((spec.quiz ?? []).length < 3) errors.push("spec.quiz needs at least 3 questions");
if (errors.length) die(`✗ ${errors.length} error(s) in the spec\n${errors.map((e) => `  ${e}`).join("\n")}`);

const today = new Date().toLocaleDateString("sv");
const data = {
	title: spec.title ?? "Change report",
	lead: spec.lead ?? "",
	repo: basename(repo),
	branch: git("rev-parse", "--abbrev-ref", "HEAD").trim(),
	range: spec.range ?? `${commits.at(0).short}..${commits.at(-1).short}`,
	pass: spec.pass ?? 80,
	generated: new Date().toLocaleString("sv").slice(0, 16),
	commits,
	quiz: spec.quiz,
};
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "../assets/template.html"), "utf8")
	.replace("__TITLE__", escapeHtml(data.title))
	.replace("__DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c"));
const target = resolve(out ?? join(homedir(), ".quiz/pages", `${data.repo}-${today}-${slug(data.title)}.html`));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, html);
const files = commits.reduce((s, c) => s + c.files.length, 0);
console.log(`✓ ${target}\n  ${commits.length} commits · ${files} files · ${data.quiz.length} questions · pass ${data.pass}%`);
if (!noOpen) execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [target]);

function slug(s) {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "report";
}
function escapeHtml(s) {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function die(msg) {
	console.error(msg);
	process.exit(1);
}
