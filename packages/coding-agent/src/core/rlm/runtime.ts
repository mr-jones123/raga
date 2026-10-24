/**
 * `RlmRuntime` is the RLM mode of one `AgentSession`: it owns the Python kernel, answers the kernel's
 * host requests, sums the sub-LLM and child usage of each cell, snapshots and restores the kernel
 * namespace, and provides the `python` tool. See docs/RLM.md.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { contentText, type ModelsSimpleStreamOptions, uuidv7 } from "@earendil-works/pi-ai";
import type { Api, Model, Usage } from "@earendil-works/pi-ai/compat";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { bashExecutionToText } from "../messages.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { pythonRenderers } from "../tools/renderers/python.ts";
import { combineUsage } from "../usage-totals.ts";
import { createRlmQueryHandler } from "./children.ts";
import { type CellOutput, type HostHandler, type HostRequest, Kernel } from "./kernel.ts";

/** The tools a python cell reaches through `tool.call`. */
export const RLM_HOST_TOOL_NAMES: readonly string[] = ["bash", "edit", "write"];
/** The active tools in RLM mode: `python` is declared, the host tools stay active as hidden declarations. */
export const RLM_ACTIVE_TOOL_NAMES: readonly string[] = ["python", ...RLM_HOST_TOOL_NAMES];
/** Custom entry `{path}` that points to the session's kernel snapshot. */
export const RLM_SNAPSHOT_ENTRY_TYPE = "rlm-kernel-snapshot";

const LLM_BATCH_CONCURRENCY = 8;
const UPDATE_THROTTLE_MS = 100;
const SNAPSHOT_DELAY_MS = 1000;
const RESTORE_NAMES_SHOWN = 20;
const RESTART_NOTICE = "[kernel restarted: the namespace is empty]";

/** RLM options of one session. Its presence turns RLM mode on. */
export interface RlmSessionOptions {
	/** Input names mapped to absolute file paths, read lazily by Python through `context.inputs`. */
	inputs?: Record<string, string>;
	/** `context.data`: any JSON value. An `rlm_query` child gets the parent's `context` argument. */
	data?: unknown;
}

export interface RlmHost {
	cwd: string;
	inputs: Readonly<Record<string, string>>;
	data: unknown;
	/** 0 for a root session; an `rlm_query` child has its parent's depth + 1. */
	depth: number;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	/** Shared with `rlm_query` children. */
	resourceLoader: ResourceLoader;
	sessionManager: SessionManager;
	getSessionModel(): Model<any> | undefined;
	getThinkingLevel(): ThinkingLevel;
	/**
	 * The session's provider hooks (`before_provider_request`, `after_provider_response`), so
	 * extensions that rewrite requests for their providers also apply to sub-LLM calls.
	 */
	getRequestHooks(): Pick<ModelsSimpleStreamOptions, "onPayload" | "onResponse">;
	/** Append a custom entry to the session and announce it to listeners. */
	appendCustomEntry(customType: string, data: unknown): void;
	/** Run one of {@link RLM_HOST_TOOL_NAMES} for the python call `parentToolCallId`. */
	runTool(
		parentToolCallId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ text: string; is_error: boolean }>;
}

const pythonSchema = Type.Object({
	code: Type.String({ description: "Python source for one cell. Top-level await works." }),
});

export interface PythonToolDetails {
	/** Characters cut from the middle of the output; the full output is in `cells[-1]`. */
	cutCharacters: number;
	/** The kernel restarted since the previous cell, so the namespace is empty. */
	restarted: boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** At most {@link RESTORE_NAMES_SHOWN} names, then how many more there are. */
function listNames(names: readonly string[]): string {
	const shown = names.slice(0, RESTORE_NAMES_SHOWN).join(", ");
	return names.length > RESTORE_NAMES_SHOWN ? `${shown}, and ${names.length - RESTORE_NAMES_SHOWN} more` : shown;
}

/** The snapshot path of an `rlm-kernel-snapshot` entry. */
function snapshotEntryPath(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== RLM_SNAPSHOT_ENTRY_TYPE) return undefined;
	const data: unknown = entry.data;
	if (typeof data !== "object" || data === null || !("path" in data) || typeof data.path !== "string")
		return undefined;
	return data.path;
}

