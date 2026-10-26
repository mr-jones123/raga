import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { getBundledHarnessPath } from "../../src/core/instances/bundle.ts";
import { InstanceMemory } from "../../src/core/instances/memory.ts";
import { checkSandbox } from "../../src/core/instances/sandbox.ts";
import { initializeInstance, openInstance } from "../../src/core/instances/store.ts";
import { resolvePythonEnv } from "../../src/core/rlm/python-env.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const cleanups: Array<() => void> = [];
let sandboxAvailable = false;
beforeAll(async () => {
	vi.stubEnv("RAGA_PYTHON", process.env.RAGA_PYTHON || "python3");
	sandboxAvailable = (await checkSandbox()).available;
});
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});
afterAll(() => vi.unstubAllEnvs());

function python(code: string) {
	return fauxAssistantMessage([fauxToolCall("python", { code })], { stopReason: "toolUse" });
}

async function setup(memoryEnabled = true, options: { git?: boolean; subdir?: string; bundled?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "raga-instance-session-"));
	const project = join(root, "project");
	const source = join(root, "harness");
	mkdirSync(project);
	mkdirSync(source);
	if (options.bundled) cpSync(getBundledHarnessPath(), source, { recursive: true });
	writeFileSync(join(source, "AGENTS.md"), "Keep each child change isolated until integration is verified.");
	mkdirSync(join(source, "extensions", "ledger-guidance"), { recursive: true });
	writeFileSync(
		join(source, "extensions", "ledger-guidance", "index.ts"),
		`export default function(api) {
		api.on("before_agent_start", () => ({ message: { customType: "ledger-guidance", content: "Keep ledger totals in decimal precision.", display: false } }));
	}`,
	);
	writeFileSync(join(project, "shared.txt"), "original\n");
	const cwd = options.subdir ? join(project, options.subdir) : project;
	mkdirSync(cwd, { recursive: true });
	if (options.git !== false) {
		execFileSync("git", ["init", "-q", project]);
		execFileSync("git", ["-C", project, "add", "shared.txt"]);
		execFileSync("git", [
			"-C",
			project,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"commit",
			"-qm",
			"base",
		]);
	}
	await initializeInstance(project, { harnessSource: source });
	const pin = await openInstance(join(project, ".raga"));
	const faux = registerFauxProvider();
	const streamSimple = getApiProvider(faux.api)?.streamSimple;
	const register: ExtensionFactory = (api) =>
		api.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			streamSimple,
			models: faux.models.map(({ id, name, api: modelApi, reasoning, input, cost, contextWindow, maxTokens }) => ({
				id,
				name,
				api: modelApi,
				reasoning,
				input,
				cost,
				contextWindow,
				maxTokens,
			})),
		});
	const services = await createAgentSessionServices({
		cwd,
		agentDir: join(root, "host"),
		resourceLoaderOptions: { extensionFactories: [register] },
	});
	const sessionManager = SessionManager.create(cwd, join(pin.stateRoot, "sessions"));
	const { session } = memoryEnabled
		? await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel() })
		: await createAgentSession({
				cwd,
				instance: pin,
				instanceMemory: false,
				sessionManager,
				model: faux.getModel(),
				modelRuntime: services.modelRuntime,
			});
	cleanups.push(() => {
		session.dispose();
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});
	return { root, project, cwd, pin, session, sessionManager, faux, services };
}

