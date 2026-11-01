/**
 * `raga agent-attach --socket <path> --agent <id>`: a full-screen view of one live subagent, served by
 * the owning Raga process over its private attach socket (see core/rlm/child-agent-server.ts). The
 * view renders the child's real session with the main TUI's message components and can prompt it.
 * Exiting the view never stops the subagent.
 */
import { createConnection, type Socket } from "node:net";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	isViewportTUI,
	type MarkdownTheme,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	TruncatedText,
	type TUI,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import {
	CHILD_AGENT_PROTOCOL_VERSION,
	type ChildAgentClientMessage,
	type ChildAgentServerMessage,
	FORWARDED_CHILD_AGENT_EVENTS,
	type ForwardedChildAgentEvent,
} from "../core/rlm/child-agent-server.ts";
import type { ChildAgentInfo } from "../core/rlm/child-agents.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { withBuiltInRenderers } from "../core/tools/renderers/index.ts";
import type { TruncationResult } from "../core/tools/truncate.ts";
import { createChatViewport } from "./interactive/chat-viewport.ts";
import { AssistantMessageComponent } from "./interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "./interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./interactive/components/compaction-summary-message.ts";
import { CustomEditor } from "./interactive/components/custom-editor.ts";
import { CustomMessageComponent } from "./interactive/components/custom-message.ts";
import { formatTokens } from "./interactive/components/footer.ts";
import { ToolExecutionComponent } from "./interactive/components/tool-execution.ts";
import { UserMessageComponent } from "./interactive/components/user-message.ts";
import { SYSTEM_THEME_NAME } from "./interactive/theme/system-theme.ts";
import {
	getEditorTheme,
	getMarkdownTheme,
	getTerminalTheme,
	initTheme,
	markTerminalColorsPending,
	resolveThemeSetting,
	setTerminalColors,
	setTheme,
	theme,
} from "./interactive/theme/theme.ts";
import { requestTerminalColors } from "./interactive/theme/theme-controller.ts";
import { createInteractiveTui } from "./interactive/tui-renderer.ts";

export const AGENT_ATTACH_USAGE = "Usage: raga agent-attach --socket <path> --agent <id>";
export const AGENT_ATTACH_DISCONNECTED = "Disconnected: the Raga session that owns this subagent ended.";
const RECONNECT_DELAY_MS = 2000;
/** The welcome carries the whole transcript; beyond this many characters a line is a broken stream. */
export const MAX_SERVER_LINE_CHARS = 64 * 1024 * 1024;
/** Connect errors that mean the owning session is not listening (yet or anymore); others are fatal. */
const RETRYABLE_CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOENT"]);

export interface AgentAttachOptions {
	socket: string;
	agent: string;
}

/** Parse `--socket <path> --agent <id>`; throws with a usage message on anything else. */
export function parseAgentAttachArgs(args: string[]): AgentAttachOptions {
	const values: { socket?: string; agent?: string } = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const key = arg === "--socket" ? "socket" : arg === "--agent" ? "agent" : undefined;
		if (!key) throw new Error(`Unknown option: ${sanitizeTerminalText(arg)}`);
		if (values[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
		const value = args[++index];
		if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
		values[key] = value;
	}
	if (values.socket === undefined) throw new Error("Missing --socket");
	if (values.agent === undefined) throw new Error("Missing --agent");
	return { socket: values.socket, agent: values.agent };
}

/**
 * Make untrusted text inert in a terminal: C0/C1 controls, DEL, ESC, bidi overrides and isolates, and
 * line/paragraph separators become visible escapes. `multiline` keeps newlines and tabs; otherwise
 * each run of CR, LF, and tab becomes one space.
 */
export function sanitizeTerminalText(text: string, multiline = false): string {
	const source = multiline ? text.replace(/\r\n/g, "\n") : text.replace(/[\r\n\t]+/g, " ");
	return source.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (char) => {
		if (multiline && (char === "\n" || char === "\t")) return char;
		const code = char.charCodeAt(0);
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

/** Sanitize every string, including object keys, in a JSON value. */
function sanitizeJson(value: unknown): unknown {
	if (typeof value === "string") return sanitizeTerminalText(value, true);
	if (Array.isArray(value)) return value.map(sanitizeJson);
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) result[sanitizeTerminalText(key)] = sanitizeJson(item);
		return result;
	}
	return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");
/** An array of content blocks, each an object with a string `type`. */
const isContent = (value: unknown): value is Record<string, unknown>[] =>
	Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.type === "string");
const forwardedEvents = new Set<string>(FORWARDED_CHILD_AGENT_EVENTS);

/** The agent fields the header and footer dereference. */
function isAgentInfo(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.usage)) return false;
	const usage = value.usage;
	return (
		["id", "name", "rootSessionId", "model", "status"].every((key) => typeof value[key] === "string") &&
		typeof value.turns === "number" &&
		typeof value.maxTurns === "number" &&
		["input", "output", "cost"].every((key) => typeof usage[key] === "number")
	);
}

