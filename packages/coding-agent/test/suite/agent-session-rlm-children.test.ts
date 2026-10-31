import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AssistantMessage, FauxResponseStep, Usage } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { SessionEntry, SessionHeader } from "../../src/core/session-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { combineUsage } from "../../src/core/usage-totals.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

// Runs real Python kernels, one per session. RAGA_PYTHON picks the interpreter; the default is
// python3 on PATH, so the test never provisions a venv or touches the network.
beforeAll(() => {
	vi.stubEnv("RAGA_PYTHON", process.env.RAGA_PYTHON || "python3");
});

afterAll(() => {
	vi.unstubAllEnvs();
});

function pythonCall(code: string): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall("python", { code })], { stopReason: "toolUse" });
}

type Turn = AssistantMessage | ((context: TranscriptContext) => AssistantMessage);

/**
 * Parent and child sessions share the faux response queue, and parallel children take responses in
 * any order. Each step picks the session by its first user message and the turn by the number of
 * assistant messages so far.
 */
function routed(scripts: Record<string, Turn[]>): FauxResponseStep[] {
	const total = Object.values(scripts).reduce((sum, turns) => sum + turns.length, 0);
	const step = (context: TranscriptContext): AssistantMessage => {
		const task = getMessageText(context.messages.find((message) => message.role === "user"));
		const turns = scripts[task];
		if (!turns) throw new Error(`No script for session "${task}"`);
		const turn = turns[context.messages.filter((message) => message.role === "assistant").length];
		if (!turn) throw new Error(`Script for "${task}" has no more turns`);
		return typeof turn === "function" ? turn(context) : turn;
	};
	return Array.from({ length: total }, () => step);
}

function readSession(file: string): { header: SessionHeader; entries: SessionEntry[] } {
	const [header, ...entries] = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	return { header, entries };
}

function sessionUsage(entries: SessionEntry[]): Usage | undefined {
	let usage: Usage | undefined;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		const messageUsage = message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
		if (messageUsage) usage = usage ? combineUsage(usage, messageUsage) : messageUsage;
	}
	return usage;
}

function tokens(usage: Usage | undefined): number {
	return usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
}

