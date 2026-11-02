import { describe, expect, it } from "vitest";
import {
	adoptRequiredClaudeCodeVersion,
	buildClaudeCodeBillingHeader,
	CLAUDE_BILLING_HEADER_PREFIX,
	CLAUDE_CODE_SYSTEM_INSTRUCTION,
	claudeCodeDeviceId,
	claudeCodeVersionFingerprint,
	firstWireUserPromptText,
	getClaudeCodeVersion,
	isClaudeCodeMetadataUserId,
	patchClaudeCodeCch,
	resolveClaudeCodeMetadataUserId,
	wrapFetchForClaudeCodeCch,
	xxHash64,
} from "../src/api/anthropic-claude-code.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function billingBody(billingText: string, userText = "Hello world"): Uint8Array {
	// Key order mirrors the Anthropic SDK payload: messages before system.
	return encoder.encode(
		JSON.stringify({
			model: "claude-test",
			messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
			max_tokens: 16,
			stream: true,
			system: [
				{ type: "text", text: billingText },
				{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
			],
		}),
	);
}

function parseBody(body: Uint8Array): {
	messages: { role: string; content: { type: string; text?: string }[] }[];
	system: { type: string; text: string }[];
} {
	return JSON.parse(decoder.decode(body));
}

describe("Claude Code wire attestation", () => {
	it("hashes like xxHash64", () => {
		expect(xxHash64(encoder.encode("")).toString(16)).toBe("ef46db3751d8e999");
		expect(xxHash64(encoder.encode("hello")).toString(16)).toBe("26c7827d889f6da3");
		expect(xxHash64(encoder.encode("a".repeat(64))).toString(16)).toHaveLength(16);
	});

	it("builds a billing header whose fingerprint follows the first user turn", async () => {
		const header = await buildClaudeCodeBillingHeader("Hello world", "2.1.280");
		expect(header.startsWith(`${CLAUDE_BILLING_HEADER_PREFIX} cc_version=2.1.280.`)).toBe(true);
		expect(header).toContain("; cc_entrypoint=cli; cch=00000;");
		expect(await claudeCodeVersionFingerprint("Hello world", "2.1.280")).toMatch(/^[0-9a-f]{3}$/);
		// Offset 4 is part of the fingerprint seed, offset 0 is not.
		expect(await claudeCodeVersionFingerprint("Xello world", "2.1.280")).toBe(
			await claudeCodeVersionFingerprint("Hello world", "2.1.280"),
		);
		expect(await claudeCodeVersionFingerprint("HellX world", "2.1.280")).not.toBe(
			await claudeCodeVersionFingerprint("Hello world", "2.1.280"),
		);
		expect(await claudeCodeVersionFingerprint("Hello world", "2.1.281")).not.toBe(
			await claudeCodeVersionFingerprint("Hello world", "2.1.280"),
		);
	});

	it("seeds the fingerprint from the first wire user turn, not from tool results", () => {
		const messages = [
			{ role: "user" as const, content: "Hello world" },
			{ role: "assistant" as const, content: [] },
			{ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t", content: "x" }] },
		] as unknown as Parameters<typeof firstWireUserPromptText>[0];
		expect(firstWireUserPromptText(messages)).toBe("Hello world");
		expect(firstWireUserPromptText([])).toBe("");
	});

	it("patches the placeholder in the first system block", async () => {
		const body = billingBody(await buildClaudeCodeBillingHeader("Hello world", "2.1.280"));
		expect(patchClaudeCodeCch(body)).toBe("patched");
		const parsed = parseBody(body);
		expect(parsed.system[0].text).toMatch(/ cch=[0-9a-f]{5};$/);
		expect(parsed.system[0].text).not.toContain("cch=00000");
		expect(parsed.system[1].text).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
		// Idempotent: an already attested header reports itself instead of being patched twice.
		expect(patchClaudeCodeCch(body)).toBe("already-attested");
	});

	it("cannot be redirected by user content that copies the billing prefix", async () => {
		const injection = `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=0.0.1.000; cc_entrypoint=cli; cch=00000;`;
		const body = billingBody(await buildClaudeCodeBillingHeader("Hello world", "2.1.280"), injection);
		expect(patchClaudeCodeCch(body)).toBe("patched");
		const parsed = parseBody(body);
		expect(parsed.messages[0].content[0].text).toBe(injection);
		expect(parsed.system[0].text).toMatch(/ cch=[0-9a-f]{5};$/);
	});

	it("survives a tool input that carries a billing-shaped object", async () => {
		const forged = { system: [{ type: "text", text: `${CLAUDE_BILLING_HEADER_PREFIX} cch=00000;` }] };
		const body = encoder.encode(
			JSON.stringify({
				model: "claude-test",
				messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: forged }] }],
				max_tokens: 16,
				system: [
					{ type: "text", text: await buildClaudeCodeBillingHeader("Hello world", "2.1.280") },
					{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
				],
			}),
		);
		expect(patchClaudeCodeCch(body)).toBe("patched");
		const parsed = JSON.parse(decoder.decode(body)) as {
			system: { text: string }[];
			messages: { content: { input: { system: { text: string }[] } }[] }[];
		};
		expect(parsed.system[0].text).toMatch(/ cch=[0-9a-f]{5};$/);
		expect(parsed.messages[0].content[0].input.system[0].text).toContain("cch=00000;");
	});

	it("reports unanchored when the billing block is not the first system block", async () => {
		const body = encoder.encode(
			JSON.stringify({
				model: "claude-test",
				messages: [{ role: "user", content: "hi" }],
				system: [
					{ type: "text", text: "first" },
					{ type: "text", text: await buildClaudeCodeBillingHeader("Hello world", "2.1.280") },
				],
			}),
		);
		const before = decoder.decode(body);
		expect(patchClaudeCodeCch(body)).toBe("unanchored");
		expect(decoder.decode(body)).toBe(before);
	});

	it("leaves bodies without a billing block untouched", () => {
		const body = encoder.encode(JSON.stringify({ model: "m", messages: [], system: [{ type: "text", text: "x" }] }));
		const before = decoder.decode(body);
		expect(patchClaudeCodeCch(body)).toBe("no-billing-header");
		expect(decoder.decode(body)).toBe(before);
	});

	it("patches request bodies on the way out and preserves their length", async () => {
		const sent: unknown[] = [];
		const wrapped = wrapFetchForClaudeCodeCch(async (_input, init) => {
			sent.push(init?.body);
			return new Response("ok");
		});
		const body = billingBody(await buildClaudeCodeBillingHeader("Hello world", "2.1.280"));
		const text = decoder.decode(body);
		await wrapped("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", body: text });
		const patched = sent[0] as string;
		expect(typeof patched).toBe("string");
		expect(encoder.encode(patched).byteLength).toBe(encoder.encode(text).byteLength);
		expect(patched).toMatch(/ cch=[0-9a-f]{5};/);

		// A body without the placeholder is forwarded untouched, string and all.
		await wrapped("https://api.anthropic.com/v1/messages", { method: "POST", body: '{"a":1}' });
		expect(sent[1]).toBe('{"a":1}');
	});

	it("carries a Claude Code shaped metadata user id on OAuth requests", async () => {
		const userId = (await resolveClaudeCodeMetadataUserId(undefined, true, "session-1")) as string;
		const parsed = JSON.parse(userId) as { device_id: string; session_id: string };
		expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/);
		expect(parsed.session_id).toBe("session-1");
		expect(await claudeCodeDeviceId("seed")).toBe(await claudeCodeDeviceId("seed"));
		expect(await claudeCodeDeviceId("seed")).not.toBe(await claudeCodeDeviceId("other"));

		expect(await resolveClaudeCodeMetadataUserId(undefined, false, "s")).toBeUndefined();
		expect(await resolveClaudeCodeMetadataUserId("caller-id", false, "s")).toBe("caller-id");
		expect(await resolveClaudeCodeMetadataUserId("caller-id", true, "s")).not.toBe("caller-id");

		const cloaking = `user_${"a".repeat(64)}_account_1a2b3c4d-1111-4111-8111-111111111111_session_1a2b3c4d-2222-4222-8222-222222222222`;
		expect(isClaudeCodeMetadataUserId(cloaking)).toBe(true);
		expect(isClaudeCodeMetadataUserId(userId)).toBe(true);
		expect(isClaudeCodeMetadataUserId("not-an-id")).toBe(false);
		expect(await resolveClaudeCodeMetadataUserId(cloaking, true, "s")).toBe(cloaking);
	});

	it("pins the wire version from the env and adopts a required one otherwise", () => {
		expect(getClaudeCodeVersion({ PI_AI_CLAUDE_CODE_VERSION: "1.2.3" } as NodeJS.ProcessEnv)).toBe("1.2.3");
		expect(
			adoptRequiredClaudeCodeVersion(new Error("x"), { PI_AI_CLAUDE_CODE_VERSION: "1.2.3" } as NodeJS.ProcessEnv),
		).toBe(false);

		const rejection = new Error(
			'400 {"type":"error","error":{"type":"invalid_request_error","code":"claude_code_version_too_old",' +
				'"message":"Claude Code version 99.0.0 or newer is required"}}',
		);
		expect(adoptRequiredClaudeCodeVersion(rejection)).toBe(true);
		expect(getClaudeCodeVersion()).toBe("99.0.0");
		// Same rejection twice must not loop.
		expect(adoptRequiredClaudeCodeVersion(rejection)).toBe(false);
		expect(
			adoptRequiredClaudeCodeVersion(new Error("claude_code_version_too_old version 1.0.0 or newer is required")),
		).toBe(false);
		expect(adoptRequiredClaudeCodeVersion(new Error("some other 400"))).toBe(false);
	});
});
