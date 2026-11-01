/**
 * `/agents`: choose the built-in dashboard or Rex panes for the current session's subagents. Both views
 * open each subagent's real session; neither starts agents or copies their output.
 */
import { execFile } from "node:child_process";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { type ChildAgentServer, startChildAgentServer } from "../../../core/rlm/child-agent-server.ts";
import { childAgents } from "../../../core/rlm/child-agents.ts";
import type { Theme } from "../theme/theme.ts";
import { type AgentHubChoice, type AgentHubView, AgentsChooser } from "./chooser.ts";
import { AgentsDashboard } from "./dashboard.ts";
import { readAgentHubPreference, saveAgentHubPreference } from "./preferences.ts";
import { disposeRexWorkspace, inspectRex, openRexWorkspace, type RexWorkspace } from "./rex.ts";

type Factory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => Component & { dispose?(): void };

export interface AgentsHubHost {
	rootSessionId(): string;
	/** Session name or short id, for Rex labels. */
	title(): string;
	cwd(): string;
	showFullscreen<T>(factory: Factory<T>): Promise<T>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type: "info" | "warning" | "error"): void;
	/** Show a subagent's session in the main view. */
	focus(id: string): Promise<void>;
}

const describe = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error))
		.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/g, " ")
		.slice(0, 2000);

/** One hub per interactive session; Rex panes keep following new subagents until the session ends. */
export class AgentsHub {
	private readonly host: AgentsHubHost;
	private opening = false;
	/** The attach socket outlives Rex sync failures, so existing panes stay connected. */
	private server?: { root: string; server: ChildAgentServer };
	private rex?: {
		root: string;
		workspace: RexWorkspace;
		unsubscribe: () => void;
		timer?: ReturnType<typeof setTimeout>;
		syncing: boolean;
		dirty: boolean;
	};

	constructor(host: AgentsHubHost) {
		this.host = host;
	}

	async open(): Promise<void> {
		if (this.opening) return;
		this.opening = true;
		try {
			let preferred: AgentHubView = readAgentHubPreference();
			for (;;) {
				const availability = await inspectRex();
				const choice = await this.host.showFullscreen<AgentHubChoice>(
					(tui, theme, keys, done) => new AgentsChooser(tui, theme, keys, done, availability, preferred),
				);
				if (!choice) return;
				if (choice === "retry") continue;
				if (choice === "start-rex") {
					await this.startRexServer();
					continue;
				}
				if (choice === "tui") {
					this.remember("tui");
					await this.showDashboard();
					return;
				}
				try {
					await this.openRex();
					preferred = "rex";
					this.remember("rex");
					return;
				} catch (error) {
					this.host.notify(`Cannot open Rex: ${describe(error)}`, "error");
					if (await this.host.confirm("Open the TUI dashboard instead?", "Your subagents are unaffected.")) {
						this.remember("tui");
						await this.showDashboard();
						return;
					}
				}
			}
		} finally {
			this.opening = false;
		}
	}

	/** The session ended or was replaced: stop following and close the attach socket. Rex panes show the disconnect. */
	dispose(): void {
		this.stopFollowing();
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		disposeRexWorkspace(server.root);
		void server.server.close();
	}

	private stopFollowing(): void {
		const rex = this.rex;
		this.rex = undefined;
		if (!rex) return;
		rex.unsubscribe();
		if (rex.timer) clearTimeout(rex.timer);
	}

	private remember(view: AgentHubView): void {
		try {
			saveAgentHubPreference(view);
		} catch {
			this.host.notify("Could not save the /agents view preference.", "warning");
		}
	}

	private async showDashboard(): Promise<void> {
		const root = this.host.rootSessionId();
		let selected: string | undefined;
		await this.host.showFullscreen<void>(
			(tui, theme, keys, done) =>
				new AgentsDashboard(
					{ list: () => childAgents.list(root), subscribe: (listener) => childAgents.subscribe(listener) },
					tui,
					theme,
					keys,
					{
						open: (id) => {
							selected = id;
							done();
						},
						stop: (id) => {
							if (!childAgents.stop(id)) this.host.notify("That subagent is not running.", "info");
						},
						close: () => done(),
					},
				),
		);
		if (selected) await this.host.focus(selected);
	}

	private async startRexServer(): Promise<void> {
		if (
			!(await this.host.confirm(
				"Start the Rex server?",
				"Run `rex server start`, then check again. Nothing is installed.",
			))
		)
			return;
		try {
			await new Promise<void>((resolve, reject) => {
				execFile("rex", ["server", "start"], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (error) =>
					error ? reject(error) : resolve(),
				);
			});
		} catch (error) {
			this.host.notify(`Rex did not start: ${describe(error)}`, "error");
		}
	}

	private async openRex(): Promise<void> {
		const root = this.host.rootSessionId();
		if (this.server && this.server.root !== root) this.dispose();
		this.server ??= { root, server: await startChildAgentServer({ rootSessionId: root }) };
		const workspace = await openRexWorkspace({
			rootSessionId: root,
			title: this.host.title(),
			socketPath: this.server.server.socketPath,
			cwd: this.host.cwd(),
		});
		await workspace.sync(childAgents.list(root), { reopenClosed: true });
		if (this.rex?.workspace !== workspace) {
			this.stopFollowing();
			const state: NonNullable<AgentsHub["rex"]> = {
				root,
				workspace,
				unsubscribe: () => {},
				syncing: false,
				dirty: false,
			};
			state.unsubscribe = childAgents.subscribe(() => this.scheduleSync(state));
			this.rex = state;
		}
		await workspace.reveal();
		const count = childAgents.list(root).filter((agent) => agent.openable).length;
		this.host.notify(
			`Rex session "${describe(workspace.sessionLabel)}": ${count} subagent pane${count === 1 ? "" : "s"}. New subagents get their own pane.`,
			"info",
		);
	}

	/** Coalesce registry changes into at most one Rex sync every 300 ms. */
	private scheduleSync(rex: NonNullable<AgentsHub["rex"]>): void {
		rex.dirty = true;
		if (rex.syncing || rex.timer) return;
		rex.timer = setTimeout(() => {
			rex.timer = undefined;
			void this.runSync(rex);
		}, 300);
		rex.timer.unref();
	}

	private async runSync(rex: NonNullable<AgentsHub["rex"]>): Promise<void> {
		rex.syncing = true;
		try {
			while (rex.dirty && this.rex === rex) {
				rex.dirty = false;
				await rex.workspace.sync(childAgents.list(rex.root));
			}
		} catch (error) {
			if (this.rex === rex) {
				this.stopFollowing();
				this.host.notify(
					`Rex panes stopped updating: ${describe(error)}. Subagents keep running; run /agents to reopen.`,
					"warning",
				);
			}
		} finally {
			rex.syncing = false;
		}
	}
}
