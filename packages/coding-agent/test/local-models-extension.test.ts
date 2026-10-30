import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import type { LlamaUi } from "../src/extensions/llama/ui.ts";
import * as localUi from "../src/extensions/llama/ui.ts";
import { LocalModelCatalog } from "../src/extensions/local-models/catalog.ts";
import {
	DEFAULT_LOCAL_MODEL,
	DEFAULT_LOCAL_QUANTIZATION,
	GgufHuggingFaceClient,
	type GgufModelDetails,
} from "../src/extensions/local-models/huggingface.ts";
import localModelsExtension, { localCppProviderConfig } from "../src/extensions/local-models/index.ts";
import { type ManagedLocalModelRuntime, prepareLocalModel } from "../src/extensions/local-models/manager.ts";
import { MlxHuggingFaceClient } from "../src/extensions/mlx/huggingface.ts";
import { MlxRuntime } from "../src/extensions/mlx/runtime.ts";

const model: GgufModelDetails = {
	id: "LiquidAI/LFM3-1.7B-GGUF",
	revision: "a".repeat(40),
	files: ["LFM3-1.7B-Q4_K_M.gguf"],
	modelFile: "LFM3-1.7B-Q4_K_M.gguf",
	format: "gguf",
	quantization: "Q4_K_M",
	contextWindow: 16384,
	gated: false,
	size: 1099627808,
};
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function setup(installed = true, cached = false) {
	const ui = {
		showModels: vi.fn(async () => ({ type: "close" as const })),
		select: vi.fn<LlamaUi["select"]>(async () => undefined),
		confirm: vi.fn<LlamaUi["confirm"]>(async () => true),
		connectionError: vi.fn(async () => "close" as const),
		searchModels: vi.fn<LlamaUi["searchModels"]>(async () => undefined),
		showStatus: vi.fn(),
		updateProgress: vi.fn(),
		progress: vi.fn(() => new Promise<void>(() => {})),
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

describe("local llama.cpp models", () => {
	it("recommends the runnable official LFM3 GGUF instead of an unsupported MLX conversion", () => {
		expect(DEFAULT_LOCAL_MODEL).toBe(model.id);
		expect(DEFAULT_LOCAL_QUANTIZATION).toBe(model.quantization);
	});

	it("registers only /local-models without installing, downloading or publishing a server", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			localModelsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:local-models",
		);
		expect(extension.commands.has("local-models")).toBe(true);
		expect([...extension.commands.keys()]).toEqual(["local-models"]);
		expect(extension.handlers.has("session_shutdown")).toBe(true);
		expect(runtime.pendingProviderRegistrations).toHaveLength(0);
	});

	it("discloses Homebrew system installation and no MLX dependencies before setup", async () => {
		const { ui, runtime, save } = setup(false);
		await prepareLocalModel(model, ui, runtime, { backend: "llama.cpp", downloadOnly: false, save });
		expect(ui.confirm.mock.calls[0]).toEqual([
			"Install local llama.cpp runtime?",
			expect.stringContaining("Homebrew"),
		]);
		expect(ui.confirm.mock.calls[0]?.[1]).toContain("No MLX packages are installed");
		expect(runtime.install).toHaveBeenCalledOnce();
		expect(runtime.start).toHaveBeenCalledOnce();
	});

	it("asks before downloading missing GGUF weights and never claims they are MLX files", async () => {
		const { ui, runtime, save } = setup();
		await prepareLocalModel(model, ui, runtime, { backend: "llama.cpp", downloadOnly: false, save });
		expect(ui.confirm).toHaveBeenCalledWith(
			"Model is not downloaded. Download it now?",
			expect.stringContaining("selected GGUF inference files"),
		);
		expect(runtime.download).toHaveBeenCalledWith(model, expect.any(AbortSignal), expect.any(Function));
		expect(runtime.start).toHaveBeenCalledOnce();
	});

	it("does not download or run if the missing-weights prompt is declined", async () => {
		const { ui, runtime, save } = setup();
		ui.confirm.mockResolvedValue(false);
		expect(
			await prepareLocalModel(model, ui, runtime, { backend: "llama.cpp", downloadOnly: false, save }),
		).toBeUndefined();
		expect(runtime.download).not.toHaveBeenCalled();
		expect(runtime.start).not.toHaveBeenCalled();
	});

	it("launches a cached selection without a new download or consent prompt", async () => {
		const { ui, runtime, save } = setup(true, true);
		expect(await prepareLocalModel(model, ui, runtime, { backend: "llama.cpp", downloadOnly: false, save })).toEqual({
			baseUrl: "http://127.0.0.1:12345/v1",
		});
		expect(ui.confirm).not.toHaveBeenCalled();
		expect(runtime.download).not.toHaveBeenCalled();
	});

	it("exposes the llama.cpp server alias directly with a 16k context budget", () => {
		const config = localCppProviderConfig(model, "http://127.0.0.1:12345/v1");
		expect(config.name).toBe("Local llama.cpp");
		expect(config.streamSimple).toBeUndefined();
		expect(config.models).toEqual([expect.objectContaining({ id: model.id, contextWindow: 16384, maxTokens: 4096 })]);
	});

	it("preserves downloaded quantizations independently and rejects missing model files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "raga-gguf-catalog-"));
		directories.push(directory);
		const catalog = new LocalModelCatalog<GgufModelDetails>(directory, "gguf");
		await catalog.save(model);
		await catalog.save({
			...model,
			quantization: "Q5_K_M",
			modelFile: "model-Q5_K_M.gguf",
			files: ["model-Q5_K_M.gguf"],
		});
		await writeFile(join(directory, "invalid.json"), JSON.stringify({ ...model, modelFile: "../unselected.gguf" }));
		expect((await catalog.list()).map((entry) => entry.quantization).sort()).toEqual(["Q4_K_M", "Q5_K_M"]);
		expect(await new LocalModelCatalog(directory, "mlx").list()).toEqual([]);
	});
});

