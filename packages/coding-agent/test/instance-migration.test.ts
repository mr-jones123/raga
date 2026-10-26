import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir, getAuthPath } from "../src/config.ts";
import { migrateProjectConfig } from "../src/core/instances/migration.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";

describe("explicit project migration", () => {
	let root: string;
	let project: string;
	let source: string;
	let destination: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "raga-migration-"));
		project = join(root, "project");
		source = join(project, ".pi");
		destination = join(project, ".raga");
		mkdirSync(source, { recursive: true });
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});
	function put(path: string, content: string): void {
		const parts = path.split("/");
		mkdirSync(join(source, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(source, path), content);
	}
	function expectUnchanged(): void {
		expect(existsSync(destination)).toBe(false);
		expect(readdirSync(project)).toEqual([".pi"]);
	}

	it("copies reviewed resources without importing extensions or copying credentials and execution state", async () => {
		put("settings.json", JSON.stringify({ theme: "dark", extensions: ["extensions/local.ts"], maxTokens: 100 }));
		put("SYSTEM.md", "Project instructions");
		put("skills/helper/SKILL.md", "---\nname: helper\ndescription: Local helper\n---\nUse the helper.");
		put("extensions/local.ts", 'throw new Error("migration must not execute extensions")');
		put("skills/helper/.env", "TOKEN=private");
		put("auth.json", '{"key":"private"}');
		put("mcp.json", '{"mcpServers":{"private":{"command":"external","env":{"TOKEN":"private"}}}}');
		put("sessions/session.jsonl", "private history");
		put("state/snapshot.json", "private state");
		put("unknown.txt", "unknown");
		const result = await migrateProjectConfig(project, { projectTrusted: true });
		expect(result.copied).toEqual(["SYSTEM.md", "extensions/local.ts", "settings.json", "skills/helper/SKILL.md"]);
		expect(result.skipped).toEqual([
			"auth.json",
			"mcp.json",
			"sessions",
			"skills/helper/.env",
			"state",
			"unknown.txt",
		]);
		expect(readFileSync(join(destination, "SYSTEM.md"), "utf8")).toBe("Project instructions");
		expect(readFileSync(join(source, "auth.json"), "utf8")).toBe('{"key":"private"}');
		expect(readFileSync(join(source, "extensions/local.ts"), "utf8")).toContain("throw new Error");
		expect(existsSync(join(destination, "auth.json"))).toBe(false);
		expect(existsSync(join(destination, "sessions"))).toBe(false);
		expect(existsSync(join(destination, "skills/helper/.env"))).toBe(false);
	});

	it("requires explicit trust and leaves an unapproved project untouched", async () => {
		put("SYSTEM.md", "untrusted");
		await expect(migrateProjectConfig(project, { projectTrusted: false })).rejects.toThrow();
		expectUnchanged();
	});

	it.each(["empty directory", "file", "dangling symlink"])("does not overwrite a destination %s", async (kind) => {
		put("SYSTEM.md", "legacy");
		if (kind === "empty directory") mkdirSync(destination);
		else if (kind === "file") writeFileSync(destination, "existing");
		else symlinkSync(join(root, "missing"), destination);
		await expect(migrateProjectConfig(project, { projectTrusted: true })).rejects.toThrow();
		expect(readFileSync(join(source, "SYSTEM.md"), "utf8")).toBe("legacy");
		expect(readdirSync(project).sort()).toEqual([".pi", ".raga"]);
		if (kind === "empty directory") expect(readdirSync(destination)).toEqual([]);
		if (kind === "file") expect(readFileSync(destination, "utf8")).toBe("existing");
	});

	it("fails without creating a destination when the legacy source is missing", async () => {
		rmSync(source, { recursive: true });
		await expect(migrateProjectConfig(project, { projectTrusted: true })).rejects.toThrow();
		expect(readdirSync(project)).toEqual([]);
	});

	it.each(["source", "internal", "external"])("rejects a %s symlink without partial publication", async (kind) => {
		put("SYSTEM.md", "legacy");
		if (kind === "source") {
			const other = join(root, "legacy");
			mkdirSync(other);
			rmSync(source, { recursive: true });
			symlinkSync(other, source);
		} else {
			mkdirSync(join(source, "extensions"));
			const target = kind === "internal" ? join(source, "SYSTEM.md") : join(root, "external.ts");
			if (kind === "external") writeFileSync(target, "private");
			symlinkSync(target, join(source, "extensions", "link.ts"));
		}
		await expect(migrateProjectConfig(project, { projectTrusted: true })).rejects.toThrow();
		expectUnchanged();
	});

	it.each([
		{ extensions: ["../external.ts"] },
		{ extensions: ["/tmp/external.ts"] },
		{ skills: ["~/private"] },
		{ packages: ["npm:unreviewed"] },
		{ packages: [{ source: "./external" }] },
		{ extensions: ["extensions/missing.ts"] },
		{ shellPath: "/bin/sh" },
		{ npmCommand: ["node", "../installer.js"] },
		{ apiKeys: { provider: "private" } },
		{ sessionDir: "../sessions" },
		{ extensionSettings: { apiKey: "private" } },
	])("rejects unreviewed configuration %j before writing resources", async (settings) => {
		put("AGENTS.md", "must not publish partially");
		put("settings.json", JSON.stringify(settings));
		await expect(migrateProjectConfig(project, { projectTrusted: true })).rejects.toThrow();
		expectUnchanged();
		expect(readFileSync(join(source, "AGENTS.md"), "utf8")).toBe("must not publish partially");
	});

	it("rejects malformed settings without partial migration", async () => {
		put("settings.json", "{ broken");
		await expect(migrateProjectConfig(project, { projectTrusted: true })).rejects.toThrow();
		expectUnchanged();
	});

	it("loads only .raga project resources while retaining independent global authentication", async () => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		put("SYSTEM.md", "ignored legacy instructions");
		put("settings.json", JSON.stringify({ theme: "legacy" }));
		put("extensions/legacy.ts", 'throw new Error("legacy discovery is forbidden")');
		writeFileSync(join(agentDir, "SYSTEM.md"), "global instructions");
		writeFileSync(join(agentDir, "auth.json"), '{"provider":"trusted credential"}');
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		expect(getAuthPath()).toBe(join(agentDir, "auth.json"));
		expect(hasTrustRequiringProjectResources(project)).toBe(false);
		const legacyLoader = new DefaultResourceLoader({ cwd: project, agentDir });
		await legacyLoader.reload();
		expect(legacyLoader.getSystemPrompt()).toBe("global instructions");
		expect(legacyLoader.getExtensions().extensions).toEqual([]);
		expect(SettingsManager.create(project, agentDir).getTheme()).not.toBe("legacy");
		mkdirSync(destination);
		writeFileSync(join(destination, "SYSTEM.md"), "new project instructions");
		writeFileSync(join(destination, "settings.json"), JSON.stringify({ theme: "new" }));
		const loader = new DefaultResourceLoader({ cwd: project, agentDir });
		await loader.reload();
		expect(loader.getSystemPrompt()).toBe("new project instructions");
		expect(SettingsManager.create(project, agentDir).getTheme()).toBe("new");
		const untrusted = new DefaultResourceLoader({
			cwd: project,
			agentDir,
			settingsManager: SettingsManager.create(project, agentDir, { projectTrusted: false }),
		});
		await untrusted.reload();
		expect(untrusted.getSystemPrompt()).toBe("global instructions");
		expect(readFileSync(getAuthPath(), "utf8")).toBe('{"provider":"trusted credential"}');
	});

	it("keeps the global default under .pi", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "");
		expect(getAgentDir()).toBe(join(homedir(), ".pi", "agent"));
	});
});