function optionalString(data: HostRequest, field: string): string | undefined {
	const value = data[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`"${field}" must be a string`);
	return value;
}

function optionalCount(data: HostRequest, field: string): number | undefined {
	const value = data[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`"${field}" must be a non-negative integer`);
	}
	return value;
}

/** The text of a transcript message for `context.history`. */
function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "toolResult":
		case "custom":
		case "system":
			return contentText(message.content);
		case "assistant":
			return message.content
				.flatMap((block) => {
					if (block.type === "text") return [block.text];
					if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
					return [];
				})
				.join("\n");
		case "bashExecution":
			return bashExecutionToText(message);
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
	}
}

/**
 * The model-facing text of a cell: stdout, stderr, result, traceback, and background output, each
 * labeled and left out when empty. Over `limit` characters, a head (3/4) and a tail (1/4) remain.
 */
export function formatCellOutput(output: CellOutput, limit: number): { text: string; cutCharacters: number } {
	const traceback = output.error
		? output.error.traceback.join("") || `${output.error.ename}: ${output.error.evalue}`
		: "";
	const parts: Array<[string, string]> = [
		["stdout", output.stdout],
		["stderr", output.stderr],
		["result", output.result ?? ""],
		["error", traceback],
		["background", output.background],
	];
	const text = parts
		.filter(([, part]) => part.length > 0)
		.map(([label, part]) => `[${label}]\n${part.replace(/\n$/, "")}`)
		.join("\n");
	if (text.length === 0) return { text: "(no output)", cutCharacters: 0 };
	if (text.length <= limit) return { text, cutCharacters: 0 };
	const head = Math.floor((limit * 3) / 4);
	const tail = limit - head;
	const cutCharacters = text.length - head - tail;
	return {
		text: `${text.slice(0, head)}\n[... ${cutCharacters} characters cut; full output in cells[-1] ...]\n${tail > 0 ? text.slice(-tail) : ""}`,
		cutCharacters,
	};
}

export class RlmRuntime {
	readonly toolDefinition: ToolDefinition<typeof pythonSchema, PythonToolDetails>;
	private readonly host: RlmHost;
	private readonly kernel: Kernel;
	private disposed = false;
	/** Settles with the eager start's error, reported by the first python call. */
	private startFailure: Promise<unknown> | undefined;
	private task: string | undefined;
	/** Pid of the kernel process that has the current context, and of the one that ran the last cell. */
	private contextPid: number | undefined;
	private lastCellPid: number | undefined;
	/** The python call whose cell is running; nested tool calls are attributed to it. */
	private currentToolCallId: string | undefined;
	private cellUsage: Usage | undefined;
	/** The first kernel process looked for a snapshot entry to restore. */
	private restoreChecked = false;
	/** A cell ended `ok` since the last snapshot. */
	private snapshotDue = false;
	private snapshotTimer: NodeJS.Timeout | undefined;
	/** The snapshot being written; never rejects. */
	private snapshotRun: Promise<void> = Promise.resolve();
	private snapshotEntryWritten = false;
	/** Snapshot problems for the next python result, each reported once. */
	private pendingNotes: string[] = [];
	private readonly reportedNotes = new Set<string>();

