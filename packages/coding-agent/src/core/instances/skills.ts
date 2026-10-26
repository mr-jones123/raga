/**
 * Fresh-interpreter validation and candidate promotion of learned Python skills.
 *
 * A skill directory holds SKILL.md (Agent Skills frontmatter) and raga-skill.json, which declares an
 * explicit-input entry function, pinned third-party dependencies, permitted file outputs, and
 * behavioral cases. Every case runs in its own sandboxed interpreter with an empty scratch directory
 * as its only writable path, so a skill that leans on session globals, undeclared imports, or
 * unrecorded side effects fails here rather than after promotion.
 *
 * The skill shares its interpreter with the runner, so everything the interpreter reports is an
 * untrusted observation: it can reject a skill but never proves the absence of an effect. The
 * interpreter sees only a copy of the skill's code and each case's input, never the expected
 * outcomes, which the supervisor compares itself. Prohibited effects are refused below Python:
 * bubblewrap mounts confine the filesystem and network namespace, and a seccomp filter installed
 * before any untrusted import refuses process creation and socket creation for the process's life.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { digestTree, materializeRevision, writeEvidence } from "./refinement.ts";
import { sandboxCommand } from "./sandbox.ts";
import { commitCandidate, createCandidate, instancePaths, readInstance } from "./store.ts";
import type { CommandResult, HarnessCandidate, RevisionEvidence } from "./types.ts";

export const SKILL_MANIFEST = "raga-skill.json";

const DEFAULT_CASE_TIMEOUT_MS = 30_000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDENTIFIER = "^[A-Za-z_][A-Za-z0-9_]*$";
const IDENTIFIER_PATTERN = new RegExp(IDENTIFIER);
const SKIPPED_NAMES = new Set(["__pycache__", ".pytest_cache"]);

const SkillDependencySchema = Type.Object({
	/** Import name. */
	module: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$" }),
	/** Distribution name when it differs from the import name. */
	distribution: Type.Optional(Type.String({ minLength: 1 })),
	/** Exact installed version required. */
	version: Type.String({ minLength: 1 }),
});

const SkillCaseSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	/** Keyword arguments for the entry function. */
	input: Type.Record(Type.String(), Type.Unknown()),
	expect: Type.Union([
		Type.Object({ result: Type.Unknown() }, { additionalProperties: false }),
		Type.Object({ error: Type.String({ pattern: IDENTIFIER }) }, { additionalProperties: false }),
	]),
});

const SkillManifestSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	name: Type.String({ pattern: NAME_PATTERN.source }),
	description: Type.String({ minLength: 1 }),
	/** Python file, relative to the skill directory. */
	module: Type.String({ pattern: "\\.py$" }),
	function: Type.String({ pattern: IDENTIFIER }),
	dependencies: Type.Array(SkillDependencySchema),
	/** Files, relative to the working directory, the function may leave behind. Network and subprocesses are never allowed. */
	sideEffects: Type.Object({ writes: Type.Array(Type.String({ minLength: 1 })) }),
	cases: Type.Array(SkillCaseSchema),
});

const validateManifestShape = Compile(SkillManifestSchema);

export type SkillDependency = Static<typeof SkillDependencySchema>;
export type SkillCase = Static<typeof SkillCaseSchema>;
export type SkillManifest = Static<typeof SkillManifestSchema>;

export type SkillFailureKind =
	| "manifest"
	| "dependency"
	| "undeclared-import"
	| "hidden-global"
	| "case-mismatch"
	| "side-effect"
	| "nondeterministic"
	| "sandbox"
	| "timeout"
	| "aborted";

export interface SkillFailure {
	kind: SkillFailureKind;
	case?: string;
	message: string;
}

export interface SkillCaseResult {
	name: string;
	passed: boolean;
	result: CommandResult;
	observed?: unknown;
	error?: string;
}

export interface SkillDependencyCheck {
	module: string;
	version?: string;
	installed?: string;
	ok: boolean;
	error?: string;
}

export interface SkillValidation {
	skill: string;
	accepted: boolean;
	contentDigest: string;
	failures: SkillFailure[];
	cases: SkillCaseResult[];
	dependencies: SkillDependencyCheck[];
	/** The dependency-check interpreter run, absent when the manifest was rejected before any run. */
	dependencyResult?: CommandResult;
}

