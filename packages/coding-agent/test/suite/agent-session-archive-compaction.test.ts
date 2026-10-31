import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	getCurrentSystemPrompt,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { renderSessionArchive } from "../../src/core/compaction/archive.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A user request, a bash call, its result, and a final answer, as a session would record them. */
function seedToolSession(harness: Harness, toolOutput = "57 tests passed"): void {
	const model = harness.getModel();
	const now = Date.now();
	const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) =>
		({
			...fauxAssistantMessage("", { stopReason, timestamp: now }),
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(100),
		}) satisfies AssistantMessage;
	harness.sessionManager.appendMessage({
		role: "user",
		content: "Keep fullscreen scrolling fast",
		timestamp: now - 3,
	});
	harness.sessionManager.appendMessage(
		assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "npm test" } }], "toolUse"),
	);
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "bash",
		content: [{ type: "text", text: toolOutput }],
		isError: false,
		timestamp: now - 1,
	});
	harness.sessionManager.appendMessage(
		assistant([{ type: "text", text: "Scrolling now moves three lines." }], "stop"),
	);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function captureRequests(harness: Harness): TranscriptContext[] {
	const contexts: TranscriptContext[] = [];
	const stream = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = (model, context, options) => {
		contexts.push(context);
		return stream(model, context, options);
	};
	return contexts;
}

describe("archive compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function archiveHarness(sessionManager?: SessionManager): Promise<Harness> {
		const harness = await createHarness({ settings: { compaction: { strategy: "archive" } }, sessionManager });
		harnesses.push(harness);
		return harness;
	}

	it("drops earlier context without a model call and archives tool calls and results verbatim", async () => {
		const harness = await archiveHarness();
		seedToolSession(harness);
		const requests = captureRequests(harness);

		const result = await harness.session.compact();

		expect(requests).toHaveLength(0);
		expect(result.usage).toBeUndefined();
		const compaction = harness.sessionManager.getBranch().at(-1);
		if (compaction?.type !== "compaction") throw new Error("expected a compaction entry");
		expect(compaction.firstKeptEntryId).toBe(compaction.id);
		expect(compaction.details).toMatchObject({ strategy: "archive", archivedEntries: 4 });
		expect(harness.session.messages.map((message) => message.role)).toEqual(["compactionSummary"]);

		const archivePath = (compaction.details as { archivePath: string }).archivePath;
		expect(result.summary).toContain(archivePath);
		expect(result.summary).toContain("Keep fullscreen scrolling fast");
		const archive = readFileSync(archivePath, "utf8");
		expect(archive).toContain("Keep fullscreen scrolling fast");
		expect(archive).toContain("[tool call bash call_1]");
		expect(archive).toContain('"command": "npm test"');
		expect(archive).toMatch(/^=== 3 tool_result bash call_1 \S+ \S+\n57 tests passed$/m);
	});

	it("tells the next request where the archive is through the system prompt", async () => {
		const harness = await archiveHarness();
		seedToolSession(harness);
		await harness.session.compact();
		const archivePath = (harness.sessionManager.getBranch().at(-1) as { details: { archivePath: string } }).details
			.archivePath;
		const requests = captureRequests(harness);
		harness.setResponses([fauxAssistantMessage("I will search the archive.")]);

		await harness.session.prompt("What did we change about scrolling?");

		const systemPrompt = getCurrentSystemPrompt(requests[0].messages);
		expect(systemPrompt).toContain("<session_archive>");
		expect(systemPrompt).toContain(archivePath);
		const userTexts = requests[0].messages.filter((message) => message.role === "user");
		expect(JSON.stringify(userTexts)).not.toContain("Scrolling now moves three lines.");
	});

	it("removes the archive instruction once a later compaction is not an archive", async () => {
		const harness = await archiveHarness();
		seedToolSession(harness);
		await harness.session.compact();
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("second"),
		]);
		await harness.session.prompt("continue");
		harness.settingsManager.applyOverrides({ compaction: { strategy: "summary", keepRecentTokens: 1 } });
		await harness.session.compact();
		const requests = captureRequests(harness);

		await harness.session.prompt("after summary");

		expect(getCurrentSystemPrompt(requests[0].messages)).not.toContain("<session_archive>");
	});

	it("writes the archive beside a persisted session file", async () => {
		const seed = await createHarness();
		harnesses.push(seed);
		const sessionManager = SessionManager.create(seed.tempDir, seed.tempDir);
		const harness = await archiveHarness(sessionManager);
		seedToolSession(harness);

		await harness.session.compact();

		const sessionFile = sessionManager.getSessionFile();
		const archivePath = (sessionManager.getBranch().at(-1) as { details: { archivePath: string } }).details
			.archivePath;
		expect(sessionFile).toBeDefined();
		expect(dirname(archivePath)).toBe(dirname(sessionFile ?? ""));
		expect(archivePath.startsWith(sessionFile?.replace(/\.jsonl$/, "") ?? "")).toBe(true);
		expect(existsSync(archivePath)).toBe(true);
	});

	it("archives on automatic threshold compaction without a summarization request", async () => {
		const harness = await archiveHarness();
		seedToolSession(harness);
		const requests = captureRequests(harness);
		const runAutoCompaction = (
			harness.session as unknown as { _runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean> }
		)._runAutoCompaction.bind(harness.session);

		await runAutoCompaction("threshold", false);

		expect(requests).toHaveLength(0);
		const [end] = harness.eventsOfType("compaction_end");
		expect(end?.result?.details).toMatchObject({ strategy: "archive" });
		expect(harness.session.messages.map((message) => message.role)).toEqual(["compactionSummary"]);
	});

	it("keeps the head and tail of long tool output and points at the session entry", async () => {
		const harness = await archiveHarness();
		seedToolSession(harness, `HEAD-MARKER${"x".repeat(20000)}TAIL-MARKER`);
		const entries = harness.sessionManager.getBranch();
		const resultEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");

		const archive = renderSessionArchive(entries);

		expect(archive).toContain("HEAD-MARKER");
		expect(archive).toContain("TAIL-MARKER");
		expect(archive).toContain(`full text is entry ${resultEntry?.id} in the session JSONL file`);
		expect(archive.length).toBeLessThan(9000);
	});
});