	constructor(host: RlmHost) {
		this.host = host;
		const rlmQuery = createRlmQueryHandler({
			cwd: host.cwd,
			depth: host.depth,
			settingsManager: host.settingsManager,
			modelRuntime: host.modelRuntime,
			resourceLoader: host.resourceLoader,
			sessionManager: host.sessionManager,
			getThinkingLevel: () => host.getThinkingLevel(),
			resolveModel: (ref) => this.resolveModel(ref),
			addUsage: (usage) => this.addCellUsage(usage),
		});
		const handlers = new Map<string, HostHandler>([
			["tool.call", (data, ctx) => this.handleToolCall(data, ctx.signal)],
			["llm.query", (data, ctx) => this.handleLlmQuery(data, ctx.signal)],
			["llm.batch", (data, ctx) => this.handleLlmBatch(data, ctx.signal)],
			["context.history", async (data) => this.handleHistory(data)],
			["rlm.query", (data, ctx) => rlmQuery(data, ctx.signal)],
		]);
		this.kernel = new Kernel({ cwd: host.cwd, handlers });
		this.startFailure = this.kernel.start().then(
			() => undefined,
			(error: unknown) => error ?? new Error("unknown error"),
		);
		this.toolDefinition = {
			name: "python",
			label: "python",
			description:
				"Run one Python cell in the session's persistent kernel and return its output. Top-level await works. The kernel binds read, bash, edit, write, llm_query, llm_batch, rlm_query, context, answer, and cells; see the rlm section of the system prompt.",
			promptSnippet: "Run Python in the persistent kernel; it reaches files, shell, sub-LLM calls, and sub-agents",
			parameters: pythonSchema,
			executionMode: "sequential",
			prepareLoadout: () => ({ hiddenDeclarations: [...RLM_HOST_TOOL_NAMES] }),
			execute: (toolCallId, params, signal, onUpdate) => this.execute(toolCallId, params, signal, onUpdate),
			...pythonRenderers,
		};
	}

	/** Kill the kernel synchronously. A pending snapshot is dropped; call {@link flushSnapshot} first to keep it. */
	dispose(): void {
		this.disposed = true;
		clearTimeout(this.snapshotTimer);
		this.snapshotTimer = undefined;
		this.kernel.dispose();
	}

