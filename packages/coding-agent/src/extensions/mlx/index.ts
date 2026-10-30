import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "../../core/extensions/types.ts";
import type { MlxModelDetails } from "./huggingface.ts";

export const MLX_PROVIDER_ID = "local-mlx";

export function mlxProviderConfig(model: MlxModelDetails, baseUrl: string): ProviderConfig {
	return {
		name: "Local MLX",
		baseUrl,
		apiKey: "local",
		api: "openai-completions",
		// mlx-lm maps this alias to its configured local snapshot. Never let a request resolve a Hub repo.
		streamSimple: (selected, context, options) =>
			streamSimple({ ...selected, id: "default_model" }, context, options),
		models: [
			{
				id: model.id,
				name: `${model.id} (local MLX)`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// A training context limit is not a safe working set on a laptop. Bound the advertised context.
				contextWindow: Math.min(model.contextWindow, 32768),
				maxTokens: Math.min(model.contextWindow, 4096),
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					supportsUsageInStreaming: true,
					supportsStrictMode: false,
					maxTokensField: "max_tokens",
				},
			},
		],
	};
}
