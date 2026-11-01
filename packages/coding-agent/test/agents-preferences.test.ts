import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentHubPreference, saveAgentHubPreference } from "../src/modes/interactive/agents/preferences.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "raga-agents-preferences-"));
	dirs.push(dir);
	return dir;
}
describe("agent hub view preference", () => {
	it("defaults to TUI for missing, malformed, and unsupported preferences", () => {
		const dir = directory();
		expect(readAgentHubPreference(dir)).toBe("tui");
		for (const content of ["{", "null", '"rex"', '{"view":"unsupported"}']) {
			writeFileSync(join(dir, "agent-hub.json"), content);
			expect(readAgentHubPreference(dir)).toBe("tui");
		}
	});
	it("remembers only an explicit successful selection in a private file", () => {
		const dir = directory();
		saveAgentHubPreference("rex", dir);
		expect(readAgentHubPreference(dir)).toBe("rex");
		expect(JSON.parse(readFileSync(join(dir, "agent-hub.json"), "utf8"))).toEqual({ view: "rex" });
		if (process.platform !== "win32") expect(statSync(join(dir, "agent-hub.json")).mode & 0o777).toBe(0o600);
		saveAgentHubPreference("tui", dir);
		expect(readAgentHubPreference(dir)).toBe("tui");
	});
});
