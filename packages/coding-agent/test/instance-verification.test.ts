import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledHarnessPath } from "../src/core/instances/bundle.ts";
import { initializeInstance, readInstance } from "../src/core/instances/store.ts";
import {
	BEND_PIN,
	installedBend,
	parseVerificationConfig,
	readVerificationConfig,
	recordVerificationResult,
	runVerification,
	setVerificationEnabled,
	type VerificationRecord,
	verificationActivationProblems,
	verificationPaths,
	verifyPinnedArchive,
} from "../src/core/instances/verification.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const passingResult = { exitCode: 0, stdout: "ALL PROOFS CHECK\n", stderr: "", timedOut: false, aborted: false };

describe("verification layer", () => {
	let temporary: string;
	let project: string;
	let instanceRoot: string;
	let instanceId: string;
	let revision: string;

	beforeEach(async () => {
		temporary = await mkdtemp(join(tmpdir(), "raga-verify-"));
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

	async function writeLaws(
		laws = "import Base\nlaw ok:\n  {1n == 1n : Nat}\n",
		proof = "import ./LAWS.bend as Laws\n",
	) {
		const paths = verificationPaths(instanceRoot);
		await mkdir(paths.directory, { recursive: true });
		await writeFile(join(paths.directory, "LAWS.bend"), laws);
		await writeFile(join(paths.directory, "PROOF.bend"), proof);
	}

	async function installFakeBend(): Promise<string> {
		const paths = verificationPaths(instanceRoot);
		const executable = join(paths.bend, "bend", "bin", "bend");
		await mkdir(join(paths.bend, "bend", "bin"), { recursive: true });
		await writeFile(executable, "fake-bend", { mode: 0o700 });
		await writeFile(
			join(paths.bend, "ready.json"),
			JSON.stringify({
				schemaVersion: 1,
				version: BEND_PIN.version,
				archiveSha256: "0".repeat(64),
				executableSha256: sha256("fake-bend"),
				installedAt: new Date().toISOString(),
			}),
		);
		return `bend@${BEND_PIN.version}:sha256:${sha256("fake-bend")}`;
	}

	it("stays off when the operator never configures it", async () => {
		expect(await readVerificationConfig(instanceRoot)).toBeNull();
		expect(await verificationActivationProblems(instanceRoot, { instanceId, revision })).toEqual([]);
	});

	it("refuses to enable without explicit approval or user-authored files", async () => {
		await expect(setVerificationEnabled(instanceRoot, { approved: false, enabled: true })).rejects.toThrow(
			/explicit approval/,
		);
		await expect(setVerificationEnabled(instanceRoot, { approved: true, enabled: true })).rejects.toThrow(
			/before enabling verification/,
		);
		expect(await readVerificationConfig(instanceRoot)).toBeNull();
	});

	it("enables only after the human writes both files, and leaves them untouched", async () => {
		await writeLaws();
		const config = await setVerificationEnabled(instanceRoot, { approved: true, enabled: true });
		expect(config).toMatchObject({ enabled: true, backend: "bend", laws: "LAWS.bend", proof: "PROOF.bend" });
		const paths = verificationPaths(instanceRoot);
		expect(await readFile(join(paths.directory, "LAWS.bend"), "utf8")).toContain("law ok");
		expect((await readInstance(instanceRoot)).activeRevision).toBe(revision);
	});

	it("blocks activation until a passing record covers the exact revision and files", async () => {
		await writeLaws();
		await setVerificationEnabled(instanceRoot, { approved: true, enabled: true });
		const missing = await verificationActivationProblems(instanceRoot, { instanceId, revision });
		expect(missing.join("\n")).toContain("has no recorded check");

		const toolDigest = await installFakeBend();
		const paths = verificationPaths(instanceRoot);
		const record: VerificationRecord = {
			schemaVersion: 1,
			instanceId,
			revision,
			verdict: "passed",
			command: ["bend", "PROOF.bend"],
			candidate: passingResult,
			lawsDigest: sha256(await readFile(join(paths.directory, "LAWS.bend"), "utf8")),
			proofDigest: sha256(await readFile(join(paths.directory, "PROOF.bend"), "utf8")),
			toolDigest,
			createdAt: new Date().toISOString(),
		};
		await recordVerificationResult(instanceRoot, record);
		expect(await verificationActivationProblems(instanceRoot, { instanceId, revision })).toEqual([]);

		await writeFile(join(paths.directory, "LAWS.bend"), "import Base\nlaw weakened:\n  {1n == 1n : Nat}\n");
		const changed = await verificationActivationProblems(instanceRoot, { instanceId, revision });
		expect(changed.join("\n")).toContain("laws changed since the recorded check");

		await recordVerificationResult(instanceRoot, {
			...record,
			verdict: "failed",
			candidate: { ...passingResult, exitCode: 1, stdout: "SOME PROOFS FAIL\n" },
		});
		expect((await verificationActivationProblems(instanceRoot, { instanceId, revision })).join("\n")).toContain(
			"verdict is failed",
		);
	});

	it("rejects a record for another revision or instance", async () => {
		await writeLaws();
		await setVerificationEnabled(instanceRoot, { approved: true, enabled: true });
		const toolDigest = await installFakeBend();
		await recordVerificationResult(instanceRoot, {
			schemaVersion: 1,
			instanceId: "another-instance",
			revision,
			verdict: "passed",
			command: ["bend", "PROOF.bend"],
			candidate: passingResult,
			lawsDigest: "0".repeat(64),
			proofDigest: "0".repeat(64),
			toolDigest,
			createdAt: new Date().toISOString(),
		});
		const problems = await verificationActivationProblems(instanceRoot, { instanceId, revision });
		expect(problems.join("\n")).toContain("another instance");
	});

	it("reports an installed tool only when its bytes match the readiness record", async () => {
		expect(await installedBend(instanceRoot)).toBeNull();
		const digest = await installFakeBend();
		expect((await installedBend(instanceRoot))?.digest).toBe(digest);
		const paths = verificationPaths(instanceRoot);
		await writeFile(join(paths.bend, "bend", "bin", "bend"), "tampered");
		expect(await installedBend(instanceRoot)).toBeNull();
	});

	it("rejects archives whose checksum does not match the pin", () => {
		expect(() => verifyPinnedArchive(Buffer.from("not bend"), "0".repeat(64))).toThrow(/checksum mismatch/);
		expect(verifyPinnedArchive(Buffer.from("not bend"), sha256("not bend"))).toBe(sha256("not bend"));
	});

	it("validates configuration at the boundary instead of guessing", () => {
		expect(() => parseVerificationConfig({ schemaVersion: 1, enabled: true, laws: "../escape" })).toThrow(
			/Verification config is invalid/,
		);
		expect(() => parseVerificationConfig({ schemaVersion: 1, enabled: true, backend: "coq" })).toThrow(
			/Verification config is invalid/,
		);
		expect(() => parseVerificationConfig({ schemaVersion: 1, enabled: true, extra: 1 })).toThrow(
			/Verification config is invalid/,
		);
		expect(parseVerificationConfig({ schemaVersion: 1, enabled: true })).toMatchObject({
			laws: "LAWS.bend",
			proof: "PROOF.bend",
			timeoutMs: 300_000,
		});
	});

	it("refuses to run without an installed pinned tool", async () => {
		await writeLaws();
		await setVerificationEnabled(instanceRoot, { approved: true, enabled: true });
		await expect(runVerification(instanceRoot, { instanceId, revision })).rejects.toThrow(
			/Install the pinned Bend release/,
		);
	});
});
