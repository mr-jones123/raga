import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MODEL_PROVIDER = "exe-dev-openai";
const MODEL_ID = "gpt-6.1-sol@llm";

function positiveInteger(value, name) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

function failureMessage(model, error, partial) {
	return {
		role: "assistant", content: partial?.content ?? [], api: model.api,
		provider: model.provider, model: model.id,
		usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
	};
}

function publicModel(model) {
	const keys = ["id", "provider", "name", "api", "type", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost", "contextWindow", "maxTokens"];
	return Object.fromEntries(keys.filter((key) => model[key] !== undefined).map((key) => [key, model[key]]));
}

async function send(socket, event) {
	if (socket.destroyed || socket.writableEnded) return;
	const data = `${JSON.stringify(event)}\n`;
	if (Buffer.byteLength(data) > MAX_FRAME_BYTES) throw new Error("Broker response frame exceeds size limit");
	if (!socket.write(data)) await once(socket, "drain");
}

export async function createModelBroker({ config, providerExtensions, hostAgentDir = join(homedir(), ".pi", "agent"), onEvent = () => {} }) {
	if (config.model?.provider !== MODEL_PROVIDER || config.model?.id !== MODEL_ID || config.model?.thinking !== "high") {
		throw new Error(`DeepSWE requires ${MODEL_PROVIDER}/${MODEL_ID} with high thinking`);
	}
	const outputLimit = positiveInteger(config.limits?.maxOutputTokens, "maxOutputTokens");
	if (!Array.isArray(providerExtensions) || providerExtensions.length === 0) throw new Error("Explicit host provider extensions are required");
	const bootstrapDir = await mkdtemp(join(tmpdir(), "raga-ds-host-"));
	const trials = new Map();
	let session;
	let state = "open";
	try {
		const runtime = await ModelRuntime.create({ authPath: join(hostAgentDir, "auth.json"), modelsPath: join(hostAgentDir, "models.json"), allowModelNetwork: false });
		const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, rlm: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: bootstrapDir, agentDir: bootstrapDir, settingsManager,
			additionalExtensionPaths: providerExtensions.map((path) => resolve(path)),
			noExtensions: true, disabledBuiltinExtensions: ["mcp"], noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const extensionErrors = loader.getExtensions().errors;
		if (extensionErrors?.length) throw new Error(`Host provider loading failed: ${JSON.stringify(extensionErrors)}`);
		const inferenceMethods = new Set(["stream", "streamSimple", "complete", "completeSimple", "classify", "generateImages", "streamDeferred", "fetchDeferred"]);
		const bootstrapRuntime = new Proxy(runtime, {
			get(target, key) {
				if (inferenceMethods.has(key)) return () => { throw new Error("Host provider bootstrap cannot perform inference"); };
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		({ session } = await createAgentSession({ cwd: bootstrapDir, agentDir: bootstrapDir, resourceLoader: loader, modelRuntime: bootstrapRuntime, sessionManager: SessionManager.inMemory(bootstrapDir), settingsManager, noTools: "all", rlm: false, thinkingLevel: "high" }));
		const model = runtime.getModel(MODEL_PROVIDER, MODEL_ID);
		if (!model || model.api === "pi-virtual" || model.type && model.type !== "chat") throw new Error(`Required physical model is unavailable: ${MODEL_PROVIDER}/${MODEL_ID}`);
		if (!model.reasoning || model.thinkingLevelMap?.high === null) throw new Error("Required model does not support high reasoning");
		positiveInteger(model.contextWindow, "model.contextWindow");
		positiveInteger(model.maxTokens, "model.maxTokens");
		await session.setModel(model);
		session.setThinkingLevel("high");
		if (session.model?.provider !== MODEL_PROVIDER || session.model?.id !== MODEL_ID || session.thinkingLevel !== "high") throw new Error("Host hook session did not retain the required model and thinking level");
		const safeModel = publicModel(model);

		async function openTrial({ trialId, maxCalls, timeoutMs, pauseAfterCalls }) {
			if (state !== "open") throw new Error("Broker is closed");
			if (typeof trialId !== "string" || !trialId) throw new Error("trialId is required");
			if (trials.has(trialId)) throw new Error(`Duplicate trial ${trialId}`);
			positiveInteger(maxCalls, "maxCalls");
			positiveInteger(timeoutMs, "timeoutMs");
			if (pauseAfterCalls !== undefined) positiveInteger(pauseAfterCalls, "pauseAfterCalls");
			const socketDir = await mkdtemp(join(tmpdir(), "raga-ds-"));
			const startedAt = Date.now();
			const deadline = startedAt + timeoutMs;
			const calls = [];
			const denials = [];
			const active = new Map();
			const sockets = new Set();
			let rootSessionId;
			let trialState = "open";
			let pauseInfo = null;
			let resolvePaused;
			let closePromise;
			const paused = new Promise((resolvePause) => { resolvePaused = resolvePause; });
			const emit = (event) => onEvent({ trialId, ...event });
			const terminal = async (socket, error, partial) => {
				const message = failureMessage(model, error, partial);
				await send(socket, { type: "error", reason: "error", error: message });
				socket.end();
			};
			const deny = async (socket, request, reason) => {
				const denial = { at: Date.now(), sessionId: request?.sessionId ?? null, reason, requestedThinking: request?.reasoning ?? "off", effectiveThinking: "high" };
				denials.push(denial);
				emit({ type: "model_denied", ...denial });
				await terminal(socket, reason);
			};

			async function dispatch(socket, request) {
				if (request?.v !== 1 || request.model?.provider !== MODEL_PROVIDER || request.model?.id !== MODEL_ID || !Array.isArray(request.messages) || typeof request.sessionId !== "string" || !request.sessionId || request.sessionId.length > 256) {
					return deny(socket, request, "INVALID_REQUEST: expected the exact benchmark model and transcript");
				}
				if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)) return deny(socket, request, "INVALID_REQUEST: maxTokens must be positive");
				if (trialState !== "open") return deny(socket, request, `${trialState.toUpperCase()}: trial is not accepting requests`);
				if (Date.now() >= deadline) return deny(socket, request, "DEADLINE: trial deadline exceeded");
				rootSessionId ??= request.sessionId;
				const root = request.sessionId === rootSessionId;
				const lastMessage = request.messages.findLast((message) => message?.role !== "system");
				if (pauseAfterCalls !== undefined && calls.length >= pauseAfterCalls && root && lastMessage?.role === "toolResult" && active.size === 0) {
					trialState = "checkpoint";
					pauseInfo = { trialId, rootSessionId, afterCalls: calls.length, at: Date.now(), toolCallId: lastMessage.toolCallId ?? null, remainingCalls: maxCalls - calls.length, remainingMs: Math.max(0, deadline - Date.now()) };
					resolvePaused(pauseInfo);
					emit({ type: "model_checkpoint", ...pauseInfo });
					return deny(socket, request, "CHECKPOINT: paused at a completed tool boundary");
				}
				if (calls.length >= maxCalls) return deny(socket, request, "CALL_LIMIT: trial model-call budget exhausted");
				const controller = new AbortController();
				const call = { index: calls.length + 1, sessionId: request.sessionId, root, startedAt: Date.now(), requestedThinking: request.reasoning ?? "off", effectiveThinking: "high", maxTokens: Math.min(request.maxTokens ?? outputLimit, outputLimit, model.maxTokens), contextBytes: Buffer.byteLength(JSON.stringify(request.messages)), status: "running", usage: null, dollars: null };
				calls.push(call);
				active.set(socket, controller);
				emit({ type: "model_start", ...call });
				let partial;
				let terminalSent = false;
				const abortOnDisconnect = () => controller.abort(new Error("Client disconnected"));
				socket.once("close", abortOnDisconnect);
				try {
					const stream = runtime.streamSimple(model, { messages: request.messages }, {
						sessionId: request.sessionId, reasoning: "high", maxTokens: call.maxTokens, signal: controller.signal,
						maxRetries: 0, timeoutMs: Math.max(1, deadline - Date.now()),
						onPayload: async (payload) => {
							const rewritten = await session.agent.onPayload?.(payload);
							const effective = rewritten ?? payload;
							if (effective && typeof effective === "object") {
								call.providerModel = typeof effective.model === "string" ? effective.model : null;
								call.providerThinking = effective.reasoning?.effort ?? effective.reasoning_effort ?? null;
								if (call.providerThinking !== null && call.providerThinking !== "high") throw new Error("Provider hook changed required high thinking");
							}
							return effective;
						},
						onResponse: session.agent.onResponse,
						onProviderStreamEvent: session.agent.onProviderStreamEvent,
						transformHeaders: async (headers) => session.extensionRunner.hasHandlers("before_provider_headers") ? session.extensionRunner.emitBeforeProviderHeaders(headers) : headers,
					});
					const iterator = stream[Symbol.asyncIterator]();
					while (true) {
						const next = iterator.next();
						const event = await new Promise((resolveEvent, rejectEvent) => {
							const abort = () => rejectEvent(controller.signal.reason ?? new Error("Request aborted"));
							if (controller.signal.aborted) return abort();
							controller.signal.addEventListener("abort", abort, { once: true });
							next.then(resolveEvent, rejectEvent).finally(() => controller.signal.removeEventListener("abort", abort));
						});
						if (event.done) break;
						const frame = event.value;
						if (frame.partial) partial = frame.partial;
						if (frame.type === "done" || frame.type === "error") {
							const message = frame.type === "done" ? frame.message : frame.error;
							call.usage = message.usage ?? null;
							call.dollars = Number.isFinite(message.usage?.cost?.total) ? message.usage.cost.total : null;
							call.status = frame.type === "error" ? "error" : "completed";
							call.stopReason = message.stopReason;
							call.error = message.errorMessage ?? null;
							if (message.provider !== MODEL_PROVIDER || message.model !== MODEL_ID) throw new Error("Provider returned a different model identity");
							await send(socket, frame);
							terminalSent = true;
							break;
						}
						await send(socket, frame);
					}
					if (!terminalSent) throw new Error("Provider stream ended without a terminal event");
					socket.end();
				} catch (error) {
					call.status = "error";
					call.error = error instanceof Error ? error.message : String(error);
					controller.abort(error);
					if (!terminalSent) await terminal(socket, call.error, partial).catch(() => socket.destroy());
				} finally {
					socket.removeListener("close", abortOnDisconnect);
					active.delete(socket);
					call.finishedAt = Date.now();
					call.wallMs = call.finishedAt - call.startedAt;
					emit({ type: call.status === "completed" ? "model_complete" : "model_error", ...call });
				}
			}

			const server = createServer((socket) => {
				sockets.add(socket);
				socket.on("error", () => {});
				socket.once("close", () => sockets.delete(socket));
				let chunks = [];
				let bytes = 0;
				const receive = (chunk) => {
					bytes += chunk.length;
					if (bytes > MAX_FRAME_BYTES) {
						socket.removeListener("data", receive);
						void deny(socket, null, "INVALID_REQUEST: request frame exceeds size limit").catch(() => socket.destroy());
						return;
					}
					const newline = chunk.indexOf(10);
					chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
					if (newline < 0) return;
					socket.removeListener("data", receive);
					socket.pause();
					try {
						if (chunk.subarray(newline + 1).toString().trim()) throw new Error("One request per connection is required");
						const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						chunks = [];
						void dispatch(socket, request).catch((error) => terminal(socket, error).catch(() => socket.destroy()));
					} catch (error) {
						void deny(socket, null, `INVALID_REQUEST: ${error.message}`).catch(() => socket.destroy());
					}
				};
				socket.on("data", receive);
			});
			const timer = setTimeout(() => {
				if (trialState !== "open") return;
				trialState = "deadline";
				for (const controller of active.values()) controller.abort(new Error("DEADLINE: trial deadline exceeded"));
				for (const socket of sockets) if (!active.has(socket)) void terminal(socket, "DEADLINE: trial deadline exceeded").catch(() => socket.destroy());
				emit({ type: "trial_deadline", deadline });
			}, timeoutMs);
			timer.unref();
			try {
				await mkdir(socketDir, { recursive: true, mode: 0o755 });
				await chmod(socketDir, 0o755);
				await writeFile(join(socketDir, "metadata.json"), `${JSON.stringify({ v: 1, model: safeModel, thinking: "high", maxOutputTokens: Math.min(outputLimit, model.maxTokens), timeoutMs, maxFrameBytes: MAX_FRAME_BYTES })}\n`, { mode: 0o444 });
				server.listen(join(socketDir, "model.sock"));
				await once(server, "listening");
				await chmod(join(socketDir, "model.sock"), 0o666);
			} catch (error) {
				clearTimeout(timer);
				server.close();
				await rm(socketDir, { recursive: true, force: true });
				throw error;
			}
			const trial = {
				socketDir, model: safeModel, paused,
				summary() {
					return structuredClone({ trialId, model: `${MODEL_PROVIDER}/${MODEL_ID}`, thinking: "high", state: trialState, rootSessionId: rootSessionId ?? null, startedAt, deadline, maxCalls, maxOutputTokens: Math.min(outputLimit, model.maxTokens), calls, denials, pause: pauseInfo, remainingCalls: Math.max(0, maxCalls - calls.length), outputTokens: calls.reduce((sum, call) => sum + (call.usage?.output ?? 0), 0), dollars: calls.every((call) => call.dollars !== null) ? calls.reduce((sum, call) => sum + call.dollars, 0) : null });
				},
				close() {
					closePromise ??= (async () => {
						trialState = "closed";
						clearTimeout(timer);
						resolvePaused(pauseInfo);
						for (const controller of active.values()) controller.abort(new Error("CLOSED: trial closed"));
						for (const socket of sockets) socket.destroy();
						await new Promise((resolveClose) => server.close(resolveClose));
						await rm(socketDir, { recursive: true, force: true });
						trials.delete(trialId);
					})();
					return closePromise;
				},
			};
			trials.set(trialId, trial);
			return trial;
		}

		return {
			model: safeModel, openTrial,
			async close() {
				if (state === "closed") return;
				state = "closed";
				try { await Promise.all([...trials.values()].map((trial) => trial.close())); }
				finally { session.dispose(); await rm(bootstrapDir, { recursive: true, force: true }); }
			},
		};
	} catch (error) {
		session?.dispose();
		await rm(bootstrapDir, { recursive: true, force: true });
		throw error;
	}
}
