#!/usr/bin/env node
/**
 * Builds the `raga-cli` npm package from the coding-agent bundle and packs it into a tarball.
 * It never publishes. See docs/RELEASING.md.
 *
 *   node scripts/raga-pack.mjs [--skip-build] [--allow-unreleased]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PACKAGE_NAME = "raga-cli";
/** Packages the bundle loads at runtime instead of inlining. See build-coding-agent-bundle.mjs. */
const RUNTIME_DEPENDENCIES = ["@silvia-odwyer/photon-node", "jiti", "quickjs-wasi"];

const { values } = parseArgs({
	options: {
		"skip-build": { type: "boolean", default: false },
		"allow-unreleased": { type: "boolean", default: false },
	},
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(repoRoot, "packages", "coding-agent");
const outDir = join(agentDir, "dist", PACKAGE_NAME);
const run = (command, args, cwd = repoRoot) =>
	execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const version = run(process.execPath, [join(repoRoot, "scripts", "raga-release.mjs"), "version"]);
const released = /^\d+\.\d+\.\d+$/.test(version);
if (!released && !values["allow-unreleased"]) {
	console.error(
		`HEAD is not a raga release (version ${version}). Commit or check out a raga-v* tag, or pass --allow-unreleased for a local test pack.`,
	);
	process.exit(1);
}

if (!values["skip-build"]) execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
if (!existsSync(join(agentDir, "dist", "bundle", "raga.js"))) {
	console.error("Missing packages/coding-agent/dist/bundle/raga.js. Run `npm run build` first.");
	process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const copy = (from, to = relative(agentDir, from), filter) =>
	cpSync(from, join(outDir, to), { recursive: true, ...(filter ? { filter } : {}) });

copy(join(agentDir, "dist", "bundle"));
copy(join(agentDir, "dist", "modes", "interactive", "theme"), undefined, (source) => /(theme|\.json)$/.test(source));
copy(join(agentDir, "dist", "modes", "interactive", "assets"));
copy(join(agentDir, "dist", "core", "export-html"), undefined, (source) =>
	/(export-html|vendor)$|template\.(html|css|js)$|vendor[\\/][^\\/]+\.js$/.test(source),
);
copy(join(agentDir, "docs"));
copy(join(agentDir, "examples"));
copy(join(agentDir, "schemas"));
copy(join(agentDir, "bundled-skills"));
copy(join(agentDir, "python", "raga_rlm"), undefined, (source) => !/__pycache__|\.pyc$/.test(source));
copy(join(repoRoot, "README.md"), "README.md");
copy(join(repoRoot, "CHANGELOG.md"), "CHANGELOG.md");
copy(join(repoRoot, "LICENSE"), "LICENSE");

const agentManifest = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));
const manifest = {
	name: PACKAGE_NAME,
	version,
	description: "Raga, a coding agent for long tasks with a persistent Python kernel (a fork of pi)",
	type: "module",
	license: agentManifest.license,
	repository: { type: "git", url: "git+https://github.com/mr-jones123/raga.git" },
	bin: { raga: "dist/bundle/raga.js" },
	engines: agentManifest.engines,
	dependencies: Object.fromEntries(
		RUNTIME_DEPENDENCIES.map((name) => {
			const pinned = agentManifest.dependencies[name];
			if (!pinned) throw new Error(`packages/coding-agent/package.json does not pin ${name}`);
			return [name, pinned];
		}),
	),
};
writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

const tarball = join(dirname(outDir), run("npm", ["pack", "--pack-destination", dirname(outDir)], outDir));
console.log(`\nPacked ${relative(repoRoot, tarball)} (${PACKAGE_NAME}@${version})`);
if (released) {
	console.log(`Publish it with: npm publish ${relative(repoRoot, tarball)}`);
} else {
	console.log("Unreleased version: test it with `npm install -g <tarball>`, but do not publish it.");
}
