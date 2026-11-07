/**
 * Live child sessions created by `rlm_query`. Each record owns a real `AgentSession` (and its Python
 * kernel) while the child runs and after it answers, so `/agents-tui` opens the child itself rather than a
 * copy of its output. See docs/AGENTS.md.
 */
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";

export type ChildAgentStatus = "queued" | "running" | "done" | "partial" | "failed" | "stopped";

export interface ChildAgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

/** A read-only copy of one child's state for views. */
export interface ChildAgentInfo {
	id: string;
	/** Generated display name, such as `SwiftFalcon`; unique within the process. */
	name: string;
	rootSessionId: string;
	parentSessionId: string;
	/** The parent child's id; undefined for children of the root session. */
	parentId?: string;
	depth: number;
	task: string;
	/** `provider/id` of the child's current model. */
	model: string;
	/** The workflow role it was launched for, such as "arena runners #2". */
	role?: string;
	/** Outcome of the `rlm_query` run; a later user prompt does not change it. */
	status: ChildAgentStatus;
	/** The child's session is producing a response, including a user follow-up after it answered. */
	busy: boolean;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	lastActivityAt: number;
	turns: number;
	maxTurns: number;
	stopReason?: string;
	error?: string;
	/** First line of the running cell, or the last one while idle. */
	activity?: string;
	usage: ChildAgentUsage;
	sessionId?: string;
	sessionFile?: string;
	/** The session is in memory. A parked child was disposed and is reopened from its session file. */
	live: boolean;
	parked: boolean;
	/** The child can be opened, live or by reopening its session file. */
	openable: boolean;
	/** The user can send it messages: always while it runs; after it answers unless its result was already collected. */
	promptable: boolean;
}

export interface ChildAgentRegistration {
	id: string;
	rootSessionId: string;
	parentSessionId: string;
	depth: number;
	task: string;
	model: string;
	role?: string;
	maxTurns: number;
	/** Stops the `rlm_query` run while it is queued or running. */
	cancel: () => void;
}

export interface ChildAgentAttachment {
	/** Reopen a parked child from its session file. */
	reopen?: () => Promise<AgentSession>;
	/** Whether the user may prompt the child after `rlm_query` returned. */
	followUps: boolean;
}

interface Entry {
	info: ChildAgentInfo;
	session?: AgentSession;
	unsubscribe?: () => void;
	cancel?: () => void;
	reopen?: () => Promise<AgentSession>;
	reopening?: Promise<AgentSession>;
	/** Flushing and disposing the parked session; reopening waits for it so two sessions never share a file. */
	parking?: Promise<void>;
	followUps: boolean;
	/** Views showing this child; a viewed child is never parked. */
	viewers: number;
}

/** Finished children per root whose sessions and kernels stay in memory; older ones are parked. */
export const CHILD_AGENT_LIVE_IDLE_LIMIT = 4;
/** Finished records kept per root; the oldest parked ones are forgotten beyond this. */
export const CHILD_AGENT_RECORD_LIMIT = 200;

