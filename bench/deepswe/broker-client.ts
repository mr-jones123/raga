import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOCKET = "/run/raga-broker/model.sock";
const METADATA = "/run/raga-broker/metadata.json";

type Metadata = {
	v: 1;
	model: Model<Api>;
	thinking: "high";
	maxOutputTokens: number;
	timeoutMs: number;
	maxFrameBytes: number;
};

function failedMessage(model: Model<Api>, error: unknown, partial?: AssistantMessage): AssistantMessage {
	return {
		role: "assistant", content: partial?.content ?? [], api: model.api, provider: model.provider, model: model.id,
		usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
	};
}

export default function brokerClient(pi: ExtensionAPI): void {
	const metadata = JSON.parse(readFileSync(METADATA, "utf8")) as Metadata;
	if (metadata.v !== 1 || metadata.model?.provider !== "exe-dev-openai" || metadata.model.id !== "gpt-6.1-sol@llm" || metadata.thinking !== "high") throw new Error("Invalid DeepSWE broker metadata");
	for (const value of [metadata.maxOutputTokens, metadata.timeoutMs, metadata.maxFrameBytes]) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid DeepSWE broker limits");
	}
	const definition = metadata.model;

	function streamSimple(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}) {
		const stream = createAssistantMessageEventStream();
		let partial: AssistantMessage | undefined;
		let terminal = false;
		const socket = createConnection(SOCKET);
		const timer = setTimeout(() => fail(new Error("DEADLINE: broker connection exceeded its trial timeout")), metadata.timeoutMs + 15_000);
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		const fail = (error: unknown) => {
			if (terminal) return;
			terminal = true;
			cleanup();
			const message = failedMessage(model, error, partial);
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
			socket.destroy();
		};
		const abort = () => fail(options.signal?.reason ?? new Error("Broker request aborted"));
		socket.on("error", fail);
		socket.on("end", () => { if (!terminal) fail(new Error("Broker closed without a terminal event")); });
		socket.on("close", () => { if (!terminal) fail(new Error("Broker connection closed without a terminal event")); });
		if (options.signal?.aborted) {
			fail(options.signal.reason ?? new Error("Broker request aborted"));
			return stream;
		}
		options.signal?.addEventListener("abort", abort, { once: true });
		let chunks: Buffer[] = [];
		let bytes = 0;
		socket.on("data", (chunk: Buffer) => {
			if (terminal) return;
			let offset = 0;
			while (offset < chunk.length && !terminal) {
				const newline = chunk.indexOf(10, offset);
				const piece = chunk.subarray(offset, newline < 0 ? chunk.length : newline);
				bytes += piece.length;
				if (bytes > metadata.maxFrameBytes) { fail(new Error("Broker response exceeds frame size limit")); return; }
				chunks.push(piece);
				if (newline < 0) break;
				try {
					const event = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as AssistantMessageEvent;
					chunks = [];
					bytes = 0;
					if (!event || typeof event.type !== "string") throw new Error("Invalid broker response event");
					if ("partial" in event) partial = event.partial;
					if (event.type === "done" || event.type === "error") {
						const message = event.type === "done" ? event.message : event.error;
						if (message?.provider !== definition.provider || message.model !== definition.id) throw new Error("Broker response has the wrong model identity");
						terminal = true;
						cleanup();
						stream.push(event);
						stream.end(message);
						socket.destroy();
					} else stream.push(event);
				} catch (error) { fail(error); }
				offset = newline + 1;
			}
		});
		socket.once("connect", () => {
			void (async () => {
				if (model.provider !== definition.provider || model.id !== definition.id) throw new Error("Only the exact DeepSWE model is permitted");
				if (typeof options.sessionId !== "string" || !options.sessionId) throw new Error("Broker requires a native session id");
				let payload: unknown = { v: 1, model: { provider: definition.provider, id: definition.id }, messages: context.messages, sessionId: options.sessionId, reasoning: options.reasoning ?? "off", maxTokens: Math.min(options.maxTokens ?? metadata.maxOutputTokens, metadata.maxOutputTokens) };
				const transformed = await options.onPayload?.(payload);
				if (transformed !== undefined) payload = transformed;
				if (terminal) return;
				const frame = `${JSON.stringify(payload)}\n`;
				if (Buffer.byteLength(frame) > metadata.maxFrameBytes) throw new Error("Broker request exceeds frame size limit");
				await options.onResponse?.({ status: 200, headers: new Headers() });
				if (!terminal) socket.write(frame);
			})().catch(fail);
		});
		return stream;
	}

	pi.registerProvider(definition.provider, {
		name: "DeepSWE host broker", baseUrl: "http://raga-broker.invalid", apiKey: "local-unix-socket", api: definition.api,
		models: [{ id: definition.id, name: definition.name, api: definition.api, reasoning: definition.reasoning, thinkingLevelMap: definition.thinkingLevelMap, input: definition.input, inputLimits: definition.inputLimits, cost: definition.cost, contextWindow: definition.contextWindow, maxTokens: Math.min(definition.maxTokens, metadata.maxOutputTokens) }],
		streamSimple,
	});
}
