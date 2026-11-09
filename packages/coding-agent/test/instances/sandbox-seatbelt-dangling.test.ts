import { symlinkSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkSandbox } from "../../src/core/instances/sandbox.ts";

describe.runIf(process.platform === "darwin")("Seatbelt probe with a dangling credential symlink", () => {
	const originalHome = process.env.HOME;
	let home: string | undefined;

	afterAll(async () => {
		process.env.HOME = originalHome;
		if (home) await rm(home, { recursive: true, force: true });
	});

	it("stays available when ~/.npmrc is a dangling symlink", async () => {
		home = await realpath(await mkdtemp(join(tmpdir(), "raga-seatbelt-home-")));
		symlinkSync("missing", join(home, ".npmrc"));
		process.env.HOME = home;
		expect(await checkSandbox("writes")).toEqual({ available: true });
	});
});