/** The message fields the renderers dereference. */
function isAgentMessage(value: unknown): boolean {
	if (!isRecord(value) || typeof value.role !== "string") return false;
	switch (value.role) {
		case "assistant":
			return (
				isContent(value.content) &&
				value.content.every(
					(block) => block.type !== "toolCall" || (typeof block.id === "string" && typeof block.name === "string"),
				)
			);
		case "toolResult":
			return typeof value.toolCallId === "string" && isContent(value.content);
		case "user":
		case "custom":
			return typeof value.content === "string" || isContent(value.content);
		case "bashExecution":
			return typeof value.command === "string" && (value.output === undefined || typeof value.output === "string");
		default:
			return true;
	}
}

const isToolResult = (value: unknown): boolean => isRecord(value) && isContent(value.content);

function isForwardedEvent(event: Record<string, unknown>): boolean {
	if (typeof event.type !== "string" || !forwardedEvents.has(event.type)) return false;
	switch (event.type) {
		case "queue_update":
			return isStringArray(event.steering) && isStringArray(event.followUp);
		case "message_start":
		case "message_update":
		case "message_end":
			return isAgentMessage(event.message);
		case "tool_execution_start":
			return typeof event.toolCallId === "string" && typeof event.toolName === "string";
		case "tool_execution_update":
			return typeof event.toolCallId === "string" && isToolResult(event.partialResult);
		case "tool_execution_end":
			return typeof event.toolCallId === "string" && isToolResult(event.result);
		default:
			return true;
	}
}

/** Strip complete ANSI CSI/OSC sequences from tool output, as the main TUI shows it without them. */
function stripResultAnsi(result: unknown): void {
	if (!isRecord(result) || !Array.isArray(result.content)) return;
	for (const block of result.content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			block.text = stripVTControlCharacters(block.text);
		}
	}
}

function stripMessageAnsi(message: unknown): void {
	if (!isRecord(message)) return;
	if (message.role === "toolResult") stripResultAnsi(message);
	else if (message.role === "bashExecution" && typeof message.output === "string") {
		message.output = stripVTControlCharacters(message.output);
	}
}

/** Parse and sanitize one server line. Returns undefined for anything that is not a valid message. */
export function parseServerMessage(line: string): ChildAgentServerMessage | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (isRecord(raw)) {
		if (Array.isArray(raw.messages)) for (const item of raw.messages) stripMessageAnsi(item);
		if (isRecord(raw.event)) {
			stripMessageAnsi(raw.event.message);
			stripResultAnsi(raw.event.partialResult);
			stripResultAnsi(raw.event.result);
		}
	}
	const message = sanitizeJson(raw);
	if (!isRecord(message)) return undefined;
	switch (message.type) {
		case "welcome":
			if (!isAgentInfo(message.agent) || !Array.isArray(message.messages)) return undefined;
			if (!message.messages.every(isAgentMessage)) return undefined;
			// JSON drops undefined values, so a missing key means no streaming message.
			message.streaming ??= null;
			if (message.streaming !== null && !isAgentMessage(message.streaming)) return undefined;
			if (!isStringArray(message.pendingToolCallIds)) return undefined;
			break;
		case "agent":
			if (!isAgentInfo(message.agent)) return undefined;
			break;
		case "event":
			if (!isRecord(message.event) || !isForwardedEvent(message.event)) return undefined;
			break;
		case "error":
			if (typeof message.message !== "string") return undefined;
			break;
		default:
			return undefined;
	}
	return message as unknown as ChildAgentServerMessage;
}

/**
 * Split a stream of text chunks into lines. Each chunk is scanned once, so a long line costs linear
 * time. Returns a push function that is false once the unfinished line exceeds `maxChars`.
 */
