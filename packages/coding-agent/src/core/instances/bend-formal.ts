/**
 * The `/bend-formal` workflow: scaffold laws, draft them with an agent, then run the
 * pinned checker. Drafts never become active without an explicit approval flag, and the
 * agent only ever returns text; it cannot write into `.raga`.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCommand } from "../agent-command.ts";
import type { CommandResult } from "./types.ts";
import {
	installBend,
	installedBend,
	runVerification,
	setVerificationEnabled,
	type VerificationRecord,
	type VerificationTool,
	verificationPaths,
} from "./verification.ts";

const MAX_DRAFT_CHARS = 200_000;

const LAWS_TEMPLATE = `import Base

# LAW: state one rule that must never break. Each law needs a proof in PROOF.bend.
# Example:
# law add_zero:
#   for value: Nat
#   {value + 0n == value : Nat}
`;

const PROOF_TEMPLATE = `import ./LAWS.bend as Laws

# Prove every law here with a def of the same name. Run \`bend guide\` for the syntax.
# A law with no def stays open, so \`bend PROOF.bend\` reports SOME PROOFS FAIL.
`;

export interface BendDraft {
	laws: string;
	proof: string;
	notes: string;
}

export interface BendScaffold {
	lawsPath: string;
	proofPath: string;
	created: string[];
}

export interface BendCheck {
	tool: VerificationTool;
	record: VerificationRecord;
	result: CommandResult;
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
	const laws = labeled.get("laws") ?? unlabeled[0];
	if (!laws) throw new Error("The agent returned no Bend laws block");
	const proof =
		labeled.get("proof") ??
		unlabeled[1] ??
		"import ./LAWS.bend as Laws\n\n# Prove each law below, or bend reports SOME PROOFS FAIL.\n";
	if (laws.length + proof.length > MAX_DRAFT_CHARS) throw new Error("The drafted laws are too large");
	return { laws, proof, notes: output.trim().slice(0, 64_000) };
}

/** Write the two template files if they are missing. Existing files are never touched. */
export async function scaffoldBendFiles(instanceRoot: string): Promise<BendScaffold> {
	const paths = verificationPaths(instanceRoot);
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	const created: string[] = [];
	for (const [name, template] of [
		["LAWS.bend", LAWS_TEMPLATE],
		["PROOF.bend", PROOF_TEMPLATE],
	] as const) {
		const path = join(paths.directory, name);
		try {
			await writeFile(path, template, { mode: 0o600, flag: "wx" });
			created.push(name);
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
	}
	return { lawsPath: join(paths.directory, "LAWS.bend"), proofPath: join(paths.directory, "PROOF.bend"), created };
}

/** Save an agent draft into the active directory. Requires approval and explicit overwrite consent. */
export async function writeBendDraft(
	instanceRoot: string,
	draft: BendDraft,
	options: { approved: boolean; overwrite: boolean },
): Promise<{ lawsPath: string; proofPath: string }> {
	if (options.approved !== true) throw new Error("Saving drafted laws requires explicit approval");
	const paths = verificationPaths(instanceRoot);
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	const lawsPath = join(paths.directory, "LAWS.bend");
	const proofPath = join(paths.directory, "PROOF.bend");
	if (!options.overwrite) {
		for (const path of [lawsPath, proofPath]) {
			try {
				await readFile(path);
				throw new Error(`${path} already exists; approve replacing it`);
			} catch (error) {
				if ((error as { code?: string }).code !== "ENOENT") throw error;
			}
		}
	}
	await writeFile(lawsPath, `${draft.laws.trim()}\n`, { mode: 0o600 });
	await writeFile(proofPath, `${draft.proof.trim()}\n`, { mode: 0o600 });
	return { lawsPath, proofPath };
}

/** Ask an agent for a draft. The result is inert until a human calls writeBendDraft. */
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

/**
 * Install if approved, enable if requested, then run the checker for one revision.
 * Every step is approval-gated by its caller.
 */
export async function checkBendFormal(
	instanceRoot: string,
	options: {
		instanceId: string;
		revision: string;
		install: boolean;
		network: boolean;
		enable: boolean;
	},
): Promise<BendCheck> {
	let tool = await installedBend(instanceRoot);
	if (!tool) {
		if (!options.install) throw new Error("The pinned Bend release is not installed; approve the download first");
		tool = await installBend(instanceRoot, { approved: true, network: options.network });
	}
	if (options.enable) await setVerificationEnabled(instanceRoot, { approved: true, enabled: true });
	const { record, result } = await runVerification(instanceRoot, {
		instanceId: options.instanceId,
		revision: options.revision,
	});
	return { tool, record, result };
}
