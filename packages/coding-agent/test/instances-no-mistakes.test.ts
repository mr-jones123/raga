import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getNoMistakesBackend,
	interpretNoMistakesResult,
	NO_MISTAKES_PIN,
	NoMistakesBackend,
	noMistakesRunPolicy,
} from "../src/core/instances/no-mistakes.ts";
import type { CommandResult } from "../src/core/instances/types.ts";

const temporary: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ project: string; backend: NoMistakesBackend }> {
	const project = await mkdtemp(join(tmpdir(), "raga-gate-"));
	temporary.push(project);
	return { project, backend: new NoMistakesBackend({ instanceRoot: join(project, ".raga"), projectRoot: project }) };
}

function command(stdout: string, exitCode = 0): CommandResult {
	return { exitCode, stdout, stderr: "", timedOut: false, aborted: false };
}

describe("managed no-mistakes authorization", () => {
	it("requires explicit network permission and preserves the user's entire intent", () => {
		const intent = "Implement the parser.\nDo not change the wire format or drop error diagnostics.";
		expect(() => noMistakesRunPolicy(intent)).toThrow(/approval/);
		const policy = noMistakesRunPolicy(intent, { network: true });
		expect(policy.skipped).toEqual(["push", "pr", "ci"]);
		expect(policy.args).toEqual([
			"axi",
			"run",
			"--intent",
			intent,
			"--wait",
			"8m",
			"--no-publish-intent",
			"--skip",
			"push,pr,ci",
		]);
	});

	it("does not let PR or CI authorization imply push permission", () => {
		expect(() => noMistakesRunPolicy("Validate", { network: true, pr: true })).toThrow(/push authorization/);
		expect(() => noMistakesRunPolicy("Validate", { network: true, ci: true })).toThrow(/push and PR/);
		expect(noMistakesRunPolicy("Validate", { network: true, push: true }).skipped).toEqual(["pr", "ci"]);
		expect(
			noMistakesRunPolicy("Validate", { network: true, push: true, pr: true, ci: true, yes: true }).args,
		).toContain("--yes");
	});

	it("reports first-use prerequisites without creating backend directories", async () => {
		const { project, backend } = await fixture();
		const inspection = await backend.inspect();
		expect(inspection).toMatchObject({ installed: false, enabled: false, version: "1.84.0" });
		expect(inspection.prerequisites.length).toBeGreaterThan(0);
		await expect(stat(join(project, ".raga"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects missing lifecycle and network approvals without provisioning or executing", async () => {
		const { project, backend } = await fixture();
		await expect(backend.provision({ approved: false } as never)).rejects.toThrow(/approval/);
		await expect(backend.enable({ approved: true, network: false } as never)).rejects.toThrow(/approval/);
		await expect(backend.start({ approved: false } as never)).rejects.toThrow(/approval/);
		await expect(backend.stop({ approved: false } as never)).rejects.toThrow(/approval/);
		await expect(backend.respond({ action: "approve", approved: false } as never)).rejects.toThrow(/approval/);
		await expect(backend.run({ intent: "Validate" })).rejects.toThrow(/approval/);
		await expect(stat(join(project, ".raga"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses backend state redirected outside its managed instance", async () => {
		const { project, backend } = await fixture();
		const external = join(project, "operator-state");
		await mkdir(external);
		await mkdir(dirname(backend.root), { recursive: true });
		await symlink(external, backend.root);
		const inspection = await backend.inspect();
		expect(inspection.installed).toBe(false);
		expect(inspection.prerequisites.join(" ")).toContain("symlinks");
		await expect(backend.stop({ approved: true })).rejects.toThrow(/symlinks/);
	});

	it("rejects a downloaded archive whose bytes do not match the recorded release digest", async () => {
		const { backend } = await fixture();
		const download = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("not the pinned archive"));
		await expect(backend.provision({ approved: true })).rejects.toThrow(/checksum mismatch/);
		expect(String(download.mock.calls[0][0])).toContain("/releases/download/v1.84.0/");
		await expect(stat(backend.executable)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(backend.provision({ approved: true })).rejects.toThrow(/checksum mismatch/);
	});

	it("never executes an unverified cached executable", async () => {
		const { project, backend } = await fixture();
		await mkdir(dirname(backend.executable), { recursive: true });
		await writeFile(join(dirname(backend.executable), "asset.tar.gz"), "changed archive");
		const marker = join(project, "was-executed");
		await writeFile(backend.executable, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
		expect((await backend.inspect()).installed).toBe(false);
		await expect(backend.status()).rejects.toThrow(/provision/);
		await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses nested provisioning, execution, and lifecycle control before making writes", async () => {
		const { project, backend } = await fixture();
		vi.stubEnv("NO_MISTAKES_GATE", "1");
		await expect(backend.provision({ approved: true })).rejects.toThrow(/nested_gate_context/);
		await expect(backend.run({ intent: "Validate", approval: { network: true } })).rejects.toThrow(
			/nested_gate_context/,
		);
		await expect(backend.stop({ approved: true })).rejects.toThrow(/nested_gate_context/);
		await expect(stat(join(project, ".raga"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not permit explicit credentials to override the managed home or service policy", () => {
		expect(
			() =>
				new NoMistakesBackend({
					instanceRoot: "/tmp/instance",
					projectRoot: "/tmp/project",
					environment: { HOME: "/home/operator" },
				}),
		).toThrow(/managed variable/);
		expect(
			() =>
				new NoMistakesBackend({
					instanceRoot: "/tmp/instance",
					projectRoot: "/tmp/project",
					environment: { NM_TEST_START_DAEMON: "0" },
				}),
		).toThrow(/managed variable/);
	});

	it("resolves only the explicitly persisted adapter and project binding", async () => {
		const { project, backend } = await fixture();
		const executable = join(project, "approved-agent");
		const bytes = "#!/bin/sh\nexit 0\n";
		await writeFile(executable, bytes, { mode: 0o700 });
		await mkdir(backend.root, { recursive: true });
		await writeFile(
			join(backend.root, "enabled.json"),
			JSON.stringify({
				schemaVersion: 1,
				projectRoot: project,
				version: NO_MISTAKES_PIN.version,
				agentExecutable: executable,
				agentVersion: "test-agent-1",
				agentArgs: [],
				agentHash: createHash("sha256").update(bytes).digest("hex"),
			}),
		);
		expect((await (await getNoMistakesBackend(join(project, ".raga"), project)).inspect()).enabled).toBe(true);
		expect((await backend.inspect()).enabled).toBe(true);
		const wrongProject = await mkdtemp(join(tmpdir(), "raga-other-project-"));
		temporary.push(wrongProject);
		const wrongBinding = await getNoMistakesBackend(join(project, ".raga"), wrongProject);
		expect((await wrongBinding.inspect()).enabled).toBe(false);
		await writeFile(executable, "changed agent bytes");
		const inspection = await (await getNoMistakesBackend(join(project, ".raga"), project)).inspect();
		expect(inspection.enabled).toBe(false);
		expect(inspection.prerequisites.join(" ")).toContain("enable again");
	});
});

describe("AXI result reporting", () => {
	it("returns approval gates without interpreting exit zero as a pass", () => {
		const result = interpretNoMistakesResult(
			command("run:\n  id: abc\ngate:\n  step: review\n  status: awaiting_approval\n"),
		);
		expect(result.state).toBe("gate");
		expect(result.fullyVerified).toBe(false);
	});

	it.each(["passed-with-skips", "passed-with-override", "ci-monitor-interrupted", "new-unknown-outcome"])(
		"keeps %s distinct from a verified pass",
		(outcome) => {
			const result = interpretNoMistakesResult(command(`outcome: ${outcome}\n`));
			expect(result.state).toBe("inconclusive");
			expect(result.outcome).toBe(outcome);
			expect(result.fullyVerified).toBe(false);
		},
	);

	it("retains default publication skips even after a requested-steps pass", () => {
		const result = interpretNoMistakesResult(command("outcome: passed\n"), ["push", "pr", "ci"]);
		expect(result).toMatchObject({ state: "passed", fullyVerified: false, skipped: ["push", "pr", "ci"] });
	});

	it("reports publication steps skipped by a completed native status result", () => {
		const result = interpretNoMistakesResult(
			command(
				"run:\n  steps[3]{step,status,findings,duration_ms}:\n    push,skipped,0,0\n    pr,skipped,0,0\n    ci,skipped,0,0\noutcome: passed\n",
			),
		);
		expect(result).toMatchObject({ state: "passed", fullyVerified: false, skipped: ["push", "pr", "ci"] });
	});

	it("does not turn a failed process into a pass because it printed a passing outcome", () => {
		expect(interpretNoMistakesResult(command("outcome: passed\n", 1)).state).toBe("failed");
	});

	it("distinguishes a bounded wait, an interrupted caller, and an actual pipeline failure", () => {
		expect(
			interpretNoMistakesResult(command("error:\n  message: wait of 8m elapsed while driving the run\n", 1)).state,
		).toBe("running");
		expect(interpretNoMistakesResult({ ...command(""), aborted: true }).state).toBe("inconclusive");
		expect(interpretNoMistakesResult(command("outcome: failed\n", 1)).state).toBe("failed");
	});
});
