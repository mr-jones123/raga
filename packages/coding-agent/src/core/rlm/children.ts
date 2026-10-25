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
/** Live child sessions across one RLM tree; more wait in a queue. */
export const RLM_TREE_CHILD_LIMIT = 8;
/** Turns a child gets when `max_turns` is not given. */
export const RLM_CHILD_DEFAULT_MAX_TURNS = 30;

export interface RlmQueryResult {
	answer: string;
	ready: boolean;
	/** The child's session file, or null when the parent session is not persisted. */
	session_file: string | null;
}

/** The child counter of one session. */
export interface RlmChildParent {
	running: number;
}

interface SlotRequest {
	parent: RlmChildParent;
	depth: number;
	maxDepth: number;
}

interface Waiter extends SlotRequest {
	start(): void;
}

/**
 * The child slots of one RLM tree. The root session creates it and every child session shares it, so
 * at most {@link RLM_TREE_CHILD_LIMIT} children are live across the tree and at most
 * {@link RLM_CHILD_CONCURRENCY} per parent. A child at depth `d` starts only while `maxDepth - d` slots
 * stay free for deeper children: parents that wait on their own children hold slots, and without the
 * reserve they could fill the tree and wait forever. With the reserve, the deepest waiting parent's
 * child can always start.
 */
export class RlmChildSlots {
	private live = 0;
	private readonly waiting: Waiter[] = [];
	private readonly limit: number;

	constructor(limit = RLM_TREE_CHILD_LIMIT) {
		this.limit = limit;
	}

	/** Run `child` once a slot for a child of `parent` at `depth` is free. */
	async run<T>(
		parent: RlmChildParent,
		depth: number,
		maxDepth: number,
		signal: AbortSignal,
		child: () => Promise<T>,
	): Promise<T> {
		await this.acquire({ parent, depth, maxDepth }, signal);
		try {
			return await child();
		} finally {
			parent.running--;
			this.live--;
			this.startWaiting();
		}
	}

	private admits({ parent, depth, maxDepth }: SlotRequest): boolean {
		const reserve = Math.min(Math.max(maxDepth - depth, 0), this.limit - 1);
		return parent.running < RLM_CHILD_CONCURRENCY && this.live + 1 + reserve <= this.limit;
	}

	private take({ parent }: SlotRequest): void {
		parent.running++;
		this.live++;
	}

	private acquire(request: SlotRequest, signal: AbortSignal): Promise<void> {
		if (this.admits(request)) {
			this.take(request);
			return Promise.resolve();
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onAbort = () => {
			this.waiting.splice(this.waiting.indexOf(waiter), 1);
			reject(new Error("rlm_query was aborted"));
		};
		// `startWaiting` takes the slot before it calls `start`.
		const waiter: Waiter = {
			...request,
			start: () => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
		};
		this.waiting.push(waiter);
		signal.addEventListener("abort", onAbort, { once: true });
		return promise;
	}

	/** Start every waiting child that fits now, oldest first. */
	private startWaiting(): void {
		for (let i = 0; i < this.waiting.length; ) {
			const waiter = this.waiting[i];
			if (!this.admits(waiter)) {
				i++;
				continue;
			}
			this.waiting.splice(i, 1);
			this.take(waiter);
			waiter.start();
		}
	}
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
	/** The tree's child slots, created by the root session and passed to every child. */
	childSlots: RlmChildSlots;
}

/**
 * The `rlm.query` handler of one session. A child waits in a queue while its parent runs
 * {@link RLM_CHILD_CONCURRENCY} children or the tree runs {@link RLM_TREE_CHILD_LIMIT}.
 */
export function createRlmQueryHandler(
	host: RlmChildHost,
): (data: HostRequest, signal: AbortSignal) => Promise<RlmQueryResult> {
	const parent: RlmChildParent = { running: 0 };
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
		return host.childSlots.run(parent, depth, maxDepth, signal, () =>
			runChild(host, { task, data: data.context, model, depth, maxTurns: maxTurnsValue }, signal),
		);
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
		rlmChildSlots: host.childSlots,
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
