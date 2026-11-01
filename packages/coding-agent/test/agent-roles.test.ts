import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRoleCatalog, effectiveAgentRoles, resolveAgentRole } from "../src/core/agent-roles.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent roles", () => {
	it("reads the bundled role catalog with panel seats", () => {
		const catalog = agentRoleCatalog();
		expect(catalog.find((role) => role.name === "bug-fix")).toMatchObject({ panel: false, defaultSeats: 1 });
		expect(catalog.find((role) => role.name === "arena runners")).toMatchObject({ panel: true, defaultSeats: 2 });
		expect(catalog.map((role) => role.name)).not.toContain("rules");
	});

	it("normalizes user settings: inherit and blanks are null, panels default to their seats", () => {
		const roles = effectiveAgentRoles({
			kind: "settings",
			settings: {
				roles: { "bug-fix": " inherit ", "how explorer": "p/m", "arena runners": "p/a", "swarm workers": ["p/x"] },
			},
		});
		expect(roles.get("bug-fix")).toBeNull();
		expect(roles.get("how explorer")).toBe("p/m");
		expect(roles.get("arena runners")).toEqual(["p/a"]);
		expect(roles.get("swarm workers")).toBe("p/x");
		expect(roles.get("interrogate reviewers")).toEqual([null, null]);
	});

	it("resolves seats and applies the budget only to assigned models", () => {
		const roles = effectiveAgentRoles({
			kind: "settings",
			settings: { roles: { "bug-fix": "p/fix", "arena runners": [null, "p/b"] } },
		});
		expect(resolveAgentRole(roles, "unlimited", "bug-fix", undefined)).toEqual({ model: "p/fix", thinking: "xhigh" });
		expect(resolveAgentRole(roles, undefined, "bug-fix", undefined)).toEqual({ model: "p/fix" });
		expect(resolveAgentRole(roles, "small", "arena runners", 0)).toEqual({});
		expect(resolveAgentRole(roles, "small", "arena runners", 1)).toEqual({ model: "p/b", thinking: "low" });
		expect(() => resolveAgentRole(roles, undefined, "arena runners", 2)).toThrow("seat must be 0 to 1");
		expect(() => resolveAgentRole(roles, undefined, "bug-fix", 1)).toThrow("omit seat");
		expect(() => resolveAgentRole(roles, undefined, "nonsense", undefined)).toThrow('Unknown role "nonsense"');
	});

	it("uses the pinned revision's model-roles.json in instance sessions, including extra roles", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-roles-"));
		dirs.push(root);
		mkdirSync(join(root, "agents"));
		writeFileSync(
			join(root, "agents", "model-roles.json"),
			JSON.stringify({
				schemaVersion: 1,
				rules: "x",
				"bug-fix": "p/pinned",
				"arena runners": ["p/1", "p/2", "p/3"],
				custom: "p/c",
			}),
		);
		const roles = effectiveAgentRoles({ kind: "instance", resourceRoot: root });
		expect(roles.get("bug-fix")).toBe("p/pinned");
		expect(roles.get("arena runners")).toEqual(["p/1", "p/2", "p/3"]);
		expect(roles.get("custom")).toBe("p/c");
		expect(roles.has("rules")).toBe(false);
	});
});
