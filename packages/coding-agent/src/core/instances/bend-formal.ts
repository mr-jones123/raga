/**
 * Agent-drafted Bend laws for `verify suggest`. The agent only returns text; drafts land in
 * the suggestions directory and never become active on their own. Interactive sessions use
 * the bundled `bend` skill instead.
 */
import { spawn } from "node:child_process";
import type { AgentCommand } from "../agent-command.ts";

const MAX_DRAFT_CHARS = 200_000;

export interface BendDraft {
	laws: string;
	proof: string;
	notes: string;
	/** False when the agent returned no parseable laws block; the raw notes are still kept. */
	parsed: boolean;
}

function draftPrompt(projectRoot: string, request: string | undefined): string {
	const goal = request?.trim()
		? `The operator described these rules:\n${request.trim()}`
		: "Derive the rules that matter most from the code and its documentation.";
	return [
		"You are drafting Bend laws for a human operator. They will review everything you write.",
		`The project is at ${projectRoot}. ${goal}`,
		"Propose at most six laws that must never break, each precise enough to prove in Bend.",
		"Return exactly two fenced blocks, in this order:",
		"```bend laws",
		"<LAWS.bend, starting with an import line>",
		"```",
		"```bend proof",
		"<PROOF.bend, importing ./LAWS.bend as Laws>",
		"```",
		"Then a short list of what the laws do not cover.",
		"Rules you cannot prove must use ?TODO in the proof block, never a false claim.",
		"Do not write files. Do not run builds. Do not claim a proof you did not write.",
	].join("\n");
}

/** Read-only agent run that captures stdout for parsing. */
export async function runReadOnlyAgent(
	agent: AgentCommand,
	projectRoot: string,
	prompt: string,
	timeoutMs = 10 * 60_000,
): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn(
		agent.executable,
		[
			...agent.args,
			"--print",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--no-mcp",
			"--no-rlm",
			"--tools",
			"read,grep,glob,ls",
			prompt,
		],
		{ cwd: projectRoot, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => {
		if (stdout.length < MAX_DRAFT_CHARS) stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < 100_000) stderr += chunk.toString("utf8");
	});
	child.once("error", (error) => {
		clearTimeout(timer);
		reject(error);
	});
	child.once("close", (code) => {
		clearTimeout(timer);
		if (timedOut) reject(new Error("The agent did not answer within ten minutes"));
		else if (code !== 0) reject(new Error(`The agent exited ${code}: ${stderr.trim()}`));
		else resolve(stdout);
	});
	return promise;
}

/** Extract the labeled Bend blocks. Unlabeled blocks fall back to laws then proof. */
export function parseBendDraft(output: string): BendDraft {
	const labeled = new Map<string, string>();
	const unlabeled: string[] = [];
	for (const match of output.matchAll(/```bend(?:[ \t]+([A-Za-z]+))?[ \t]*\r?\n([\s\S]*?)```/gi)) {
		const label = match[1]?.toLowerCase();
		const body = match[2].trim();
		if (!body) continue;
		if (label === "laws" || label === "proof") labeled.set(label, body);
		else unlabeled.push(body);
	}
	const laws = labeled.get("laws") ?? unlabeled[0] ?? "";
	const proof = labeled.get("proof") ?? unlabeled[1] ?? "";
	if (laws.length + proof.length > MAX_DRAFT_CHARS) throw new Error("The drafted laws are too large");
	return { laws, proof, notes: output.trim().slice(0, 64_000), parsed: Boolean(laws) };
}

/** Ask an agent for a draft. The result is inert text; the caller decides where it goes. */
export async function draftBendFormal(
	agent: AgentCommand,
	options: { projectRoot: string; request?: string; timeoutMs?: number },
): Promise<BendDraft> {
	const output = await runReadOnlyAgent(
		agent,
		options.projectRoot,
		draftPrompt(options.projectRoot, options.request),
		options.timeoutMs,
	);
	return parseBendDraft(output);
}
