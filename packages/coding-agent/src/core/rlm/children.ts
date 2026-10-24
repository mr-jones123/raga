/**
 * Child sessions for `rlm_query`: the `rlm.query` host request runs a task in an in-process child
 * `AgentSession` in RLM mode and returns the child's `answer`. See docs/RLM.md "Host requests".
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai/compat";
import { createExtensionRuntime } from "../extensions/loader.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { combineUsage } from "../usage-totals.ts";
import type { HostRequest } from "./kernel.ts";

/** Children of one session that run at once; more wait in a queue. */
export const RLM_CHILD_CONCURRENCY = 4;
/** Turns a child gets when `max_turns` is not given. */
export const RLM_CHILD_DEFAULT_MAX_TURNS = 30;

export interface RlmQueryResult {
	answer: string;
	ready: boolean;
	/** The child's session file, or null when the parent session is not persisted. */
	session_file: string | null;
}

/** What a child shares with its parent session. */
export interface RlmChildHost {
	cwd: string;
	/** Depth of the parent session: 0 for a root session. */
	depth: number;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	resourceLoader: ResourceLoader;
	sessionManager: SessionManager;
	getThinkingLevel(): ThinkingLevel;
	/** The payload's model, then the `rlm.subModel` setting, then the parent's model. */
	resolveModel(ref: string | undefined): Model<Api>;
	/** Add the child's usage to the parent's running python cell. */
	addUsage(usage: Usage): void;
}

/** The `rlm.query` handler of one session. Children beyond {@link RLM_CHILD_CONCURRENCY} wait in a queue. */
export function createRlmQueryHandler(
	host: RlmChildHost,
): (data: HostRequest, signal: AbortSignal) => Promise<RlmQueryResult> {
	let running = 0;
	const waiting: Array<() => void> = [];
	const acquire = async (signal: AbortSignal): Promise<void> => {
		if (running < RLM_CHILD_CONCURRENCY) {
			running++;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onAbort = () => {
			waiting.splice(waiting.indexOf(start), 1);
			reject(new Error("rlm_query was aborted"));
		};
		// `release` hands its slot over, so `running` stays the same.
		const start = () => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		waiting.push(start);
		signal.addEventListener("abort", onAbort, { once: true });
		return promise;
	};
	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else running--;
	};

	return async (data, signal) => {
		const task = data.task;
		if (typeof task !== "string" || task.trim() === "") throw new Error('rlm.query needs a non-empty string "task"');
		const modelRef = data.model;
		if (modelRef !== undefined && modelRef !== null && typeof modelRef !== "string") {
			throw new Error('"model" must be a string');
		}
		const maxTurnsValue = data.max_turns ?? RLM_CHILD_DEFAULT_MAX_TURNS;
		if (typeof maxTurnsValue !== "number" || !Number.isSafeInteger(maxTurnsValue) || maxTurnsValue < 1) {
			throw new Error('"max_turns" must be a positive integer');
		}
		const depth = host.depth + 1;
		const { maxDepth } = host.settingsManager.getRlmSettings();
		if (depth > maxDepth) throw new Error(`RLM recursion depth limit reached (depth ${depth}, max ${maxDepth})`);
		const model = host.resolveModel(modelRef ?? undefined);

		if (signal.aborted) throw new Error("rlm_query was aborted");
		await acquire(signal);
		try {
			return await runChild(host, { task, data: data.context, model, depth, maxTurns: maxTurnsValue }, signal);
		} finally {
			release();
		}
	};
}

/**
 * The parent's resources, with an extension runtime of the child's own. A session binds its actions
 * into the extension runtime and invalidates it on dispose; with the parent's runtime, the child would
 * take over the parent's extension API and leave it stale after the child answers. The child still runs
 * the parent's extensions' event handlers, such as `before_provider_request`.
 */
function childResourceLoader(parent: ResourceLoader): ResourceLoader {
	const parentExtensions = parent.getExtensions();
	const runtime = createExtensionRuntime();
	runtime.flagValues = new Map(parentExtensions.runtime.flagValues);
	const extensions = { ...parentExtensions, runtime };
	return {
		getExtensions: () => extensions,
		getSkills: () => parent.getSkills(),
		getPrompts: () => parent.getPrompts(),
		getThemes: () => parent.getThemes(),
		getAgentsFiles: () => parent.getAgentsFiles(),
		getSystemPrompt: () => parent.getSystemPrompt(),
		getSystemPromptSource: () => parent.getSystemPromptSource(),
		getAppendSystemPrompt: () => parent.getAppendSystemPrompt(),
		getAppendSystemPromptSources: () => parent.getAppendSystemPromptSources(),
		extendResources: (paths) => parent.extendResources(paths),
		reload: (options) => parent.reload(options),
	};
}

async function runChild(
	host: RlmChildHost,
	options: { task: string; data: unknown; model: Model<Api>; depth: number; maxTurns: number },
	signal: AbortSignal,
): Promise<RlmQueryResult> {
	const parent = host.sessionManager;
	const parentSession = parent.getSessionFile();
	const sessionManager = parent.isPersisted()
		? SessionManager.create(host.cwd, parent.getSessionDir(), { parentSession })
		: SessionManager.inMemory(host.cwd, { parentSession });
	const { session: child } = await createAgentSession({
		cwd: host.cwd,
		modelRuntime: host.modelRuntime,
		settingsManager: host.settingsManager,
		resourceLoader: childResourceLoader(host.resourceLoader),
		sessionManager,
		model: options.model,
		thinkingLevel: host.getThinkingLevel(),
		rlm: true,
		rlmDepth: options.depth,
		rlmData: options.data,
	});
	try {
		if (signal.aborted) throw new Error("rlm_query was aborted");
		let turns = 0;
		const unsubscribe = child.subscribe((event) => {
			if (event.type === "turn_end" && ++turns >= options.maxTurns) void child.abort();
		});
		const onAbort = () => void child.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await child.prompt(options.task, { expandPromptTemplates: false });
		} finally {
			signal.removeEventListener("abort", onAbort);
			unsubscribe();
		}

		let usage: Usage | undefined;
		for (const entry of sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			const messageUsage = message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
			if (messageUsage) usage = usage ? combineUsage(usage, messageUsage) : messageUsage;
		}
		if (usage) host.addUsage(usage);
		if (signal.aborted) throw new Error("rlm_query was aborted");
		const answer = await child.getRlmAnswer();
		if (answer.ready) return { answer: answer.content, ready: true, session_file: child.sessionFile ?? null };
		const last = child.messages.findLast((message) => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "error") {
			throw new Error(`The child session failed: ${last.errorMessage ?? "unknown error"}`);
		}
		return { answer: child.getLastAssistantText() ?? "", ready: false, session_file: child.sessionFile ?? null };
	} finally {
		child.dispose();
	}
}
