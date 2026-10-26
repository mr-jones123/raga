import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryModelsStore,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	ModelCallBudget,
	meterModelRuntime,
	parseRefineCommand,
	runModelRefinement,
} from "../src/core/instances/model-refinement.ts";
import { RefinementInputError } from "../src/core/instances/refinement.ts";
import { checkSandbox } from "../src/core/instances/sandbox.ts";
import { readInstance } from "../src/core/instances/store.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createRefinementFixture, type RefinementFixture } from "./refinement-fixtures.ts";
import { getMessageText } from "./suite/harness.ts";

const sandbox = await checkSandbox();

async function fauxRuntime() {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		models: [{ id: "refiner", contextWindow: 200_000, maxTokens: 8_192, input: ["text"] }],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const model = faux.getModel();
	return { runtime, faux, model, spec: `${model.provider}/${model.id}` };
}

function pythonCall(code: string): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall("python", { code })], { stopReason: "toolUse" });
}

type Turn = AssistantMessage | ((context: TranscriptContext) => AssistantMessage);

/**
 * Sessions of one refinement share the faux queue. Each request is routed by its first user
 * message (the refinement prompt, the solver task, an llm_query prompt, or a child task) and the
 * turn by the number of assistant messages so far. Every provider request records the retry count
 * it was sent with.
 */
function routed(scripts: Record<string, Turn[]>, retries: Array<number | undefined> = []): FauxResponseStep[] {
	const step = (context: TranscriptContext, options: { maxRetries?: number } | undefined): AssistantMessage => {
		retries.push(options?.maxRetries);
		const first = getMessageText(context.messages.find((message) => message.role === "user"));
		const key = Object.keys(scripts).find((prefix) => first.startsWith(prefix));
		if (!key) throw new Error(`No script for session "${first.slice(0, 80)}"`);
		const turn = scripts[key][context.messages.filter((message) => message.role === "assistant").length];
		if (!turn) throw new Error(`Script for "${key}" has no more turns`);
		return typeof turn === "function" ? turn(context) : turn;
	};
	return Array.from({ length: 30 }, () => step);
}

const ROOT = "You are refining";
const SOLVE = "Solve the fixture task";
const SOLVED = [fauxAssistantMessage("solved")];

describe("metered refinement runtime", () => {
	it("lets exactly the budgeted number of concurrent requests reach the provider, with provider retries off", async () => {
		const { runtime, faux, model } = await fauxRuntime();
		const retries: Array<number | undefined> = [];
		faux.setResponses(
			Array.from(
				{ length: 5 },
				() => (_context: TranscriptContext, options: { maxRetries?: number } | undefined) => {
					retries.push(options?.maxRetries);
					return fauxAssistantMessage("ok");
				},
			),
		);
		const budget = new ModelCallBudget(3, new AbortController().signal);
		const metered = meterModelRuntime(runtime, budget);
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

		const messages = await Promise.all(
			Array.from({ length: 5 }, () => metered.completeSimple(model, context, { maxRetries: 5 })),
		);

		expect(faux.state.callCount).toBe(3);
		expect(budget.modelCalls()).toBe(3);
		expect(messages.filter((message) => message.stopReason === "stop")).toHaveLength(3);
		expect(messages.filter((message) => message.stopReason === "error")).toHaveLength(2);
		expect(retries).toEqual([0, 0, 0]);
	});

	it("starts no request after the refinement is stopped", async () => {
		const { runtime, faux, model } = await fauxRuntime();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const controller = new AbortController();
		const budget = new ModelCallBudget(10, controller.signal);
		const metered = meterModelRuntime(runtime, budget);
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

		expect((await metered.streamSimple(model, context).result()).stopReason).toBe("stop");
		controller.abort(new Error("operator cancelled"));
		const refused = await metered.streamSimple(model, context).result();

		expect(refused.stopReason).toBe("error");
		expect(faux.state.callCount).toBe(1);
		expect(budget.modelCalls()).toBe(1);
	});
});

