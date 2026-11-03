import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	currentTmuxPane,
	deleteTenmoSession,
	focusTenmoSession,
	listTenmoSessions,
	parseTenmoSpawn,
	removeTenmoRecord,
	spawnTenmoSession,
	type TenmoRecord,
	type TenmoStatus,
	writeTenmoRecord,
} from "../../core/tenmo.ts";
import { TenmoDashboard } from "./ui.ts";

const SNIPPET = 160;
/** Streaming fires many events; write the record at most this often unless the status changes. */
const WRITE_INTERVAL_MS = 1000;

function messageText(message: AgentMessage): string | undefined {
	if (!("role" in message) || (message.role !== "user" && message.role !== "assistant")) return undefined;
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: content
					.filter((part) => part.type === "text")
					.map((part) => ("text" in part ? part.text : ""))
					.join(" ");
	const line = text.replace(/\s+/g, " ").trim();
	return line ? line.slice(0, SNIPPET) : undefined;
}

/**
 * Publishes this process's main session to the tenmo registry and adds `/tenmo`. Subagent sessions run this
 * extension's handlers too, so every handler ignores events from sessions other than the tracked one.
 */
export default function tenmoExtension(pi: ExtensionAPI): void {
	let record: TenmoRecord | undefined;
	let lastWrite = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let exitHooked = false;

	const flush = () => {
		if (pending) clearTimeout(pending);
		pending = undefined;
		if (!record) return;
		record.updatedAt = Date.now();
		lastWrite = record.updatedAt;
		try {
			writeTenmoRecord(record);
		} catch {
			// Tracking must never break the session; the next change retries.
		}
	};
	const save = (urgent: boolean) => {
		if (!record) return;
		if (urgent || Date.now() - lastWrite >= WRITE_INTERVAL_MS) flush();
		else pending ??= setTimeout(flush, WRITE_INTERVAL_MS).unref();
	};
	const tracked = (ctx: ExtensionContext) =>
		record !== undefined && ctx.sessionManager.getSessionId() === record.sessionId;
	const setStatus = (status: TenmoStatus) => {
		if (!record || record.status === status) return;
		record.status = status;
		save(true);
	};

	pi.on("session_start", (event, ctx) => {
		// The first session in the process is the main one; later starts without a switch reason are subagents.
		if (record && event.reason === "startup") return;
		const manager = ctx.sessionManager;
		let intent: string | undefined;
		let lastPrompt: string | undefined;
		for (const entry of manager.getEntries()) {
			if (entry.type !== "message" || !("role" in entry.message) || entry.message.role !== "user") continue;
			const text = messageText(entry.message);
			intent ??= text;
			lastPrompt = text ?? lastPrompt;
		}
		record = {
			pid: process.pid,
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			cwd: manager.getCwd(),
			name: manager.getSessionName(),
			mode: ctx.mode,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			status: "idle",
			intent,
			lastPrompt,
			tmux: currentTmuxPane(),
			startedAt: record?.startedAt ?? Date.now(),
			updatedAt: Date.now(),
		};
		flush();
		if (!exitHooked) {
			exitHooked = true;
			process.once("exit", () => removeTenmoRecord(process.pid));
		}
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (!tracked(ctx) || event.reason !== "quit") return;
		if (pending) clearTimeout(pending);
		record = undefined;
		removeTenmoRecord(process.pid);
	});
	pi.on("session_info_changed", (event, ctx) => {
		if (!tracked(ctx) || !record) return;
		record.name = event.name;
		save(true);
	});
	pi.on("model_select", (event, ctx) => {
		if (!tracked(ctx) || !record) return;
		record.model = `${event.model.provider}/${event.model.id}`;
		save(false);
	});
	pi.on("agent_start", (_event, ctx) => {
		if (tracked(ctx)) setStatus("working");
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (tracked(ctx)) setStatus("idle");
	});
	pi.on("ui_prompt_start", (event, ctx) => {
		// A custom view opened while idle is a dashboard the user asked for, such as /tenmo itself.
		if (tracked(ctx) && (event.kind !== "custom" || !ctx.isIdle())) setStatus("waiting");
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		if (tracked(ctx)) setStatus(ctx.isIdle() ? "idle" : "working");
	});
	pi.on("message_start", (event, ctx) => {
		if (!tracked(ctx) || !record || !("role" in event.message) || event.message.role !== "user") return;
		const text = messageText(event.message);
		if (!text) return;
		record.intent ??= text;
		record.lastPrompt = text;
		save(true);
	});
	pi.on("message_end", (event, ctx) => {
		if (!tracked(ctx) || !record || !("role" in event.message) || event.message.role !== "assistant") return;
		const text = messageText(event.message);
		if (!text) return;
		record.activity = text;
		save(false);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (!tracked(ctx) || !record || event.parentToolCallId) return;
		record.activity = `running ${event.toolName}`;
		save(false);
	});

	pi.registerCommand("tenmo", {
		description: "Watch every running session, delete one, or start one: /tenmo @path <task>",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (request) {
				const parsed = parseTenmoSpawn(request, ctx.cwd);
				if ("error" in parsed) {
					ctx.ui.notify(parsed.error, "warning");
					return;
				}
				try {
					const result = await spawnTenmoSession(parsed);
					const where = result.attach ? ` Attach with: ${result.attach}` : "";
					ctx.ui.notify(`Started a session in ${parsed.cwd} (tmux pane ${result.pane}).${where}`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (ctx.mode !== "tui") {
				const sessions = listTenmoSessions();
				ctx.ui.notify(
					sessions.length
						? sessions.map((s) => `${s.status.padEnd(7)} ${s.cwd}  ${s.intent ?? ""}`).join("\n")
						: "No running sessions.",
					"info",
				);
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) =>
					new TenmoDashboard(listTenmoSessions, tui, theme, keybindings, {
						self: process.pid,
						focus: (session) => {
							focusTenmoSession(session).catch((error: unknown) => {
								ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
							});
						},
						delete: async (session) => {
							try {
								const deleted = await deleteTenmoSession(session);
								ctx.ui.notify(
									`Deleted the session in ${session.cwd} (${deleted.length} ${deleted.length === 1 ? "path" : "paths"} removed).`,
									"info",
								);
							} catch (error) {
								ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
							}
						},
						close: () => done(),
					}),
				{
					overlay: true,
					overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 },
				},
			);
		},
	});
}
