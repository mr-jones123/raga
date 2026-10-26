import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { APP_NAME, isBunBinary, VERSION } from "../config.ts";
import {
	disableAutomaticPromotion,
	disableAutomation,
	enableAutomaticPromotion,
	enableAutomation,
	readAutomation,
} from "../core/instances/automation.ts";
import { getBundledHarnessPath } from "../core/instances/bundle.ts";
import { runModelCheckpoint } from "../core/instances/checkpoint.ts";
import { InstanceMemory, type MemoryEntry, type MemoryInput } from "../core/instances/memory.ts";
import { migrateProjectConfig } from "../core/instances/migration.ts";
import { runModelRefinement } from "../core/instances/model-refinement.ts";
import { getNoMistakesBackend, NoMistakesBackend } from "../core/instances/no-mistakes.ts";
import { checkSandbox } from "../core/instances/sandbox.ts";
import { proposeSkill, validateSkill, verifySkillRevision } from "../core/instances/skills.ts";
import {
	activateRevision,
	commitCandidate,
	createCandidate,
	getCandidate,
	initializeInstance,
	instancePaths,
	listRevisions,
	openInstance,
	readInstance,
	rollbackInstance,
} from "../core/instances/store.ts";
import type { HarnessPin } from "../core/instances/types.ts";
import { loadSkillsFromDir } from "../core/skills.ts";

class UsageError extends Error {}

interface CommandSpec {
	usage: string;
	values?: string[];
	required?: string[];
	flags?: string[];
	operands?: number;
	trailing?: boolean;
}

const COMMANDS: Record<string, CommandSpec> = {
	init: { usage: "init [--trust]", flags: ["trust"] },
	run: { usage: "run [--revision REV] [-- CLI_ARGS...]", values: ["revision"], trailing: true },
	status: { usage: "status [--revision REV]", values: ["revision"] },
	fork: { usage: "fork --from SOURCE_PROJECT [--revision REV]", values: ["from", "revision"], required: ["from"] },
	migrate: { usage: "migrate --trust", flags: ["trust"], required: ["trust"] },
	revisions: { usage: "revisions" },
	"candidate create": { usage: "candidate create" },
	"candidate inspect": { usage: "candidate inspect ID", operands: 1 },
	"candidate commit": {
		usage: "candidate commit ID --message TEXT",
		operands: 1,
		values: ["message"],
		required: ["message"],
	},
	activate: {
		usage: "activate REV --approved --evidence ID --expected-base REV",
		operands: 1,
		values: ["evidence", "expected-base"],
		flags: ["approved"],
		required: ["approved", "evidence", "expected-base"],
	},
	"memory history": { usage: "memory history ID", operands: 1 },
	rollback: {
		usage: "rollback REV --expected-base REV",
		operands: 1,
		values: ["expected-base"],
		required: ["expected-base"],
	},
	"memory observe": { usage: "memory observe --input FILE", values: ["input"], required: ["input"] },
	"memory revise": { usage: "memory revise ID --input FILE", operands: 1, values: ["input"], required: ["input"] },
	"memory retire": { usage: "memory retire ID --reason TEXT", operands: 1, values: ["reason"], required: ["reason"] },
	"memory get": { usage: "memory get ID [--version N]", operands: 1, values: ["version"] },
	"memory list": { usage: "memory list" },
	"memory retrieve": {
		usage: "memory retrieve --query TEXT [--scope SCOPE] [--task-type TYPE] [--revision REV] [--max-chars N] [--limit N] [--include-hypotheses]",
		values: ["query", "scope", "task-type", "revision", "max-chars", "limit"],
		flags: ["include-hypotheses"],
		required: ["query"],
	},
	"memory export": { usage: "memory export --ids ID,ID", values: ["ids"], required: ["ids"] },
	"memory import": {
		usage: "memory import --input FILE [--scope SCOPE]",
		values: ["input", "scope"],
		required: ["input"],
	},
	refine: {
		usage: 'refine --goal TEXT --check \'["executable","arg"]\' --evaluator DIR [--timeout-ms N] [--max-model-calls N] [--model PROVIDER/ID] [--skill NAME] [--approved]',
		values: ["goal", "check", "evaluator", "timeout-ms", "max-model-calls", "model", "skill"],
		flags: ["approved"],
		required: ["goal", "check", "evaluator"],
	},
	"skill verify": {
		usage: "skill verify --directory PATH [--timeout-ms N] | skill verify --revision REV --skill NAME [--timeout-ms N]",
		values: ["directory", "revision", "skill", "timeout-ms"],
	},
	"skill propose": {
		usage: "skill propose --directory PATH [--timeout-ms N]",
		values: ["directory", "timeout-ms"],
		required: ["directory"],
	},
	"automation status": { usage: "automation status" },
	"automation enable": {
		usage: "automation enable --limits FILE --approved",
		values: ["limits"],
		flags: ["approved"],
		required: ["limits", "approved"],
	},
	"automation disable": { usage: "automation disable --reason TEXT", values: ["reason"], required: ["reason"] },
	"automation approve": {
		usage: "automation approve --report FILE --margin N --min-trials N --approved",
		values: ["report", "margin", "min-trials"],
		flags: ["approved"],
		required: ["report", "margin", "min-trials", "approved"],
	},
	"automation manual": { usage: "automation manual" },
	"automation checkpoint": {
		usage: 'automation checkpoint --goal TEXT --check \'["executable","arg"]\' --evaluator DIR [--model PROVIDER/ID]',
		values: ["goal", "check", "evaluator", "model"],
		required: ["goal", "check", "evaluator"],
	},
	"no-mistakes inspect": { usage: "no-mistakes inspect" },
	"no-mistakes provision": { usage: "no-mistakes provision --approved", flags: ["approved"], required: ["approved"] },
	"no-mistakes enable": {
		usage: "no-mistakes enable --approved --network [--agent-config FILE]",
		values: ["agent-config"],
		flags: ["approved", "network"],
		required: ["approved", "network"],
	},
	"no-mistakes start": { usage: "no-mistakes start --approved", flags: ["approved"], required: ["approved"] },
	"no-mistakes status": { usage: "no-mistakes status" },
	"no-mistakes run": {
		usage: "no-mistakes run --intent-file FILE --approved --network [--push] [--pr] [--ci] [--yes]",
		values: ["intent-file"],
		flags: ["approved", "network", "push", "pr", "ci", "yes"],
		required: ["intent-file", "approved", "network"],
	},
	"no-mistakes respond": {
		usage: "no-mistakes respond --action approve|fix|skip --approved [--findings ID,ID] [--instructions TEXT] [--reason TEXT]",
		values: ["action", "findings", "instructions", "reason"],
		flags: ["approved"],
		required: ["action", "approved"],
	},
	"no-mistakes stop": {
		usage: "no-mistakes stop --approved [--force]",
		flags: ["approved", "force"],
		required: ["approved"],
	},
};

