/** Reads a pi session JSONL file and sums what one benchmark run cost. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

function addUsage(totals, usage) {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

/** The top-level session file in `dir`: the oldest one without a parent session. */
export function findSessionFile(dir) {
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
	} catch {
		return undefined;
	}
	for (const file of files) {
		const header = JSON.parse(readFileSync(join(dir, file), "utf8").split("\n", 1)[0]);
		if (!header.parentSession) return join(dir, file);
	}
	return files[0] ? join(dir, files[0]) : undefined;
}

const SUB_CALLS = ["llm_query", "llm_batch", "rlm_query"];

/**
 * usage: every usage in the session (assistant turns, tool results such as the python tool's sub-LLM
 * calls, standalone usage entries, compactions). subUsage: the tool-result part of it.
 */
export function summarizeSession(file) {
	const usage = emptyUsage();
	const subUsage = emptyUsage();
	const toolCalls = {};
	const subCalls = Object.fromEntries(SUB_CALLS.map((name) => [name, 0]));
	let assistantTurns = 0;
	let finalText = "";
	let stopReason;
	let errorMessage;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line);
		if (entry.type === "usage") addUsage(usage, entry.usage);
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) addUsage(usage, entry.usage);
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			assistantTurns++;
			addUsage(usage, message.usage);
			stopReason = message.stopReason;
			errorMessage = message.errorMessage;
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text.trim()) finalText = text;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
				const code = typeof block.arguments?.code === "string" ? block.arguments.code : "";
				for (const name of SUB_CALLS) subCalls[name] += code.match(new RegExp(`\\b${name}\\s*\\(`, "g"))?.length ?? 0;
			}
		} else if (message.role === "toolResult" && message.usage) {
			addUsage(usage, message.usage);
			addUsage(subUsage, message.usage);
		}
	}
	return { usage, subUsage, toolCalls, subCallSites: subCalls, assistantTurns, finalText, stopReason, errorMessage };
}
