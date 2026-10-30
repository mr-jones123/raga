import { findHuggingFaceToken, type HuggingFaceModel } from "../llama/huggingface.ts";

export { findHuggingFaceToken };

export const DEFAULT_MLX_MODEL = "LiquidAI/LFM3-1.7B-MLX-4bit";

export interface MlxModelDetails {
	id: string;
	revision: string;
	files: string[];
	contextWindow: number;
	size?: number;
	gated: false | "auto" | "manual";
}

const INFERENCE_FILES = new Set([
	"config.json",
	"generation_config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"special_tokens_map.json",
	"added_tokens.json",
	"tokenizer.model",
	"sentencepiece.bpe.model",
	"vocab.json",
	"vocab.txt",
	"merges.txt",
	"chat_template.jinja",
	"chat_template.json",
]);
const INDEX = "model.safetensors.index.json";

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(id) && !id.includes("..");
}

function isWeight(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_.-]*\.safetensors$/u.test(name) && !/(?:optimizer|training|adapter)/iu.test(name);
}

function nonText(value: Record<string, unknown>): boolean {
	const tags = Array.isArray(value.tags) ? value.tags : [];
	return (
		Boolean(
			(value.vision_config &&
				(!record(value.vision_config) || Object.keys(record(value.vision_config)!).length > 0)) ||
				value.audio_config ||
				value.visual ||
				value.vision_tower,
		) ||
		tags.some(
			(tag) => typeof tag === "string" && /(?:vision|image-text|image-to|audio|speech|multimodal|video)/iu.test(tag),
		)
	);
}

export class MlxHuggingFaceClient {
	private readonly token: string | undefined;
	private readonly baseUrl: string;

	constructor(token?: string, baseUrl = "https://huggingface.co") {
		this.token = token;
		this.baseUrl = baseUrl.replace(/\/+$/u, "");
	}