describe("refinement options", () => {
	it("rejects zero or invalid limits and widened surfaces before touching the instance", async () => {
		const missing = join("/nonexistent", ".raga");
		const base = { task: "improve", command: ["python3", "check.py"], evaluatorRoot: "/nonexistent/evaluator" };
		const invalid = [
			{ maxModelCalls: 0 },
			{ repetitions: 1 },
			{ maxProbeRuns: 0 },
			{ timeoutMs: Number.NaN },
			{ command: [] },
			{ probeTask: " " },
			{ editableSurface: ["settings.json"] },
			{ editableSurface: ["skills/../extensions/"] },
			{ editableSurface: ["lessons/"], skill: "helper" },
		];
		for (const options of invalid) {
			await expect(runModelRefinement(missing, { ...base, ...options })).rejects.toBeInstanceOf(
				RefinementInputError,
			);
		}
	});

	it("keeps the operator's quoted JSON check command intact and rejects anything else", () => {
		expect(
			parseRefineCommand(
				`--goal "Fix the lint step" --probe-task "Run lint" --check '["node","check.js","--strict"]' --evaluator /trusted/checks --max-probe-runs 6 --approved`,
				"/work",
			),
		).toEqual({
			task: "Fix the lint step",
			probeTask: "Run lint",
			command: ["node", "check.js", "--strict"],
			evaluatorRoot: "/trusted/checks",
			maxProbeRuns: 6,
			approved: true,
		});
		expect(() => parseRefineCommand("--goal x --check node", "/work")).toThrow(RefinementInputError);
		expect(() => parseRefineCommand(`--check '["node"]'`, "/work")).toThrow(RefinementInputError);
		expect(() => parseRefineCommand(`--goal x --check '["node"]' --criteria hidden`, "/work")).toThrow(
			RefinementInputError,
		);
	});
});

