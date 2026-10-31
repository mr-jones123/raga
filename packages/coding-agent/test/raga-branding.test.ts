import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const branding = vi.hoisted(() => ({ raga: true, agentDir: "", packageDir: "" }));
vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as Record<string, unknown>),
		get APP_NAME() {
			return branding.raga ? "raga" : "pi";
		},
		get IS_RAGA_CLI() {
			return branding.raga;
		},
		get PACKAGE_NAME() {
			return branding.raga ? "raga-cli" : "@earendil-works/pi-coding-agent";
		},
		getAgentDir: () => branding.agentDir,
		getPackageDir: () => branding.packageDir,
		detectInstallMethod: () => "npm",
		getSelfUpdateCommand: (
			_packageName: string,
			_npmCommand: string[] | undefined,
			target: { installSpec: string },
		) => ({
			// A harmless stand-in for installation; no package manager or network writes run.
			command: process.execPath,
			args: ["--version"],
			display: `npm install -g ${target.installSpec}`,
		}),
	};
});

import { VERSION } from "../src/config.ts";
import { bugReportArchiveFileName } from "../src/core/bug-report.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { allowNetwork } from "./test-network-env.ts";

describe("Raga branding", () => {
	let dir: string;
	let exitCode: typeof process.exitCode;

	beforeEach(() => {
		allowNetwork();
		branding.raga = true;
		dir = mkdtempSync(join(tmpdir(), "raga-branding-"));
		branding.agentDir = join(dir, "agent");
		branding.packageDir = join(dir, "package");
		mkdirSync(branding.agentDir, { recursive: true });
		exitCode = process.exitCode;
		process.exitCode = undefined;
		vi.stubEnv("PI_MANAGED_INSTALL_ROOT", "");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		process.exitCode = exitCode;
		rmSync(dir, { recursive: true, force: true });
	});

	it("identifies the harness as Raga while acknowledging the upstream SDK", () => {
		const prompt = buildSystemPrompt({ cwd: dir });
		expect(prompt).toContain("operating inside raga, a coding agent harness");
		expect(prompt).toContain("Raga documentation, including the upstream pi SDK");
		expect(prompt).not.toContain("operating inside pi,");
		expect(bugReportArchiveFileName("example")).toBe("raga-bug-report-example.zip");
	});

	for (const inheritedManagedInstall of [false, true]) {
		it(`updates raga-cli without recommending or using the pi installer (inherited managed install: ${inheritedManagedInstall})`, async () => {
			if (inheritedManagedInstall) {
				const managedRoot = join(dir, "managed");
				branding.packageDir = join(managedRoot, "releases", VERSION, "node_modules", "raga-cli");
				mkdirSync(branding.packageDir, { recursive: true });
				writeFileSync(
					join(managedRoot, "managed-install.json"),
					JSON.stringify({
						kind: "pi-managed-install",
						schemaVersion: 1,
						layout: "releases-v1",
					}),
				);
				vi.stubEnv("PI_MANAGED_INSTALL_ROOT", managedRoot);
			}
			const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({ version: VERSION }));
			vi.stubGlobal("fetch", fetchMock);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			expect(await handlePackageCommand(["update", "--force"])).toBe(true);
			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(String(fetchMock.mock.calls[0]?.[0])).toContain("registry.npmjs.org/raga-cli/latest");
			const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).toContain(`npm install -g raga-cli@${VERSION}`);
			expect(output).toContain(`Updated raga from ${VERSION} to ${VERSION}`);
			expect(output).not.toContain("pi.dev");
			expect(output).not.toContain("Run the installer");
			expect(output).not.toContain("does not pin its dependencies");
		});
	}

	it("preserves the upstream pi npm installer advice when actually running pi", async () => {
		branding.raga = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: VERSION })),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await handlePackageCommand(["update", "--force"])).toBe(true);
		expect(process.exitCode).toBeUndefined();
		const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain(
			process.platform === "win32" ? "https://pi.dev/install.ps1" : "https://pi.dev/install.sh",
		);
		expect(buildSystemPrompt({ cwd: dir })).toContain("operating inside pi, a coding agent harness");
	});
});