	/** Write a scheduled snapshot now and wait for the snapshot in progress. */
	async flushSnapshot(): Promise<void> {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
			this.queueSnapshot();
		}
		await this.snapshotRun;
	}

	/** The namespace's `answer`. A kernel that is gone has no answer. */
	async getAnswer(): Promise<{ content: string; ready: boolean }> {
		try {
			return await this.kernel.getAnswer();
		} catch {
			return { content: "", ready: false };
		}
	}

	private async execute(
		toolCallId: string,
		{ code }: Static<typeof pythonSchema>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<PythonToolDetails> | undefined,
	): Promise<AgentToolResult<PythonToolDetails>> {
		const startFailure = await this.startFailure;
		this.startFailure = undefined;
		if (startFailure) return this.failure(`The Python kernel failed to start: ${errorMessage(startFailure)}`);

		// Debounce: the snapshot waits until no cell has run for SNAPSHOT_DELAY_MS.
		clearTimeout(this.snapshotTimer);
		this.snapshotTimer = undefined;
		const { outputLimit } = this.host.settingsManager.getRlmSettings();
		this.currentToolCallId = toolCallId;
		this.cellUsage = undefined;
		let streamed = "";
		let lastUpdate = 0;
		const onOutput = (_stream: "stdout" | "stderr", text: string) => {
			streamed = (streamed + text).slice(-outputLimit);
			const now = Date.now();
			if (!onUpdate || now - lastUpdate < UPDATE_THROTTLE_MS) return;
			lastUpdate = now;
			onUpdate({ content: [{ type: "text", text: streamed }], details: { cutCharacters: 0, restarted: false } });
		};

		const notices: string[] = [];
		let output: CellOutput;
		let restarted: boolean;
		try {
			await this.kernel.start();
			restarted = this.lastCellPid !== undefined && this.kernel.pid !== this.lastCellPid;
			if (this.kernel.pid !== this.contextPid) {
				await this.kernel.setContext(this.getTask(), { ...this.host.inputs }, this.host.data);
				this.contextPid = this.kernel.pid;
			}
			if (!this.restoreChecked) {
				this.restoreChecked = true;
				const restoreNotice = await this.restoreSnapshot();
				if (restoreNotice) notices.push(restoreNotice);
			}
			output = await this.kernel.execute(code, { signal, onOutput });
		} catch (error) {
			return this.failure(`The Python kernel is unavailable: ${errorMessage(error)}`);
		}
		restarted ||= output.restarted;
		this.lastCellPid = this.kernel.pid;
		const usage = this.cellUsage;
		this.cellUsage = undefined;
		if (restarted) notices.push(RESTART_NOTICE);
		notices.push(...this.pendingNotes);
		this.pendingNotes = [];

		// A restarted kernel has an empty namespace; saving it would overwrite the last good snapshot.
		this.snapshotDue = !restarted && (this.snapshotDue || output.status === "ok");
		if (this.snapshotDue) {
			this.snapshotTimer = setTimeout(() => {
				this.snapshotTimer = undefined;
				this.queueSnapshot();
			}, SNAPSHOT_DELAY_MS);
			this.snapshotTimer.unref();
		}

		const { text, cutCharacters } = formatCellOutput(output, outputLimit);
		return {
			content: [{ type: "text", text: [...notices, text].join("\n") }],
			details: { cutCharacters, restarted },
			...(usage ? { usage } : {}),
			...(output.status === "error" ? { isError: true } : {}),
		};
	}

	private failure(text: string): AgentToolResult<PythonToolDetails> {
		return { content: [{ type: "text", text }], details: { cutCharacters: 0, restarted: false }, isError: true };
	}

	private addCellUsage(usage: Usage): void {
		this.cellUsage = this.cellUsage ? combineUsage(this.cellUsage, usage) : usage;
	}

	/** `context.task`: the first user prompt of the session, read from the branch once it exists. */
	private getTask(): string {
		if (this.task) return this.task;
		for (const entry of this.host.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") {
				this.task = contentText(entry.message.content);
				return this.task;
			}
		}
		return "";
	}

	/**
	 * `<sessionDir>/<sessionId>.rlm/kernel.dill`, or `<tmpdir>/raga-rlm/<sessionId>/kernel.dill` for an
	 * in-memory session. A fork has its own session id, so it never writes its parent's file.
	 */
	private snapshotPath(): string {
		const sessionManager = this.host.sessionManager;
		const sessionId = sessionManager.getSessionId();
		return sessionManager.isPersisted()
			? join(sessionManager.getSessionDir(), `${sessionId}.rlm`, "kernel.dill")
			: join(tmpdir(), "raga-rlm", sessionId, "kernel.dill");
	}

	private queueSnapshot(): void {
		this.snapshotDue = false;
		const pid = this.kernel.pid;
		this.snapshotRun = this.snapshotRun.then(() => this.writeSnapshot(pid));
	}

	/** Snapshot the namespace of kernel process `pid`. Problems become notes, never errors. */
	private async writeSnapshot(pid: number | undefined): Promise<void> {
		if (this.disposed || pid === undefined || this.kernel.pid !== pid) return;
		const path = this.snapshotPath();
		try {
			const { skipped } = await this.kernel.snapshot(path);
			if (skipped.length > 0) {
				this.note(
					`[kernel snapshot left out ${skipped.length} variables that cannot be pickled or exceed the size caps: ${listNames(skipped)}]`,
				);
			}
		} catch (error) {
			if (!this.disposed) this.note(`[${errorMessage(error)}; the namespace will not survive a resume]`);
			return;
		}
		if (this.snapshotEntryWritten) return;
		this.snapshotEntryWritten = this.host.sessionManager
			.getEntries()
			.some((entry) => snapshotEntryPath(entry) === path);
		if (!this.snapshotEntryWritten) {
			this.host.appendCustomEntry(RLM_SNAPSHOT_ENTRY_TYPE, { path });
			this.snapshotEntryWritten = true;
		}
	}

	private note(text: string): void {
		if (this.reportedNotes.has(text)) return;
		this.reportedNotes.add(text);
		this.pendingNotes.push(text);
	}

	/** Restore the snapshot of the newest snapshot entry on the branch, if its file exists. */
	private async restoreSnapshot(): Promise<string | undefined> {
		let path: string | undefined;
		for (const entry of this.host.sessionManager.getBranch()) path = snapshotEntryPath(entry) ?? path;
		if (!path || !existsSync(path)) return undefined;
		try {
			const { restored, failed } = await this.kernel.restore(path);
			const restoredText = restored.length > 0 ? `: ${listNames(restored)}` : "";
			const failedText = failed.length > 0 ? `; ${failed.length} failed: ${listNames(failed)}` : "";
			return `[kernel restored ${restored.length} variables${restoredText}${failedText}]`;
		} catch (error) {
			return `[${errorMessage(error)}]`;
		}
	}

	private async handleToolCall(data: HostRequest, signal: AbortSignal): Promise<{ text: string; is_error: boolean }> {
		const name = data.name;
		const args = data.args ?? {};
		if (typeof name !== "string") throw new Error('tool.call needs a string "name"');
		if (typeof args !== "object" || args === null || Array.isArray(args)) {
			throw new Error('tool.call needs an object "args"');
		}
		if (!this.currentToolCallId) throw new Error("tool.call outside a python call");
		return this.host.runTool(this.currentToolCallId, name, args as Record<string, unknown>, signal);
	}

	private async handleLlmQuery(data: HostRequest, signal: AbortSignal): Promise<{ text: string }> {
		const prompt = data.prompt;
		if (typeof prompt !== "string") throw new Error('llm.query needs a string "prompt"');
		const model = this.resolveModel(optionalString(data, "model"));
		return { text: await this.complete(model, prompt, optionalString(data, "system"), signal) };
	}

	private async handleLlmBatch(data: HostRequest, signal: AbortSignal): Promise<{ texts: string[] }> {
		const prompts = data.prompts;
		if (!Array.isArray(prompts) || !prompts.every((prompt): prompt is string => typeof prompt === "string")) {
			throw new Error('llm.batch needs a list of strings "prompts"');
		}
		const model = this.resolveModel(optionalString(data, "model"));
		const system = optionalString(data, "system");
		// The first failure stops the calls that have not finished.
		const failed = new AbortController();
		const batchSignal = AbortSignal.any([signal, failed.signal]);
		const texts = new Array<string>(prompts.length);
		let next = 0;
		const worker = async () => {
			while (next < prompts.length) {
				const index = next++;
				texts[index] = await this.complete(model, prompts[index], system, batchSignal);
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(LLM_BATCH_CONCURRENCY, prompts.length) }, worker));
		} catch (error) {
			failed.abort();
			throw error;
		}
		return { texts };
	}

	/** The payload's model, then the `rlm.subModel` setting, then the session model. */
	private resolveModel(ref: string | undefined): Model<Api> {
		const spec = ref ?? this.host.settingsManager.getRlmSettings().subModel;
		if (spec === undefined) {
			const model = this.host.getSessionModel();
			if (!model) throw new Error("No model is selected for sub-LLM calls");
			return model;
		}
		const slash = spec.indexOf("/");
		const model =
			slash > 0 ? this.host.modelRuntime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
		if (!model) throw new Error(`Unknown model "${spec}"; use "provider/id"`);
		return model;
	}

	private async complete(
		model: Model<Api>,
		prompt: string,
		system: string | undefined,
		signal: AbortSignal,
	): Promise<string> {
		const message = await this.host.modelRuntime.completeSimple(
			model,
			{
				...(system === undefined ? {} : { systemPrompt: system }),
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			// A fresh session id keeps sub-LLM calls out of the session's prompt cache warming.
			{ ...this.host.getRequestHooks(), signal, sessionId: uuidv7() },
		);
		this.addCellUsage(message.usage);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `The sub-LLM call ended with ${message.stopReason}`);
		}
		return contentText(message.content);
	}

	private handleHistory(data: HostRequest): { messages: Array<{ role: string; text: string }>; total: number } {
		const offset = optionalCount(data, "offset") ?? 0;
		const limit = optionalCount(data, "limit");
		// The whole branch, including messages before a compaction.
		const messages = this.host.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role !== "system" ? [entry.message] : []));
		return {
			messages: messages
				.slice(offset, limit === undefined ? undefined : offset + limit)
				.map((message) => ({ role: message.role, text: messageText(message) })),
			total: messages.length,
		};
	}
}
