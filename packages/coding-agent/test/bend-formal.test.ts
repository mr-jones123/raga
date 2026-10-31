import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBendDraft } from "../src/core/instances/bend-formal.ts";

describe("bend draft parsing", () => {
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
		expect(unlabeled.parsed).toBe(true);
		const missing = parseBendDraft("no code here");
		expect(missing.parsed).toBe(false);
		expect(missing.laws).toBe("");
		expect(missing.notes).toContain("no code here");
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
