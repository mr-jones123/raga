import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBundledHarnessPath, inspectBundledSkills } from "../src/core/instances/bundle.ts";

const temporary: string[] = [];
const packageOverride = process.env.PI_PACKAGE_DIR;
afterEach(async () => {
	if (packageOverride === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = packageOverride;
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("portable default harness", () => {
	it("discovers the complete portable inventory with the native skill loader", async () => {
		const skills = await inspectBundledSkills();
		expect(skills).toHaveLength(63);
		expect(skills.filter((skill) => skill.source === "pstack")).toHaveLength(56);
		expect(skills.filter((skill) => skill.source === "cursor-team-kit")).toHaveLength(4);
		expect(skills.filter((skill) => skill.name.startsWith("principle-"))).toHaveLength(24);
		expect(skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining([
				"poteto-mode",
				"how",
				"architect",
				"swarm",
				"control-cli",
				"control-ui",
				"create-skill",
				"no-mistakes",
				"raga-runtime",
			]),
		);
		expect(skills.some((skill) => skill.name === "make-bot-ui" || skill.name === "pstack-omp")).toBe(false);
	});

	it("loads copied package assets and rejects changed shipped bytes", async () => {
		const source = getBundledHarnessPath();
		const root = await mkdtemp(join(tmpdir(), "raga-package-"));
		temporary.push(root);
		await cp(source, join(root, "bundled-skills"), { recursive: true });
		process.env.PI_PACKAGE_DIR = root;
		expect(await inspectBundledSkills()).toHaveLength(63);
		await writeFile(join(root, "bundled-skills", "skills", "how", "SKILL.md"), "changed package bytes");
		await expect(inspectBundledSkills()).rejects.toThrow(/checksum mismatch/);
	});

	it("rejects executable assets absent from the shipped manifest", async () => {
		const root = await mkdtemp(join(tmpdir(), "raga-package-"));
		temporary.push(root);
		await cp(getBundledHarnessPath(), join(root, "bundled-skills"), { recursive: true });
		process.env.PI_PACKAGE_DIR = root;
		await writeFile(join(root, "bundled-skills", "unexpected.mjs"), "process.exit(0)");
		await expect(inspectBundledSkills()).rejects.toThrow(/Unmanifested/);
	});

	it("rejects a skill declaration whose content has no checksum", async () => {
		const root = await mkdtemp(join(tmpdir(), "raga-package-"));
		temporary.push(root);
		await cp(getBundledHarnessPath(), join(root, "bundled-skills"), { recursive: true });
		process.env.PI_PACKAGE_DIR = root;
		const path = join(root, "bundled-skills", "bundle.json");
		const manifest = JSON.parse(await readFile(path, "utf8")) as { files: { path: string }[] };
		manifest.files = manifest.files.filter((entry) => entry.path !== "skills/how/SKILL.md");
		await writeFile(path, JSON.stringify(manifest));
		await expect(inspectBundledSkills()).rejects.toThrow(/missing its asset checksum/);
	});

	it("resolves every shipped local Markdown link as a bundle artifact contract", async () => {
		const root = getBundledHarnessPath();
		const manifest = JSON.parse(await readFile(join(root, "bundle.json"), "utf8")) as { files: { path: string }[] };
		for (const file of manifest.files.filter((file) => file.path.endsWith(".md"))) {
			const text = await readFile(join(root, file.path), "utf8");
			for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				const href = match[1].split("#")[0];
				if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) continue;
				const path = resolve(root, dirname(file.path), decodeURIComponent(href));
				const readable = await readFile(path).then(
					() => true,
					(error: NodeJS.ErrnoException) => error.code === "EISDIR",
				);
				expect(readable, `${file.path} links to ${href}`).toBe(true);
			}
		}
	});

	it("runs the shipped plan checker without an external editor or npm installation", async () => {
		const root = await mkdtemp(join(tmpdir(), "raga-plan-"));
		temporary.push(root);
		const plan = join(root, "plan.md");
		await writeFile(plan, "# Small plan\n\n## Goal\n\nComplete the parser migration.\n");
		const result = spawnSync(
			process.execPath,
			[join(getBundledHarnessPath(), "skills", "poteto-mode", "scripts", "check-plan.mjs"), plan],
			{ encoding: "utf8", cwd: root },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('no "## How to read this" section');
		expect(result.stderr).toContain('no "## Program checklist" section');
	});

	it("runs the vendored orchestration CLI and returns an actual help interface", () => {
		const command = join(getBundledHarnessPath(), "skills", "poteto-mode", "scripts", "orch", "orch.ts");
		const result = spawnSync(process.execPath, [command, "--help"], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Usage:");
	});

	it("rejects write-capable delegation without supervisor change evidence", () => {
		const root = getBundledHarnessPath();
		const script = `
import asyncio
from pathlib import Path
exec(Path(${JSON.stringify(root)}, "skills/raga-runtime/raga_runtime.py").read_text(), globals())
async def main():
    try:
        await run_child("worker", "Change the parser", ${JSON.stringify(root)}, read_only=False)
    except ValueError as error:
        print(str(error))
    else:
        raise AssertionError("Writing child launched without change evidence")
asyncio.run(main())
`;
		const result = spawnSync("python3", ["-"], { input: script, encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("details=True");
	});
});
