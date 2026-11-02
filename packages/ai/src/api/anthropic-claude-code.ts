/**
 * Claude Code wire attestation for Anthropic OAuth requests.
 *
 * Anthropic's subscription transport expects an OAuth request to look like the one Claude Code's own
 * CLI emits: a `x-anthropic-billing-header` system block whose `cc_version` suffix is derived from the
 * first user turn, and a `cch` checksum over the serialized request body. Both are Anthropic's
 * constants, not ours, so they move when it does — see {@link adoptRequiredClaudeCodeVersion} for the
 * one part that self-heals.
 *
 * Shape and constants follow oh-my-pi's implementation
 * (packages/ai/src/providers/anthropic.ts there); this is a port of that behaviour, not an independent
 * recovery of the wire format.
 *
 * Wired in by `anthropic-messages.ts` for OAuth credentials only. API-key requests never take this path.
 */

import type { BetaMessageParam as MessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { FetchFunction } from "../types.ts";
import { uuidv7 } from "../utils/uuid.ts";

/** Pinned Claude Code CLI version, used when neither the env pin nor a server rejection names one. */
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.280";

/** Entrypoint Claude Code stamps into the billing header for its interactive CLI transport. */
export const CLAUDE_CODE_ENTRYPOINT = "cli";

/** Identity block Claude Code's CLI runtime prepends to every OAuth request. */
export const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/** `PI_AI_CLAUDE_CODE_VERSION` pins the version on the wire and disables server-driven adoption. */
export const CLAUDE_CODE_VERSION_ENV = "PI_AI_CLAUDE_CODE_VERSION";

// SHA-256 salt and offsets Anthropic's fingerprint uses: chars 4/7/20 of the first user turn.
const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_OFFSETS = [4, 7, 20] as const;

const CCH_PLACEHOLDER = "cch=00000";
const CCH_SEED = 0x4d659218e32a3268n;

// Combined anchor for the placeholder: `"system":[{"type":"text","text":"x-anthropic-billing-header:`.
// A JSON string escapes its inner quotes, so user content, tool results and later system prompts can
// never contain this byte sequence; only the first system block we inject can match it.
const BILLING_SYSTEM_MARKER = new TextEncoder().encode(
	`"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`,
);
const CCH_PLACEHOLDER_BYTES = new TextEncoder().encode(CCH_PLACEHOLDER);
/** How far past the anchor the placeholder may sit before the layout is treated as unrecognized. */
const CCH_SEARCH_WINDOW = 150;

const VERSION_TOO_OLD_CODE = "claude_code_version_too_old";
const REQUIRED_VERSION_PATTERN = /version (\d+\.\d+\.\d+) or newer is required/i;

const DEVICE_ID_INSTALL_DOMAIN = "raga-claude-device-id-v1:";
const CLOAKING_USER_ID_PATTERN =
	/^user_[0-9a-f]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let adoptedClaudeCodeVersion: string | null = null;
let warnedUnanchored = false;

/**
 * Claude Code CLI version represented on the wire (user agent, billing header):
 * `PI_AI_CLAUDE_CODE_VERSION` → version adopted from a server rejection → {@link DEFAULT_CLAUDE_CODE_VERSION}.
 */
export function getClaudeCodeVersion(env: NodeJS.ProcessEnv = process.env): string {
	return env[CLAUDE_CODE_VERSION_ENV]?.trim() || adoptedClaudeCodeVersion || DEFAULT_CLAUDE_CODE_VERSION;
}

/** User agent Claude Code's CLI inference entrypoint sends. */
function getClaudeCodeUserAgent(env: NodeJS.ProcessEnv = process.env): string {
	return `claude-cli/${getClaudeCodeVersion(env)} (external, cli)`;
}

/**
 * Per-request Claude Code headers. Sent per request rather than fixed on the client because
 * {@link adoptRequiredClaudeCodeVersion} can move the version mid-process.
 */
export function claudeCodeRequestHeaders(sessionId?: string): Record<string, string> {
	return {
		"user-agent": getClaudeCodeUserAgent(),
		"x-app": "cli",
		...(sessionId ? { "x-claude-code-session-id": sessionId } : {}),
	};
}

function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Adopt the minimum version named by an Anthropic `claude_code_version_too_old` rejection for the rest
 * of the process, so a stale pin costs one rejected request instead of a hard failure.
 *
 * Returns true only when the wire version actually increased — callers retry on true, so a repeated
 * rejection at the same version cannot loop. Always false while the env pin is set.
 */
export function adoptRequiredClaudeCodeVersion(error: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
	if (env[CLAUDE_CODE_VERSION_ENV]?.trim()) return false;
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes(VERSION_TOO_OLD_CODE)) return false;
	const required = REQUIRED_VERSION_PATTERN.exec(message)?.[1];
	if (!required || compareVersions(required, getClaudeCodeVersion(env)) <= 0) return false;
	adoptedClaudeCodeVersion = required;
	return true;
}

