import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import { GitDiffClient } from "../src/extensions/diff/git.ts";
import diffExtension from "../src/extensions/diff/index.ts";

async function load() {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		diffExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"builtin:diff",
	);
	const notify = vi.fn();
	const custom = vi.fn(async () => {});
	const ctx = { cwd: process.cwd(), mode: "tui", ui: { notify, custom } } as unknown as ExtensionCommandContext;
	return { runtime, extension, notify, custom, ctx, command: extension.commands.get("diff")! };
}

describe("built-in /diff", () => {
	it("registers a read-only dashboard without creating a provider or Git side effects", async () => {
		const { extension, runtime } = await load();
		expect([...extension.commands.keys()]).toEqual(["diff"]);
		expect(runtime.pendingProviderRegistrations).toHaveLength(0);
		expect(extension.tools.size).toBe(0);
	});

	it("requires an interactive TUI", async () => {
		const { command, ctx, notify, custom } = await load();
		await command.handler("", { ...ctx, mode: "json" });
		expect(notify).toHaveBeenCalledWith("/diff requires interactive mode.", "warning");
		expect(custom).not.toHaveBeenCalled();
	});

	it("reports Git errors without opening a broken dashboard", async () => {
		const root = vi.spyOn(GitDiffClient.prototype, "root").mockRejectedValue(new Error("Not a Git repository"));
		try {
			const { command, ctx, notify, custom } = await load();
			await command.handler("", ctx);
			expect(notify).toHaveBeenCalledWith("Not a Git repository", "error");
			expect(custom).not.toHaveBeenCalled();
		} finally {
			root.mockRestore();
		}
	});

	it("resolves commit references before opening the dashboard", async () => {
		const root = vi.spyOn(GitDiffClient.prototype, "root").mockResolvedValue(process.cwd());
		const resolve = vi.spyOn(GitDiffClient.prototype, "resolveCommit").mockResolvedValue("a".repeat(40));
		try {
			const { command, ctx, custom } = await load();
			await command.handler("HEAD~2", ctx);
			expect(resolve).toHaveBeenCalledWith("HEAD~2");
			expect(custom).toHaveBeenCalledOnce();
		} finally {
			root.mockRestore();
			resolve.mockRestore();
		}
	});

	it("provides configurable dashboard actions", () => {
		expect(KEYBINDINGS["app.diff.commits"].defaultKeys).toBe("c");
		expect(KEYBINDINGS["app.diff.file"].defaultKeys).toBe("o");
		const keys = new KeybindingsManager({ "app.diff.commits": "ctrl+k" });
		expect(keys.matches("\x0b", "app.diff.commits")).toBe(true);
		expect(keys.matches("c", "app.diff.commits")).toBe(false);
	});
});
