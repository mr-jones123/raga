import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLAUDE_BILLING_HEADER_PREFIX,
	CLAUDE_CODE_SYSTEM_INSTRUCTION,
	getClaudeCodeVersion,
} from "../src/api/anthropic-claude-code.ts";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	createParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		beta = {
			messages: {
				create: (params: Record<string, unknown>) => {
					mockState.createParams = params;
					return { asResponse: async () => createSseResponse() };
				},
			},
		};
	}

	return { default: FakeAnthropic };
});

const neverAbortedSignal = new AbortController().signal;

const context = normalizeContext({
	systemPrompt: "Raga system prompt.",
	messages: [{ role: "user", content: "Hello world", timestamp: Date.now() }],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

function systemTexts(): string[] {
	const params = mockState.createParams as { system?: { type: string; text: string }[] };
	return (params.system ?? []).map((block) => block.text);
}

function metadataUserId(): string | undefined {
	const params = mockState.createParams as { metadata?: { user_id?: string } };
	return params.metadata?.user_id;
}

afterEach(() => {
	mockState.constructorOpts = undefined;
	mockState.createParams = undefined;
});

describe("OAuth requests carry the Claude Code attestation", () => {
	it("puts the billing block first and the identity block second", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-ant-oat-test",
			signal: neverAbortedSignal,
		}).result();

		expect(systemTexts()[0].startsWith(`${CLAUDE_BILLING_HEADER_PREFIX} cc_version=`)).toBe(true);
		expect(systemTexts()[0]).toContain(`cc_version=${getClaudeCodeVersion()}.`);
		expect(systemTexts()[0]).toContain("; cc_entrypoint=cli; cch=00000;");
		expect(systemTexts()[1]).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
		expect(systemTexts()[2]).toBe("Raga system prompt.");
	});

	it("sends a Claude Code metadata user id derived from the session", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-ant-oat-test",
			sessionId: "session-42",
			signal: neverAbortedSignal,
		}).result();

		const parsed = JSON.parse(metadataUserId() as string) as { device_id: string; session_id: string };
		expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/);
		expect(parsed.session_id).toBe("session-42");
	});

	it("patches the serialized body on the way out", async () => {
		const transport = vi.fn(async () => new Response("ok"));
		await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-ant-oat-test",
			fetch: transport,
			signal: neverAbortedSignal,
		}).result();

		const wrapped = mockState.constructorOpts?.fetch as typeof globalThis.fetch;
		expect(wrapped).not.toBe(transport);

		const params = mockState.createParams as { system: { text: string }[]; messages: unknown[] };
		const body = JSON.stringify({ ...params, stream: true });
		await wrapped("https://api.anthropic.com/v1/messages", { method: "POST", body });
		const sent = (transport.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string;
		expect(typeof sent).toBe("string");
		expect(sent).toMatch(/ cch=[0-9a-f]{5};/);
		expect(sent).not.toContain("cch=00000");
	});
});

describe("API-key requests keep the plain wire shape", () => {
	it("sends only the caller's system prompt and no generated metadata", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-ant-api-test",
			signal: neverAbortedSignal,
		}).result();

		expect(systemTexts()).toEqual(["Raga system prompt."]);
		expect(metadataUserId()).toBeUndefined();
	});

	it("does not wrap the caller's fetch", async () => {
		const transport = vi.fn(async () => new Response("ok"));
		await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-ant-api-test",
			fetch: transport,
			signal: neverAbortedSignal,
		}).result();

		expect(mockState.constructorOpts?.fetch).toBe(transport);
	});
});