export interface SkillValidationOptions {
	signal?: AbortSignal;
	/** Per interpreter run. */
	timeoutMs?: number;
	/** Interpreter command inside the sandbox. Default python3 from the system runtime mounts. */
	python?: string;
	/** Extra read-only canonical paths the interpreter needs, such as a virtual environment. */
	pythonMounts?: string[];
}

export interface SkillProposal {
	candidate: HarnessCandidate;
	validation: SkillValidation;
	/** Absent only when no interpreter ran, so there is no measured outcome to record. */
	evidenceId?: string;
}

export interface SkillEvidence extends RevisionEvidence {
	kind: "skill";
	skill: string;
	validation: SkillValidation;
}

export class SkillInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillInputError";
	}
}

// ---------------------------------------------------------------------------------------------
// Manifest boundary

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function isPlainRelative(path: string): boolean {
	return !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "" || part === ".");
}

/** Parse raga-skill.json and check it against SKILL.md and the directory name. */
export function parseSkillManifest(raw: unknown, directoryName: string, skillMarkdown: string): SkillManifest {
	if (!validateManifestShape.Check(raw)) {
		const errors = validateManifestShape
			.Errors(raw)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`)
			.join("; ");
		throw new SkillInputError(`invalid ${SKILL_MANIFEST}: ${errors}`);
	}
	const manifest = raw;
	if (manifest.name !== directoryName) {
		throw new SkillInputError(`skill name ${manifest.name} does not match directory ${directoryName}`);
	}
	const { frontmatter } = parseFrontmatter(skillMarkdown);
	if (frontmatter.name !== manifest.name || frontmatter.description !== manifest.description) {
		throw new SkillInputError("SKILL.md frontmatter name and description must match the manifest");
	}
	if (!isPlainRelative(manifest.module)) throw new SkillInputError("manifest.module must be a relative path");
	if (!manifest.sideEffects.writes.every(isPlainRelative)) {
		throw new SkillInputError("sideEffects.writes entries must be relative paths");
	}
	const cases = manifest.cases;
	if (new Set(cases.map((entry) => entry.name)).size !== cases.length)
		throw new SkillInputError("case names must be unique");
	if (cases.some((entry) => "error" in entry.expect && entry.expect.error === "NameError")) {
		throw new SkillInputError("cases may not expect NameError; it signals a hidden global");
	}
	const resultInputs = new Set(
		cases.filter((entry) => "result" in entry.expect).map((entry) => canonical(entry.input)),
	);
	if (resultInputs.size < 2) throw new SkillInputError("at least two result cases with different inputs are required");
	if (!cases.some((entry) => "error" in entry.expect))
		throw new SkillInputError("at least one failure-handling case is required");
	return manifest;
}

async function loadSkill(skillDir: string): Promise<SkillManifest> {
	const directoryName = skillDir.split(sep).filter(Boolean).pop() ?? "";
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(join(skillDir, SKILL_MANIFEST), "utf8"));
	} catch (error) {
		throw new SkillInputError(
			`cannot read ${SKILL_MANIFEST}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const markdown = await readFile(join(skillDir, "SKILL.md"), "utf8").catch(() => {
		throw new SkillInputError("SKILL.md is missing");
	});
	return parseSkillManifest(raw, directoryName, markdown);
}

// ---------------------------------------------------------------------------------------------
// Fresh interpreter runner

/**
 * Trusted runner executed by a fresh `python -I -B`. Before importing anything untrusted it installs
 * a seccomp filter that refuses process creation and socket creation, failing closed where it cannot.
 * It then checks pinned dependencies and, for a case, loads the skill module, calls the entry
 * function twice with copies of the input, and reports the outcome plus audited imports, writes
 * outside the scratch directory, network use, and process spawns. The report is the last stdout
 * line, prefixed with a per-run marker that separates it from skill output; the skill can read the
 * marker and forge the line, so the supervisor parses the report as untrusted input.
 */
const RUNNER_SOURCE = String.raw`import contextlib, copy, importlib, importlib.util, io, json, os, sys

def deny_processes_and_network():
    import ctypes, struct
    machine = os.uname().machine
    # (audit arch, numbers refused with EPERM: socket fork vfork execve execveat io_uring_setup, clone).
    # aarch64 has no fork or vfork syscalls. Threads still need clone with CLONE_THREAD.
    tables = {
        "x86_64": (0xC000003E, (41, 57, 58, 59, 322, 425), 56),
        "aarch64": (0xC00000B7, (198, 221, 281, 425), 220),
    }
    if sys.platform != "linux" or sys.byteorder != "little" or ctypes.sizeof(ctypes.c_void_p) != 8 or machine not in tables:
        raise OSError("unsupported platform " + sys.platform + "/" + machine)
    arch, denied, clone = tables[machine]
    allow, kill, eperm, enosys = 0x7FFF0000, 0x80000000, 0x00050001, 0x00050026
    load, jeq, jset, ret = 0x20, 0x15, 0x45, 0x06
    program = [(load, 0, 0, 4), (jeq, 1, 0, arch), (ret, 0, 0, kill), (load, 0, 0, 0)]
    if machine == "x86_64":
        program += [(jset, 0, 1, 0x40000000), (ret, 0, 0, kill)]
    for number in denied:
        program += [(jeq, 0, 1, number), (ret, 0, 0, eperm)]
    # clone3 hides its flags behind a pointer; ENOSYS makes libc fall back to clone, whose flags are visible.
    program += [(jeq, 0, 1, 435), (ret, 0, 0, enosys)]
    program += [(jeq, 0, 3, clone), (load, 0, 0, 16), (jset, 1, 0, 0x00010000), (ret, 0, 0, eperm), (ret, 0, 0, allow)]
    filters = ctypes.create_string_buffer(b"".join(struct.pack("=HBBI", *step) for step in program))

    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]

    fprog = Program(len(program), ctypes.cast(filters, ctypes.c_void_p))
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS failed")
    if libc.prctl(22, 2, ctypes.addressof(fprog), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_SECCOMP failed")

def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        job = json.load(handle)
    nonce = job["nonce"]
    report = {"dependencies": [], "imports": [], "writes": [], "network": [], "processes": []}
    active = [False]

    def emit(code):
        active[0] = False
        sys.__stdout__.write("\n" + nonce + json.dumps(report, default=repr) + "\n")
        sys.__stdout__.flush()
        os._exit(code)

    try:
        deny_processes_and_network()
    except Exception as error:
        report["fatal"] = "cannot refuse process and network syscalls: " + type(error).__name__ + ": " + str(error)
        emit(3)
    if not hasattr(sys, "stdlib_module_names"):
        report["fatal"] = "Python 3.10 or newer is required"
        emit(3)
    from importlib import metadata
    stdlib = set(sys.stdlib_module_names)
    for dep in job["dependencies"]:
        entry = {"module": dep["module"], "version": dep["version"], "ok": False}
        top = dep["module"].split(".")[0]
        if top in stdlib:
            entry["error"] = "standard library modules are not dependencies"
        else:
            try:
                importlib.import_module(dep["module"])
                entry["installed"] = metadata.version(dep.get("distribution") or top)
                entry["ok"] = entry["installed"] == dep["version"]
                if not entry["ok"]:
                    entry["error"] = "installed " + entry["installed"] + ", declared " + dep["version"]
            except Exception as error:
                entry["error"] = type(error).__name__ + ": " + str(error)
        report["dependencies"].append(entry)
    if not all(entry["ok"] for entry in report["dependencies"]):
        emit(4)
    case = job.get("case")
    if case is None:
        emit(0)

    skill_dir = job["skillDir"]
    scratch = os.path.realpath(os.getcwd())
    allowed = stdlib | {name.split(".")[0] for name in sys.modules} | set(job["localModules"])
    allowed |= {dep["module"].split(".")[0] for dep in job["dependencies"]}
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC

    def inside(path, root):
        return path == root or path.startswith(root + os.sep)

    def audit(event, args):
        if not active[0]:
            return
        if event == "import":
            name = args[0]
            if name.split(".")[0] not in allowed and name not in report["imports"]:
                report["imports"].append(name)
        elif event == "open":
            path, mode, flags = args
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & write_flags)
            if writing and not isinstance(path, int):
                full = os.path.realpath(os.fsdecode(path))
                protected = any(inside(full, root) for root in job["protected"])
                if protected or not (inside(full, scratch) or inside(full, "/tmp")):
                    report["writes"].append(full)
        elif event in ("socket.__new__", "socket.connect", "socket.bind", "socket.sendto", "socket.getaddrinfo"):
            report["network"].append(event + " " + repr(args[1:2]))
        elif event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty"):
            report["processes"].append(event)

    sys.addaudithook(audit)
    sys.path.insert(0, skill_dir)
    captured = io.StringIO()
    active[0] = True
    try:
        with contextlib.redirect_stdout(captured):
            spec = importlib.util.spec_from_file_location("raga_skill_under_test", os.path.join(skill_dir, job["module"]))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            function = getattr(module, job["function"], None)
            if not callable(function):
                raise AttributeError(job["function"] + " is not callable in " + job["module"])
            first = function(**copy.deepcopy(case["input"]))
            second = function(**copy.deepcopy(case["input"]))
    except BaseException as error:
        active[0] = False
        report["outcome"] = {"error": type(error).__name__, "message": str(error)[:2000]}
    else:
        active[0] = False
        try:
            first_json = json.dumps(first, sort_keys=True)
            report["outcome"] = {"result": json.loads(first_json), "repeatMatches": first_json == json.dumps(second, sort_keys=True)}
        except (TypeError, ValueError) as error:
            report["outcome"] = {"unserializable": str(error)[:2000]}
    report["stdout"] = captured.getvalue()[-4000:]
    emit(0)

main()
`;

/** The runner shares its process with untrusted skill code, so its report is parsed like any external input. */
const RunnerReportSchema = Type.Object({
	dependencies: Type.Array(
		Type.Object({
			module: Type.String(),
			version: Type.Optional(Type.String()),
			installed: Type.Optional(Type.String()),
			ok: Type.Boolean(),
			error: Type.Optional(Type.String()),
		}),
	),
	imports: Type.Array(Type.String()),
	writes: Type.Array(Type.String()),
	network: Type.Array(Type.String()),
	processes: Type.Array(Type.String()),
	fatal: Type.Optional(Type.String()),
	outcome: Type.Optional(
		Type.Union([
			Type.Object({ error: Type.String(), message: Type.String() }),
			Type.Object({ result: Type.Unknown(), repeatMatches: Type.Boolean() }),
			Type.Object({ unserializable: Type.String() }),
		]),
	),
});
const validateReport = Compile(RunnerReportSchema);
type RunnerReport = Static<typeof RunnerReportSchema>;

function parseReport(stdout: string, nonce: string): RunnerReport | undefined {
	const line = stdout
		.split("\n")
		.reverse()
		.find((candidate) => candidate.startsWith(nonce));
	if (!line) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice(nonce.length));
	} catch {
		return undefined;
	}
	return validateReport.Check(parsed) ? parsed : undefined;
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const name of await readdir(dir)) {
			const path = join(dir, name);
			const stat = await lstat(path);
			if (stat.isDirectory()) await walk(path);
			else files.push(relative(root, path).split(sep).join("/"));
		}
	};
	await walk(root);
	return files.sort();
}

