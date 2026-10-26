import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	CompositionRequest,
	DriverReply,
	ProbeSpec,
	ProposalRequest,
	RefinementDriver,
} from "../src/core/instances/refinement.ts";
import { initializeInstance } from "../src/core/instances/store.ts";

/**
 * Trusted evaluator for refinement tests. It scores the harness under test from lessons/*.md and
 * mutates the project copy it was given, so a reused workspace shows up as score -1.
 */
const EVALUATOR_SOURCE = `import os, pathlib, time
harness = pathlib.Path(os.environ["RAGA_HARNESS"])
project = pathlib.Path(os.environ["RAGA_PROJECT"])
repetition = int(os.environ["RAGA_PROBE_REPETITION"])
data = project / "data.txt"
pristine = data.read_text() == "original\\n"
data.write_text("changed by an earlier probe\\n")
lessons = harness / "lessons"
flags = {name for name in ("a", "b", "c") if (lessons / (name + ".md")).exists()}
mode = (lessons / "score.md").read_text().strip()
if flags == {"a", "b"}:
    score = 0
elif flags == {"a", "c"}:
    score = 5
elif flags == {"a"}:
    score = 2
elif flags == {"b"}:
    score = 3
elif flags == {"c"}:
    score = 2
elif mode == "flaky":
    score = 1 + repetition % 2
elif mode == "slow":
    time.sleep(60)
    score = 9
elif mode == "tamper":
    try:
        (lessons / "score.md").write_text("9")
        score = 9
    except OSError:
        score = 0
else:
    score = float(mode)
print("RAGA_SCORE=%s" % (score if pristine else -1))
`;

export interface RefinementFixture {
	root: string;
	project: string;
	instanceRoot: string;
	evaluator: string;
	probe(overrides?: Partial<ProbeSpec>): ProbeSpec;
	cleanup(): void;
}

function git(cwd: string, args: string[]): void {
	execFileSync(
		"git",
		["-c", "user.name=test", "-c", "user.email=test@localhost", "-c", "commit.gpgSign=false", ...args],
		{
			cwd,
			stdio: "ignore",
		},
	);
}

export function writeTree(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

/** A Git project with one tracked file, an initialized instance, and a trusted evaluator outside both. */
export async function createRefinementFixture(harness: Record<string, string> = {}): Promise<RefinementFixture> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "raga-refinement-")));
	const project = join(root, "project");
	mkdirSync(project);
	writeFileSync(join(project, "data.txt"), "original\n");
	git(project, ["init", "-q"]);
	git(project, ["add", "data.txt"]);
	git(project, ["commit", "-q", "-m", "initial"]);

	const bundle = join(root, "bundle");
	writeTree(bundle, { "AGENTS.md": "# Base instructions\n", "lessons/score.md": "1\n", ...harness });
	await initializeInstance(project, { harnessSource: bundle });

	const evaluator = join(root, "evaluator");
	writeTree(evaluator, { "evaluate.py": EVALUATOR_SOURCE });
	return {
		root,
		project,
		instanceRoot: join(project, ".raga"),
		evaluator,
		probe: (overrides = {}) => ({
			command: "python3",
			args: [join(evaluator, "evaluate.py")],
			evaluatorRoot: evaluator,
			timeoutMs: 20_000,
			repetitions: 2,
			externalEffects: "none",
			notCovered: ["full task replay"],
			...overrides,
		}),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

export type ProposalStep = (request: ProposalRequest) => Promise<DriverReply | undefined> | DriverReply | undefined;

/**
 * Stands in for the model: each proposal runs the next scripted edit against the real candidate
 * checkout. The orchestrator commits, probes, and judges those edits itself.
 */
export function scriptedDriver(
	steps: Array<Record<string, string> | ProposalStep>,
	compose?: (request: CompositionRequest) => DriverReply,
): RefinementDriver & { proposals: ProposalRequest[]; compositions: CompositionRequest[] } {
	const proposals: ProposalRequest[] = [];
	const compositions: CompositionRequest[] = [];
	return {
		proposals,
		compositions,
		async propose(request) {
			const step = steps[proposals.length];
			proposals.push(request);
			if (!step) throw new Error("no scripted proposal left");
			if (typeof step === "function") {
				return (await step(request)) ?? { hypothesis: `step ${proposals.length}`, modelCalls: 1 };
			}
			writeTree(request.checkout, step);
			return { hypothesis: `edit ${Object.keys(step).join(", ")}`, modelCalls: 1 };
		},
		async compose(request) {
			compositions.push(request);
			if (!compose) throw new Error("no scripted composition");
			return compose(request);
		},
	};
}

export const BUDGET = { maxCandidates: 4, maxDriverCalls: 8, maxProbeRuns: 40, deadlineMs: 300_000 };
