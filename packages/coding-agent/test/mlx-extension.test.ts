import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { LlamaUi } from "../src/extensions/llama/ui.ts";
import { LocalModelCatalog } from "../src/extensions/local-models/catalog.ts";
import localModelsExtension from "../src/extensions/local-models/index.ts";
import { type ManagedLocalModelRuntime, prepareLocalModel } from "../src/extensions/local-models/manager.ts";
import { DEFAULT_MLX_MODEL, type MlxModelDetails } from "../src/extensions/mlx/huggingface.ts";
import { mlxProviderConfig } from "../src/extensions/mlx/index.ts";

const model: MlxModelDetails = {
	id: DEFAULT_MLX_MODEL,
	revision: "a".repeat(40),
	files: ["config.json", "tokenizer.json", "model.safetensors"],
	contextWindow: 262144,
	size: 970000000,
	gated: false,
};
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function setup(installed = true, cached = false) {
	const ui = {
		showModels: vi.fn(async () => ({ type: "close" as const })),
		select: vi.fn(async () => undefined),
		confirm: vi.fn(async () => true),
		connectionError: vi.fn(async () => "close" as const),
		searchModels: vi.fn(async () => undefined),
		showStatus: vi.fn(),
		progress: vi.fn(() => new Promise<void>(() => {})),
		updateProgress: vi.fn(),
	} satisfies LlamaUi;
	const runtime = {
		installed: vi.fn(async () => installed),
		install: vi.fn(async () => {}),
		cached: vi.fn(async () => cached),
		download: vi.fn(async () => {}),
		start: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:12345/v1" })),
		stop: vi.fn(async () => {}),
	} satisfies ManagedLocalModelRuntime;
	const save = vi.fn(async () => {});
	return { ui, runtime, save };
}

describe("local MLX models", () => {
	it("registers the unified local manager without a separate MLX command", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			localModelsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:local-mlx",
		);
		expect([...extension.commands.keys()]).toEqual(["local-models"]);
		expect(extension.handlers.has("session_shutdown")).toBe(true);
		expect(runtime.pendingProviderRegistrations).toHaveLength(0);
	});

	it("asks before downloading a missing model and then starts it", async () => {
		const { ui, runtime, save } = setup();
		const result = await prepareLocalModel(model, ui, runtime, { downloadOnly: false, save });
		expect(ui.confirm).toHaveBeenCalledWith(
			"Model is not downloaded. Download it now?",
			expect.stringContaining(model.id),
		);
		expect(runtime.download).toHaveBeenCalledOnce();
		expect(runtime.start).toHaveBeenCalledOnce();
		expect(save).toHaveBeenCalledOnce();
		expect(result).toEqual({ baseUrl: "http://127.0.0.1:12345/v1" });
	});

	it("does not download or start when download confirmation is declined", async () => {
		const { ui, runtime, save } = setup();
		ui.confirm.mockResolvedValue(false);
		expect(await prepareLocalModel(model, ui, runtime, { downloadOnly: false, save })).toBeUndefined();
		expect(runtime.download).not.toHaveBeenCalled();
		expect(runtime.start).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("requires separate consent before installing the runtime", async () => {
		const { ui, runtime, save } = setup(false);
		ui.confirm.mockResolvedValue(false);
		await prepareLocalModel(model, ui, runtime, { downloadOnly: false, save });
		expect(ui.confirm).toHaveBeenCalledWith("Install local MLX runtime?", expect.stringContaining("isolated Python"));
		expect(runtime.install).not.toHaveBeenCalled();
		expect(runtime.cached).not.toHaveBeenCalled();
	});

	it("installs once with consent, without starting a server for download-only", async () => {
		const { ui, runtime, save } = setup(false);
		expect(await prepareLocalModel(model, ui, runtime, { downloadOnly: true, save })).toBe("downloaded");
		expect(ui.confirm).toHaveBeenCalledTimes(2);
		expect(runtime.install).toHaveBeenCalledOnce();
		expect(runtime.download).toHaveBeenCalledOnce();
		expect(runtime.start).not.toHaveBeenCalled();
	});

	it("starts a complete cached snapshot without asking for another download", async () => {
		const { ui, runtime, save } = setup(true, true);
		await prepareLocalModel(model, ui, runtime, { downloadOnly: false, save });
		expect(ui.confirm).not.toHaveBeenCalled();
		expect(runtime.download).not.toHaveBeenCalled();
		expect(runtime.start).toHaveBeenCalledOnce();
	});

	it("does not start inference or save a discovery record after a failed download", async () => {
		const { ui, runtime, save } = setup();
		runtime.download.mockRejectedValue(new Error("Download interrupted"));
		await expect(prepareLocalModel(model, ui, runtime, { downloadOnly: false, save })).rejects.toThrow(
			"Download interrupted",
		);
		expect(runtime.start).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("surfaces gated repository instructions before downloading", async () => {
		const { ui, runtime, save } = setup();
		await prepareLocalModel({ ...model, gated: "manual" }, ui, runtime, { downloadOnly: true, save });
		expect(ui.confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("HF_TOKEN"));
	});

	it("cancels an in-progress download without starting inference", async () => {
		const { ui, runtime, save } = setup();
		ui.progress.mockImplementation(async () => {});
		const cancellable: ManagedLocalModelRuntime = {
			...runtime,
			download: async (_model, signal) => {
				signal.throwIfAborted();
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		};
		expect(await prepareLocalModel(model, ui, cancellable, { downloadOnly: false, save })).toBeUndefined();
		expect(runtime.start).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("keeps the running model when replacement is declined", async () => {
		const { ui, runtime, save } = setup(true, true);
		const beforeStart = vi.fn(async () => false);
		expect(await prepareLocalModel(model, ui, runtime, { downloadOnly: false, save, beforeStart })).toBeUndefined();
		expect(beforeStart).toHaveBeenCalledOnce();
		expect(runtime.start).not.toHaveBeenCalled();
	});

	it("uses a local server alias and conservative context limits", () => {
		const config = mlxProviderConfig(model, "http://127.0.0.1:12345/v1");
		expect(config.baseUrl).toBe("http://127.0.0.1:12345/v1");
		expect(config.api).toBe("openai-completions");
		expect(config.streamSimple).toBeTypeOf("function");
		expect(config.models).toEqual([expect.objectContaining({ id: model.id, contextWindow: 32768, maxTokens: 4096 })]);
	});

	it("persists discovery records atomically and ignores malformed records", async () => {
		const directory = await mkdtemp(join(tmpdir(), "raga-mlx-catalog-"));
		directories.push(directory);
		const catalog = new LocalModelCatalog(directory);
		expect(await catalog.list()).toEqual([]);
		await catalog.save(model);
		await writeFile(join(directory, "broken.json"), "{");
		await writeFile(join(directory, "unsafe.json"), JSON.stringify({ ...model, files: ["../outside"] }));
		expect(await catalog.list()).toEqual([model]);
		const files = await readdir(directory);
		expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
		const record = await readFile(join(directory, `${Buffer.from(model.id).toString("base64url")}.json`), "utf8");
		expect(record).not.toContain("HF_TOKEN");
	});
});
