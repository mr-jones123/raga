/**
 * Child sessions for `rlm_query`: the `rlm.query` host request runs a task in an in-process child
 * `AgentSession` in RLM mode and returns the child's `answer`. See docs/RLM.md "Host requests".
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai/compat";
import { effectiveAgentRoles, resolveAgentRole } from "../agent-roles.ts";
import { createExtensionRuntime } from "../extensions/loader.ts";
import { type MemoryService, readOnlyMemoryService } from "../instances/memory-service.ts";
import { checkSandbox } from "../instances/sandbox.ts";
import { instanceSandbox } from "../instances/session.ts";
import type { ChildChange, ChildWorkspace, HarnessPin, SandboxPolicy } from "../instances/types.ts";
import {
	collectChildChange,
	createChildWorkspace,
	listChildWorkspaces,
	removeChildWorkspace,
	snapshotChildWorkspace,
	snapshotProject,
} from "../instances/workspaces.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { combineUsage } from "../usage-totals.ts";
import { childAgents } from "./child-agents.ts";
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
	/** Why the child stopped; reaching a turn budget is not a provider failure. */
	stop_reason: "completed" | "max_turns";
	turns: number;
	/** The child's session file, or null when the parent session is not persisted. */
	session_file: string | null;
	workspace?: ChildWorkspace;
	change?: ChildChange;
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
	/** Shared identity of the coordinator, including for in-memory child sessions. */
	rootSessionId?: string;
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
			if (signal.aborted) throw new Error("rlm_query was aborted");
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
		if (signal.aborted) return Promise.reject(new Error("rlm_query was aborted"));
		if (this.admits(request)) {
			this.take(request);
			return Promise.resolve();
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onAbort = () => {
			const index = this.waiting.indexOf(waiter);
			if (index !== -1) this.waiting.splice(index, 1);
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
	instance?: HarnessPin;
	memory?: MemoryService;
	sandbox?: SandboxPolicy;
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
	host.childSlots.rootSessionId ??= host.sessionManager.getSessionId();
	return async (data, signal) => {
		const task = data.task;
		if (typeof task !== "string" || task.trim() === "") throw new Error('rlm.query needs a non-empty string "task"');
		const modelRef = data.model;
		if (modelRef !== undefined && modelRef !== null && typeof modelRef !== "string") {
			throw new Error('"model" must be a string');
		}
		if (data.read_only !== undefined && typeof data.read_only !== "boolean")
			throw new Error('"read_only" must be boolean');
		if (data.isolated !== undefined && typeof data.isolated !== "boolean")
			throw new Error('"isolated" must be boolean');
		if (data.isolated === true && data.read_only === true)
			throw new Error('"isolated" and "read_only" cannot both be set');
		const maxTurnsValue = data.max_turns ?? RLM_CHILD_DEFAULT_MAX_TURNS;
		if (typeof maxTurnsValue !== "number" || !Number.isSafeInteger(maxTurnsValue) || maxTurnsValue < 1) {
			throw new Error('"max_turns" must be a positive integer');
		}
		const role = data.role;
		if (role !== undefined && role !== null && (typeof role !== "string" || !role.trim())) {
			throw new Error('"role" must be a non-empty string');
		}
		const seat = data.seat;
		if (
			seat !== undefined &&
			seat !== null &&
			(typeof seat !== "number" || !Number.isSafeInteger(seat) || seat < 0)
		) {
			throw new Error('"seat" must be a non-negative integer');
		}
		if (seat !== undefined && seat !== null && !role) throw new Error('"seat" needs "role"');
		const depth = host.depth + 1;
		const { maxDepth } = host.settingsManager.getRlmSettings();
		if (depth > maxDepth) throw new Error(`RLM recursion depth limit reached (depth ${depth}, max ${maxDepth})`);
		// An explicit model wins; otherwise the role's assignment, then rlm.subModel, then the parent's model.
		const assigned =
			typeof role === "string"
				? resolveAgentRole(
						agentRolesFor(host),
						agentRoleBudget(host),
						role,
						typeof seat === "number" ? seat : undefined,
					)
				: {};
		const model = host.resolveModel(modelRef ?? assigned.model);

		if (signal.aborted) throw new Error("rlm_query was aborted");
		const id = randomUUID();
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		const agent = childAgents.register({
			id,
			rootSessionId: host.childSlots.rootSessionId ?? host.sessionManager.getSessionId(),
			parentSessionId: host.sessionManager.getSessionId(),
			depth,
			task,
			model: `${model.provider}/${model.id}`,
			role: typeof role === "string" ? (typeof seat === "number" ? `${role} #${seat + 1}` : role) : undefined,
			maxTurns: maxTurnsValue,
			cancel: () => controller.abort(),
		});
		try {
			const result = await host.childSlots.run(parent, depth, maxDepth, controller.signal, () => {
				childAgents.start(id);
				return runChild(
					host,
					{
						id,
						name: agent.name,
						task,
						data: data.context,
						model,
						thinkingLevel: modelRef ? undefined : assigned.thinking,
						depth,
						maxTurns: maxTurnsValue,
						readOnly: data.read_only === true,
						isolated: data.isolated === true,
					},
					controller.signal,
				);
			});
			childAgents.finish(id, {
				status: result.stop_reason === "max_turns" ? "partial" : "done",
				stopReason: result.stop_reason,
			});
			return result;
		} catch (error) {
			childAgents.finish(id, {
				status: controller.signal.aborted ? "stopped" : "failed",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	};
}

/** Instance sessions use their pinned revision's roles; ordinary sessions use the user's /agent-setup choices. */
function agentRolesFor(host: Pick<RlmChildHost, "instance" | "settingsManager">) {
	return effectiveAgentRoles(
		host.instance
			? { kind: "instance", resourceRoot: host.instance.resourceRoot }
			: { kind: "settings", settings: host.settingsManager.getAgentRoles() },
	);
}

function agentRoleBudget(host: Pick<RlmChildHost, "instance" | "settingsManager">) {
	return host.instance ? undefined : host.settingsManager.getAgentRoles().budget;
}

/** The `agent.roles` host request: the role table this session's children resolve against. */
export function describeAgentRoles(host: Pick<RlmChildHost, "instance" | "settingsManager">) {
	return {
		source: host.instance ? "instance revision agents/model-roles.json" : "user settings (/agent-setup)",
		budget: agentRoleBudget(host) ?? null,
		roles: Object.fromEntries(agentRolesFor(host)),
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
	options: {
		id: string;
		name: string;
		task: string;
		data: unknown;
		model: Model<Api>;
		/** From the role's budget; otherwise the parent's level. */
		thinkingLevel?: ThinkingLevel;
		depth: number;
		maxTurns: number;
		readOnly: boolean;
		/** Run in a throwaway checkout of the parent's git repository, outside instance mode too. */
		isolated: boolean;
	},
	signal: AbortSignal,
): Promise<RlmQueryResult> {
	const parent = host.sessionManager;
	const parentSession = parent.getSessionFile();
	const parentCwd = realpathSync(host.cwd);
	// Instance writers always get a checkout; an ordinary session's child only when it asks for `isolated`.
	const projectRoot = host.instance?.projectRoot ?? (options.isolated ? await gitTopLevel(host.cwd) : undefined);
	const writable = projectRoot !== undefined && !options.readOnly;
	const existingWorkspace = writable
		? (await listChildWorkspaces(projectRoot)).find(
				(entry) => parentCwd === entry.path || parentCwd.startsWith(`${entry.path}${sep}`),
			)
		: undefined;
	const childrenRoot = host.instance ? join(host.instance.stateRoot, "children") : join(tmpdir(), "raga-children");
	if (writable) await mkdir(childrenRoot, { recursive: true, mode: 0o700 });
	const workspace = writable
		? await createChildWorkspace(
				existingWorkspace ? await snapshotChildWorkspace(existingWorkspace) : await snapshotProject(projectRoot),
				join(childrenRoot, randomUUID()),
			)
		: undefined;
	if (workspace && projectRoot && !host.instance) await cloneDependencies(projectRoot, workspace.path);
	if (workspace) parent.appendCustomEntry("raga-child-workspace", { workspace });
	const sourceRoot = existingWorkspace?.path ?? projectRoot ?? host.cwd;
	const cwd = workspace ? join(workspace.path, relative(realpathSync(sourceRoot), parentCwd)) : host.cwd;
	if (workspace) await mkdir(cwd, { recursive: true, mode: 0o700 });
	const sessionManager = parent.isPersisted()
		? SessionManager.create(cwd, parent.getSessionDir(), { parentSession })
		: SessionManager.inMemory(cwd, { parentSession });
	let change: ChildChange | undefined;
	const captureChange = async () => {
		if (!workspace || change) return;
		change = await collectChildChange(workspace);
		parent.appendCustomEntry("raga-child-change", { workspace, change });
	};
	// An instance keeps its children's checkouts for integration; an isolated child's change lives on in
	// refs/raga/changes, so its checkout goes once the change is captured.
	const release = async () => {
		await captureChange();
		if (workspace && !host.instance) await removeChildWorkspace(workspace);
	};
	// An isolated child's writes are confined to its checkout: bubblewrap on Linux, Seatbelt on macOS.
	// ponytail: without a backend it falls back to the bare checkout; fail closed if that is ever too weak.
	const isolatedSandbox: SandboxPolicy | undefined =
		workspace && !host.instance && (await checkSandbox("writes")).available
			? confinedToWorkspace(workspace.path, cwd)
			: undefined;
	const createChild = (manager: SessionManager) => {
		const baseSandbox = host.instance
			? instanceSandbox(host.instance, cwd, manager, workspace?.path ?? host.sandbox?.workspace ?? cwd)
			: (isolatedSandbox ?? host.sandbox);
		const sandbox = baseSandbox && options.readOnly ? { ...baseSandbox, workspaceReadOnly: true } : baseSandbox;
		return createAgentSession({
			cwd,
			instance: host.instance,
			instanceMemory: host.memory ? (options.readOnly ? readOnlyMemoryService(host.memory) : host.memory) : false,
			sandbox,
			modelRuntime: host.modelRuntime,
			settingsManager: host.instance ? undefined : host.settingsManager,
			resourceLoader: host.instance ? undefined : childResourceLoader(host.resourceLoader),
			sessionManager: manager,
			model: options.model,
			thinkingLevel: options.thinkingLevel ?? host.getThinkingLevel(),
			rlm: true,
			rlmDepth: options.depth,
			rlmData: options.data,
			rlmChildSlots: host.childSlots,
		});
	};
	const { session: child } = await createChild(sessionManager).catch(async (error) => {
		await release();
		throw error;
	});
	child.setSessionName(options.name);
	const sessionFile = child.sessionFile;
	childAgents.attach(options.id, child, {
		// A collected workspace change is final, so a writable instance child no longer takes follow-ups.
		followUps: !workspace,
		reopen: sessionFile
			? async () => (await createChild(SessionManager.open(sessionFile, parent.getSessionDir()))).session
			: undefined,
	});
	try {
		if (signal.aborted) throw new Error("rlm_query was aborted");
		let turns = 0;
		let maxTurnsReached = false;
		const unsubscribe = child.subscribe((event) => {
			if (event.type !== "turn_end" || maxTurnsReached) return;
			turns++;
			if (
				turns >= options.maxTurns &&
				event.message.role === "assistant" &&
				event.message.stopReason === "toolUse"
			) {
				maxTurnsReached = true;
				void child.abort();
			}
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
		await captureChange();
		const artifact = { workspace, change };
		if (answer.ready)
			return {
				answer: answer.content,
				ready: true,
				stop_reason: "completed",
				turns,
				session_file: child.sessionFile ?? null,
				...artifact,
			};
		const last = child.messages.findLast((message) => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "error" && !maxTurnsReached) {
			throw new Error(`The child session failed: ${last.errorMessage ?? "unknown error"}`);
		}
		let partial = child.getLastAssistantText() ?? "";
		if (maxTurnsReached) {
			const lastTool = child.messages.findLast((message) => message.role === "toolResult");
			const toolText =
				lastTool?.role === "toolResult"
					? lastTool.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n")
					: "";
			partial = answer.content || toolText.slice(-8000) || partial;
			partial = `Child reached max_turns=${options.maxTurns}; this result is incomplete. Inspect the child session before retrying; earlier cells may have changed files.${partial ? `\n\n${partial}` : ""}`;
		}
		return {
			answer: partial,
			ready: false,
			stop_reason: maxTurnsReached ? "max_turns" : "completed",
			turns,
			session_file: child.sessionFile ?? null,
			...artifact,
		};
	} finally {
		// The session and kernel stay open for /agents; the registry parks idle children and the parent's
		// runtime disposes them with itself.
		await release();
	}
}

async function gitTopLevel(cwd: string): Promise<string> {
	try {
		return (await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
	} catch {
		throw new Error(`"isolated" needs a git repository; ${cwd} is not inside one`);
	}
}

/**
 * Copy-on-write clones of the project's `node_modules` directories, so tests run in the checkout
 * without an install. APFS (`cp -c`) and reflink filesystems clone without copying data.
 */
// ponytail: node_modules only; add venv/target dirs when a non-JS repo needs them.
async function cloneDependencies(source: string, target: string): Promise<void> {
	const find = async (rel: string, depth: number): Promise<string[]> => {
		const found: string[] = [];
		for (const entry of await readdir(join(source, rel), { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const path = join(rel, entry.name);
			if (entry.name === "node_modules") found.push(path);
			else if (depth < 2) found.push(...(await find(path, depth + 1)));
		}
		return found;
	};
	const flags = process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];
	for (const path of await find("", 0)) {
		await mkdir(dirname(join(target, path)), { recursive: true });
		await promisify(execFile)("cp", [...flags, join(source, path), join(target, path)]);
	}
}

/** Writes only inside the checkout; the running Node's install stays readable so npm and node work. */
function confinedToWorkspace(workspace: string, cwd: string): SandboxPolicy {
	const nodePrefix = realpathSync(dirname(dirname(process.execPath)));
	return {
		workspace,
		cwd,
		readOnly: [nodePrefix],
		writable: [],
		confinement: "writes",
		env: { PATH: [join(nodePrefix, "bin"), process.env.PATH].filter(Boolean).join(delimiter) },
	};
}
