import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ProviderConfig } from "../../core/extensions/types.ts";
import { formatBytes } from "../llama/client.ts";
import { findHuggingFaceToken, type HuggingFaceModel } from "../llama/huggingface.ts";
import { showLlamaUi } from "../llama/ui.ts";
import { MlxHuggingFaceClient, type MlxModelDetails } from "../mlx/huggingface.ts";
import { MLX_PROVIDER_ID, mlxProviderConfig } from "../mlx/index.ts";
import { MlxRuntime } from "../mlx/runtime.ts";
import { LocalModelCatalog } from "./catalog.ts";
import {
	DEFAULT_LOCAL_MODEL,
	DEFAULT_LOCAL_QUANTIZATION,
	GgufHuggingFaceClient,
	type GgufModelDetails,
} from "./huggingface.ts";
import { prepareLocalModel } from "./manager.ts";

export const LOCAL_CPP_PROVIDER_ID = "local-llama.cpp";

export function localCppProviderConfig(model: GgufModelDetails, baseUrl: string): ProviderConfig {
	const contextWindow = Math.min(model.contextWindow, 16384);
	return {
		name: "Local llama.cpp",
		api: "openai-completions",
		apiKey: "local",
		baseUrl,
		models: [
			{
				id: model.id,
				name: `${model.id} ${model.quantization} (local llama.cpp)`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: Math.min(contextWindow, 4096),
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					supportsStrictMode: false,
					supportsUsageInStreaming: true,
					maxTokensField: "max_tokens",
				},
			},
		],
	};
}

type LocalModel = GgufModelDetails | MlxModelDetails;
type Backend = "llama.cpp" | "mlx";

function isGguf(model: LocalModel): model is GgufModelDetails {
	return "format" in model && model.format === "gguf";
}

