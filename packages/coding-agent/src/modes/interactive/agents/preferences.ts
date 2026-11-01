import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import type { AgentHubView } from "./chooser.ts";

export function readAgentHubPreference(agentDir = getAgentDir()): AgentHubView {
	try {
		const value: unknown = JSON.parse(readFileSync(join(agentDir, "agent-hub.json"), "utf8"));
		if (typeof value === "object" && value !== null && "view" in value && value.view === "rex") return "rex";
	} catch {
		// A missing or invalid preference must not prevent viewing agents.
	}
	return "tui";
}

export function saveAgentHubPreference(view: AgentHubView, agentDir = getAgentDir()): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const temporary = join(agentDir, `.agent-hub-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify({ view })}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, join(agentDir, "agent-hub.json"));
	} finally {
		rmSync(temporary, { force: true });
	}
}