describe("automatic local backend routing", () => {
	async function manager() {
		const { ui } = setup();
		vi.spyOn(localUi, "showLlamaUi").mockImplementation(async (_ctx, run) => run(ui));
		vi.spyOn(LocalModelCatalog.prototype, "list").mockResolvedValue([]);
		vi.spyOn(LocalModelCatalog.prototype, "save").mockResolvedValue();
		vi.spyOn(MlxRuntime.prototype, "supported").mockReturnValue(true);
		vi.spyOn(MlxRuntime.prototype, "installed").mockResolvedValue(false);
		vi.spyOn(MlxRuntime.prototype, "install").mockResolvedValue();
		vi.spyOn(MlxRuntime.prototype, "cached").mockResolvedValue(false);
		const download = vi.spyOn(MlxRuntime.prototype, "download").mockResolvedValue();
		const start = vi.spyOn(MlxRuntime.prototype, "start").mockResolvedValue({ baseUrl: "http://127.0.0.1:12345/v1" });
		const stop = vi.spyOn(MlxRuntime.prototype, "stop").mockResolvedValue();
		const variants = vi.spyOn(GgufHuggingFaceClient.prototype, "variants").mockResolvedValue([]);
		const ggufDetails = vi.spyOn(GgufHuggingFaceClient.prototype, "details").mockResolvedValue(model);
		const mlxModel = {
			id: "org/model-without-backend-in-name",
			revision: "a".repeat(40),
			files: ["config.json", "model.safetensors"],
			contextWindow: 4096,
			gated: false as const,
		};
		const mlxDetails = vi.spyOn(MlxHuggingFaceClient.prototype, "details").mockResolvedValue(mlxModel);
		const runtime = createExtensionRuntime();
		runtime.setModel = vi.fn(async () => true);
		const extension = await loadExtensionFromFactory(
			localModelsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:local-models",
		);
		const command = extension.commands.get("local-models")!;
		const ctx = {
			mode: "tui",
			ui: { notify: vi.fn() },
			modelRegistry: { find: vi.fn((provider: string, id: string) => ({ provider, id })) },
		} as unknown as ExtensionCommandContext;
		return { ui, download, start, stop, variants, ggufDetails, mlxDetails, mlxModel, command, ctx, extension };
	}

	it("detects MLX from validated files even when the repository name has no MLX hint", async () => {
		const state = await manager();
		state.ui.select.mockResolvedValueOnce("Download only");
		await state.command.handler(state.mlxModel.id, state.ctx);
		expect(state.variants).toHaveBeenCalledWith(state.mlxModel.id);
		expect(state.mlxDetails).toHaveBeenCalledWith(state.mlxModel.id);
		expect(state.ui.select).toHaveBeenCalledWith(expect.stringContaining(" · MLX"), expect.any(Array));
		expect(state.ui.confirm).toHaveBeenCalledWith("Install local MLX runtime?", expect.any(String));
		expect(state.download).toHaveBeenCalledWith(state.mlxModel, expect.any(AbortSignal), expect.any(Function));
		expect(state.ggufDetails).not.toHaveBeenCalled();
		expect(state.start).not.toHaveBeenCalled();
	});

	it("detects GGUF and uses llama.cpp with an explicit quantization picker", async () => {
		const state = await manager();
		state.variants.mockResolvedValue([{ name: "Q4_K_M", size: model.size }]);
		state.ui.select
			.mockImplementationOnce(async (_title, labels) => labels[0])
			.mockResolvedValueOnce("Download only");
		await state.command.handler(model.id, state.ctx);
		expect(state.ggufDetails).toHaveBeenCalledWith(model.id, "Q4_K_M");
		expect(state.mlxDetails).not.toHaveBeenCalled();
		expect(state.ui.confirm).toHaveBeenCalledWith("Install local llama.cpp runtime?", expect.any(String));
		expect(state.download).toHaveBeenCalledWith(model, expect.any(AbortSignal), expect.any(Function));
	});

	it("does not misclassify network/auth failures as MLX", async () => {
		const state = await manager();
		state.variants.mockRejectedValue(new Error("Hugging Face authentication/access denied"));
		await expect(state.command.handler("org/private", state.ctx)).rejects.toThrow("authentication/access denied");
		expect(state.mlxDetails).not.toHaveBeenCalled();
		expect(state.download).not.toHaveBeenCalled();
	});

	it("combines and deduplicates both backend searches in one browser", async () => {
		const state = await manager();
		const ggufSearch = vi.spyOn(GgufHuggingFaceClient.prototype, "search").mockResolvedValue([
			{ id: model.id, downloads: 100 },
			{ id: "org/both", downloads: 10 },
		]);
		const mlxSearch = vi.spyOn(MlxHuggingFaceClient.prototype, "search").mockResolvedValue([
			{ id: state.mlxModel.id, downloads: 20 },
			{ id: "org/both", downloads: 10 },
		]);
		state.ui.select.mockResolvedValueOnce("Search Hugging Face models…");
		state.ui.searchModels.mockImplementationOnce(async (search) => {
			const controller = new AbortController();
			const results = await search("model", controller.signal);
			expect(results.map((entry) => entry.id)).toEqual([model.id, state.mlxModel.id, "org/both"]);
			return undefined;
		});
		await state.command.handler("", state.ctx);
		expect(ggufSearch).toHaveBeenCalledWith("model", expect.any(AbortSignal));
		expect(mlxSearch).toHaveBeenCalledWith("model", expect.any(AbortSignal));
	});

	it("stops both backends from the shared menu", async () => {
		const state = await manager();
		state.ui.select.mockResolvedValueOnce("Stop local server");
		await state.command.handler("", state.ctx);
		expect(state.stop).toHaveBeenCalledTimes(2);
		expect(state.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Local server stopped"));
	});
	it("requires confirmation to replace a llama.cpp model with an MLX model", async () => {
		const state = await manager();
		state.ui.select.mockResolvedValueOnce("Run locally");
		await state.command.handler(`${model.id}:Q4_K_M`, state.ctx);
		expect(state.start).toHaveBeenCalledTimes(1);
		state.ui.select.mockResolvedValueOnce("Run locally");
		await state.command.handler(state.mlxModel.id, state.ctx);
		expect(state.ui.confirm).toHaveBeenCalledWith(
			"Replace the running local model?",
			expect.stringContaining("(llama.cpp)"),
		);
		expect(state.stop).toHaveBeenCalledTimes(2);
		expect(state.start).toHaveBeenCalledTimes(2);
	});

	it("keeps the active backend if replacement is declined", async () => {
		const state = await manager();
		state.ui.select.mockResolvedValueOnce("Run locally");
		await state.command.handler(`${model.id}:Q4_K_M`, state.ctx);
		state.ui.confirm.mockImplementation(async (title) => title !== "Replace the running local model?");
		state.ui.select.mockResolvedValueOnce("Run locally");
		await state.command.handler(state.mlxModel.id, state.ctx);
		expect(state.stop).not.toHaveBeenCalled();
		expect(state.start).toHaveBeenCalledTimes(1);
	});

	it("does not install or download an MLX model on an unsupported platform", async () => {
		const state = await manager();
		vi.spyOn(MlxRuntime.prototype, "supported").mockReturnValue(false);
		await state.command.handler(state.mlxModel.id, state.ctx);
		expect(state.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Apple Silicon"), "warning");
		expect(state.download).not.toHaveBeenCalled();
		expect(state.start).not.toHaveBeenCalled();
		expect(state.ui.confirm).not.toHaveBeenCalled();
	});
});