interface ParsedCommand {
	name: string;
	projectRoot: string;
	values: Map<string, string>;
	flags: Set<string>;
	operands: string[];
	trailing: string[];
}

function help(): void {
	console.log(`Usage: ${APP_NAME} instance COMMAND [--project PATH]\n\n${Object.values(COMMANDS)
		.map((spec) => `  ${spec.usage}`)
		.join("\n")}\n\n--project defaults to the current directory. All results except run are JSON.
Run starts the same executable in the bound project with an accepted revision and isolated instance sessions.
Only arguments after -- are forwarded to run. Session storage overrides are rejected.
Fork copies only an accepted harness, never credentials, memory, sessions, or live state.
Init imports executable project resources only with --trust. The vetted default bundle does not require project trust.
Migration preserves .pi and requires explicit trust before importing project configuration.
Memory input files contain JSON MemoryInput objects with text, scope, evidence, and kind.
Memory import files contain exported entry arrays. Retrieval scope defaults to the instance project path.
Import --scope deliberately remaps only lessons explicitly exported as reusable.
Refinement checks are JSON argv arrays, never shell strings. Promotion requires supervisor evidence and explicit approval.
No-mistakes setup and gate lifecycle are manual. Run skips push, PR, and CI unless individually authorized.
Use --help with any instance command to show this help. No command changes global user configuration.`);
}