export default function localModelsExtension(pi: ExtensionAPI): void {
	const runtimes = { "llama.cpp": new MlxRuntime({ backend: "llama.cpp" }), mlx: new MlxRuntime() };
	const catalog = new LocalModelCatalog<GgufModelDetails>(join(getAgentDir(), "local-models", "gguf-catalog"), "gguf");
	const mlxCatalog = new LocalModelCatalog();
	let busy = false;
	let active: { backend: Backend; id: string } | undefined;
	const stop = async () => {
		await Promise.all(Object.values(runtimes).map((runtime) => runtime.stop()));
		pi.unregisterProvider(LOCAL_CPP_PROVIDER_ID);
		pi.unregisterProvider(MLX_PROVIDER_ID);
		active = undefined;
	};
	pi.on("session_shutdown", stop);
	pi.registerCommand("local-models", {
		description: "Search, download, and run local Hugging Face models with automatic llama.cpp / MLX detection",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/local-models requires interactive mode.", "warning");
				return;
			}
			if (busy) {
				ctx.ui.notify("A local-model operation is already running.", "warning");
				return;
			}
			busy = true;
			try {
				await showLlamaUi(ctx, async (ui) => {
					const token = await findHuggingFaceToken();
					const hub = new GgufHuggingFaceClient(token);
					const mlxHub = new MlxHuggingFaceClient(token);
					let requested = args.trim() || undefined;
					while (true) {
						const saved = await catalog.list();
						const savedMlx = await mlxCatalog.list();
						let selection = requested;
						requested = undefined;
						if (!selection) {
							const recommended = `${DEFAULT_LOCAL_MODEL}:${DEFAULT_LOCAL_QUANTIZATION} · recommended · llama.cpp`;
							const search = "Search Hugging Face models…";
							const stopChoice = "Stop local server";
							const selections = new Map([
								[recommended, `${DEFAULT_LOCAL_MODEL}:${DEFAULT_LOCAL_QUANTIZATION}`],
								...saved
									.filter(
										(model) =>
											model.id !== DEFAULT_LOCAL_MODEL || model.quantization !== DEFAULT_LOCAL_QUANTIZATION,
									)
									.map((model): [string, string] => [
										`${model.id}:${model.quantization} · llama.cpp`,
										`${model.id}:${model.quantization}`,
									]),
								...savedMlx.map((model): [string, string] => [`${model.id} · MLX`, model.id]),
							]);
							const choice = await ui.select("Local models · automatic llama.cpp / MLX", [
								recommended,
								search,
								...[...selections.keys()].slice(1),
								stopChoice,
								"Close",
							]);
							if (!choice || choice === "Close") return;
							if (choice === stopChoice) {
								await stop();
								ctx.ui.notify("Local server stopped. Select another model with /model before continuing.");
								continue;
							}
							selection = selections.get(choice);
							if (choice === search) {
								selection = await ui.searchModels(
									async (query, signal) => {
										const results = await Promise.all([
											hub.search(query, signal),
											mlxHub.search(query, signal),
										]);
										const models = new Map<string, HuggingFaceModel>();
										for (const model of results.flat()) models.set(model.id, model);
										return [...models.values()].sort((a, b) =>
											a.id === DEFAULT_LOCAL_MODEL
												? -1
												: b.id === DEFAULT_LOCAL_MODEL
													? 1
													: b.downloads - a.downloads,
										);
									},
									{
										title: "Search local text models · GGUF / MLX",
										placeholder:
											"Model name or owner/repository[:quantization] · runtime detected automatically",
										emptyMessage: "No supported local text models found",
									},
								);
							}
							if (!selection) continue;
						}
						const parsed = /^([^:\s]+)(?::([A-Za-z0-9_-]+))?$/.exec(selection);
						if (!parsed) throw new Error("Expected owner/repository[:quantization]");
						const id = parsed[1]!;
						let quantization = parsed[2]?.toUpperCase();
						ui.showStatus("Detecting local model runtime", id);
						let model: LocalModel | undefined = quantization
							? saved.find((entry) => entry.id === id && entry.quantization === quantization)
							: (savedMlx.find((entry) => entry.id === id) ?? saved.find((entry) => entry.id === id));
						if (!model) {
							// Inspect actual GGUF files, not repository naming conventions. Only an empty
							// variant list falls back to MLX validation; network/auth errors are not swallowed.
							const variants = quantization ? [] : await hub.variants(id);
							if (!quantization && variants.length === 0) {
								model = await mlxHub.details(id);
							} else {
								if (!quantization) {
									const labels = variants.map(
										(variant) =>
											`${variant.name}${variant.size === undefined ? "" : ` · ${formatBytes(variant.size)}`}${variant.name === DEFAULT_LOCAL_QUANTIZATION ? " · recommended" : ""}`,
									);
									const choice = await ui.select(`Select quantization · llama.cpp\n${id}`, labels);
									if (!choice) continue;
									quantization = variants[labels.indexOf(choice)]?.name;
									if (!quantization) continue;
								}
								model = await hub.details(id, quantization);
							}
						}
						const backend: Backend = isGguf(model) ? "llama.cpp" : "mlx";
						const runtime = runtimes[backend];
						if (!runtime.supported()) {
							ctx.ui.notify(
								backend === "mlx"
									? "This model requires MLX on macOS with Apple Silicon. Choose a GGUF model for llama.cpp on other platforms."
									: "Managed llama.cpp servers require macOS or Linux. Use /llama for a separately configured server.",
								"warning",
							);
							continue;
						}
						const pending = backend === "mlx" && /lfm3/i.test(model.id);
						const label = `${model.id}${isGguf(model) ? ` · ${model.quantization}` : ""} · ${backend === "mlx" ? "MLX" : backend}`;
						const warning = pending
							? "\nMLX runtime support for LFM3 is pending. Download-only is available; use the GGUF recommendation to run LFM3."
							: "";
						const action = await ui.select(
							label + warning,
							pending ? ["Download only", "Back"] : ["Run locally", "Download only", "Back"],
						);
						if (!action || action === "Back") continue;
						const selectedModel = model;
						const result = await prepareLocalModel(model, ui, runtime, {
							backend,
							downloadOnly: action === "Download only",
							save: () => (isGguf(selectedModel) ? catalog.save(selectedModel) : mlxCatalog.save(selectedModel)),
							beforeStart: async () => {
								if (!active) return true;
								if (
									!(await ui.confirm(
										"Replace the running local model?",
										`${active.id} (${active.backend}) will be stopped before loading ${label}.`,
									))
								)
									return false;
								await stop();
								return true;
							},
						});
						if (!result) continue;
						if (result === "downloaded") {
							ctx.ui.notify(`${label} is downloaded in the Hugging Face cache.`);
							continue;
						}
						active = { backend, id: model.id };
						const providerId = backend === "mlx" ? MLX_PROVIDER_ID : LOCAL_CPP_PROVIDER_ID;
						pi.registerProvider(
							providerId,
							isGguf(model)
								? localCppProviderConfig(model, result.baseUrl)
								: mlxProviderConfig(model, result.baseUrl),
						);
						const selected = ctx.modelRegistry.find(providerId, model.id);
						if (!selected || !(await pi.setModel(selected)))
							throw new Error("Local server started, but model selection failed. Try /model.");
						ctx.ui.notify(`Using ${label} locally. It is also available in /model.`);
						return;
					}
				});
			} finally {
				busy = false;
			}
		},
	});
}
