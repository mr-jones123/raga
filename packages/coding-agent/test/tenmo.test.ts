import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	listTenmoSessions,
	parseTenmoSpawn,
	sessionTree,
	type TenmoRecord,
	tenmoDir,
	writeTenmoRecord,
} from "../src/core/tenmo.ts";
import tenmoExtension from "../src/extensions/tenmo/index.ts";

let root: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tenmo-test-"));
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = join(root, "agent");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

function record(overrides: Partial<TenmoRecord>): TenmoRecord {
	return {
		pid: process.pid,
		sessionId: "s1",
		cwd: root,
		mode: "tui",
		status: "idle",
		startedAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("tenmo registry", () => {
	it("lists live sessions and removes records of dead processes", () => {
		writeTenmoRecord(record({ sessionId: "live" }));
		// Pid 2^31-1 is never a real process.
		writeTenmoRecord(record({ pid: 2147483647, sessionId: "dead" }));
		expect(listTenmoSessions().map((session) => session.sessionId)).toEqual(["live"]);
		expect(() => readFileSync(join(tenmoDir(), "2147483647.json"))).toThrow();
	});

	it("skips unreadable records without deleting fresh ones", () => {
		mkdirSync(tenmoDir(), { recursive: true });
		writeFileSync(join(tenmoDir(), "123.json"), "{");
		expect(listTenmoSessions()).toEqual([]);
		expect(readFileSync(join(tenmoDir(), "123.json"), "utf8")).toBe("{");
	});
});

describe("sessionTree", () => {
	function session(name: string, id: string, parentSession?: string): string {
		const path = join(root, name);
		writeFileSync(path, `${JSON.stringify({ type: "session", id, parentSession })}\n`);
		return path;
	}

	it("collects subagent sessions and forks, skipping sessions still running elsewhere", () => {
		const main = session("main.jsonl", "m");
		const child = session("child.jsonl", "c", main);
		const grandchild = session("grandchild.jsonl", "g", child);
		const running = session("running-fork.jsonl", "r", main);
		session("running-child.jsonl", "rc", running);
		session("other.jsonl", "o");
		expect(sessionTree(main, new Set([running])).sort()).toEqual([child, grandchild, main].sort());
	});
});

describe("parseTenmoSpawn", () => {
	beforeEach(() => mkdirSync(join(root, "app")));

	it("drops the leading request phrase and keeps the task", () => {
		expect(parseTenmoSpawn("make a raga session at @app. it needs to do x and y", root)).toEqual({
			cwd: join(root, "app"),
			prompt: "it needs to do x and y",
		});
	});

	it("accepts a bare folder followed by the task and quoted paths", () => {
		expect(parseTenmoSpawn("@app fix the login bug", root)).toEqual({
			cwd: join(root, "app"),
			prompt: "fix the login bug",
		});
		mkdirSync(join(root, "my app"));
		expect(parseTenmoSpawn('@"my app" run the tests', root)).toEqual({
			cwd: join(root, "my app"),
			prompt: "run the tests",
		});
	});

	it("keeps text before the folder when it is the task", () => {
		expect(parseTenmoSpawn("fix the flaky test in @app", root)).toEqual({
			cwd: join(root, "app"),
			prompt: "fix the flaky test in",
		});
	});

	it("rejects a missing folder, a missing path, and an empty task", () => {
		expect(parseTenmoSpawn("do things", root)).toHaveProperty("error");
		expect(parseTenmoSpawn("@nope do things", root)).toHaveProperty("error");
		expect(parseTenmoSpawn("make a session at @app", root)).toHaveProperty("error");
	});
});

describe("tenmo extension", () => {
	async function load() {
		const extension = await loadExtensionFromFactory(
			tenmoExtension,
			root,
			createEventBus(),
			createExtensionRuntime(),
			"builtin:tenmo",
		);
		const emit = async (event: { type: string } & Record<string, unknown>, ctx: ExtensionContext) => {
			for (const handler of extension.handlers.get(event.type) ?? []) await handler(event, ctx);
		};
		return { extension, emit };
	}

	function context(sessionId: string, entries: unknown[] = []): ExtensionContext {
		return {
			mode: "tui",
			cwd: root,
			model: { provider: "faux", id: "m1" },
			isIdle: () => true,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => join(root, `${sessionId}.jsonl`),
				getCwd: () => root,
				getSessionName: () => undefined,
				getEntries: () => entries,
			},
		} as unknown as ExtensionContext;
	}

	it("registers /tenmo", async () => {
		const { extension } = await load();
		expect([...extension.commands.keys()]).toEqual(["tenmo"]);
	});

	it("tracks the main session's intent and status and ignores subagent sessions", async () => {
		const { emit } = await load();
		const main = context("main", [
			{ type: "message", message: { role: "user", content: "ship the importer" } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "now add tests" }] } },
		]);
		await emit({ type: "session_start", reason: "startup" }, main);
		let [session] = listTenmoSessions();
		expect(session).toMatchObject({
			sessionId: "main",
			status: "idle",
			intent: "ship the importer",
			lastPrompt: "now add tests",
			model: "faux/m1",
		});

		const child = context("child");
		await emit({ type: "session_start", reason: "startup" }, child);
		await emit({ type: "agent_start" }, child);
		expect(listTenmoSessions()[0]).toMatchObject({ sessionId: "main", status: "idle" });

		await emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" }, main);
		expect(listTenmoSessions()[0].status).toBe("idle");
		await emit({ type: "agent_start" }, main);
		expect(listTenmoSessions()[0].status).toBe("working");
		await emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" }, main);
		expect(listTenmoSessions()[0].status).toBe("waiting");
		await emit({ type: "agent_settled" }, main);
		[session] = listTenmoSessions();
		expect(session.status).toBe("idle");

		await emit({ type: "session_shutdown", reason: "quit" }, main);
		expect(listTenmoSessions()).toEqual([]);
	});
});
