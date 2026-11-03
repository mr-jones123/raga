import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import {
	listTenmoSessions,
	parseTenmoSpawn,
	spawnTenmoSession,
	type TenmoRecord,
	tenmoAgo,
	tenmoPath,
} from "../core/tenmo.ts";

const WATCH_INTERVAL_MS = 2000;

/** Usage lines for `tenmo`, shared by its own help and the top-level help screens. */
export function tenmoUsage(): string {
	const rows: [string, string][] = [
		["", "List running sessions"],
		[" --json", "Same, as JSON"],
		[" watch", `Refresh the list every ${WATCH_INTERVAL_MS / 1000}s until Ctrl+C`],
		[" spawn @<path> <task>", "Start a session in <path> in a new tmux window with <task> as its first message"],
	];
	const width = Math.max(...rows.map(([usage]) => usage.length)) + `${APP_NAME} tenmo`.length + 4;
	return rows.map(([usage, text]) => `  ${`${APP_NAME} tenmo${usage}`.padEnd(width)}${text}`).join("\n");
}

function printHelp(): void {
	console.log(`Usage:\n${tenmoUsage()}`);
}

function line(session: TenmoRecord, now: number): string {
	const color = session.status === "working" ? chalk.cyan : session.status === "waiting" ? chalk.yellow : chalk.dim;
	const rows = [
		`${color(session.status.padEnd(8))}${chalk.bold(tenmoPath(session.cwd))}${chalk.dim(`  pid ${session.pid}  ${session.model ?? ""}  ${tenmoAgo(now - session.updatedAt)}`)}`,
	];
	if (session.intent) rows.push(`        ${chalk.dim("intent")}  ${session.intent}`);
	if (session.lastPrompt && session.lastPrompt !== session.intent)
		rows.push(`        ${chalk.dim("latest")}  ${session.lastPrompt}`);
	if (session.activity) rows.push(`        ${chalk.dim("now")}     ${session.activity}`);
	return rows.join("\n");
}

function report(): string {
	const now = Date.now();
	const sessions = listTenmoSessions();
	const list = sessions.length ? sessions.map((session) => line(session, now)).join("\n\n") : chalk.dim("  none");
	return `${chalk.bold(`Sessions (${sessions.length})`)}\n${list}`;
}

/** `tenmo` CLI subcommand. Returns false when `args` is not a tenmo command. */
export async function handleTenmoCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "tenmo") return false;
	const [sub, ...rest] = args.slice(1);
	if (sub === "help" || sub === "--help" || sub === "-h") {
		printHelp();
	} else if (sub === "--json") {
		console.log(JSON.stringify({ sessions: listTenmoSessions() }, null, 2));
	} else if (sub === "watch") {
		for (;;) {
			const text = report();
			process.stdout.write(`\x1b[2J\x1b[H${text}\n`);
			await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
		}
	} else if (sub === "spawn") {
		const parsed = parseTenmoSpawn(rest.join(" "), process.cwd());
		if ("error" in parsed) {
			console.error(chalk.red(parsed.error));
			process.exitCode = 1;
			return true;
		}
		try {
			const result = await spawnTenmoSession(parsed);
			console.log(`Started a session in ${parsed.cwd} (tmux pane ${result.pane}).`);
			if (result.attach) console.log(`Attach with: ${result.attach}`);
		} catch (error) {
			console.error(chalk.red(error instanceof Error ? error.message : String(error)));
			process.exitCode = 1;
		}
	} else if (sub === undefined) {
		console.log(report());
	} else {
		printHelp();
		process.exitCode = 1;
	}
	return true;
}
