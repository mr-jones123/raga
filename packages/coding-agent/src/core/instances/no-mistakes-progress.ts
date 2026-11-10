/**
 * Live state of a no-mistakes run for the TUI. `axi run` prints `run: <status>` and `  <step>: <status>`
 * lines to stderr as steps change, and its final stdout holds a `run:` object with a `steps` table.
 * Pure parsing only, so the renderer can import it without loading the backend.
 */

/** Core pipeline steps in run order. */
export const NO_MISTAKES_STEPS = [
	"intent",
	"rebase",
	"review",
	"test",
	"document",
	"lint",
	"push",
	"pr",
	"ci",
] as const;

export interface NoMistakesStep {
	name: string;
	/** pending, running, fixing, fix_review, awaiting_approval, completed, skipped, or failed. */
	status: string;
	findings?: number;
}

export interface NoMistakesProgress {
	branch?: string;
	/** Short commit id. */
	head?: string;
	/** The run's own status: running, completed, failed, or cancelled. */
	runStatus?: string;
	steps: NoMistakesStep[];
	/** Steps the user did not authorize, such as push, pr, and ci. */
	skipped: string[];
	/** Final interpreted state, set once the call returns. */
	state?: "gate" | "passed" | "failed" | "running" | "inconclusive" | "stopped";
	outcome?: string;
	pr?: string;
	startedAt: number;
	endedAt?: number;
}

export function initialNoMistakesProgress(skipped: string[], startedAt: number): NoMistakesProgress {
	return {
		steps: NO_MISTAKES_STEPS.map((name) => ({ name, status: skipped.includes(name) ? "skipped" : "pending" })),
		skipped: [...skipped],
		startedAt,
	};
}

/** The core step a step name belongs to: `gate.test.flaky` is a repository gate anchored at `test`. */
export function noMistakesAnchor(name: string): string {
	return name.startsWith("gate.") ? (name.split(".")[1] ?? name) : name === "babysit" ? "ci" : name;
}

function setStep(progress: NoMistakesProgress, name: string, status: string, findings?: number): void {
	const step = progress.steps.find((entry) => entry.name === name);
	if (step) {
		step.status = status;
		if (findings !== undefined) step.findings = findings;
		return;
	}
	// A repository gate goes after the last step sharing its anchor; an unknown step goes last.
	const anchor = noMistakesAnchor(name);
	let index = -1;
	for (let i = 0; i < progress.steps.length; i++) if (noMistakesAnchor(progress.steps[i].name) === anchor) index = i;
	progress.steps.splice(index === -1 ? progress.steps.length : index + 1, 0, {
		name,
		status,
		...(findings === undefined ? {} : { findings }),
	});
}

/** Apply one stderr progress line. Returns whether anything changed. */
export function applyNoMistakesProgressLine(progress: NoMistakesProgress, line: string): boolean {
	const run = /^run:\s*([a-z_]+)\s*$/.exec(line);
	if (run) {
		if (progress.runStatus === run[1]) return false;
		progress.runStatus = run[1];
		return true;
	}
	const step = /^\s+([a-z][a-z0-9.-]*):\s*([a-z_]+)\s*$/.exec(line);
	if (!step) return false;
	const name = step[1] === "babysit" ? "ci" : step[1];
	if (progress.steps.find((entry) => entry.name === name)?.status === step[2]) return false;
	setStep(progress, name, step[2]);
	return true;
}

/** Apply the `run:` object of a final `axi` output: branch, head, status, PR, and the steps table. */
export function applyNoMistakesOutput(progress: NoMistakesProgress, stdout: string): void {
	const lines = stdout.split("\n");
	const start = lines.findIndex((line) => /^run:\s*$/.test(line));
	if (start !== -1) {
		for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]); i++) {
			const field = /^ {2}([a-z_]+):\s*(.*?)\s*$/.exec(lines[i]);
			if (field) {
				const value = field[2].replace(/^"(.*)"$/, "$1");
				if (field[1] === "branch" && value) progress.branch = value;
				else if (field[1] === "head" && value) progress.head = value;
				else if (field[1] === "status" && value) progress.runStatus = value;
				else if (field[1] === "pr" && value) progress.pr = value;
			}
			if (!/^ {2}steps\[\d+\]\{step,status/.test(lines[i])) continue;
			for (i++; i < lines.length && /^ {4}\S/.test(lines[i]); i++) {
				const [name, status, findings] = lines[i].trim().split(",");
				if (name && status) setStep(progress, name, status, findings ? Number(findings) || 0 : undefined);
			}
			i--;
		}
	}
	const outcome = /^outcome:\s*([\w-]+)\s*$/m.exec(stdout)?.[1];
	if (outcome) progress.outcome = outcome;
}