describe.runIf(sandbox.available)("runModelRefinement", () => {
	const fixtures: RefinementFixture[] = [];

	beforeAll(() => {
		vi.stubEnv("RAGA_PYTHON", process.env.RAGA_PYTHON || "python3");
	});

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		while (fixtures.length > 0) fixtures.pop()?.cleanup();
	});

	async function setup() {
		const fixture = await createRefinementFixture();
		fixtures.push(fixture);
		return {
			fixture,
			command: ["python3", join(fixture.evaluator, "evaluate.py")],
			...(await fauxRuntime()),
		};
	}

	it("runs a solver in each replay's fresh project copy before the evaluator, without the evaluator mounted", async () => {
		const { fixture, command, runtime, faux, spec } = await setup();
		const solverTasks: string[] = [];
		const cellOutputs: string[] = [];
		const evaluatorFile = join(fixture.evaluator, "evaluate.py");
		faux.setResponses(
			routed({
				[SOLVE]: [
					(context) => {
						solverTasks.push(getMessageText(context.messages.find((message) => message.role === "user")));
						return pythonCall(
							`import os\nprint("evaluator visible:", os.path.exists(${JSON.stringify(evaluatorFile)}))\nprint("data:", open("data.txt").read().strip())\nopen("data.txt", "w").write("solved\\n")`,
						);
					},
					(context) => {
						cellOutputs.push(getMessageText(context.messages.at(-1)));
						return fauxAssistantMessage("done");
					},
				],
			}),
		);

		const result = await runModelRefinement(fixture.instanceRoot, {
			task: "Raise the lesson score",
			probeTask: SOLVE,
			probeMemory: "Frozen note: data.txt holds the input.",
			command,
			evaluatorRoot: fixture.evaluator,
			model: spec,
			modelRuntime: runtime,
			maxModelCalls: 4,
		});

		expect(cellOutputs).toHaveLength(2);
		for (const output of cellOutputs) {
			expect(output).toContain("evaluator visible: False");
			expect(output).toContain("data: original");
		}
		expect(solverTasks).toHaveLength(2);
		for (const task of solverTasks) expect(task).toContain("Frozen note: data.txt holds the input.");
		// The fixture evaluator scores -1 when the project it is given was already changed: the solver's edit.
		expect(result.refinement.baseline?.runs.map((run) => run.score)).toEqual([-1, -1]);
		expect(result.modelCalls).toBe(4);
		expect(result.refinement.stopReason).toBe("driver-call-limit");
		expect(result.refinement.candidates).toEqual([]);
	}, 180_000);

	it("charges solvers, root turns, llm_query, and an rlm_query child to one budget and stops the tree at the limit", async () => {
		const { fixture, command, runtime, faux, spec } = await setup();
		const retries: Array<number | undefined> = [];
		faux.setResponses(
			routed(
				{
					[SOLVE]: SOLVED,
					[ROOT]: [
						pythonCall('print(await llm_query("ping"))\nopen("lessons/a.md", "w").write("a\\n")'),
						pythonCall('print(await rlm_query("Inspect lessons", read_only=True))'),
						fauxAssistantMessage("never reached: the budget is spent"),
					],
					ping: [fauxAssistantMessage("pong")],
					"Inspect lessons": [fauxAssistantMessage("lessons inspected")],
				},
				retries,
			),
		);
		const before = await readInstance(fixture.instanceRoot);

		const result = await runModelRefinement(fixture.instanceRoot, {
			task: "Raise the lesson score",
			probeTask: SOLVE,
			command,
			evaluatorRoot: fixture.evaluator,
			model: spec,
			modelRuntime: runtime,
			maxModelCalls: 6,
			maxCandidates: 1,
		});

		// Two baseline solvers, then root, ping, root, child; the third root turn and the candidate's solvers are refused.
		expect(faux.state.callCount).toBe(6);
		expect(result.modelCalls).toBe(6);
		expect(result.refinement.usage.driverCalls).toBe(6);
		expect(retries).toEqual([0, 0, 0, 0, 0, 0]);
		const [candidate] = result.refinement.candidates;
		expect(candidate.changedFiles).toEqual(["lessons/a.md"]);
		expect(candidate.status).toMatchObject({ kind: "rejected", reason: "probe-error" });
		expect(result.refinement.outcome.kind).toBe("insufficient-evidence");
		expect(result.activation.kind).toBe("not-requested");
		expect((await readInstance(fixture.instanceRoot)).activeRevision).toBe(before.activeRevision);
	}, 180_000);

	it("cancellation stops the running python cell, ends the run as cancelled, and leaves the active revision", async () => {
		const { fixture, command, runtime, faux, spec } = await setup();
		const controller = new AbortController();
		faux.setResponses(
			routed({
				[SOLVE]: SOLVED,
				[ROOT]: [
					pythonCall(
						'open("lessons/a.md", "w").write("a\\n")\nawait llm_query("cancel now")\nimport time\ntime.sleep(120)',
					),
					fauxAssistantMessage("never reached"),
				],
				// The operator cancels while the root's python cell is waiting on this sub-call.
				"cancel now": [
					() => {
						controller.abort(new Error("operator cancelled"));
						return fauxAssistantMessage("ok");
					},
				],
			}),
		);
		const before = await readInstance(fixture.instanceRoot);
		const started = Date.now();

		const result = await runModelRefinement(fixture.instanceRoot, {
			task: "Raise the lesson score",
			probeTask: SOLVE,
			command,
			evaluatorRoot: fixture.evaluator,
			model: spec,
			modelRuntime: runtime,
			maxModelCalls: 8,
			signal: controller.signal,
		});

		expect(Date.now() - started).toBeLessThan(90_000);
		expect(result.refinement.stopReason).toBe("cancelled");
		expect(result.refinement.outcome.kind).toBe("cancelled");
		expect(result.refinement.candidates.map((record) => record.status.kind)).toEqual(["interrupted"]);
		expect(result.modelCalls).toBe(4);
		expect(faux.state.callCount).toBe(4);
		expect((await readInstance(fixture.instanceRoot)).activeRevision).toBe(before.activeRevision);
	}, 180_000);

	it("refuses an edit outside the narrowed surface before it is committed or probed", async () => {
		const { fixture, command, runtime, faux, spec } = await setup();
		faux.setResponses(
			routed({
				[SOLVE]: SOLVED,
				[ROOT]: [pythonCall('open("lessons/a.md", "w").write("a\\n")'), fauxAssistantMessage("Added lesson a")],
			}),
		);

		const result = await runModelRefinement(fixture.instanceRoot, {
			task: "Raise the lesson score",
			probeTask: SOLVE,
			command,
			evaluatorRoot: fixture.evaluator,
			editableSurface: ["skills/helper/"],
			model: spec,
			modelRuntime: runtime,
			maxModelCalls: 6,
			maxCandidates: 1,
		});

		const [candidate] = result.refinement.candidates;
		expect(candidate.revision).toBeUndefined();
		expect(candidate.status).toMatchObject({ kind: "rejected", reason: "driver-error" });
		expect(candidate.status.kind === "rejected" && candidate.status.detail).toContain("lessons/a.md");
		expect(result.refinement.usage.probeRuns).toBe(2);
		expect(result.modelCalls).toBe(4);
		expect(result.refinement.probeMetadata?.editableSurface).toBe("skills/helper/");
		expect(result.refinement.outcome.kind).toBe("insufficient-evidence");
	}, 180_000);

	it("activates only the measured improving commit when approved", async () => {
		const { fixture, command, runtime, faux, spec } = await setup();
		faux.setResponses(
			routed({
				[SOLVE]: SOLVED,
				[ROOT]: [pythonCall('open("lessons/a.md", "w").write("a\\n")'), fauxAssistantMessage("Added lesson a")],
			}),
		);

		const result = await runModelRefinement(fixture.instanceRoot, {
			task: "Raise the lesson score",
			probeTask: SOLVE,
			command,
			evaluatorRoot: fixture.evaluator,
			model: spec,
			modelRuntime: runtime,
			maxModelCalls: 6,
			maxCandidates: 1,
			approved: true,
		});

		const outcome = result.refinement.outcome;
		if (outcome.kind !== "improved")
			throw new Error(`expected an improvement, got ${outcome.kind}: ${outcome.reason}`);
		expect(result.refinement.candidates[0].hypothesis).toBe("Added lesson a");
		expect(result.modelCalls).toBe(6);
		expect(result.activation).toMatchObject({
			kind: "activated",
			revision: outcome.revision,
			evidenceId: outcome.evidenceId,
		});
		expect((await readInstance(fixture.instanceRoot)).activeRevision).toBe(outcome.revision);
	}, 180_000);

	it("refuses approved activation of a regression and keeps the baseline active", async () => {
		const { fixture, command, runtime, faux, spec } = await setup();
		faux.setResponses(
			routed({
				[SOLVE]: SOLVED,
				[ROOT]: [
					pythonCall('open("lessons/a.md", "w").write("a\\n")\nopen("lessons/b.md", "w").write("b\\n")'),
					fauxAssistantMessage("Added lessons a and b"),
				],
			}),
		);
		const before = await readInstance(fixture.instanceRoot);

		const result = await runModelRefinement(fixture.instanceRoot, {
			task: "Raise the lesson score",
			probeTask: SOLVE,
			command,
			evaluatorRoot: fixture.evaluator,
			model: spec,
			modelRuntime: runtime,
			maxModelCalls: 6,
			maxCandidates: 1,
			approved: true,
		});

		expect(result.refinement.candidates[0].status).toMatchObject({ kind: "assessed", assessment: "regression" });
		expect(result.refinement.outcome.kind).toBe("no-improvement");
		expect(result.activation.kind).toBe("refused");
		expect((await readInstance(fixture.instanceRoot)).activeRevision).toBe(before.activeRevision);
	}, 180_000);
});
