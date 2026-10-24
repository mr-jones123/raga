import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RlmSessionOptions } from "../../src/core/rlm/runtime.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

// Runs the real Python kernel. RAGA_PYTHON picks the interpreter; the default is python3 on PATH,
// so the test never provisions a venv or touches the network.
let inputsDir: string;

beforeAll(() => {
	vi.stubEnv("RAGA_PYTHON", process.env.RAGA_PYTHON || "python3");
	inputsDir = mkdtempSync(join(tmpdir(), "rlm-suite-inputs-"));
});

afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(inputsDir, { recursive: true, force: true });
});

/** A model turn that runs one python cell. */
function pythonCall(code: string) {
	return fauxAssistantMessage([fauxToolCall("python", { code })], { stopReason: "toolUse" });
}

describe("AgentSession RLM mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: { settings?: Partial<Settings>; rlm?: RlmSessionOptions } = {}): Promise<Harness> {
		const harness = await createHarness({ settings: options.settings, rlm: options.rlm ?? {} });
		harnesses.push(harness);
		return harness;
	}

	function resultText(harness: Harness): string {
		return getMessageText(getToolResult(harness, "python"));
	}

	it("edits a file using only the python tool, which is the only tool the provider sees", async () => {
		const harness = await setup();
		writeFileSync(join(harness.tempDir, "notes.txt"), "hello world\n");
		expect(harness.session.getActiveToolNames()).toEqual(["python", "bash", "edit", "write"]);

		const requestTools: string[][] = [];
		let rlmSection: string | null | undefined;
		harness.setResponses([
			(context: TranscriptContext) => {
				requestTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				rlmSection = getCurrentSystemMessage(context.messages)?.sections?.rlm;
				return pythonCall(
					'print(await edit("notes.txt", [("hello", "goodbye")]))\nprint((await read("notes.txt")).strip())',
				);
			},
			(context: TranscriptContext) => {
				requestTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Change hello to goodbye in notes.txt");

		expect(requestTools).toEqual([["python"], ["python"]]);
		expect(rlmSection).toContain("already exists and persists");
		expect(readFileSync(join(harness.tempDir, "notes.txt"), "utf8")).toBe("goodbye world\n");
		const result = getToolResult(harness, "python");
		expect(result.isError).toBe(false);
		expect(resultText(harness)).toContain("goodbye world");
		// The only tool calls in the transcript are python calls.
		const toolCalls = harness.session.messages.flatMap((message) =>
			message.role === "assistant"
				? message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []))
				: [],
		);
		expect(toolCalls).toEqual(["python"]);
	});

	it("rejects host tools other than bash, edit, and write", async () => {
		const harness = await setup();
		harness.setResponses([
			pythonCall(
				'import raga_rlm\ntry:\n    await raga_rlm.host_request({"type": "tool.call", "name": "read", "args": {"path": "x"}})\nexcept HostError as e:\n    print("refused:", e)',
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(resultText(harness)).toContain('refused: python cannot call tool "read"');
	});

	it("adds the usage of llm_query inside a cell to the session stats", async () => {
		const harness = await setup();
		const subPrompts: string[] = [];
		harness.setResponses([
			pythonCall('answer_text = await llm_query("What is 2+2?", system="Be brief.")\nprint(answer_text)'),
			(context: TranscriptContext) => {
				subPrompts.push(getMessageText(context.messages.at(-1)));
				return fauxAssistantMessage("four");
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Ask a sub-model");

		expect(subPrompts).toEqual(["What is 2+2?"]);
		expect(resultText(harness)).toBe("[stdout]\nfour");
		const usage = getToolResult(harness, "python").usage;
		expect(usage?.totalTokens).toBeGreaterThan(0);

		const assistantTokens = harness.session.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.reduce(
				(sum, message) =>
					sum + message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite,
				0,
			);
		const toolTokens = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
		expect(toolTokens).toBeGreaterThan(0);
		expect(harness.session.getSessionStats().tokens.total).toBe(assistantTokens + toolTokens);
	});

	it("runs llm_batch prompts in order and reports a failed call as HostError", async () => {
		const harness = await setup();
		harness.setResponses([
			pythonCall('print(await llm_batch(["a", "b", "c"]))'),
			(context: TranscriptContext) => fauxAssistantMessage(`answer ${getMessageText(context.messages.at(-1))}`),
			(context: TranscriptContext) => fauxAssistantMessage(`answer ${getMessageText(context.messages.at(-1))}`),
			(context: TranscriptContext) => fauxAssistantMessage(`answer ${getMessageText(context.messages.at(-1))}`),
			pythonCall('try:\n    await llm_query("q")\nexcept HostError as e:\n    print("failed:", e)'),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("batch");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(results[0])).toBe("[stdout]\n['answer a', 'answer b', 'answer c']");
		expect(getMessageText(results[1])).toBe("[stdout]\nfailed: provider exploded");
	});

	it("sets context.task to the first prompt and returns earlier messages from context.history after compaction", async () => {
		const harness = await setup({ settings: { compaction: { keepRecentTokens: 1 } } });
		harness.setResponses([
			pythonCall('print("secret marker 4711")'),
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("summary of the conversation"),
			pythonCall(
				"history = await context.history()\n" +
					"print(repr(context.task))\n" +
					'print([m["role"] for m in history])\n' +
					'print(any("secret marker 4711" in m["text"] for m in history if m["role"] == "toolResult"))\n' +
					"print(len(await context.history(offset=1, limit=2)))",
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("first question");
		await harness.session.compact();
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		await harness.session.prompt("second question");

		expect(resultText(harness)).toBe(
			[
				"[stdout]",
				"'first question'",
				"['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant']",
				"True",
				"2",
			].join("\n"),
		);
	});

	it("cuts output over rlm.outputLimit and keeps the full text in cells[-1]", async () => {
		const harness = await setup({ settings: { rlm: { outputLimit: 200 } } });
		harness.setResponses([
			pythonCall('print("x" * 1000)'),
			pythonCall('len(cells[-1]["stdout"])'),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("print a lot");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		const cut = getMessageText(results[0]);
		expect(cut).toMatch(/\[\.\.\. \d+ characters cut; full output in cells\[-1\] \.\.\.\]/);
		expect(cut.length).toBeLessThan(300);
		expect(getMessageText(results[1])).toBe("[result]\n1001");
	});

	it("reads --rlm-input files through context.inputs", async () => {
		const notes = join(inputsDir, "notes.md");
		writeFileSync(notes, "# Large input\nline two\n");
		const harness = await setup({ rlm: { inputs: { notes } } });
		harness.setResponses([
			pythonCall('print(sorted(context.inputs))\nprint(context.inputs["notes"].splitlines()[1])'),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read the input");
		expect(resultText(harness)).toBe("[stdout]\n['notes']\nline two");
	});

	it("reports a Python error as an error result and keeps the namespace", async () => {
		const harness = await setup();
		harness.setResponses([pythonCall("value = 21\n1 / 0"), pythonCall("value * 2"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results[0].role === "toolResult" && results[0].isError).toBe(true);
		expect(getMessageText(results[0])).toContain("ZeroDivisionError");
		expect(getMessageText(results[1])).toBe("[result]\n42");
	});
});