async function localModules(skillDir: string): Promise<string[]> {
	const names: string[] = [];
	for (const name of await readdir(skillDir)) {
		const stat = await lstat(join(skillDir, name));
		if (stat.isFile() && name.endsWith(".py")) names.push(name.slice(0, -3));
		else if (stat.isDirectory() && IDENTIFIER_PATTERN.test(name)) names.push(name);
	}
	return names;
}

interface RunContext {
	workDir: string;
	runnerPath: string;
	skillDir: string;
	mounts: string[];
	manifest: SkillManifest;
	modules: string[];
	options: SkillValidationOptions;
	counter: number;
}

/**
 * Lay out the runner and a copy of the skill's code in workDir. The copy leaves out the manifest, so
 * the cases' expected outcomes sit nowhere the interpreter can read. An absent source stages an empty
 * skill directory, which the runner reports as a missing module.
 */
async function prepareRun(
	workDir: string,
	source: string | undefined,
	manifest: SkillManifest,
	options: SkillValidationOptions,
): Promise<RunContext> {
	await mkdir(join(workDir, "runner"));
	const runnerPath = join(workDir, "runner", "raga_skill_runner.py");
	await writeFile(runnerPath, RUNNER_SOURCE);
	const skillDir = join(workDir, "skill", manifest.name);
	if (source) await copySkillTree(source, skillDir);
	else await mkdir(skillDir, { recursive: true });
	await rm(join(skillDir, SKILL_MANIFEST), { force: true });
	return {
		workDir,
		runnerPath,
		skillDir,
		mounts: [join(workDir, "runner"), skillDir, ...(options.pythonMounts ?? [])],
		manifest,
		modules: await localModules(skillDir),
		options,
		counter: 0,
	};
}