const ADJECTIVES = [
	"Amber",
	"Bold",
	"Brave",
	"Bright",
	"Brisk",
	"Calm",
	"Clever",
	"Cosmic",
	"Crisp",
	"Curious",
	"Dapper",
	"Deft",
	"Eager",
	"Early",
	"Fancy",
	"Fleet",
	"Gentle",
	"Glad",
	"Golden",
	"Grand",
	"Happy",
	"Hardy",
	"Humble",
	"Jolly",
	"Keen",
	"Kind",
	"Lively",
	"Lucky",
	"Lunar",
	"Mellow",
	"Merry",
	"Mighty",
	"Misty",
	"Nimble",
	"Noble",
	"Plucky",
	"Polar",
	"Proud",
	"Quick",
	"Quiet",
	"Rapid",
	"Rustic",
	"Sage",
	"Silent",
	"Sleek",
	"Smart",
	"Snowy",
	"Solar",
	"Spry",
	"Steady",
	"Stellar",
	"Stormy",
	"Sunny",
	"Swift",
	"Tidy",
	"Tranquil",
	"Trusty",
	"Vivid",
	"Wild",
	"Wise",
	"Witty",
	"Zany",
	"Zesty",
	"Velvet",
];
const ANIMALS = [
	"Badger",
	"Bat",
	"Bear",
	"Beaver",
	"Bison",
	"Bobcat",
	"Crane",
	"Crow",
	"Deer",
	"Dolphin",
	"Eagle",
	"Egret",
	"Falcon",
	"Ferret",
	"Finch",
	"Fox",
	"Gecko",
	"Gibbon",
	"Goose",
	"Hare",
	"Hawk",
	"Heron",
	"Ibis",
	"Jackal",
	"Jaguar",
	"Kestrel",
	"Koala",
	"Lemur",
	"Lion",
	"Lynx",
	"Magpie",
	"Marten",
	"Mole",
	"Moose",
	"Moth",
	"Newt",
	"Ocelot",
	"Orca",
	"Osprey",
	"Otter",
	"Owl",
	"Panda",
	"Panther",
	"Pelican",
	"Puffin",
	"Quail",
	"Rabbit",
	"Raven",
	"Robin",
	"Salmon",
	"Seal",
	"Shrike",
	"Sparrow",
	"Stoat",
	"Swan",
	"Tapir",
	"Tiger",
	"Toucan",
	"Turtle",
	"Viper",
	"Walrus",
	"Weasel",
	"Wolf",
	"Wren",
];

const emptyUsage = (): ChildAgentUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
});

const finished = (info: ChildAgentInfo) => info.status !== "queued" && info.status !== "running";

export class ChildAgentRegistry {
	private readonly entries = new Map<string, Entry>();
	private readonly listeners = new Set<() => void>();
	private readonly usedNames = new Set<string>();
	private readonly random: () => number;

	constructor(random: () => number = Math.random) {
		this.random = random;
	}

	/** A display name not used by another child of this process. */
	generateName(): string {
		const pick = (list: string[]) => list[Math.floor(this.random() * list.length) % list.length];
		for (let attempt = 0; attempt < 50; attempt++) {
			const name = `${pick(ADJECTIVES)}${pick(ANIMALS)}`;
			if (!this.usedNames.has(name)) {
				this.usedNames.add(name);
				return name;
			}
		}
		for (let suffix = 2; ; suffix++) {
			const name = `${pick(ADJECTIVES)}${pick(ANIMALS)}${suffix}`;
			if (!this.usedNames.has(name)) {
				this.usedNames.add(name);
				return name;
			}
		}
	}

	register(input: ChildAgentRegistration): ChildAgentInfo {
		const parent = [...this.entries.values()].find((entry) => entry.info.sessionId === input.parentSessionId);
		const now = Date.now();
		const info: ChildAgentInfo = {
			id: input.id,
			name: this.generateName(),
			rootSessionId: input.rootSessionId,
			parentSessionId: input.parentSessionId,
			parentId: parent?.info.id,
			depth: input.depth,
			task: input.task,
			model: input.model,
			role: input.role,
			status: "queued",
			busy: false,
			createdAt: now,
			lastActivityAt: now,
			turns: 0,
			maxTurns: input.maxTurns,
			usage: emptyUsage(),
			live: false,
			parked: false,
			openable: false,
			promptable: false,
		};
		this.entries.set(info.id, { info, cancel: input.cancel, followUps: false, viewers: 0 });
		this.changed();
		return { ...info };
	}