function parse(args: string[]): ParsedCommand {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	const operands: string[] = [];
	let index = 2;
	let name = args[1];
	if (["candidate", "memory", "skill", "no-mistakes", "automation"].includes(name)) name += ` ${args[index++] ?? ""}`;
	const spec = COMMANDS[name];
	if (!spec) throw new UsageError(`Unknown instance command ${JSON.stringify(name)}. Use --help.`);
	let trailing: string[] = [];
	for (; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--" && spec.trailing) {
			trailing = args.slice(index + 1);
			break;
		}
		if (!arg.startsWith("-")) {
			operands.push(arg);
			continue;
		}
		const key = arg.slice(2);
		if (!arg.startsWith("--") || (!spec.flags?.includes(key) && !spec.values?.includes(key) && key !== "project")) {
			throw new UsageError(`Unknown option ${arg} for ${name}.`);
		}
		if (values.has(key) || flags.has(key)) throw new UsageError(`Duplicate option ${arg}.`);
		if (spec.flags?.includes(key)) flags.add(key);
		else {
			const value = args[++index];
			if (!value?.trim() || value.startsWith("--")) throw new UsageError(`${arg} requires a value.`);
			values.set(key, value);
		}
	}
	if (operands.length !== (spec.operands ?? 0)) throw new UsageError(`Usage: ${APP_NAME} instance ${spec.usage}`);
	for (const key of spec.required ?? []) {
		if (!values.has(key) && !flags.has(key)) throw new UsageError(`Missing required --${key}.`);
	}
	for (const key of ["timeout-ms", "max-model-calls", "max-chars", "limit", "version", "min-trials"]) {
		const value = values.get(key);
		if (value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
			throw new UsageError(`--${key} must be a positive safe integer.`);
		}
	}
	if (name === "refine" || name === "automation checkpoint") stringArray(parseJson(values.get("check")!), "--check");
	if (values.has("margin") && (!Number.isFinite(Number(values.get("margin"))) || Number(values.get("margin")) < 0)) {
		throw new UsageError("--margin must be a nonnegative number.");
	}
	if (name === "no-mistakes respond" && !["approve", "fix", "skip"].includes(values.get("action")!)) {
		throw new UsageError("--action must be approve, fix, or skip.");
	}
	for (const key of ["ids", "findings"]) {
		if (
			values.has(key) &&
			values
				.get(key)!
				.split(",")
				.some((id) => !id.trim())
		)
			throw new UsageError(`--${key} requires comma-separated nonempty IDs.`);
	}
	if (name === "skill verify") {
		if (
			values.has("directory")
				? values.has("revision") || values.has("skill")
				: !values.has("revision") || !values.has("skill")
		) {
			throw new UsageError("Skill verification requires --directory PATH or both --revision REV and --skill NAME.");
		}
	}
	if (
		name === "run" &&
		trailing.some((arg) => /^(--session(?:-dir|-id)?|--fork|--resume|--continue|-r|-c)(=|$)/.test(arg))
	) {
		throw new UsageError(
			"Instance run owns session storage. Explicit session/resume/fork overrides are not supported.",
		);
	}
	return { name, values, flags, operands, trailing, projectRoot: resolve(values.get("project") ?? process.cwd()) };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new UsageError("Invalid JSON input.");
	}
}

async function readText(path: string): Promise<string> {
	const file = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
			throw new UsageError("Input must be a regular file no larger than 4 MiB.");
		const content = await file.readFile("utf8");
		if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new UsageError("Input exceeds 4 MiB.");
		return content;
	} finally {
		await file.close();
	}
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new UsageError(`${label} must be a JSON object.`);
	return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))
	) {
		throw new UsageError(`${label} must be a nonempty array of nonempty strings.`);
	}
	return value as string[];
}

function memoryInput(value: unknown): MemoryInput {
	const input = object(value, "Memory input");
	if (typeof input.text !== "string" || !input.text.trim() || typeof input.scope !== "string" || !input.scope.trim()) {
		throw new UsageError("Memory text and scope must be nonempty strings.");
	}
	if (input.kind !== "observation" && input.kind !== "lesson")
		throw new UsageError("Memory kind must be observation or lesson.");
	stringArray(input.evidence, "Memory evidence");
	return input as unknown as MemoryInput;
}

