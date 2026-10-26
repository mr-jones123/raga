import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkBendFormal,
	parseBendDraft,
	scaffoldBendFiles,
	writeBendDraft,
} from "../src/core/instances/bend-formal.ts";
import { getBundledHarnessPath } from "../src/core/instances/bundle.ts";
import { initializeInstance, readInstance } from "../src/core/instances/store.ts";
import { verificationPaths } from "../src/core/instances/verification.ts";

describe("bend formal", () => {
	let temporary: string;
	let project: string;
	let instanceRoot: string;
	let instanceId: string;
	let revision: string;

	beforeEach(async () => {
		temporary = await mkdtemp(join(tmpdir(), "raga-bend-formal-"));
		project = join(temporary, "project");
		await mkdir(project);
		const manifest = await initializeInstance(project, { harnessSource: getBundledHarnessPath() });
		instanceRoot = join(project, ".raga");
		instanceId = manifest.id;
		revision = manifest.activeRevision;
	});

	afterEach(async () => {
		await rm(temporary, { recursive: true, force: true });
	});

	it("scaffolds both files once and never overwrites a human edit", async () => {
		const first = await scaffoldBendFiles(instanceRoot);
		expect(first.created).toEqual(["LAWS.bend", "PROOF.bend"]);
		const paths = verificationPaths(instanceRoot);
		await writeFile(join(paths.directory, "LAWS.bend"), "import Base\nlaw mine:\n  {1n == 1n : Nat}\n");
		const second = await scaffoldBendFiles(instanceRoot);
		expect(second.created).toEqual([]);
		expect(await readFile(join(paths.directory, "LAWS.bend"), "utf8")).toContain("law mine");
	});

	it("parses labeled and unlabeled drafts", () => {
		const labeled = parseBendDraft(
			[
				"notes",
				"```bend laws",
				"import Base\nlaw a:",
				"  {1n == 1n : Nat}",
				"```",
				"```bend proof",
				"import ./LAWS.bend as Laws",
				"```",
			].join("\n"),
		);
		expect(labeled.laws).toContain("law a");
		expect(labeled.proof).toContain("Laws");
		const unlabeled = parseBendDraft(["```bend", "import Base", "```"].join("\n"));
		expect(unlabeled.laws).toBe("import Base");
		expect(unlabeled.proof).toContain("LAWS.bend");
		expect(() => parseBendDraft("no code here")).toThrow(/no Bend laws block/);
	});

	it("saves drafts only with approval, and refuses silent replacement", async () => {
		const draft = { laws: "import Base\nlaw a:\n  {1n == 1n : Nat}", proof: "import ./LAWS.bend as Laws", notes: "" };
		await expect(writeBendDraft(instanceRoot, draft, { approved: false, overwrite: true })).rejects.toThrow(
			/explicit approval/,
		);
		await writeBendDraft(instanceRoot, draft, { approved: true, overwrite: true });
		await expect(writeBendDraft(instanceRoot, draft, { approved: true, overwrite: false })).rejects.toThrow(
			/already exists/,
		);
		await writeBendDraft(instanceRoot, { ...draft, laws: "import Base\n" }, { approved: true, overwrite: true });
		const paths = verificationPaths(instanceRoot);
		expect(await readFile(join(paths.directory, "LAWS.bend"), "utf8")).toContain("import Base");
	});

	it("refuses to check before the pinned tool is installed", async () => {
		await scaffoldBendFiles(instanceRoot);
		await expect(
			checkBendFormal(instanceRoot, { instanceId, revision, install: false, network: false, enable: true }),
		).rejects.toThrow(/not installed/);
		expect((await readInstance(instanceRoot)).activeRevision).toBe(revision);
	});
});

describe("raga executable", () => {
	const sourceResolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
	const entry = fileURLToPath(new URL("../src/raga.ts", import.meta.url));
	const run = (...args: string[]) =>
		execFileSync(process.execPath, ["--import", sourceResolver, entry, ...args], {
			encoding: "utf8",
			env: { ...process.env, PI_OFFLINE: "1" },
		});

	it("presents instance commands without the instance level", () => {
		const help = run("--help");
		expect(help).toContain("Usage: raga COMMAND");
		expect(help).not.toContain("pi instance");
	});

	it("reports usage errors under the raga name", () => {
		let error: { status?: number; stderr?: string } | undefined;
		try {
			run("status", "--project", join(tmpdir(), `raga-missing-${Date.now()}`));
		} catch (caught) {
			error = caught as { status?: number; stderr?: string };
		}
		expect(error?.status).toBe(1);
		expect(error?.stderr).toContain("raga:");
	});
});
