/** Benchmark tasks: fixture generation, prompt, and scorer. */
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CATEGORIES, generateT1, MESSAGE_COUNT } from "./fixtures/t1-messages.mjs";
import { generateT2 } from "./fixtures/t2-ledger.mjs";

/** The integer after the last `ANSWER:`; otherwise the last integer in the text. */
function parseAnswer(text) {
	const tagged = [...text.matchAll(/ANSWER\s*:\s*\**\s*(-?[\d,]+)/gi)];
	const raw = tagged.length > 0 ? tagged.at(-1)[1] : text.match(/-?\d[\d,]*/g)?.at(-1);
	if (raw === undefined) return undefined;
	const value = Number.parseInt(raw.replaceAll(",", ""), 10);
	return Number.isNaN(value) ? undefined : value;
}

function pyFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...pyFiles(path));
		else if (name.endsWith(".py")) out.push(path);
	}
	return out;
}

function pytest(python, cwd, target) {
	const result = spawnSync(python, ["-m", "pytest", "-q", "-p", "no:cacheprovider", target], {
		cwd,
		encoding: "utf8",
		timeout: 120_000,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	return { pass: result.status === 0, summary: output.trim().split("\n").at(-1) ?? "" };
}

export const TASKS = {
	T1: {
		title: "long-context aggregation",
		/** Writes the fixture into `fixtureDir/work`; returns the ground truth. */
		generate(fixtureDir, seed) {
			return generateT1(join(fixtureDir, "work"), seed);
		},
		prompt: `The file messages.txt in the current directory holds ${MESSAGE_COUNT} customer support messages, one per line (format: "MSG <id> | <date> | <name> | <text>"). Every message belongs to exactly one of these categories: ${CATEGORIES.join(", ")}. Judge each message by what the customer is actually asking for or reporting, not by the words it happens to use: a message can mention a charge, a refund, or an invoice without being a billing complaint.

How many of the messages are billing complaints? Count exactly. End your reply with a final line of the form "ANSWER: <integer>".`,
		score({ finalText, truth }) {
			const answer = parseAnswer(finalText);
			return {
				success: answer === truth.answer,
				answer: answer ?? null,
				expected: truth.answer,
				absError: answer === undefined ? null : Math.abs(answer - truth.answer),
			};
		},
	},
	T2: {
		title: "rename + thread a keyword parameter",
		generate(fixtureDir, seed) {
			return generateT2(join(fixtureDir, "work"), join(fixtureDir, "hidden"), seed);
		},
		prompt: `This directory holds a small Python package \`ledger\` with a pytest suite in tests/. Make this refactor:

1. Rename the function \`apply_tax\` (in ledger/tax.py) to \`add_sales_tax\`. Update every reference: imports, import aliases, module-attribute calls, re-exports, \`__all__\`, docstrings, and tests. Do not keep a compatibility alias; the name \`apply_tax\` must not appear anywhere under ledger/ afterwards.
2. Give \`add_sales_tax\` a new keyword-only parameter \`rounding\` with default \`"half_even"\`. Supported values: "half_even" (the current behavior), "half_up" (ties round away from zero), and "down" (truncate toward zero). Any other value raises ValueError.
3. Thread the parameter through all call sites: every function or method in ledger/ that calls \`add_sales_tax\` directly or indirectly must itself take a keyword-only \`rounding="half_even"\` parameter and pass it on to the function it calls. With the default, behavior stays exactly as it is today.
4. Run the tests with \`python -m pytest -q\` and make sure they pass.`,
		/** Success: visible suite passes, hidden suite (new API, threaded parameter) passes, old name gone from ledger/. */
		score({ workDir, fixtureDir, truth, python }) {
			const visible = pytest(python, workDir, truth.testsDir);
			const hiddenDir = join(workDir, ".bench_hidden");
			cpSync(join(fixtureDir, "hidden"), hiddenDir, { recursive: true });
			const hidden = pytest(python, workDir, ".bench_hidden");
			const pattern = new RegExp(`\\b${truth.oldName}\\b`);
			const leftovers = pyFiles(join(workDir, truth.packageDir))
				.filter((file) => pattern.test(readFileSync(file, "utf8")))
				.map((file) => relative(workDir, file));
			return {
				success: visible.pass && hidden.pass && leftovers.length === 0,
				visiblePass: visible.pass,
				visibleSummary: visible.summary,
				hiddenPass: hidden.pass,
				hiddenSummary: hidden.summary,
				oldNameIn: leftovers,
			};
		},
	},
};
