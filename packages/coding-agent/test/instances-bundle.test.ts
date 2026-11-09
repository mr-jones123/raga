import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { render } from "pele";
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
	it("discovers bend, peak, quiz, raga-artifacts, and review and keeps every engineering workflow as a peak reference", async () => {
		const skills = await inspectBundledSkills();
		expect(skills.map((skill) => ({ name: skill.name, source: skill.source }))).toEqual([
			{ name: "bend", source: "raga" },
			{ name: "peak", source: "pstack" },
			{ name: "quiz", source: "raga" },
			{ name: "raga-artifacts", source: "raga" },
			{ name: "review", source: "raga" },
		]);
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
		expect(await inspectBundledSkills()).toHaveLength(5);
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
	it("keeps ordinary-session children read-only and marks their shared checkout", () => {
		const root = getBundledHarnessPath();
		const script = `
import asyncio, os
from pathlib import Path
os.environ.pop("RAGA_INSTANCE_ID", None)
async def read(path):
    return Path(path).read_text()
prompts = []
async def rlm_query(prompt, **options):
    prompts.append((prompt, options))
    return "ok"
exec(Path(${JSON.stringify(root)}, "skills/peak/references/raga-runtime/raga_runtime.py").read_text(), globals())
async def main():
    assert harness_mode() == "ordinary"
    try:
        await run_child("worker", "Change the parser", ${JSON.stringify(root)}, read_only=False, details=True)
    except ValueError as error:
        print(str(error))
    else:
        raise AssertionError("Ordinary writing child launched")
    await run_child("worker", "Review the parser", ${JSON.stringify(root)})
    prompt, options = prompts[-1]
    assert "raga does not enforce read-only access" in prompt
    assert options["read_only"] is True
    os.environ["RAGA_INSTANCE_ID"] = "instance"
    assert harness_mode() == "instance"
    await run_child("worker", "Change the parser", ${JSON.stringify(root)}, read_only=False, details=True)
    prompt, options = prompts[-1]
    assert "raga does not enforce read-only access" not in prompt
    assert options["read_only"] is False and options["details"] is True
asyncio.run(main())
`;
		const result = spawnSync("python3", ["-"], { input: script, encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("no isolated child workspaces");
	});
	it("runs the bend skill helper from the Python REPL and rejects laws moved or changed after approval", async () => {
		const root = await mkdtemp(join(tmpdir(), "raga-bend-skill-"));
		temporary.push(root);
		const fake = join(root, "bend");
		await writeFile(
			fake,
			'#!/bin/sh\nif grep -q TODO "$1"; then echo "SOME PROOFS FAIL"; exit 1; fi\necho "ALL PROOFS CHECK"\n',
			{ mode: 0o755 },
		);
		await writeFile(join(root, "LAWS.bend"), "import Base\nlaw rule:\n  {1n == 1n : Nat}\n");
		await writeFile(join(root, "PROOF.bend"), "import ./LAWS.bend as Laws\n\ndef Laws.rule():\n  {==}\n");
		await writeFile(join(root, "OPEN.bend"), "import ./LAWS.bend as Laws\n?TODO\n");
		await writeFile(join(root, "MOVED.bend"), "import ./LAWS.bend as Laws\nlaw own:\n  {1n == 1n : Nat}\n");
		const helper = join(getBundledHarnessPath(), "skills", "bend", "bend_tool.py");
		const script = `
import asyncio, os
os.environ["BEND_BIN"] = ${JSON.stringify(fake)}
os.environ.pop("RAGA_INSTANCE_ID", None)
async def bash(command, timeout=None):
    process = await asyncio.create_subprocess_shell(command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    output, _ = await process.communicate()
    return output.decode()
exec(open(${JSON.stringify(helper)}).read(), globals())
async def main():
    assert find_bend() == ${JSON.stringify(fake)}
    unapproved = await bend_check(${JSON.stringify(join(root, "PROOF.bend"))})
    assert unapproved["verdict"] == "failed" and "not approved" in unapproved["problems"][0], unapproved
    approve_laws(${JSON.stringify(join(root, "LAWS.bend"))})
    passed = await bend_check(${JSON.stringify(join(root, "PROOF.bend"))})
    assert passed["verdict"] == "passed", passed
    failed = await bend_check(${JSON.stringify(join(root, "OPEN.bend"))})
    assert failed["verdict"] == "failed" and failed["exit_code"] == 1, failed
    moved = await bend_check(${JSON.stringify(join(root, "MOVED.bend"))})
    assert moved["verdict"] == "failed" and moved["exit_code"] == 0, moved
    assert "states a law" in moved["problems"][0], moved
    assert moved["output"].startswith("CHECK REJECTED"), moved
    with open(${JSON.stringify(join(root, "LAWS.bend"))}, "a") as handle:
        handle.write("law weaker:\\n  {0n == 0n : Nat}\\n")
    changed = await bend_check(${JSON.stringify(join(root, "PROOF.bend"))})
    assert changed["verdict"] == "failed" and "approved" in changed["problems"][0], changed
    with open(${JSON.stringify(join(root, "LAWS.bend"))}, "w") as handle:
        handle.write("import Base\\nlaw vacuous:\\n  for n: Nat\\n  {1n == 1n : Nat}\\n")
    approve_laws(${JSON.stringify(join(root, "LAWS.bend"))})
    vacuous = await bend_check(${JSON.stringify(join(root, "PROOF.bend"))})
    assert vacuous["problems"] == ["law vacuous never uses its variable n"], vacuous
    assert law_files(${JSON.stringify(root)})["directory"].endswith(".raga/verification")
    os.environ["RAGA_INSTANCE_ID"] = "instance"
    assert law_files(${JSON.stringify(root)})["directory"].endswith("verification-draft")
    print("ok")
asyncio.run(main())
`;
		const result = spawnSync("python3", ["-"], { input: script, encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("ok");
	});
	it("builds an artifact template into static HTML with Pele diagrams and rejects unsafe sources", async () => {
		const root = await mkdtemp(join(tmpdir(), "raga-artifact-"));
		temporary.push(root);
		const skill = join(getBundledHarnessPath(), "skills", "raga-artifacts");
		const build = (source: string) =>
			spawnSync(process.execPath, [join(skill, "artifact.mjs"), "build", source, "--no-pdf"], { encoding: "utf8" });

		const deck = join(root, "deck.html");
		await cp(join(skill, "templates", "slides.html"), deck);
		const built = build(deck);
		expect(built.status, built.stdout + built.stderr).toBe(0);
		const result = JSON.parse(built.stdout) as { ok: boolean; html: string; diagrams: number; slides: number };
		expect(result).toMatchObject({ ok: true, diagrams: 1, slides: 3 });
		const html = await readFile(result.html, "utf8");
		expect(html).toContain('class="pele pele-flowchart"');
		expect(html).not.toContain('class="mermaid"');

		const unsafe = join(root, "unsafe.html");
		await writeFile(
			unsafe,
			'<section class="slide"><script>alert(1)</script><pre class="mermaid">flowchart LR\n A --> </pre><img src="https://example.com/x.png"></section>',
		);
		const rejected = build(unsafe);
		expect(rejected.status).toBe(1);
		const problems = (JSON.parse(rejected.stdout) as { problems: string[] }).problems.join("\n");
		expect(problems).toContain("<script>");
		expect(problems).toContain("Diagram 1");
		expect(problems).toContain("is remote");
	});

	it.skipIf(
		![
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
		].some(existsSync),
	)(
		"prints a slide deck to one PDF page per slide and reports a slide that overflows",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "raga-artifact-pdf-"));
			temporary.push(root);
			const skill = join(getBundledHarnessPath(), "skills", "raga-artifacts");
			const template = await readFile(join(skill, "templates", "slides.html"), "utf8");
			const deck = join(root, "deck.html");
			await writeFile(
				deck,
				template.replace("<li>One idea per bullet", `<li>${"Too much text. ".repeat(600)}One idea per bullet`),
			);
			const built = spawnSync(process.execPath, [join(skill, "artifact.mjs"), "build", deck], { encoding: "utf8" });
			expect(built.status, built.stdout + built.stderr).toBe(0);
			const result = JSON.parse(built.stdout) as { pages: number; layout: string[]; pdf: string };
			expect(result.pages).toBe(3);
			expect(result.layout).toEqual([expect.stringMatching(/^Slide 2 overflows its frame by \d+px/)]);
			expect((await readFile(result.pdf)).subarray(0, 5).toString()).toBe("%PDF-");
		},
		60000,
	);
	it("renders every diagram example the raga-artifacts skill documents with the pinned Pele", async () => {
		const skill = join(getBundledHarnessPath(), "skills", "raga-artifacts");
		const examples = [
			...(await readFile(join(skill, "diagrams.md"), "utf8")).matchAll(
				/^## (.+)\n[\s\S]*?```mermaid\n([\s\S]*?)```/gm,
			),
		];
		expect(examples).toHaveLength(32);
		const table = await readFile(join(skill, "SKILL.md"), "utf8");
		for (const [, name, source] of examples) {
			expect(table, `SKILL.md lists ${name}`).toContain(`| ${name} |`);
			expect(() => render(source), name).not.toThrow();
		}
	});
});