	private async request(path: string, signal?: AbortSignal): Promise<unknown> {
		const headers = new Headers();
		if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
		const timeout = AbortSignal.timeout(15_000);
		const response = await fetch(`${this.baseUrl}${path}`, {
			headers,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			if (signal?.aborted || timeout.aborted) throw error;
		}
		if (!response.ok) {
			const detail = record(payload)?.error;
			const message = typeof detail === "string" ? `: ${detail}` : "";
			if (response.status === 401 || response.status === 403) {
				throw new Error(
					`Hugging Face authentication/access denied (HTTP ${response.status}); gated models require access approval and an HF_TOKEN${message}`,
				);
			}
			if (response.status === 429) throw new Error(`Hugging Face rate limit reached; retry later${message}`);
			throw new Error(`Hugging Face returned HTTP ${response.status}${message}`);
		}
		return payload;
	}

	async search(query: string, signal?: AbortSignal): Promise<HuggingFaceModel[]> {
		const params = new URLSearchParams({
			search: query.trim(),
			filter: "mlx",
			pipeline_tag: "text-generation",
			sort: "downloads",
			direction: "-1",
			limit: "40",
		});
		const payload = await this.request(`/api/models?${params}`, signal);
		if (!Array.isArray(payload)) throw new Error("Hugging Face returned invalid search results");
		const models = new Map<string, HuggingFaceModel>();
		for (const value of payload) {
			const model = record(value);
			if (!model || typeof model.id !== "string" || !safeId(model.id) || nonText(model)) continue;
			if (Array.isArray(model.tags) && model.tags.includes("gguf")) continue;
			if (model.pipeline_tag !== "text-generation" || !Array.isArray(model.tags) || !model.tags.includes("mlx"))
				continue;
			models.set(model.id, {
				id: model.id,
				downloads: typeof model.downloads === "number" && Number.isFinite(model.downloads) ? model.downloads : 0,
			});
		}
		const sorted = [...models.values()].sort((a, b) => b.downloads - a.downloads);
		if (query.trim()) return sorted;
		return [
			models.get(DEFAULT_MLX_MODEL) ?? { id: DEFAULT_MLX_MODEL, downloads: 0 },
			...sorted.filter((model) => model.id !== DEFAULT_MLX_MODEL),
		];
	}

	async details(id: string, signal?: AbortSignal): Promise<MlxModelDetails> {
		if (!safeId(id)) throw new Error("Invalid Hugging Face repository ID; expected owner/name");
		const model = record(await this.request(`/api/models/${id}?blobs=true`, signal));
		if (!model || !Array.isArray(model.siblings)) throw new Error("Hugging Face returned invalid model details");
		if (typeof model.sha !== "string" || !/^[a-f0-9]{40}$/iu.test(model.sha))
			throw new Error("Hugging Face did not return an immutable revision SHA");
		if (nonText(model) || (model.pipeline_tag !== undefined && model.pipeline_tag !== "text-generation"))
			throw new Error("Only MLX text-generation models are supported (not vision/audio)");
		const available = new Map<string, number | undefined>();
		for (const value of model.siblings) {
			const file = record(value);
			if (file && typeof file.rfilename === "string")
				available.set(
					file.rfilename,
					typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0
						? file.size
						: undefined,
				);
		}
		let weights = [...available.keys()].filter(isWeight);
		if (!weights.length || !available.has("config.json"))
			throw new Error(
				"Unsupported MLX format: root safetensors weights and config.json are required (not GGUF/PyTorch)",
			);
		const prefix = `/${id}/resolve/${model.sha}/`;
		const config = record(await this.request(`${prefix}config.json`, signal));
		if (!config || typeof config.model_type !== "string" || !config.model_type.trim())
			throw new Error("Invalid MLX config: model_type is required");
		if (nonText(config)) throw new Error("Only MLX text models are supported (not vision/audio)");
		const quantization = record(config.quantization) ?? record(config.quantization_config);
		if (!quantization) {
			const tags = Array.isArray(model.tags) ? model.tags : [];
			if (model.library_name !== "mlx" && !tags.includes("mlx"))
				throw new Error("Unsupported format: unquantized weights must be published as an MLX model");
		} else {
			if (
				typeof quantization.bits !== "number" ||
				!Number.isInteger(quantization.bits) ||
				quantization.bits < 2 ||
				quantization.bits > 8 ||
				typeof quantization.group_size !== "number" ||
				!Number.isInteger(quantization.group_size) ||
				quantization.group_size <= 0
			)
				throw new Error("Unsupported MLX quantization: valid bits and group_size are required");
			if (quantization.quant_method !== undefined && quantization.quant_method !== "mlx")
				throw new Error("Unsupported quantization format; expected MLX quantized safetensors");
		}
		if (
			!available.has("tokenizer.json") &&
			!available.has("tokenizer.model") &&
			!available.has("sentencepiece.bpe.model") &&
			!available.has("vocab.json") &&
			!available.has("vocab.txt")
		)
			throw new Error("Unsupported MLX model: tokenizer files are missing");
		if (available.has(INDEX)) {
			const index = record(await this.request(`${prefix}${INDEX}`, signal));
			const map = record(index?.weight_map);
			if (!map || !Object.keys(map).length) throw new Error("Invalid safetensors index: empty weight_map");
			const shards = new Set<string>();
			for (const shard of Object.values(map)) {
				if (typeof shard !== "string" || !isWeight(shard) || !available.has(shard))
					throw new Error("Invalid safetensors index: unsafe or missing shard");
				shards.add(shard);
			}
			weights = [...shards];
		}
		const files = [...available.keys()].filter((name) => INFERENCE_FILES.has(name));
		files.push(...weights);
		if (available.has(INDEX)) files.push(INDEX);
		files.sort();
		const context = config.max_position_embeddings;
		const contextWindow =
			typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? context : 32768;
		const sizes = files.map((name) => available.get(name));
		return {
			id,
			revision: model.sha,
			files,
			contextWindow,
			size: sizes.every((size): size is number => size !== undefined)
				? sizes.reduce((sum, size) => sum + size, 0)
				: undefined,
			gated: model.gated === "auto" || model.gated === "manual" ? model.gated : false,
		};
	}
}