	/** The child's session exists. The registry observes it for usage, activity, and turns. */
	attach(id: string, session: AgentSession, attachment: ChildAgentAttachment): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.detach(entry);
		entry.session = session;
		entry.reopen = attachment.reopen ?? entry.reopen;
		entry.followUps = attachment.followUps;
		entry.info.sessionId = session.sessionId;
		entry.info.sessionFile = session.sessionFile;
		entry.info.parked = false;
		entry.unsubscribe = session.subscribe((event) => this.observe(entry, event));
		this.refresh(entry);
		this.changed();
	}

	/** Mark a queued child as running. */
	start(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.info.status = "running";
		entry.info.startedAt = Date.now();
		entry.info.lastActivityAt = entry.info.startedAt;
		this.refresh(entry);
		this.changed();
	}

	/** Record the outcome of the `rlm_query` run. The session stays open for viewing and follow-ups. */
	finish(
		id: string,
		outcome: { status: Exclude<ChildAgentStatus, "queued" | "running">; stopReason?: string; error?: string },
	): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.cancel = undefined;
		entry.info.status = outcome.status;
		entry.info.stopReason = outcome.stopReason;
		entry.info.error = outcome.error?.slice(0, 4000);
		entry.info.endedAt = Date.now();
		this.refresh(entry);
		this.changed();
		void this.park(entry.info.rootSessionId);
	}

	get(id: string): ChildAgentInfo | undefined {
		const entry = this.entries.get(id);
		return entry ? this.copy(entry) : undefined;
	}

	/** Children of one root session, oldest first. */
	list(rootSessionId: string): ChildAgentInfo[] {
		return [...this.entries.values()]
			.filter((entry) => entry.info.rootSessionId === rootSessionId)
			.map((entry) => this.copy(entry));
	}

	/** The child's live session, if it is in memory. */
	session(id: string): AgentSession | undefined {
		return this.entries.get(id)?.session;
	}

	/** The child's session, reopening a parked child from its session file. */
	async open(id: string): Promise<AgentSession> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error("This subagent is no longer available.");
		if (entry.session) return entry.session;
		const reopen = entry.reopen;
		if (!reopen) throw new Error(`${entry.info.name} was not saved to a session file and cannot be reopened.`);
		entry.reopening ??= (entry.parking ?? Promise.resolve()).then(reopen).then(
			(session) => {
				entry.reopening = undefined;
				if (!this.entries.has(id)) {
					session.dispose();
					throw new Error("This subagent is no longer available.");
				}
				this.attach(id, session, { reopen: entry.reopen, followUps: entry.followUps });
				void this.park(entry.info.rootSessionId, id);
				return session;
			},
			(error: unknown) => {
				entry.reopening = undefined;
				throw error;
			},
		);
		return entry.reopening;
	}

	/**
	 * Send a user message to a child: steer it while it responds, or start a new turn once it is idle.
	 * Resolves when the message is accepted, not when the child finishes.
	 */
	async prompt(id: string, text: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error("This subagent is no longer available.");
		const info = this.copy(entry);
		if (!info.promptable) {
			throw new Error(`${info.name} already returned a workspace result to its parent; its session is read-only.`);
		}
		const session = await this.open(id);
		if (session.isStreaming) {
			await session.prompt(text, { streamingBehavior: "steer", expandPromptTemplates: false });
			return;
		}
		void session.prompt(text, { expandPromptTemplates: false }).catch((error: unknown) => {
			entry.info.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
			this.changed();
		});
	}

	/** Stop the child's current work. Returns false when there is nothing to stop. */
	stop(id: string): boolean {
		const entry = this.entries.get(id);
		if (!entry) return false;
		if (entry.cancel && !finished(entry.info)) {
			entry.cancel();
			return true;
		}
		if (entry.session?.isStreaming) {
			void entry.session.abort();
			return true;
		}
		return false;
	}

	/** Keep a child's session in memory while a view shows it. Returns the release function. */
	retain(id: string): () => void {
		const entry = this.entries.get(id);
		if (!entry) return () => {};
		entry.viewers++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			entry.viewers--;
			void this.park(entry.info.rootSessionId);
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Dispose the children that `sessionId` created; each child's runtime disposes its own children. */
	disposeOwnedBy(sessionId: string): void {
		for (const [id, entry] of [...this.entries]) {
			if (entry.info.parentSessionId !== sessionId) continue;
			entry.cancel?.();
			this.detach(entry);
			entry.session?.dispose();
			entry.session = undefined;
			this.entries.delete(id);
		}
		this.changed();
	}

	private observe(entry: Entry, event: AgentSessionEvent): void {
		const info = entry.info;
		info.lastActivityAt = Date.now();
		switch (event.type) {
			case "agent_start":
				info.busy = true;
				break;
			case "agent_end":
			case "agent_settled":
				info.busy = entry.session?.isStreaming ?? false;
				break;
			case "turn_end":
				info.turns++;
				break;
			case "message_end": {
				const message = event.message;
				const usage = message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
				if (usage) {
					info.usage.input += usage.input;
					info.usage.output += usage.output;
					info.usage.cacheRead += usage.cacheRead;
					info.usage.cacheWrite += usage.cacheWrite;
					info.usage.totalTokens += usage.totalTokens;
					info.usage.cost += usage.cost.total;
				}
				break;
			}
			case "tool_execution_start": {
				if (event.parentToolCallId) return;
				const code =
					event.toolName === "python" && typeof event.args?.code === "string" ? event.args.code : undefined;
				const line = code
					?.split("\n")
					.find((value: string) => value.trim())
					?.trim();
				info.activity = (line ?? event.toolName).slice(0, 200);
				break;
			}
			case "thinking_level_changed":
				break;
			default:
				return;
		}
		this.refresh(entry);
		this.changed();
	}

	private refresh(entry: Entry): void {
		const session = entry.session;
		if (!session) return;
		const model = session.model;
		if (model) entry.info.model = `${model.provider}/${model.id}`;
		entry.info.busy = session.isStreaming;
	}

	private copy(entry: Entry): ChildAgentInfo {
		const info = entry.info;
		const live = entry.session !== undefined;
		const running = !finished(info);
		return {
			...info,
			usage: { ...info.usage },
			live,
			openable: live || entry.reopen !== undefined,
			promptable: (live || entry.reopen !== undefined) && (running || entry.followUps),
		};
	}

	private detach(entry: Entry): void {
		entry.unsubscribe?.();
		entry.unsubscribe = undefined;
	}

	/** Keep the most recent idle children of a root in memory and park the rest. */
	private async park(rootSessionId: string, keep?: string): Promise<void> {
		const idle = [...this.entries.values()]
			.filter(
				(entry) =>
					entry.info.rootSessionId === rootSessionId &&
					entry.session &&
					finished(entry.info) &&
					!entry.session.isStreaming &&
					entry.viewers === 0 &&
					entry.reopen !== undefined &&
					entry.info.id !== keep,
			)
			.sort((a, b) => b.info.lastActivityAt - a.info.lastActivityAt);
		for (const entry of idle.slice(CHILD_AGENT_LIVE_IDLE_LIMIT - (keep ? 1 : 0))) {
			const session = entry.session;
			// A child without a session file could not come back, so it stays in memory.
			if (!session || !entry.reopen) continue;
			this.detach(entry);
			entry.session = undefined;
			entry.info.parked = true;
			entry.info.busy = false;
			entry.parking = (async () => {
				try {
					await session.flushRlmSnapshot();
				} catch {
					/* The transcript is still on disk; only the kernel namespace is lost. */
				}
				session.dispose();
			})();
			await entry.parking;
			entry.parking = undefined;
		}
		const records = [...this.entries.values()].filter(
			(entry) => entry.info.rootSessionId === rootSessionId && !entry.session && finished(entry.info),
		);
		for (const entry of records.slice(0, Math.max(0, records.length - CHILD_AGENT_RECORD_LIMIT))) {
			this.entries.delete(entry.info.id);
		}
		this.changed();
	}

	private changed(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				/* A view cannot break agent execution. */
			}
		}
	}
}

export const childAgents = new ChildAgentRegistry();