function agentCommand(): { executable: string; args: string[]; version: string } {
	if (!isBunBinary && !process.argv[1]) throw new Error("Cannot locate the current CLI entry point.");
	const runtimeArgs = process.execArgv.map((arg, index, args) => {
		const option = /^(--import|--loader|--require|-r)=(.*)$/.exec(arg);
		if (option && /^\.{1,2}\//.test(option[2])) return `${option[1]}=${resolve(option[2])}`;
		if (["--import", "--loader", "--require", "-r"].includes(args[index - 1]) && /^\.{1,2}\//.test(arg))
			return resolve(arg);
		return arg;
	});
	return {
		executable: process.execPath,
		args: isBunBinary ? [] : [...runtimeArgs, resolve(process.argv[1])],
		version: VERSION,
	};
}

async function run(pin: HarnessPin, args: string[]): Promise<void> {
	const agent = agentCommand();
	const detached = !process.stdin.isTTY && process.platform !== "win32";
	const child = spawn(agent.executable, [...agent.args, ...args, "--session-dir", join(pin.stateRoot, "sessions")], {
		cwd: pin.projectRoot,
		env: { ...process.env, RAGA_INSTANCE_ROOT: pin.instanceRoot, RAGA_INSTANCE_REVISION: pin.revision },
		stdio: "inherit",
		detached,
	});
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const handlers = signals.map((signal) => {
		const handler = () => {
			if (!child.pid) return;
			try {
				if (signal === "SIGINT" && process.stdin.isTTY) return;
				if (detached) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		process.on(signal, handler);
		return handler;
	});
	try {
		const {
			promise,
			resolve: accept,
			reject,
		} = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
		child.once("error", reject);
		child.once("exit", (code, signal) => accept({ code, signal }));
		const result = await promise;
		process.exitCode = result.code ?? 1;
		if (result.signal) {
			for (let index = 0; index < signals.length; index++) process.removeListener(signals[index], handlers[index]);
			process.kill(process.pid, result.signal);
		}
	} finally {
		for (let index = 0; index < signals.length; index++) process.removeListener(signals[index], handlers[index]);
	}
}

async function execute(command: ParsedCommand): Promise<unknown> {
	const { name, projectRoot, values, flags, operands } = command;
	const root = instancePaths(projectRoot).root;
	const value = (key: string): string => values.get(key)!;
	const number = (key: string): number | undefined => (values.has(key) ? Number(value(key)) : undefined);
	switch (name) {
		case "init":
			return initializeInstance(projectRoot, {
				harnessSource: getBundledHarnessPath(),
				projectTrusted: flags.has("trust"),
			});
		case "fork":
			return initializeInstance(projectRoot, {
				forkFrom: { instanceRoot: instancePaths(resolve(value("from"))).root, revision: values.get("revision") },
			});
		case "migrate":
			return migrateProjectConfig(projectRoot, { projectTrusted: true });
		case "revisions":
			return listRevisions(root);
		case "candidate create":
			return createCandidate(root);
		case "candidate inspect":
			return getCandidate(root, operands[0]);
		case "candidate commit":
			return commitCandidate(root, operands[0], value("message"));
		case "activate":
			return activateRevision(root, operands[0], {
				expectedRevision: value("expected-base"),
				evidenceId: value("evidence"),
				approved: true,
				approvedBy: "user",
			});
		case "rollback":
			return rollbackInstance(root, operands[0], value("expected-base"));
		case "automation status":
			return readAutomation(root);
		case "automation enable":
			return enableAutomation(root, parseJson(await readText(value("limits"))));
		case "automation disable":
			return disableAutomation(root, value("reason"));
		case "automation approve":
			return enableAutomaticPromotion(root, {
				reportPath: resolve(value("report")),
				margin: Number(value("margin")),
				minTrials: Number(value("min-trials")),
			});
		case "automation manual":
			return disableAutomaticPromotion(root);
		case "automation checkpoint":
			return runModelCheckpoint(root, {
				task: value("goal"),
				command: stringArray(parseJson(value("check")), "--check"),
				evaluatorRoot: resolve(value("evaluator")),
				model: values.get("model"),
			});
		case "run":
			await run(await openInstance(root, values.get("revision")), command.trailing);
			return undefined;
		case "status": {
			const manifest = await readInstance(root);
			const pin = await openInstance(root, values.get("revision"));
			const skills = loadSkillsFromDir({ dir: join(pin.resourceRoot, "skills"), source: "instance" });
			const backend = new NoMistakesBackend({ instanceRoot: root, projectRoot: pin.projectRoot });
			return {
				manifest,
				pin,
				skills: skills.skills.map(({ name, description, filePath }) => ({ name, description, filePath })),
				diagnostics: skills.diagnostics,
				capabilities: { sandbox: await checkSandbox(), noMistakes: await backend.inspect() },
			};
		}
		case "refine":
			return runModelRefinement(root, {
				task: value("goal"),
				command: stringArray(parseJson(value("check")), "--check"),
				timeoutMs: number("timeout-ms"),
				maxModelCalls: number("max-model-calls"),
				model: values.get("model"),
				skill: values.get("skill"),
				approved: flags.has("approved"),
				evaluatorRoot: resolve(value("evaluator")),
			});
		case "skill verify": {
			const result = values.has("directory")
				? await validateSkill(resolve(value("directory")), { timeoutMs: number("timeout-ms") })
				: await verifySkillRevision(root, value("revision"), value("skill"), { timeoutMs: number("timeout-ms") });
			if (!result.accepted) process.exitCode = 1;
			return result;
		}
		case "skill propose": {
			const result = await proposeSkill(root, resolve(value("directory")), { timeoutMs: number("timeout-ms") });
			if (!result.validation.accepted) process.exitCode = 1;
			return result;
		}
	}
	if (name.startsWith("memory ")) {
		await readInstance(root);
		const memory = new InstanceMemory(root);
		switch (name) {
			case "memory observe":
				return memory.observe(memoryInput(parseJson(await readText(value("input")))));
			case "memory revise":
				return memory.revise(operands[0], memoryInput(parseJson(await readText(value("input")))));
			case "memory retire":
				return memory.retire(operands[0], value("reason"));
			case "memory get":
				return memory.get(operands[0], number("version"));
			case "memory list":
				return memory.list();
			case "memory history":
				return memory.history(operands[0]);
			case "memory retrieve":
				return memory.retrieve({
					query: value("query"),
					scope: values.get("scope") ?? (await readInstance(root)).projectRoot,
					taskType: values.get("task-type"),
					harnessRevision: values.get("revision"),
					maxChars: number("max-chars"),
					limit: number("limit"),
					includeHypotheses: flags.has("include-hypotheses"),
				});
			case "memory export":
				return memory.exportEntries(
					value("ids")
						.split(",")
						.map((id) => id.trim()),
				);
			case "memory import": {
				const entries = parseJson(await readText(value("input")));
				if (!Array.isArray(entries))
					throw new UsageError("Memory import must be a JSON array of exported entries.");
				for (const entry of entries) memoryInput(entry);
				return memory.importEntries(
					entries as MemoryEntry[],
					values.has("scope") ? { scope: value("scope") } : undefined,
				);
			}
		}
	}
	if (name.startsWith("no-mistakes ")) {
		const manifest = await readInstance(root);
		let agent = agentCommand();
		if (values.has("agent-config")) {
			const input = parseJson(await readText(value("agent-config")));
			if (
				!input ||
				typeof input !== "object" ||
				Array.isArray(input) ||
				!("executable" in input) ||
				typeof input.executable !== "string" ||
				!isAbsolute(input.executable) ||
				!("version" in input) ||
				typeof input.version !== "string" ||
				!input.version.trim() ||
				("args" in input && (!Array.isArray(input.args) || !input.args.every((arg) => typeof arg === "string"))) ||
				Object.keys(input).some((key) => !["executable", "version", "args"].includes(key))
			)
				throw new UsageError("Agent config requires an absolute executable, version, and optional string args.");
			agent = {
				executable: input.executable,
				version: input.version,
				args: "args" in input ? (input.args as string[]) : [],
			};
		}
		const backend =
			name === "no-mistakes enable"
				? new NoMistakesBackend({ instanceRoot: root, projectRoot: manifest.projectRoot, agent })
				: name === "no-mistakes inspect" || name === "no-mistakes provision"
					? new NoMistakesBackend({ instanceRoot: root, projectRoot: manifest.projectRoot })
					: await getNoMistakesBackend(root, manifest.projectRoot);
		switch (name) {
			case "no-mistakes inspect":
				return backend.inspect();
			case "no-mistakes provision":
				return backend.provision({ approved: true });
			case "no-mistakes enable":
				return backend.enable({ approved: true, network: true });
			case "no-mistakes start":
				return backend.start({ approved: true });
			case "no-mistakes status":
				return backend.status();
			case "no-mistakes run":
				return backend.run({
					intent: await readText(value("intent-file")),
					approval: {
						network: true,
						push: flags.has("push") ? true : undefined,
						pr: flags.has("pr") ? true : undefined,
						ci: flags.has("ci") ? true : undefined,
						yes: flags.has("yes") ? true : undefined,
					},
				});
			case "no-mistakes respond":
				return backend.respond({
					action: value("action") as "approve" | "fix" | "skip",
					approved: true,
					findings: values
						.get("findings")
						?.split(",")
						.map((id) => id.trim()),
					instructions: values.get("instructions"),
					reason: values.get("reason"),
				});
			case "no-mistakes stop":
				return backend.stop({ approved: true, force: flags.has("force") ? true : undefined });
		}
	}
	throw new Error(`Unimplemented instance command ${name}.`);
}

export async function handleInstanceCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "instance") return false;
	try {
		const separator = args.indexOf("--");
		const ownArgs = separator === -1 ? args : args.slice(0, separator);
		if (args.length === 1 || ownArgs.includes("--help") || ownArgs.includes("-h") || args[1] === "help") {
			help();
			return true;
		}
		const result = await execute(parse(args));
		if (result !== undefined) {
			console.log(JSON.stringify(result, null, 2));
			if (result && typeof result === "object" && "exitCode" in result && typeof result.exitCode === "number")
				process.exitCode = result.exitCode;
		}
	} catch (error) {
		console.error(`${APP_NAME} instance: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = error instanceof UsageError ? 2 : 1;
	}
	return true;
}
