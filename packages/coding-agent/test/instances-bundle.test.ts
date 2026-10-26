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
	it("discovers peak as the only skill and keeps every workflow as a reference", async () => {
		const skills = await inspectBundledSkills();
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ name: "peak", source: "pstack" });
		const manifest = JSON.parse(await readFile(join(getBundledHarnessPath(), "bundle.json"), "utf8")) as {
			files: { path: string }[];
		};
		const references = manifest.files.filter((file) =>
			/^skills\/peak\/references\/[^/]+\/SKILL\.md$/.test(file.path),
		);
		expect(references).toHaveLength(62);
		expect(references.map((file) => file.path)).toEqual(
			expect.arrayContaining([
				"skills/peak/references/how/SKILL.md",
				"skills/peak/references/principle-model-the-domain/SKILL.md",
				"skills/peak/references/control-cli/SKILL.md",
				"skills/peak/references/create-skill/SKILL.md",
				"skills/peak/references/no-mistakes/SKILL.md",
				"skills/peak/references/raga-runtime/SKILL.md",
			]),
		);
		expect(references.some((file) => file.path.includes("make-bot-ui"))).toBe(false);
		const peak = await readFile(join(getBundledHarnessPath(), "skills", "peak", "SKILL.md"), "utf8");
		for (const reference of references) {
			const name = reference.path.split("/")[3];
			expect(peak, `peak indexes ${name}`).toContain(`references/${name}/SKILL.md`);
		}
	});

	it("loads copied package assets and rejects changed shipped bytes", async () => {
		const source = getBundledHarnessPath();
		const root = await mkdtemp(join(tmpdir(), "raga-package-"));
		temporary.push(root);
		await cp(source, join(root, "bundled-skills"), { recursive: true });
		process.env.PI_PACKAGE_DIR = root;
		expect(await inspectBundledSkills()).toHaveLength(1);
		await writeFile(
			join(root, "bundled-skills", "skills", "peak", "references", "how", "SKILL.md"),
			"changed package bytes",
		);
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
		manifest.files = manifest.files.filter((entry) => entry.path !== "skills/peak/SKILL.md");
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
			[join(getBundledHarnessPath(), "skills", "peak", "scripts", "check-plan.mjs"), plan],
			{ encoding: "utf8", cwd: root },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('no "## How to read this" section');
		expect(result.stderr).toContain('no "## Program checklist" section');
	});

	it("runs the vendored orchestration CLI and returns an actual help interface", () => {
		const command = join(getBundledHarnessPath(), "skills", "peak", "scripts", "orch", "orch.ts");
		const result = spawnSync(process.execPath, [command, "--help"], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Usage:");
	});

	it("rejects write-capable delegation without supervisor change evidence", () => {
		const root = getBundledHarnessPath();
		const script = `
import asyncio
from pathlib import Path
exec(Path(${JSON.stringify(root)}, "skills/peak/references/raga-runtime/raga_runtime.py").read_text(), globals())
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
