import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./check-ts-relative-imports.mjs", import.meta.url));

test("import validation ignores generated caches but checks new source and tracked ignored source", () => {
	const root = mkdtempSync(join(tmpdir(), "raga-import-check-"));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	try {
		const initialized = spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root, env, encoding: "utf8" });
		assert.equal(initialized.status, 0, initialized.stderr);
		writeFileSync(join(root, ".gitignore"), ".cache/\n");
		writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
		mkdirSync(join(root, ".cache"));
		writeFileSync(join(root, ".cache/bad.ts"), 'import "./missing.js";\n');
		const ignored = spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8", timeout: 30000 });
		assert.equal(ignored.status, 0, ignored.stderr);
		writeFileSync(join(root, "new.ts"), 'import "./missing.js";\n');
		const untracked = spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8", timeout: 30000 });
		assert.equal(untracked.status, 1, untracked.stderr);
		assert.match(untracked.stderr, /new\.ts:/);
		rmSync(join(root, "new.ts"));
		const staged = spawnSync("git", ["add", "--force", "--", ".cache/bad.ts"], { cwd: root, env, encoding: "utf8" });
		assert.equal(staged.status, 0, staged.stderr);
		const tracked = spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8", timeout: 30000 });
		assert.equal(tracked.status, 1, tracked.stderr);
		assert.match(tracked.stderr, /\.cache\/bad\.ts:/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