/** Run the dependency check (`input` null) or one case in a fresh interpreter that never sees the expectation. */
async function runInterpreter(
	context: RunContext,
	input: SkillCase["input"] | null,
): Promise<{ result: CommandResult; report?: RunnerReport; leftovers: string[] }> {
	const index = context.counter++;
	const nonce = `RAGA-${randomBytes(16).toString("hex")}:`;
	const jobPath = join(context.workDir, "runner", `job-${index}.json`);
	await writeFile(
		jobPath,
		JSON.stringify({
			nonce,
			skillDir: context.skillDir,
			module: context.manifest.module,
			function: context.manifest.function,
			dependencies: context.manifest.dependencies,
			localModules: context.modules,
			protected: context.mounts,
			case: input === null ? null : { input },
		}),
	);
	const scratch = await realpath(await mkdtemp(join(context.workDir, "scratch-")));
	try {
		const result = await sandboxCommand({
			command: context.options.python ?? "python3",
			args: ["-I", "-B", context.runnerPath, jobPath],
			// -I ignores PYTHON* variables and user site-packages; -B keeps the read-only skill free of bytecode.
			policy: { workspace: scratch, readOnly: context.mounts, writable: [scratch], cwd: scratch, network: false },
			timeoutMs: context.options.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
			signal: context.options.signal,
		});
		return { result, report: parseReport(result.stdout, nonce), leftovers: await listFiles(scratch) };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

function runFailure(result: CommandResult, report: RunnerReport | undefined): SkillFailure | undefined {
	if (result.aborted) return { kind: "aborted", message: "validation was cancelled" };
	if (result.timedOut) return { kind: "timeout", message: "interpreter exceeded its time limit" };
	if (!report)
		return {
			kind: "sandbox",
			message: `interpreter produced no report (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`,
		};
	if (report.fatal) return { kind: "sandbox", message: report.fatal };
	return undefined;
}

/** Judge one case run against its declared expectation and the manifest's side-effect contract. */
function judgeCase(
	skillCase: SkillCase,
	manifest: SkillManifest,
	run: { result: CommandResult; report?: RunnerReport; leftovers: string[] },
): { failures: SkillFailure[]; record: SkillCaseResult } {
	const record: SkillCaseResult = { name: skillCase.name, passed: false, result: run.result };
	const fail = (kind: SkillFailureKind, message: string): SkillFailure => ({ kind, case: skillCase.name, message });
	const failure = runFailure(run.result, run.report);
	if (failure) return { failures: [{ ...failure, case: skillCase.name }], record };
	const report = run.report as RunnerReport; // runFailure returns a failure when the report is missing.
	const failures: SkillFailure[] = [];
	if (report.imports.length > 0)
		failures.push(fail("undeclared-import", `imports undeclared modules: ${report.imports.join(", ")}`));
	if (report.writes.length > 0)
		failures.push(fail("side-effect", `attempted writes outside its scratch directory: ${report.writes.join(", ")}`));
	if (report.network.length > 0)
		failures.push(fail("side-effect", `attempted network access: ${report.network.join(", ")}`));
	if (report.processes.length > 0)
		failures.push(fail("side-effect", `attempted to start processes: ${report.processes.join(", ")}`));
	const undeclared = run.leftovers.filter((path) => !manifest.sideEffects.writes.includes(path));
	if (undeclared.length > 0) failures.push(fail("side-effect", `left undeclared files: ${undeclared.join(", ")}`));

	const outcome = report.outcome;
	if (!outcome) {
		failures.push(fail("sandbox", "runner reported no outcome"));
	} else if ("unserializable" in outcome) {
		failures.push(fail("case-mismatch", `result is not JSON-serializable: ${outcome.unserializable}`));
	} else if ("error" in outcome) {
		record.error = `${outcome.error}: ${outcome.message}`;
		if (outcome.error === "NameError") {
			failures.push(
				fail("hidden-global", `depends on a name the fresh interpreter does not define: ${outcome.message}`),
			);
		} else if (!("error" in skillCase.expect) || skillCase.expect.error !== outcome.error) {
			failures.push(fail("case-mismatch", `raised ${record.error}`));
		}
	} else {
		record.observed = outcome.result;
		if (!("result" in skillCase.expect)) {
			failures.push(
				fail("case-mismatch", `expected ${skillCase.expect.error}, returned ${canonical(outcome.result)}`),
			);
		} else if (canonical(outcome.result) !== canonical(skillCase.expect.result)) {
			failures.push(
				fail(
					"case-mismatch",
					`expected ${canonical(skillCase.expect.result)}, returned ${canonical(outcome.result)}`,
				),
			);
		} else if (!outcome.repeatMatches) {
			failures.push(fail("nondeterministic", "a second call with the same input returned a different result"));
		}
	}
	record.passed = failures.length === 0;
	return { failures, record };
}

/**
 * Validate a skill directory in fresh sandboxed interpreters: dependencies first, then every case in
 * its own process. The directory must be unchanged afterwards.
 */
export async function validateSkill(skillDir: string, options: SkillValidationOptions = {}): Promise<SkillValidation> {
	const root = await realpath(skillDir);
	const skillName = root.split(sep).pop() ?? "";
	const contentDigest = await digestTree(root);
	let manifest: SkillManifest;
	try {
		manifest = await loadSkill(root);
	} catch (error) {
		if (!(error instanceof SkillInputError)) throw error;
		return {
			skill: skillName,
			accepted: false,
			contentDigest,
			failures: [{ kind: "manifest", message: error.message }],
			cases: [],
			dependencies: [],
		};
	}

	const workDir = await realpath(await mkdtemp(join(tmpdir(), "raga-skill-")));
	try {
		const validation: SkillValidation = {
			skill: manifest.name,
			accepted: false,
			contentDigest,
			failures: [],
			cases: [],
			dependencies: [],
		};
		let context: RunContext;
		try {
			context = await prepareRun(workDir, root, manifest, options);
		} catch (error) {
			if (!(error instanceof SkillInputError)) throw error;
			validation.failures.push({ kind: "manifest", message: error.message });
			return validation;
		}

		const dependencyRun = await runInterpreter(context, null);
		validation.dependencyResult = dependencyRun.result;
		const dependencyFailure = runFailure(dependencyRun.result, dependencyRun.report);
		if (dependencyFailure) {
			validation.failures.push(dependencyFailure);
			return validation;
		}
		validation.dependencies = dependencyRun.report?.dependencies ?? [];
		for (const dependency of validation.dependencies.filter((entry) => !entry.ok)) {
			validation.failures.push({
				kind: "dependency",
				message: `${dependency.module}: ${dependency.error ?? "unavailable"}`,
			});
		}
		if (validation.failures.length > 0) return validation;

		for (const skillCase of manifest.cases) {
			const judged = judgeCase(skillCase, manifest, await runInterpreter(context, skillCase.input));
			validation.cases.push(judged.record);
			validation.failures.push(...judged.failures);
			if (judged.failures.some((failure) => failure.kind === "aborted")) return validation;
		}
		if ((await digestTree(root)) !== contentDigest) {
			validation.failures.push({ kind: "sandbox", message: "skill files changed during validation" });
		}
		validation.accepted = validation.failures.length === 0;
		return validation;
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

/** Validate skills/<name> exactly as committed in a harness revision, accepted or candidate. */
export async function verifySkillRevision(
	instanceRoot: string,
	revision: string,
	skillName: string,
	options: SkillValidationOptions = {},
): Promise<SkillValidation> {
	if (!NAME_PATTERN.test(skillName)) throw new SkillInputError(`invalid skill name: ${skillName}`);
	const manifest = await readInstance(instanceRoot);
	const paths = instancePaths(manifest.projectRoot);
	const scratch = await mkdtemp(join(tmpdir(), "raga-skill-revision-"));
	try {
		const tree = await materializeRevision(paths.harness, revision, join(scratch, "harness"));
		const skillDir = join(tree, "skills", skillName);
		const present = await lstat(skillDir).then(
			(stat) => stat.isDirectory(),
			() => false,
		);
		if (!present) {
			return {
				skill: skillName,
				accepted: false,
				contentDigest: "",
				failures: [{ kind: "manifest", message: `skills/${skillName} is not present in ${revision}` }],
				cases: [],
				dependencies: [],
			};
		}
		return await validateSkill(skillDir, options);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function copySkillTree(source: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	for (const name of await readdir(source)) {
		if (SKIPPED_NAMES.has(name) || name.endsWith(".pyc")) continue;
		const from = join(source, name);
		const stat = await lstat(from);
		if (stat.isDirectory()) await copySkillTree(from, join(destination, name));
		else if (stat.isFile())
			await writeFile(join(destination, name), await readFile(from), { mode: stat.mode & 0o755 });
		else throw new SkillInputError(`${from} is not a regular file or directory`);
	}
}

/**
 * Commit a skill into a new candidate revision, validate that exact commit, and record supervisor
 * evidence against the candidate's base. Never activates; promotion goes through the store with approval.
 */
export async function proposeSkill(
	instanceRoot: string,
	sourceDir: string,
	options: SkillValidationOptions = {},
): Promise<SkillProposal> {
	const source = await realpath(sourceDir);
	const manifest = await loadSkill(source);
	const instance = await readInstance(instanceRoot);
	const paths = instancePaths(instance.projectRoot);
	const candidate = await createCandidate(instanceRoot);
	const destination = join(candidate.path, "skills", manifest.name);
	await rm(destination, { recursive: true, force: true });
	await copySkillTree(source, destination);
	const committed = await commitCandidate(instanceRoot, candidate.id, `skill: propose ${manifest.name}`);
	const revision = committed.revision;
	if (!revision) throw new Error(`candidate ${candidate.id} has no revision after commit`);

	const validation = await verifySkillRevision(instanceRoot, revision, manifest.name, options);
	const candidateRun = validation.cases[0]?.result ?? validation.dependencyResult;
	if (!candidateRun) return { candidate: committed, validation };
	const baseline = await baselineRun(paths.harness, committed.baseRevision, manifest, options);
	const evidence = await writeEvidence<SkillEvidence>(paths, {
		schemaVersion: 1,
		id: "",
		instanceId: instance.id,
		baseRevision: committed.baseRevision,
		candidateRevision: revision,
		createdAt: new Date().toISOString(),
		verdict: validation.accepted ? "passed" : "failed",
		command: [options.python ?? "python3", "-I", "-B", "raga_skill_runner.py", `skills/${manifest.name}`],
		baseline,
		candidate: candidateRun,
		reason: validation.accepted
			? `skill ${manifest.name} passed ${validation.cases.length} fresh-interpreter cases`
			: `skill ${manifest.name} rejected: ${validation.failures.map((failure) => `${failure.kind}: ${failure.message}`).join("; ")}`,
		kind: "skill",
		skill: manifest.name,
		validation,
	});
	return { candidate: committed, validation, evidenceId: evidence.id };
}

/** The first case run against the base revision's copy of the skill, which may not exist yet. */
async function baselineRun(
	harness: string,
	baseRevision: string,
	manifest: SkillManifest,
	options: SkillValidationOptions,
): Promise<CommandResult> {
	const workDir = await realpath(await mkdtemp(join(tmpdir(), "raga-skill-base-")));
	try {
		const tree = await materializeRevision(harness, baseRevision, join(workDir, "harness"));
		const skillDir = join(tree, "skills", manifest.name);
		const present = await lstat(skillDir).then(
			(stat) => stat.isDirectory(),
			() => false,
		);
		const context = await prepareRun(workDir, present ? skillDir : undefined, manifest, options);
		const run = await runInterpreter(context, manifest.cases[0].input);
		return run.result;
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
