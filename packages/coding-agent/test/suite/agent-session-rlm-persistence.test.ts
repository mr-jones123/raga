import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { type PythonEnv, resolvePythonEnv } from "../../src/core/rlm/python-env.ts";
import { RLM_SNAPSHOT_ENTRY_TYPE } from "../../src/core/rlm/runtime.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

// Runs the real Python kernel. Snapshots need dill: set RAGA_PYTHON to an interpreter that has it.
// The default is python3 on PATH, so the test never provisions a venv or touches the network.
let pythonEnv: PythonEnv;

beforeAll(async () => {
	vi.stubEnv("RAGA_PYTHON", process.env.RAGA_PYTHON || "python3");
	pythonEnv = await resolvePythonEnv();
});

afterAll(() => {
	vi.unstubAllEnvs();
});

function pythonCall(code: string) {
	return fauxAssistantMessage([fauxToolCall("python", { code })], { stopReason: "toolUse" });
}

function snapshotPaths(entries: SessionEntry[]): string[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== RLM_SNAPSHOT_ENTRY_TYPE) return [];
		const data: unknown = entry.data;
		return typeof data === "object" && data !== null && "path" in data && typeof data.path === "string"
			? [data.path]
			: [];
	});
}

describe("AgentSession RLM kernel persistence", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	function requireDill(ctx: { skip: (note: string) => void }): void {
		if (!pythonEnv.hasDill) {
			ctx.skip(`dill is not installed for ${pythonEnv.python}; set RAGA_PYTHON to an interpreter with dill`);
		}
	}

	/** An RLM runtime over persisted sessions in a fresh directory, driven by the faux provider. */
	async function createRlmRuntime() {
		const tempDir = mkdtempSync(join(tmpdir(), "rlm-persistence-"));
		const sessionDir = join(tempDir, "sessions");
		const faux = registerFauxProvider();
		const registerFaux = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.getModel().provider, {
				baseUrl: faux.getModel().baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((model) => ({
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				})),
			});
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				resourceLoaderOptions: {
					extensionFactories: [registerFaux],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
					rlm: true,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, sessionDir),
		});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});
		return { runtime, faux, sessionDir };
	}

	it("restores a variable after a teardown and a resume", async (ctx) => {
		requireDill(ctx);
		const { runtime, faux, sessionDir } = await createRlmRuntime();
		faux.setResponses([
			pythonCall("secret = {'value': 4711}"),
			fauxAssistantMessage("stored"),
			pythonCall("print(secret['value'])"),
			fauxAssistantMessage("read"),
		]);
		await runtime.session.prompt("Store a secret");
		const sessionFile = runtime.session.sessionFile;
		const sessionId = runtime.session.sessionId;
		if (!sessionFile) throw new Error("The session is not persisted");

		// Replacing the session tears it down, which writes the snapshot that is still scheduled.
		await runtime.newSession();
		expect(runtime.session.sessionFile).not.toBe(sessionFile);
		await runtime.switchSession(sessionFile);
		expect(runtime.session.sessionFile).toBe(sessionFile);
		const snapshot = join(sessionDir, `${sessionId}.rlm`, "kernel.dill");
		expect(existsSync(snapshot)).toBe(true);
		expect(snapshotPaths(runtime.session.sessionManager.getBranch())).toEqual([snapshot]);

		await runtime.session.prompt("Read the secret");
		const text = getMessageText(runtime.session.messages.findLast((message) => message.role === "toolResult"));
		expect(text).toBe("[kernel restored 1 variables: secret]\n[stdout]\n4711");
		// The resumed session already has its snapshot entry, so it adds no second one.
		await runtime.session.flushRlmSnapshot();
		expect(snapshotPaths(runtime.session.sessionManager.getEntries())).toEqual([snapshot]);
	});

	it("restores the parent's variable in a fork, which snapshots to its own file", async (ctx) => {
		requireDill(ctx);
		const { runtime, faux, sessionDir } = await createRlmRuntime();
		faux.setResponses([
			pythonCall("value = 1"),
			fauxAssistantMessage("set"),
			fauxAssistantMessage("second answer"),
			pythonCall("print(value)\nvalue = 2"),
			fauxAssistantMessage("changed in the fork"),
		]);
		await runtime.session.prompt("Set value");
		await runtime.session.flushRlmSnapshot();
		await runtime.session.prompt("Second question");
		const parentSnapshot = join(sessionDir, `${runtime.session.sessionId}.rlm`, "kernel.dill");
		const parentBytes = readFileSync(parentSnapshot);
		const parentModified = statSync(parentSnapshot).mtimeMs;

		const secondQuestion = runtime.session.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "message" && entry.message.role === "user");
		if (!secondQuestion) throw new Error("No user message to fork from");
		await runtime.fork(secondQuestion.id);
		const forkSnapshot = join(sessionDir, `${runtime.session.sessionId}.rlm`, "kernel.dill");
		expect(forkSnapshot).not.toBe(parentSnapshot);

		await runtime.session.prompt("Change value in the fork");
		const text = getMessageText(runtime.session.messages.findLast((message) => message.role === "toolResult"));
		expect(text).toBe("[kernel restored 1 variables: value]\n[stdout]\n1");

		await runtime.session.flushRlmSnapshot();
		expect(existsSync(forkSnapshot)).toBe(true);
		expect(snapshotPaths(runtime.session.sessionManager.getBranch())).toEqual([parentSnapshot, forkSnapshot]);
		expect(readFileSync(parentSnapshot).equals(parentBytes)).toBe(true);
		expect(statSync(parentSnapshot).mtimeMs).toBe(parentModified);
	});

	describe("snapshot problems", () => {
		const harnesses: Harness[] = [];

		afterEach(() => {
			while (harnesses.length > 0) harnesses.pop()?.cleanup();
		});

		it("reports variables the snapshot leaves out once, in the next python result", async (ctx) => {
			requireDill(ctx);
			const harness = await createHarness({ rlm: {} });
			harnesses.push(harness);
			harness.setResponses([
				pythonCall("numbers = (n for n in range(3))\nkept = 1"),
				fauxAssistantMessage("first"),
				pythonCall("kept"),
				fauxAssistantMessage("second"),
				pythonCall("kept + 1"),
				fauxAssistantMessage("third"),
			]);
			await harness.session.prompt("first");
			await harness.session.flushRlmSnapshot();
			await harness.session.prompt("second");
			expect(getMessageText(getToolResult(harness, "python"))).toBe(
				"[kernel snapshot left out 1 variables that cannot be pickled or exceed the size caps: numbers]\n[result]\n1",
			);
			await harness.session.flushRlmSnapshot();
			await harness.session.prompt("third");
			expect(getMessageText(getToolResult(harness, "python"))).toBe("[result]\n2");
		});
	});
});
