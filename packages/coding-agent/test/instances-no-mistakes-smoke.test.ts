import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { getBundledHarnessPath } from "../src/core/instances/bundle.ts";
import { NoMistakesBackend } from "../src/core/instances/no-mistakes.ts";
import { initializeInstance } from "../src/core/instances/store.ts";

it.skipIf(process.env.RAGA_NM_SMOKE !== "1")(
	"runs the real pinned gate in an explicitly authorized disposable repository without publication",
	async () => {
		const executable = process.env.RAGA_NM_AGENT_EXECUTABLE;
		const version = process.env.RAGA_NM_AGENT_VERSION;
		if (!executable || !version)
			throw new Error(
				"Real gate smoke requires RAGA_NM_AGENT_EXECUTABLE and RAGA_NM_AGENT_VERSION; optional JSON RAGA_NM_AGENT_ARGS and RAGA_NM_AGENT_ENV provide explicit adapter inputs",
			);
		const root = await mkdtemp(join(tmpdir(), "raga-nm-"));
		const project = join(root, "repo");
		const remote = join(root, "origin.git");
		const ambientHome = join(root, "operator-home");
		await mkdir(project);
		await mkdir(ambientHome);
		await writeFile(join(ambientHome, "sentinel"), "operator-owned data");
		vi.stubEnv("HOME", ambientHome);
		const git = (...args: string[]) => {
			const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
			if (result.status !== 0) throw new Error(result.stderr);
			return result.stdout.trim();
		};
		const backend = new NoMistakesBackend({
			instanceRoot: join(project, ".raga"),
			projectRoot: project,
			agent: { executable, version, args: JSON.parse(process.env.RAGA_NM_AGENT_ARGS ?? "[]") as string[] },
			environment: JSON.parse(process.env.RAGA_NM_AGENT_ENV ?? "{}") as Record<string, string>,
		});
		const publicSkill = join(getBundledHarnessPath(), "skills", "no-mistakes", "upstream", "SKILL.md");
		const originalSkill = await readFile(publicSkill);
		let provisioned = false;
		try {
			git("init", "--bare", "--initial-branch=main", remote);
			git("init", "--initial-branch=main");
			git("config", "user.name", "Raga gate test");
			git("config", "user.email", "gate@example.invalid");
			await writeFile(join(project, ".gitignore"), ".raga/\n");
			await writeFile(
				join(project, "package.json"),
				JSON.stringify({ private: true, scripts: { test: "node --test" } }),
			);
			await writeFile(join(project, "README.md"), "# Disposable gate fixture\n");
			git("add", ".gitignore", "package.json", "README.md");
			git("commit", "-m", "Initialize disposable fixture");
			git("remote", "add", "origin", remote);
			git("push", "origin", "main");
			git("switch", "-c", "feature");
			await writeFile(
				join(project, "README.md"),
				"# Disposable gate fixture\n\nValidation fixture for the native adapter.\n",
			);
			git("add", "README.md");
			git("commit", "-m", "Document the adapter fixture");
			await initializeInstance(project, { harnessSource: getBundledHarnessPath() });
			const inspection = await backend.provision({ approved: true });
			expect(inspection.installed).toBe(true);
			provisioned = true;
			const enabled = await backend.enable({ approved: true, network: true });
			expect(enabled.exitCode, enabled.stderr).toBe(0);
			expect((await backend.inspect()).enabled).toBe(true);
			const result = await backend.run({
				intent:
					"Validate this disposable documentation-only change. Do not publish any branch, PR, or CI workflow.",
				approval: { network: true },
			});
			expect(result.skipped).toEqual(["push", "pr", "ci"]);
			expect(result.fullyVerified).toBe(false);
			expect(["gate", "passed", "running"]).toContain(result.state);
			const published = spawnSync("git", ["--git-dir", remote, "show-ref", "--verify", "refs/heads/feature"], {
				encoding: "utf8",
			});
			expect(published.status).toBe(1);
			expect(await readFile(publicSkill)).toEqual(originalSkill);
			expect(await readdir(ambientHome)).toEqual(["sentinel"]);
			const stopped = await backend.stop({ approved: true, force: true });
			expect(stopped).toMatchObject({ exitCode: 0, state: "stopped" });
		} finally {
			try {
				if (provisioned) await backend.stop({ approved: true, force: true });
			} finally {
				vi.unstubAllEnvs();
				await rm(root, { recursive: true, force: true });
			}
		}
	},
	900_000,
);