describe("AgentSession RLM child sessions (rlm_query)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	/** A harness whose sessions are files in a fresh directory, so child session files can be inspected. */
	async function setup(
		settings?: Partial<Settings>,
		extensionFactories?: ExtensionFactory[],
	): Promise<{ harness: Harness; sessionDir: string }> {
		const sessionDir = mkdtempSync(join(tmpdir(), "rlm-children-sessions-"));
		const harness = await createHarness({
			settings,
			extensionFactories,
			rlm: {},
			sessionManager: SessionManager.create(sessionDir, sessionDir),
		});
		cleanups.push(() => {
			harness.cleanup();
			rmSync(sessionDir, { recursive: true, force: true });
		});
		return { harness, sessionDir };
	}

	function childSessionFiles(harness: Harness, sessionDir: string): string[] {
		return readdirSync(sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(sessionDir, name))
			.filter((file) => file !== harness.session.sessionFile);
	}

	it("answers through answer, links the child session to its parent, and adds the child's usage to the parent", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const { harness, sessionDir } = await setup(undefined, [
			(pi) => {
				extensionApi = pi;
			},
		]);
		let childPrompt: string | null | undefined;
		harness.setResponses(
			routed({
				Delegate: [
					pythonCall('result = await rlm_query("Multiply the numbers", context={"x": 6, "y": 7})\nprint(result)'),
					fauxAssistantMessage("done"),
				],
				"Multiply the numbers": [
					(context) => {
						childPrompt = getCurrentSystemMessage(context.messages)?.sections?.rlm;
						return pythonCall(
							'answer["content"] = f"{context.data[\'x\'] * context.data[\'y\']} for {context.task}"\nanswer["ready"] = True',
						);
					},
					fauxAssistantMessage("The answer is set."),
				],
			}),
		);
		await harness.session.prompt("Delegate");

		const result = getToolResult(harness, "python");
		expect(getMessageText(result)).toBe("[stdout]\n42 for Multiply the numbers");
		expect(childPrompt).toContain("You are a sub-agent at depth 1.");

		const [childFile] = childSessionFiles(harness, sessionDir);
		const child = readSession(childFile);
		expect(child.header.parentSession).toBe(harness.session.sessionFile);

		// The python result carries the child's usage, and the session stats include it.
		const childUsage = sessionUsage(child.entries);
		expect(tokens(childUsage)).toBeGreaterThan(0);
		expect(result.usage).toEqual(childUsage);
		const parentAssistantTokens = tokens(
			sessionUsage(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
			),
		);
		expect(harness.session.getSessionStats().tokens.total).toBe(parentAssistantTokens + tokens(childUsage));

		// The child ran the parent's extensions with its own extension runtime, so the parent's
		// extension API still acts on the parent and is not stale after the child was disposed.
		expect(extensionApi?.getActiveTools()).toEqual(harness.session.getActiveToolNames());
	});

	it("rejects a grandchild past rlm.maxDepth with the documented message and creates no session", async () => {
		const { harness, sessionDir } = await setup({ rlm: { maxDepth: 1 } });
		let childPrompt: string | null | undefined;
		harness.setResponses(
			routed({
				"Go deep": [pythonCall('print(await rlm_query("Level one"))'), fauxAssistantMessage("done")],
				"Level one": [
					(context) => {
						childPrompt = getCurrentSystemMessage(context.messages)?.sections?.rlm;
						return pythonCall(
							'try:\n    await rlm_query("Level two")\nexcept HostError as e:\n    answer["content"] = str(e)\nanswer["ready"] = True',
						);
					},
					fauxAssistantMessage("finished"),
				],
			}),
		);
		await harness.session.prompt("Go deep");

		expect(getMessageText(getToolResult(harness, "python"))).toBe(
			"[stdout]\nRLM recursion depth limit reached (depth 2, max 1)",
		);
		// The child at the maximum depth is not offered rlm_query.
		expect(childPrompt).not.toContain("rlm_query(task");
		expect(childSessionFiles(harness, sessionDir)).toHaveLength(1);
	});

	it("runs two children in parallel through asyncio.gather", async () => {
		const { harness } = await setup();
		// Each child marks its start in a file and waits for the other's mark, so both answers say
		// "saw" only if the children overlap.
		const barrier = (self: string, other: string) =>
			pythonCall(
				[
					"import asyncio, os",
					`open(${JSON.stringify(self)}, "w").close()`,
					"for _ in range(200):",
					`    if os.path.exists(${JSON.stringify(other)}):`,
					"        break",
					"    await asyncio.sleep(0.05)",
					`answer["content"] = "${self} saw ${other}" if os.path.exists(${JSON.stringify(other)}) else "${self} alone"`,
					'answer["ready"] = True',
				].join("\n"),
			);
		harness.setResponses(
			routed({
				"Split the work": [
					pythonCall('import asyncio\nprint(await asyncio.gather(rlm_query("Child A"), rlm_query("Child B")))'),
					fauxAssistantMessage("done"),
				],
				"Child A": [barrier("a.mark", "b.mark"), fauxAssistantMessage("A done")],
				"Child B": [barrier("b.mark", "a.mark"), fauxAssistantMessage("B done")],
			}),
		);
		await harness.session.prompt("Split the work");

		expect(getMessageText(getToolResult(harness, "python"))).toBe(
			"[stdout]\n['a.mark saw b.mark', 'b.mark saw a.mark']",
		);
	});

	it("returns a turn-budget stop reason, partial output, session path, and usage instead of a generic abort", async () => {
		const { harness, sessionDir } = await setup();
		harness.setResponses(
			routed({
				"Bound the child": [
					pythonCall(
						'result = await rlm_query("Inspect one thing", max_turns=1, details=True)\nprint(result["stop_reason"])\nprint(result["turns"])\nprint(result["ready"])\nprint(result["answer"])\nprint(bool(result["session_file"]))',
					),
					fauxAssistantMessage("done"),
				],
				"Inspect one thing": [pythonCall('answer["content"] = "Found the parser; validation is unfinished"')],
			}),
		);
		await harness.session.prompt("Bound the child");
		const result = getToolResult(harness, "python");
		expect(result.isError).toBe(false);
		const text = getMessageText(result);
		expect(text).toContain("max_turns\n1\nFalse");
		expect(text).toContain("Child reached max_turns=1; this result is incomplete.");
		expect(text).toContain("Found the parser; validation is unfinished");
		expect(text).toContain("True");
		expect(text).not.toContain("This operation was aborted");
		const [childFile] = childSessionFiles(harness, sessionDir);
		expect(tokens(result.usage)).toBeGreaterThan(0);
		expect(result.usage).toEqual(sessionUsage(readSession(childFile).entries));
	});

	it("keeps tool output for string callers when a child exhausts its turn budget", async () => {
		const { harness } = await setup();
		harness.setResponses(
			routed({
				"Read partial work": [
					pythonCall('print(await rlm_query("Report a finding", max_turns=1))'),
					fauxAssistantMessage("done"),
				],
				"Report a finding": [pythonCall('print("parser.ts: invalid delimiter")')],
			}),
		);
		await harness.session.prompt("Read partial work");
		const result = getToolResult(harness, "python");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toContain("Child reached max_turns=1; this result is incomplete.");
		expect(getMessageText(result)).toContain("parser.ts: invalid delimiter");
	});

	it("accepts an explicit ready answer on the last allowed turn", async () => {
		const { harness } = await setup();
		harness.setResponses(
			routed({
				"Finish within budget": [
					pythonCall(
						'result = await rlm_query("Answer immediately", max_turns=1, details=True)\nprint(result["answer"], result["ready"], result["stop_reason"])',
					),
					fauxAssistantMessage("done"),
				],
				"Answer immediately": [pythonCall('answer["content"] = "42"\nanswer["ready"] = True')],
			}),
		);
		await harness.session.prompt("Finish within budget");
		expect(getMessageText(getToolResult(harness, "python"))).toBe("[stdout]\n42 True completed");
	});

	it("does not call a natural final response a turn-budget failure", async () => {
		const { harness } = await setup();
		harness.setResponses(
			routed({
				"Ask for text": [
					pythonCall(
						'result = await rlm_query("Say hello", max_turns=1, details=True)\nprint(result["answer"], result["stop_reason"], result["turns"])',
					),
					fauxAssistantMessage("done"),
				],
				"Say hello": [fauxAssistantMessage("hello")],
			}),
		);
		await harness.session.prompt("Ask for text");
		expect(getMessageText(getToolResult(harness, "python"))).toBe("[stdout]\nhello completed 1");
	});

	it("preserves real provider errors instead of labelling them as budget exhaustion", async () => {
		const { harness } = await setup();
		harness.setResponses(
			routed({
				"Handle a failed provider": [
					pythonCall(
						'try:\n    await rlm_query("Fail upstream", max_turns=1)\nexcept HostError as error:\n    print(error)',
					),
					fauxAssistantMessage("done"),
				],
				"Fail upstream": [fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" })],
			}),
		);
		await harness.session.prompt("Handle a failed provider");
		const text = getMessageText(getToolResult(harness, "python"));
		expect(text).toContain("The child session failed: provider exploded");
		expect(text).not.toContain("max_turns");
	});

	it("aborts the child when the parent is aborted", async () => {
		const { harness, sessionDir } = await setup();
		const marker = join(harness.tempDir, "sleeping.mark");
		harness.setResponses(
			routed({
				"Start a slow child": [pythonCall('print(await rlm_query("Sleep"))'), fauxAssistantMessage("unused")],
				Sleep: [
					pythonCall(
						`import asyncio\nopen(${JSON.stringify(marker)}, "w").close()\nawait asyncio.sleep(30)\nanswer["ready"] = True`,
					),
					fauxAssistantMessage("unused"),
				],
			}),
		);
		const started = Date.now();
		const run = harness.session.prompt("Start a slow child");
		// Abort the parent once the child's cell is running.
		await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
		await harness.session.abort();
		await run;
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(getToolResult(harness, "python").isError).toBe(true);

		const [childFile] = childSessionFiles(harness, sessionDir);
		await vi.waitFor(
			() => {
				const childResult = readSession(childFile).entries.find(
					(entry) => entry.type === "message" && entry.message.role === "toolResult",
				);
				expect(childResult?.type === "message" && getMessageText(childResult.message)).toContain(
					"KeyboardInterrupt",
				);
			},
			{ timeout: 5000 },
		);
	});
});