/**
 * Text of the first conversational wire user turn — the fingerprint seed. Claude Code uses the first
 * user message, not the system prompt, so a replayed tool-result-only turn contributes nothing.
 */
export function firstWireUserPromptText(messages: readonly MessageParam[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.filter((block): block is Extract<(typeof content)[number], { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return "";
}

/** `SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]`, the prompt-dependent `cc_version` suffix. */
export async function claudeCodeVersionFingerprint(
	firstUserPromptText: string,
	version: string = getClaudeCodeVersion(),
): Promise<string> {
	const selected = FINGERPRINT_OFFSETS.map((index) => firstUserPromptText[index] ?? "0").join("");
	const hex = await sha256Hex(`${FINGERPRINT_SALT}${selected}${version}`);
	return hex.slice(0, 3);
}

/**
 * Billing system block. `cch` starts as a placeholder that {@link wrapFetchForClaudeCodeCch} replaces
 * with the real checksum once the body is serialized.
 */
export async function buildClaudeCodeBillingHeader(
	firstUserPromptText: string,
	version: string = getClaudeCodeVersion(),
): Promise<string> {
	const fingerprint = await claudeCodeVersionFingerprint(firstUserPromptText, version);
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${version}.${fingerprint}; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; ${CCH_PLACEHOLDER};`;
}

const MASK_64 = 0xffffffffffffffffn;
const PRIME_1 = 0x9e3779b185ebca87n;
const PRIME_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME_3 = 0x165667b19e3779f9n;
const PRIME_4 = 0x85ebca77c2b2ae63n;
const PRIME_5 = 0x27d4eb2f165667c5n;

function rotateLeft(value: bigint, bits: bigint): bigint {
	const normalized = value & MASK_64;
	return ((normalized << bits) | (normalized >> (64n - bits))) & MASK_64;
}

function readUint32Le(bytes: Uint8Array, offset: number): bigint {
	return (
		BigInt(bytes[offset]) |
		(BigInt(bytes[offset + 1]) << 8n) |
		(BigInt(bytes[offset + 2]) << 16n) |
		(BigInt(bytes[offset + 3]) << 24n)
	);
}

function readUint64Le(bytes: Uint8Array, offset: number): bigint {
	return readUint32Le(bytes, offset) | (readUint32Le(bytes, offset + 4) << 32n);
}

function xxhRound(accumulator: bigint, input: bigint): bigint {
	return (rotateLeft((accumulator + input * PRIME_2) & MASK_64, 31n) * PRIME_1) & MASK_64;
}

function xxhMergeRound(accumulator: bigint, value: bigint): bigint {
	return ((accumulator ^ xxhRound(0n, value)) * PRIME_1 + PRIME_4) & MASK_64;
}

/** XXH64 over *bytes*; the low 20 bits are what the billing header carries. */
export function xxHash64(bytes: Uint8Array, seed = 0n): bigint {
	const length = bytes.length;
	let offset = 0;
	let hash: bigint;
	if (length >= 32) {
		let v1 = (seed + PRIME_1 + PRIME_2) & MASK_64;
		let v2 = (seed + PRIME_2) & MASK_64;
		let v3 = seed & MASK_64;
		let v4 = (seed - PRIME_1) & MASK_64;
		const limit = length - 32;
		do {
			v1 = xxhRound(v1, readUint64Le(bytes, offset));
			v2 = xxhRound(v2, readUint64Le(bytes, offset + 8));
			v3 = xxhRound(v3, readUint64Le(bytes, offset + 16));
			v4 = xxhRound(v4, readUint64Le(bytes, offset + 24));
			offset += 32;
		} while (offset <= limit);
		hash = (rotateLeft(v1, 1n) + rotateLeft(v2, 7n) + rotateLeft(v3, 12n) + rotateLeft(v4, 18n)) & MASK_64;
		hash = xxhMergeRound(hash, v1);
		hash = xxhMergeRound(hash, v2);
		hash = xxhMergeRound(hash, v3);
		hash = xxhMergeRound(hash, v4);
	} else {
		hash = (seed + PRIME_5) & MASK_64;
	}

	hash = (hash + BigInt(length)) & MASK_64;

	while (offset + 8 <= length) {
		hash = (rotateLeft(hash ^ xxhRound(0n, readUint64Le(bytes, offset)), 27n) * PRIME_1 + PRIME_4) & MASK_64;
		offset += 8;
	}
	if (offset + 4 <= length) {
		hash =
			(rotateLeft(hash ^ ((readUint32Le(bytes, offset) * PRIME_1) & MASK_64), 23n) * PRIME_2 + PRIME_3) & MASK_64;
		offset += 4;
	}
	while (offset < length) {
		hash = (rotateLeft(hash ^ ((BigInt(bytes[offset]) * PRIME_5) & MASK_64), 11n) * PRIME_1) & MASK_64;
		offset += 1;
	}

	hash ^= hash >> 33n;
	hash = (hash * PRIME_2) & MASK_64;
	hash ^= hash >> 29n;
	hash = (hash * PRIME_3) & MASK_64;
	hash ^= hash >> 32n;
	return hash & MASK_64;
}

export type ClaudeCodeCchResult = "patched" | "already-attested" | "no-billing-header" | "unanchored";

const BILLING_PREFIX_BYTES = new TextEncoder().encode(CLAUDE_BILLING_HEADER_PREFIX);
const ATTESTED_SUFFIX = / cch=[0-9a-f]{5};$/;

/**
 * First offset of *needle* in *haystack* at or after *from*, or -1. A plain byte scan keeps this module
 * free of `node:buffer`, which the browser bundle cannot resolve; the payload is scanned once.
 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
	const last = haystack.length - needle.length;
	for (let at = Math.max(0, from); at <= last; at++) {
		if (haystack[at] !== needle[0]) continue;
		let offset = 1;
		while (offset < needle.length && haystack[at + offset] === needle[offset]) offset++;
		if (offset === needle.length) return at;
	}
	return -1;
}

function firstSystemText(body: Uint8Array): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	if (!("system" in parsed)) return undefined;
	const { system } = parsed;
	if (!Array.isArray(system) || system.length === 0) return undefined;
	const [first] = system;
	if (!first || typeof first !== "object" || !("text" in first)) return undefined;
	return typeof first.text === "string" ? first.text : undefined;
}

/**
 * Replace the `cch=00000` placeholder inside the first system block with the real checksum.
 *
 * The anchor is found by bytes, then confirmed by structure: a tool input can carry a JSON object
 * shaped like the billing block, and only the real `system[0]` verifies once patched. A candidate that
 * does not verify is restored before the next one is tried, so a rejected candidate cannot corrupt the
 * body and the checksum — which covers the body with the placeholder in place — stays valid.
 */
export function patchClaudeCodeCch(body: Uint8Array): ClaudeCodeCchResult {
	const markerIndexes: number[] = [];
	for (
		let at = indexOfBytes(body, BILLING_SYSTEM_MARKER);
		at !== -1;
		at = indexOfBytes(body, BILLING_SYSTEM_MARKER, at + 1)
	) {
		markerIndexes.push(at);
	}
	if (markerIndexes.length === 0) {
		// The billing prefix is present but not where we put it: not ours to touch, and worth a warning.
		return indexOfBytes(body, BILLING_PREFIX_BYTES) === -1 ? "no-billing-header" : "unanchored";
	}

	const checksum = (xxHash64(body, CCH_SEED) & 0xfffffn).toString(16).padStart(5, "0");
	for (const markerIndex of markerIndexes) {
		const searchFrom = markerIndex + BILLING_SYSTEM_MARKER.length;
		const placeholderIndex = indexOfBytes(body, CCH_PLACEHOLDER_BYTES, searchFrom);
		if (placeholderIndex === -1 || placeholderIndex - searchFrom > CCH_SEARCH_WINDOW) continue;

		const checksumStart = placeholderIndex + "cch=".length;
		for (let index = 0; index < checksum.length; index++) {
			body[checksumStart + index] = checksum.charCodeAt(index);
		}
		if (firstSystemText(body)?.endsWith(`cch=${checksum};`)) return "patched";

		for (let index = 0; index < CCH_PLACEHOLDER_BYTES.length; index++) {
			body[placeholderIndex + index] = CCH_PLACEHOLDER_BYTES[index];
		}
	}
	return ATTESTED_SUFFIX.test(firstSystemText(body) ?? "") ? "already-attested" : "unanchored";
}

/**
 * Wrap a fetch implementation to patch the `cch` attestation into outgoing request bodies. Bodies
 * without the placeholder pass through untouched, so it is safe to install on every OAuth request.
 *
 * An unanchored body is sent with the placeholder intact rather than failing the request: a request
 * that is not attested is still a valid request, just a less convincing one.
 */
export function wrapFetchForClaudeCodeCch(fetchImpl?: FetchFunction): FetchFunction {
	return (input, init) => {
		const send = fetchImpl ?? globalThis.fetch;
		if (typeof init?.body === "string" && init.body.includes(CCH_PLACEHOLDER)) {
			const body = new TextEncoder().encode(init.body);
			if (patchClaudeCodeCch(body) === "unanchored" && !warnedUnanchored) {
				warnedUnanchored = true;
				console.warn(
					"anthropic: Claude Code billing placeholder present but not anchored; sending an unattested OAuth request",
				);
			}
			// Hand the transport a string, as the SDK did: wrappers and proxies downstream expect that
			// type, and the replacement is byte-length preserving so `content-length` stays correct.
			return send(input, { ...init, body: new TextDecoder().decode(body) });
		}
		return send(input, init);
	};
}

/** Whether *userId* is one of the metadata shapes Claude Code itself sends. */
export function isClaudeCodeMetadataUserId(userId: string): boolean {
	if (CLOAKING_USER_ID_PATTERN.test(userId)) return true;
	if (!userId.startsWith("{")) return false;
	try {
		const parsed: unknown = JSON.parse(userId);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		if (!("session_id" in parsed)) return false;
		return typeof parsed.session_id === "string";
	} catch {
		return false;
	}
}

let cachedInstallSeed: string | undefined;

/**
 * Stable per-runtime identity for the device id: the OS user when the runtime has one, else a
 * per-process id, because a browser exposes no stable install handle to read.
 */
function installSeed(): string {
	if (cachedInstallSeed) return cachedInstallSeed;
	const user = typeof process === "undefined" ? "" : (process.env.USER ?? process.env.USERNAME ?? "").trim();
	cachedInstallSeed = user || uuidv7();
	return cachedInstallSeed;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable per-installation device id for `metadata.user_id`; a digest, never the raw machine identity. */
export async function claudeCodeDeviceId(seed: string = installSeed()): Promise<string> {
	return sha256Hex(`${DEVICE_ID_INSTALL_DOMAIN}\0${seed}`);
}

/**
 * `metadata.user_id` for an OAuth request: the JSON shape Claude Code sends, carrying a stable device
 * id and the conversation's session id. A caller-supplied Claude Code-shaped id is preserved.
 */
export async function resolveClaudeCodeMetadataUserId(
	existing: unknown,
	isOAuthToken: boolean,
	sessionId?: string,
): Promise<string | undefined> {
	if (typeof existing === "string" && existing.length > 0) {
		if (!isOAuthToken || isClaudeCodeMetadataUserId(existing)) return existing;
	}
	if (!isOAuthToken) return undefined;
	return JSON.stringify({ device_id: await claudeCodeDeviceId(), session_id: sessionId ?? uuidv7() });
}