function texts(messages: Array<{ role: string; content?: unknown }>): string {
	return messages
		.map((message) => {
			if (typeof message.content === "string") return message.content;
			if (!Array.isArray(message.content)) return "";
			return message.content
				.map((block: { type: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : ""))
				.join("");
		})
		.join("\n");
}

describe("pinned instance sessions", () => {
	it("retrieves scoped guidance before the first model call and rejects direct host tools", async (ctx) => {
		if (!sandboxAvailable) ctx.skip("bubblewrap unavailable");
		const { pin, project, session, sessionManager, faux } = await setup();
		const memory = new InstanceMemory(pin.instanceRoot);
		await memory.observe({
			text: "Ledger rows require stable currency grouping.",
			scope: project,
			kind: "lesson",
			evidence: ["prior-validation"],
			epistemicStatus: "guidance",
		});
		await memory.observe({
			text: "Ledger rows require secret project B data.",
			scope: "other-project",
			kind: "lesson",
			evidence: ["other-validation"],
			epistemicStatus: "guidance",
		});
		let observed = "";
		faux.setResponses([
			(context) => {
				observed = texts(context.messages);
				return fauxAssistantMessage("Reviewed ledger grouping.");
			},
		]);
		await session.prompt("Review ledger currency grouping");
		expect(observed).toContain("stable currency grouping");
		expect(observed).toContain("Keep ledger totals in decimal precision.");
		expect(observed).not.toContain("secret project B");
		expect(session.getCallableToolNames()).toEqual(["python"]);
		expect(
			sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "raga-memory-retrieval"),
		).toBe(true);
	});

	it("continues using the pinned harness and provider after reload", async (ctx) => {
		if (!sandboxAvailable) ctx.skip("bubblewrap unavailable");
		const { session, faux } = await setup();
		faux.setResponses([python("print('before reload')"), fauxAssistantMessage("Ready.")]);
		await session.prompt("Run before reload");
		await session.reload();
		faux.setResponses([python("print('after reload')"), fauxAssistantMessage("Ready again.")]);
		await session.prompt("Run after reload");
		expect(texts(session.messages.filter((message) => message.role === "toolResult"))).toContain("after reload");
		expect(session.getCallableToolNames()).toEqual(["python"]);
	});

	it("keeps backend agents inside instance administration separate from the parent session", async () => {
		const { root, project, pin, services, faux } = await setup();
		const backendHome = join(pin.stateRoot, "backends", "no-mistakes", "home");
		mkdirSync(backendHome, { recursive: true });
		const backendServices = await createAgentSessionServices({
			cwd: backendHome,
			agentDir: join(root, "backend-agent"),
			modelRuntime: services.modelRuntime,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true },
		});
		const { session: backend } = await createAgentSessionFromServices({
			services: backendServices,
			sessionManager: SessionManager.create(backendHome, join(root, "backend-sessions")),
			model: faux.getModel(),
			rlm: true,
		});
		cleanups.push(() => backend.dispose());
		faux.setResponses([python("await write('gate-result.txt', 'backend-owned')"), fauxAssistantMessage("Checked.")]);
		await backend.prompt("Write the gate result in the backend workspace");
		expect(readFileSync(join(backendHome, "gate-result.txt"), "utf8")).toBe("backend-owned");
		expect(existsSync(join(project, "gate-result.txt"))).toBe(false);
		expect(backendServices.instance).toBeUndefined();
		expect(texts(backend.messages)).not.toContain("Keep ledger totals in decimal precision.");
	});

	it.skipIf(!sandboxAvailable).each(["tracked", "untracked"])(
		"preserves the project-relative working directory for %s child writers",
		async (kind) => {
			const { project, session, sessionManager, faux } = await setup(true, { subdir: "src" });
			if (kind === "tracked") {
				writeFileSync(join(project, "src", "local.txt"), "local original");
				execFileSync("git", ["-C", project, "add", "src/local.txt"]);
			}
			faux.setResponses(
				Array.from({ length: 4 }, () => (context) => {
					const first = context.messages.find((message) => message.role === "user");
					const task = texts(first ? [first] : []);
					if (context.messages.some((message) => message.role === "assistant"))
						return fauxAssistantMessage("Completed.");
					if (task === "Delegate from subdirectory")
						return python("result = await rlm_query('edit from src', details=True)\nprint(result['answer'])");
					return python(
						"assert await read('../shared.txt') == 'original\\n'\nawait write('local.txt', 'isolated child edit')\nanswer['content'] = 'subdirectory preserved'\nanswer['ready'] = True",
					);
				}),
			);
			await session.prompt("Delegate from subdirectory");
			expect(texts(session.messages.filter((message) => message.role === "toolResult"))).toContain(
				"subdirectory preserved",
			);
			if (kind === "tracked") expect(readFileSync(join(project, "src", "local.txt"), "utf8")).toBe("local original");
			else expect(existsSync(join(project, "src", "local.txt"))).toBe(false);
			const entry = sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom" && entry.customType === "raga-child-change");
			if (entry?.type !== "custom") throw new Error("Missing isolated child change");
			const { workspace } = entry.data as { workspace: { path: string } };
			expect(readFileSync(join(workspace.path, "src", "local.txt"), "utf8")).toBe("isolated child edit");
		},
	);

	it("keeps simultaneous same-file child edits separate from the user's worktree", async (ctx) => {
		if (!sandboxAvailable) ctx.skip("bubblewrap unavailable");
		const { project, session, sessionManager, faux } = await setup(true, { bundled: true });
		faux.setResponses(
			Array.from({ length: 6 }, () => (context) => {
				const first = context.messages.find((message) => message.role === "user");
				const task = texts(first ? [first] : [])
					.split("# Assignment\n")
					.at(-1)!;
				const turn = context.messages.filter((message) => message.role === "assistant").length;
				if (turn > 0) return fauxAssistantMessage("Completed.");
				if (task === "Delegate two writers")
					return python(
						"import asyncio\nroot = (await instance.info())['harnessPath']\nexec(await read(root + '/skills/peak/references/raga-runtime/raga_runtime.py'), globals())\na, b = await asyncio.gather(run_child('worker', 'writer-one', root, read_only=False, details=True), run_child('worker', 'writer-two', root, read_only=False, details=True))\nassert a['workspace']['id'] != b['workspace']['id']\nassert await read('shared.txt') == 'original\\n'\nprint('writers isolated')",
					);
				return python(
					`await write('shared.txt', ${JSON.stringify(task)})\nanswer['content'] = 'change isolated'\nanswer['ready'] = True`,
				);
			}),
		);
		await session.prompt("Delegate two writers");
		expect(readFileSync(join(project, "shared.txt"), "utf8")).toBe("original\n");
		const changes = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "raga-child-change");
		expect(changes).toHaveLength(2);
		const contents = changes.map((entry) => {
			if (entry.type !== "custom") throw new Error("not a child artifact");
			const data = entry.data as { workspace: { path: string } };
			return readFileSync(join(data.workspace.path, "shared.txt"), "utf8");
		});
		expect(new Set(contents)).toEqual(new Set(["writer-one", "writer-two"]));
	});

	it("freezes memory access for evaluated roots and descendants", async (ctx) => {
		if (!sandboxAvailable) ctx.skip("bubblewrap unavailable");
		const { pin, project, session, sessionManager, faux } = await setup(false, { git: false });
		await new InstanceMemory(pin.instanceRoot).observe({
			text: "Frozen ledger secret.",
			scope: project,
			kind: "lesson",
			evidence: ["prior"],
			epistemicStatus: "guidance",
		});
		let observed = "";
		faux.setResponses(
			Array.from({ length: 4 }, () => (context) => {
				observed += texts(context.messages);
				if (context.messages.some((message) => message.role === "assistant"))
					return fauxAssistantMessage("Frozen context only.");
				const first = context.messages.find((message) => message.role === "user");
				const task = texts(first ? [first] : []);
				const denied =
					"try:\n    await memory.search('ledger')\n    raise AssertionError('live memory accessible')\nexcept Exception as error:\n    assert type(error).__name__ == 'HostError'\n    print(str(error))";
				return task === "ledger"
					? python(`${denied}\nprint(await rlm_query('inspect frozen ledger', read_only=True))`)
					: python(`${denied}\nanswer['content'] = 'child memory denied'\nanswer['ready'] = True`);
			}),
		);
		await session.prompt("ledger");
		expect(observed).not.toContain("Frozen ledger secret");
		expect(
			sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "raga-memory-retrieval"),
		).toHaveLength(0);
		const output = texts(session.messages.filter((message) => message.role === "toolResult"));
		expect(output).toContain("memory.search");
		expect(output).not.toContain("live memory accessible");
		expect(output).toContain("child memory denied");
	});

	it("restores forked state without mounting the parent's private snapshot directory", async (ctx) => {
		if (!sandboxAvailable) ctx.skip("bubblewrap unavailable");
		if (!(await resolvePythonEnv()).hasDill) ctx.skip("dill is required for snapshot restoration");
		const { project, pin, session, sessionManager, faux, services } = await setup();
		faux.setResponses([python("value = 41"), fauxAssistantMessage("Stored.")]);
		await session.prompt("Store a value");
		await session.flushRlmSnapshot();
		const parentSnapshot = join(pin.stateRoot, "kernels", session.sessionId, "kernel.dill");
		const parentBytes = readFileSync(parentSnapshot);
		session.dispose();
		const leaf = sessionManager.getBranch().at(-1);
		if (!leaf) throw new Error("Missing parent session branch");
		sessionManager.createBranchedSession(leaf.id);
		const { session: fork } = await createAgentSession({
			cwd: project,
			instance: pin,
			sessionManager,
			modelRuntime: services.modelRuntime,
			model: faux.getModel(),
		});
		cleanups.push(() => fork.dispose());
		faux.setResponses([
			python(
				`assert value == 41\nvalue = 42\ntry:\n    await read(${JSON.stringify(parentSnapshot)})\n    raise AssertionError('parent snapshot was mounted')\nexcept FileNotFoundError:\n    print('fork restored without sibling mount')`,
			),
			fauxAssistantMessage("Restored."),
		]);
		await fork.prompt("Read and update the inherited value");
		expect(texts(fork.messages.filter((message) => message.role === "toolResult"))).toContain(
			"fork restored without sibling mount",
		);
		await fork.flushRlmSnapshot();
		expect(readFileSync(parentSnapshot)).toEqual(parentBytes);
		expect(readFileSync(join(pin.stateRoot, "kernels", fork.sessionId, "kernel.dill"))).not.toEqual(parentBytes);
	});
});