export function createLineReader(maxChars: number, onLine: (line: string) => void): (chunk: string) => boolean {
	let parts: string[] = [];
	let length = 0;
	return (chunk) => {
		let start = 0;
		for (let index = chunk.indexOf("\n"); index !== -1; index = chunk.indexOf("\n", start)) {
			if (length + index - start > maxChars) return false;
			const piece = chunk.slice(start, index);
			const line = parts.length > 0 ? parts.join("") + piece : piece;
			parts = [];
			length = 0;
			start = index + 1;
			onLine(line);
		}
		if (start < chunk.length) {
			length += chunk.length - start;
			if (length > maxChars) return false;
			parts.push(chunk.slice(start));
		}
		return true;
	};
}

const statusText = (agent: ChildAgentInfo) =>
	agent.busy && agent.status !== "running" ? `${agent.status}, responding` : agent.status;

/** `<Name> · <status> · <model> · subagent of <root short id>`, one sanitized line. */
export function formatAttachHeader(agent: ChildAgentInfo): string {
	return sanitizeTerminalText(
		`${agent.name} · ${statusText(agent)} · ${agent.model} · subagent of ${agent.rootSessionId.slice(0, 8)}`,
	);
}

/** `<model> · ↑<in> ↓<out> tokens · $<cost> · turns n/max · <status>`, one sanitized line. */
export function formatAttachFooter(agent: ChildAgentInfo): string {
	const usage = agent.usage;
	return sanitizeTerminalText(
		`${agent.model} · ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} tokens · $${usage.cost.toFixed(3)} · turns ${agent.turns}/${agent.maxTurns} · ${statusText(agent)}`,
	);
}

/** One line built at render time, so theme changes apply; truncated to the width. */
class Line implements Component {
	private readonly build: () => string;
	constructor(build: () => string) {
		this.build = build;
	}
	render(width: number): string[] {
		const text = this.build();
		return text ? [truncateToWidth(text, Math.max(0, width))] : [];
	}
	invalidate(): void {}
}

export interface AgentAttachViewSettings {
	hideThinkingBlock?: boolean;
	outputPad?: number;
	showImages?: boolean;
	imageWidthCells?: number;
	codeBlockIndent?: string;
	cwd?: string;
}

/**
 * The attach view's components and the protocol messages that update them. Rendering mirrors
 * InteractiveMode's renderSessionItems and handleEvent for the forwarded event types.
 */
export class AgentAttachView {
	readonly header: Component;
	readonly chat = new Container();
	readonly pending = new Container();
	readonly status: Component;
	readonly footer: Component;
	agent?: ChildAgentInfo;
	/** `failed`: the server rejected this view; the connection stopped and does not retry. */
	connection: "connecting" | "connected" | "disconnected" | "failed" = "connecting";
	private readonly ui: TUI;
	private readonly settings: AgentAttachViewSettings;
	private notice?: { text: string; color: "dim" | "error" | "warning" };
	private lastError?: string;
	private fatalError?: string;
	private expanded = false;
	private streamingComponent?: AssistantMessageComponent;
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();

	constructor(ui: TUI, settings: AgentAttachViewSettings = {}) {
		this.ui = ui;
		this.settings = settings;
		this.header = new Line(() =>
			this.agent ? theme.bold(theme.fg("accent", formatAttachHeader(this.agent))) : theme.fg("dim", "Connecting..."),
		);
		this.status = new Line(() => {
			if (this.connection === "failed") return theme.fg("error", `Error: ${this.fatalError ?? ""}`);
			if (this.connection === "disconnected") return theme.fg("warning", AGENT_ATTACH_DISCONNECTED);
			return this.notice ? theme.fg(this.notice.color, this.notice.text) : "";
		});
		this.footer = new Line(() => (this.agent ? theme.fg("dim", formatAttachFooter(this.agent)) : ""));
	}

	/** Show a one-line notice under the transcript until the next notice or welcome. */
	setNotice(text: string | undefined, color: "dim" | "error" | "warning" = "dim"): void {
		this.notice = text === undefined ? undefined : { text: sanitizeTerminalText(text), color };
		this.ui.requestRender();
	}

	setConnected(connected: boolean): void {
		if (this.connection === "failed") return;
		this.connection = connected ? "connected" : "disconnected";
		this.ui.requestRender();
	}

	/** The server refused this view (for example, an unknown subagent); show why in the status line. */
	setFailed(message: string): void {
		this.connection = "failed";
		this.fatalError = sanitizeTerminalText(message);
		this.ui.requestRender();
	}

	toggleExpanded(): void {
		this.expanded = !this.expanded;
		for (const child of this.chat.children) {
			if (
				child instanceof ToolExecutionComponent ||
				child instanceof CustomMessageComponent ||
				child instanceof BashExecutionComponent ||
				child instanceof CompactionSummaryMessageComponent ||
				child instanceof BranchSummaryMessageComponent
			) {
				child.setExpanded(this.expanded);
			}
		}
		this.ui.requestRender();
	}

