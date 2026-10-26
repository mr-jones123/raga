import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ARMS = {
	fixed: { memory: false, skills: false, refinement: false, retries: 1 },
	"equal-budget": { memory: false, skills: false, refinement: false, retries: 2 },
	memory: { memory: true, skills: false, refinement: false, retries: 1 },
	skills: { memory: false, skills: true, refinement: false, retries: 1 },
	refinement: { memory: false, skills: false, refinement: true, retries: 1 },
	combined: { memory: true, skills: true, refinement: true, retries: 1 },
	"combined-scoped": { memory: true, skills: true, refinement: true, retries: 1, scoped: true },
};

export function budgetPlan(maxModelCalls) {
	const taskCalls = Math.max(1, Math.floor(maxModelCalls / 24));
	return {
		taskCalls,
		retryTaskCalls: Math.max(2, Math.floor((maxModelCalls - taskCalls * 4) / 8)),
		acquisitionCalls: Math.floor(maxModelCalls * 0.15 / 2),
		refinementCalls: Math.floor(maxModelCalls * 0.35 / 2),
	};
}

export const FAMILIES = {
	records: `Implement normalize(rows, key="id", keep="last") in solution.py. Rows are dictionaries. Reject missing keys and keep values other than "first" or "last" with ValueError. Deduplicate by the selected key. Return fresh dictionaries in the original order of the retained occurrences. Never mutate the input.`,
	money: `Implement amount(value, places=2, mode="half_even") in solution.py. Convert value through str to Decimal, quantize to the requested nonnegative number of decimal places, and return a fixed-point string. Modes are half_even, half_up, and down (toward zero). Reject other modes and negative places with ValueError.`,
};

export function shuffled(values, seed) {
	let state = seed >>> 0;
	return [...values].map((value) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return { value, order: state };
	}).sort((a, b) => a.order - b.order).map(({ value }) => value);
}

export function cases(seed) {
	return ["development", "selection", "held-out"].flatMap((split, s) =>
		["atlas", "beacon"].flatMap((repository, r) => Object.keys(FAMILIES).map((family) => ({
			id: `${split}-${repository}-${family}`, split, repository, family,
			variant: seed + s * 101 + r * 17,
			prompt: `${FAMILIES[family]}\nUse the Python tool to edit the repository. Run python3 public_check.py. Keep all public files and entrypoints.`,
		}))),
	);
}

export function git(cwd, ...args) {
	return execFileSync("git", ["-c", "user.name=Raga benchmark", "-c", "user.email=benchmark@raga.invalid", "-c", "commit.gpgSign=false", ...args], {
		cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	}).trim();
}

export function createRepository(root, name) {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, ".gitignore"), ".raga/\n__pycache__/\n");
	writeFileSync(join(root, "README.md"), `# ${name}\n\nPython transformation utilities.\n`);
	writeFileSync(join(root, "solution.py"), `def normalize(rows, key="id", keep="last"):\n    return rows\n\ndef amount(value, places=2, mode="half_even"):\n    return str(value)\n`);
	writeFileSync(join(root, "public_check.py"), `from solution import normalize, amount\nassert normalize([{"id": 1}, {"id": 1}]) == [{"id": 1}]\nassert amount("1.235", mode="half_up") == "1.24"\nprint("public checks passed")\n`);
	git(root, "init", "-q");
	git(root, "add", ".gitignore", "README.md", "solution.py", "public_check.py");
	git(root, "commit", "-qm", "benchmark fixture");
	return root;
}

export const HELPER_REQUEST = `Derive a reusable Python helper from the development attempts and their observed feedback below. Write ONLY a portable skill directory skills/transfer-helper under the current workspace. Do not copy repository solutions. The helper must expose run(family, payload) and return the raw function result, never a {"result":...} envelope. Raise exceptions for invalid input instead of returning error dictionaries. For records payload has rows, key, keep. For money payload has value, places, mode. Follow these public contracts:\n${Object.values(FAMILIES).join("\n")}\nWrite SKILL.md with frontmatter name: transfer-helper and description matching raga-skill.json. Write raga-skill.json with schemaVersion:1, name, description, module (relative .py file), function:"run", dependencies:[], sideEffects:{writes:[]}, and cases:[{name,input:{family,payload},expect:{result:...}}]. Include at least two distinct successful input cases and one expect:{error:"ValueError"} case. Use explicit input only, no hidden globals, no subprocesses, no network, no writes. Explain how another Python session imports this helper from the skill path. Do not hand-author any harness instructions outside that directory.`;

export const EVALUATOR = String.raw`import copy, importlib.util, json, os, pathlib, sys
job = json.loads(pathlib.Path(sys.argv[1]).read_text())
root = pathlib.Path(os.environ.get("RAGA_PROJECT", os.getcwd()))
try:
    spec = importlib.util.spec_from_file_location("evaluated_solution", root / "solution.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
except Exception:
    print(json.dumps({"success": False, "mistakes": ["import-failure"]}))
    print("RAGA_SCORE=0")
    sys.exit(0)
failures = []
for case in job["checks"]:
    family, payload = case["family"], case["input"]
    original = copy.deepcopy(payload)
    try:
        if family == "records":
            result = module.normalize(**payload)
        else:
            result = module.amount(**payload)
        aliases = family == "records" and isinstance(result, list) and any(item is row for item in result for row in payload["rows"])
        ok = "error" not in case and result == case.get("expected") and payload == original and not aliases
    except Exception as error:
        ok = type(error).__name__ == case.get("error")
    if not ok:
        failures.append(case["tag"])
print(json.dumps({"success": not failures, "mistakes": failures}))
print("RAGA_SCORE=" + str((len(job["checks"]) - len(failures)) / len(job["checks"])))
sys.exit(0)
`;

export function truth(task) {
	const n = task.variant;
	const rows = [{ id: n, value: "old" }, { id: n + 1, value: "other" }, { id: n, value: "new" }];
	const records = [
		{ input: { rows, keep: "last" }, expected: [rows[1], rows[2]], tag: "last-occurrence-order" },
		{ input: { rows, keep: "first" }, expected: [rows[0], rows[1]], tag: "first-occurrence-order" },
		{ input: { rows: [{ code: n }, { code: n }], key: "code" }, expected: [{ code: n }], tag: "custom-key" },
		{ input: { rows: [{}] }, error: "ValueError", tag: "missing-key" },
		{ input: { rows: [], keep: "unknown" }, error: "ValueError", tag: "invalid-keep" },
	];
	const money = [
		{ input: { value: `${n}.125` }, expected: `${n}.12`, tag: "half-even" },
		{ input: { value: `-${n}.125`, mode: "half_up" }, expected: `-${n}.13`, tag: "negative-tie" },
		{ input: { value: `${n}.129`, mode: "down" }, expected: `${n}.12`, tag: "truncate" },
		{ input: { value: n, places: 3 }, expected: `${n}.000`, tag: "fixed-precision" },
		{ input: { value: "1", mode: "unknown" }, error: "ValueError", tag: "invalid-mode" },
		{ input: { value: "1", places: -1 }, error: "ValueError", tag: "invalid-places" },
	];
	return { checks: (task.family === "records" ? records : money).map((check) => ({ ...check, family: task.family })) };
}
