import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession.askAside (/btw)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(): Promise<Harness> {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("The port is 8080.")]);
		await harness.session.prompt("Start the server on port 8080");
		return harness;
	}

	it("answers from the conversation without adding the exchange to the session", async () => {
		const harness = await setup();
		const before = harness.session.messages.length;
		let seen: { context: TranscriptContext; options: SimpleStreamOptions | undefined } | undefined;
		harness.setResponses([
			(context, options) => {
				seen = { context, options };
				return fauxAssistantMessage("8080");
			},
		]);

		const { text } = await harness.session.askAside("which port?");

		expect(text).toBe("8080");
		expect(harness.session.messages).toHaveLength(before);
		// The request repeats the conversation, so it shares the main prompt-cache prefix.
		const texts = seen!.context.messages.map((message) => getMessageText(message));
		expect(texts).toContain("Start the server on port 8080");
		expect(texts.at(-1)).toContain("which port?");
		expect(seen!.options?.sessionId).toBe(harness.session.sessionId);
		const usage = harness.sessionManager.getEntries().filter((entry) => entry.type === "usage");
		expect(usage.map((entry) => entry.kind)).toEqual(["btw"]);
	});

	it("drops tool calls instead of running them", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
		]);

		const { text } = await harness.session.askAside("what files are here?");

		expect(text).toBe("(no answer: the model tried to use a tool)");
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(false);
	});
});