	/** Apply one sanitized server message. A message the view cannot show becomes an error notice. */
	apply(message: ChildAgentServerMessage): void {
		try {
			this.applyMessage(message);
		} catch (error) {
			this.setNotice(
				`Could not show a server ${message.type} message: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		this.ui.requestRender();
	}

	private applyMessage(message: ChildAgentServerMessage): void {
		switch (message.type) {
			case "welcome":
				this.agent = message.agent;
				this.notice = undefined;
				this.lastError = undefined;
				this.renderWelcome(message.messages, message.streaming, message.pendingToolCallIds);
				break;
			case "agent":
				this.agent = message.agent;
				break;
			case "event":
				this.handleEvent(message.event);
				break;
			case "error":
				if (message.message !== this.lastError) {
					this.lastError = message.message;
					this.chat.addChild(new Spacer(1));
					const text = sanitizeTerminalText(message.message);
					this.chat.addChild(new TruncatedText(theme.fg("error", `Error: ${text}`), 1, 0));
				}
				break;
		}
	}

	private markdownTheme(): MarkdownTheme {
		return { ...getMarkdownTheme(), codeBlockIndent: this.settings.codeBlockIndent ?? "  " };
	}

	private outputPad(): number {
		return this.settings.outputPad ?? 1;
	}

	private createToolComponent(name: string, id: string, args: unknown): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			name,
			id,
			args,
			{
				showImages: this.settings.showImages ?? true,
				imageWidthCells: this.settings.imageWidthCells,
				outputPad: this.outputPad(),
			},
			withBuiltInRenderers(name, undefined),
			this.ui,
			this.settings.cwd ?? process.cwd(),
		);
		component.setExpanded(this.expanded);
		this.chat.addChild(component);
		return component;
	}

	private createAssistantComponent(message?: AssistantMessage): AssistantMessageComponent {
		return new AssistantMessageComponent(
			message,
			this.settings.hideThinkingBlock ?? false,
			this.markdownTheme(),
			"Thinking...",
			this.outputPad(),
		);
	}

	private renderWelcome(messages: AgentMessage[], streaming: AgentMessage | null, pendingIds: string[]): void {
		this.chat.clear();
		this.pending.clear();
		this.pendingTools.clear();
		this.streamingComponent = undefined;
		const rendered = new Map<string, ToolExecutionComponent>();
		for (const message of messages) {
			if (message.role === "assistant") {
				this.addMessage(message);
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const component = this.createToolComponent(content.name, content.id, content.arguments);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
						component.updateResult({ content: [{ type: "text", text }], isError: true });
					} else {
						rendered.set(content.id, component);
					}
				}
			} else if (message.role === "toolResult") {
				const component = rendered.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					rendered.delete(message.toolCallId);
				}
			} else {
				this.addMessage(message);
			}
		}
		for (const [id, component] of rendered) this.pendingTools.set(id, component);
		if (streaming?.role === "assistant") {
			this.startStreaming(streaming);
			this.updateStreaming(streaming);
		}
		for (const id of pendingIds) this.pendingTools.get(id)?.markExecutionStarted();
	}

	private startStreaming(message: AssistantMessage): void {
		this.streamingComponent = this.createAssistantComponent();
		this.chat.addChild(this.streamingComponent);
		this.streamingComponent.updateContent(message, true);
	}

	private updateStreaming(message: AssistantMessage): void {
		if (!this.streamingComponent) return;
		this.streamingComponent.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const existing = this.pendingTools.get(content.id);
			if (existing) existing.updateArgs(content.arguments);
			else this.pendingTools.set(content.id, this.createToolComponent(content.name, content.id, content.arguments));
		}
	}

	private handleEvent(event: ForwardedChildAgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.pendingTools.clear();
				break;
			case "queue_update":
				this.pending.clear();
				if (event.steering.length > 0 || event.followUp.length > 0) {
					this.pending.addChild(new Spacer(1));
					for (const text of event.steering) {
						const line = sanitizeTerminalText(text);
						this.pending.addChild(new TruncatedText(theme.fg("dim", `Steering: ${line}`), 1, 0));
					}
					for (const text of event.followUp) {
						const line = sanitizeTerminalText(text);
						this.pending.addChild(new TruncatedText(theme.fg("dim", `Follow-up: ${line}`), 1, 0));
					}
				}
				break;
			case "message_start":
				if (event.message.role === "custom" || event.message.role === "user") {
					this.addMessage(event.message);
				} else if (event.message.role === "assistant") {
					this.startStreaming(event.message);
				}
				break;
			case "message_update":
				if (event.message.role === "assistant") this.updateStreaming(event.message);
				break;
			case "message_end": {
				const message = event.message;
				if (message.role !== "assistant" || !this.streamingComponent) break;
				if (message.stopReason === "aborted") message.errorMessage = "Operation aborted";
				this.streamingComponent.updateContent(message, false);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					const text = message.errorMessage || "Error";
					for (const component of this.pendingTools.values()) {
						component.updateResult({ content: [{ type: "text", text }], isError: true });
					}
					this.pendingTools.clear();
				} else {
					for (const component of this.pendingTools.values()) component.setArgsComplete();
				}
				this.streamingComponent = undefined;
				break;
			}
			case "tool_execution_start": {
				if (event.parentToolCallId) break;
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = this.createToolComponent(event.toolName, event.toolCallId, event.args);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				break;
			}
			case "tool_execution_update":
				this.pendingTools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
				break;
			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
					this.pendingTools.delete(event.toolCallId);
				}
				break;
			}
			case "agent_end":
				if (this.streamingComponent) {
					this.chat.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
				}
				this.pendingTools.clear();
				break;
			case "turn_start":
			case "turn_end":
				break;
		}
	}

	/** InteractiveMode.addMessageToChat for a view without extensions. */
	private addMessage(message: AgentMessage): void {
		const pad = this.outputPad();
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext, pad);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				component.setExpanded(this.expanded);
				this.chat.addChild(component);
				break;
			}
			case "custom": {
				if (!message.display) break;
				const component = new CustomMessageComponent(message, undefined, this.markdownTheme(), pad);
				component.setExpanded(this.expanded);
				this.chat.addChild(component);
				break;
			}
			case "compactionSummary": {
				this.chat.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.markdownTheme(), pad);
				component.setExpanded(this.expanded);
				this.chat.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chat.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.markdownTheme(), pad);
				component.setExpanded(this.expanded);
				this.chat.addChild(component);
				break;
			}
			case "user": {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((content) => content.type === "text")
								.map((content) => content.text)
								.join("");
				if (!text) break;
				if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
				this.chat.addChild(new UserMessageComponent(text, this.markdownTheme(), pad));
				break;
			}
			case "assistant":
				this.chat.addChild(this.createAssistantComponent(message));
				break;
			default:
				break;
		}
	}
}

export interface AttachConnectionHandlers {
	message(message: ChildAgentServerMessage): void;
	connected(connected: boolean): void;
	/** The server refused the view, or the socket cannot be used; the connection stopped for good. */
	failed(message: string): void;
	/** A line that is not a valid protocol message was ignored. */
	invalid?(): void;
}

/**
 * A connection to the attach socket. A closed socket, or a socket that does not exist or refuses
 * connections, is retried every `reconnectDelayMs` until close(). An `error` before the first
 * `welcome` of a connection, an oversized line, or any other connect error is fatal.
 */
export class AttachConnection {
	private readonly options: AgentAttachOptions;
	private readonly handlers: AttachConnectionHandlers;
	private readonly reconnectDelayMs: number;
	private socket?: Socket;
	private timer?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(options: AgentAttachOptions, handlers: AttachConnectionHandlers, reconnectDelayMs = RECONNECT_DELAY_MS) {
		this.options = options;
		this.handlers = handlers;
		this.reconnectDelayMs = reconnectDelayMs;
	}

	connect(): void {
		if (this.closed) return;
		const socket = createConnection(this.options.socket);
		this.socket = socket;
		socket.setEncoding("utf8");
		let connected = false;
		let welcomed = false;
		const push = createLineReader(MAX_SERVER_LINE_CHARS, (line) => {
			if (this.socket !== socket || !line.trim()) return;
			const message = parseServerMessage(line);
			if (!message) {
				this.handlers.invalid?.();
				return;
			}
			if (message.type === "welcome") welcomed = true;
			else if (message.type === "error" && !welcomed) {
				this.fail(message.message);
				return;
			}
			this.handlers.message(message);
		});
		socket.on("connect", () => {
			connected = true;
			this.handlers.connected(true);
			this.send({ type: "hello", version: CHILD_AGENT_PROTOCOL_VERSION, agentId: this.options.agent });
		});
		socket.on("data", (chunk: string) => {
			if (!push(chunk)) this.fail("The Raga session sent a message larger than 64 MiB.");
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (!connected && !RETRYABLE_CONNECT_ERRORS.has(error.code ?? "")) {
				this.fail(`Cannot connect to the subagent socket: ${error.message}`);
			}
		});
		socket.on("close", () => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.handlers.connected(false);
			if (!this.closed) this.timer = setTimeout(() => this.connect(), this.reconnectDelayMs);
		});
	}

	send(message: ChildAgentClientMessage): boolean {
		const socket = this.socket;
		if (!socket || socket.destroyed || !socket.writable || socket.connecting) return false;
		socket.write(`${JSON.stringify(message)}\n`);
		return true;
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.socket?.destroy();
		this.socket = undefined;
	}

	private fail(message: string): void {
		if (this.closed) return;
		this.close();
		this.handlers.failed(message);
	}
}

export async function runAgentAttach(args: string[]): Promise<void> {
	let options: AgentAttachOptions;
	try {
		options = parseAgentAttachArgs(args);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${AGENT_ATTACH_USAGE}\n`);
		process.exitCode = 2;
		return;
	}

	// Read-only: the view follows the user's theme and display settings but never writes them.
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
	markTerminalColorsPending();
	initTheme(resolveThemeSetting(settings.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	const keybindings = KeybindingsManager.create();
	setKeybindings(keybindings);

	const ui = createInteractiveTui({
		tuiMode: "fullscreen",
		showHardwareCursor: settings.getShowHardwareCursor(),
		logDirectory: getAgentDir(),
	});
	const view = new AgentAttachView(ui, {
		hideThinkingBlock: settings.getHideThinkingBlock(),
		outputPad: settings.getOutputPad(),
		showImages: settings.getShowImages(),
		imageWidthCells: settings.getImageWidthCells(),
		codeBlockIndent: settings.getCodeBlockIndent(),
		cwd: process.cwd(),
	});
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings, {
		paddingX: settings.getEditorPaddingX(),
		autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
	});
	const viewport = createChatViewport({
		document: view.chat,
		pendingMessages: view.pending,
		status: view.status,
		editor,
		footer: view.footer,
		scrollbar: settings.getFullscreenScrollbar(),
		scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
		scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
	});
	const root = new VStack([
		{ component: view.header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		{ component: viewport.root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	ui.addChild(root);
	if (isViewportTUI(ui)) ui.setLayoutRoot(root);

	const connection = new AttachConnection(options, {
		message: (message) => view.apply(message),
		connected: (connected) => view.setConnected(connected),
		failed: (message) => view.setFailed(message),
		invalid: () => view.setNotice("Ignored an invalid message from the Raga session.", "warning"),
	});

	let finish: () => void = () => {};
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	const onSignal = () => finish();
	for (const signal of signals) process.on(signal, onSignal);

	// Ctrl+C closes this view only; the subagent keeps running in the owning Raga session.
	editor.onAction("app.clear", () => finish());
	editor.onCtrlD = () => finish();
	editor.onEscape = () => {
		editor.setText("");
		ui.requestRender();
	};
	editor.onAction("app.tools.expand", () => view.toggleExpanded());
	editor.onSubmit = (text) => {
		if (!text.trim()) return;
		if (!view.agent?.promptable) {
			editor.setText(text);
			view.setNotice("read-only: this subagent does not accept messages.", "dim");
			return;
		}
		if (!connection.send({ type: "prompt", text })) {
			editor.setText(text);
			view.setNotice("Not connected; your message was kept.", "warning");
			return;
		}
		editor.addToHistory(text);
		view.setNotice(undefined);
	};

	ui.setFocus(editor);
	ui.start();
	// From here on the terminal is in raw mode; the finally block always restores it.
	try {
		requestTerminalColors(ui, (colors) => {
			setTerminalColors(colors);
			setTheme(resolveThemeSetting(settings.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME);
			ui.invalidate();
			ui.requestRender();
		}).catch(() => {
			/* Keep the current theme when the terminal does not report colors. */
		});
		connection.connect();
		ui.requestRender();
		await finished;
	} finally {
		for (const signal of signals) process.off(signal, onSignal);
		connection.close();
		// After SIGHUP the terminal is gone: restore writes fail with EIO/EPIPE, which must not crash
		// the exit. The listener stays because those errors arrive asynchronously.
		process.stdout.on("error", () => {});
		try {
			ui.stop();
		} catch {
			/* The terminal is gone. */
		}
	}
}
