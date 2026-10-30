import type { HuggingFaceModel, HuggingFaceQuantization } from "../llama/huggingface.ts";
import type { MlxModelDetails } from "../mlx/huggingface.ts";

export const DEFAULT_LOCAL_MODEL = "LiquidAI/LFM3-1.7B-GGUF";
export const DEFAULT_LOCAL_QUANTIZATION = "Q4_K_M";

export interface GgufModelDetails extends MlxModelDetails {
	format: "gguf";
	modelFile: string;
	quantization: string;
}

const QUANTIZATION =
	/(?:^|[-_.])((?:(?:QAD|UD)-)?(?:IQ\d(?:_[A-Z0-9]+)+|Q\d(?:_[A-Z0-9]+)+|BF16|F16|F32|MXFP\d(?:_[A-Z0-9]+)*))$/iu;
const SHARD = /-(\d{5})-of-(\d{5})$/u;

interface Weight {
	name: string;
	size?: number;
	index?: number;
	count?: number;
}

interface Group {
	stem: string;
	weights: Weight[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(id) && !id.includes("..");
}

function unsupported(model: Record<string, unknown>): boolean {
	const tags = Array.isArray(model.tags) ? model.tags : [];
	const config = record(model.config);
	return (
		(model.pipeline_tag !== undefined && model.pipeline_tag !== "text-generation") ||
		tags.some(
			(tag) =>
				typeof tag === "string" &&
				/(?:vision|image|audio|speech|multimodal|video|embedding|sentence-similarity|feature-extraction|classification|non[-_]?chat|base_model:.*:base)/iu.test(
					tag,
				),
		) ||
		[model, config, record(model.cardData)].some(
			(value) =>
				value &&
				(Boolean(value.audio_config || value.visual || value.vision_tower) ||
					(value.vision_config !== undefined &&
						(!record(value.vision_config) || Object.keys(record(value.vision_config)!).length > 0))),
		)
	);
}

function groups(model: Record<string, unknown>): Map<string, Group[]> {
	const result = new Map<string, Group[]>();
	if (!Array.isArray(model.siblings)) return result;
	for (const value of model.siblings) {
		const file = record(value);
		if (!file) continue;
		const name = file.rfilename;
		if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$/iu.test(name)) continue;
		if (/(?:mmproj|adapter|optimizer|training)/iu.test(name)) continue;
		const rawStem = name.slice(0, -5);
		const shard = rawStem.match(SHARD);
		const stem = rawStem.replace(SHARD, "");
		const quantization = stem.match(QUANTIZATION)?.[1]?.toUpperCase();
		if (!quantization) continue;
		const variants = result.get(quantization) ?? [];
		let group = variants.find((candidate) => candidate.stem === stem);
		if (!group) {
			group = { stem, weights: [] };
			variants.push(group);
		}
		group.weights.push({
			name,
			size:
				typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined,
			index: shard ? Number(shard[1]) : undefined,
			count: shard ? Number(shard[2]) : undefined,
		});
		result.set(quantization, variants);
	}
	return result;
}

function selectedGroup(candidates: Group[]): Group {
	if (candidates.length !== 1) throw new Error("Ambiguous GGUF quantization: multiple weight groups");
	const group = candidates[0]!;
	const weights = group.weights;
	const count = weights[0]?.count;
	if (count === undefined) {
		if (weights.length !== 1) throw new Error("Ambiguous GGUF quantization: mixed weight files/shards");
	} else if (
		count < 1 ||
		weights.length !== count ||
		new Set(weights.map((weight) => weight.index)).size !== count ||
		weights.some(
			(weight) => weight.count !== count || weight.index === undefined || weight.index < 1 || weight.index > count,
		)
	) {
		throw new Error("Incomplete or inconsistent GGUF shards");
	}
	return group;
}

function groupSize(group: Group): number | undefined {
	let total = 0;
	for (const weight of group.weights) {
		if (weight.size === undefined) return undefined;
		total += weight.size;
	}
	return Number.isSafeInteger(total) ? total : undefined;
}

function availableVariants(all: Map<string, Group[]>): HuggingFaceQuantization[] {
	const variants: HuggingFaceQuantization[] = [];
	for (const [name, candidates] of all) {
		try {
			variants.push({ name, size: groupSize(selectedGroup(candidates)) });
		} catch {
			// Do not offer ambiguous or incomplete groups for download.
		}
	}
	return variants.sort((a, b) => {
		if (a.name === DEFAULT_LOCAL_QUANTIZATION) return -1;
		if (b.name === DEFAULT_LOCAL_QUANTIZATION) return 1;
		return (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
	});
}

export class GgufHuggingFaceClient {
	private readonly token: string | undefined;
	private readonly baseUrl: string;

	constructor(token?: string, baseUrl = "https://huggingface.co") {
		this.token = token;
		this.baseUrl = baseUrl.replace(/\/+$/u, "");
	}

	private async request(path: string, signal?: AbortSignal): Promise<unknown> {
		const headers = new Headers();
		if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
		const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
		combined.throwIfAborted();
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, { headers, signal: combined });
		} catch {
			combined.throwIfAborted();
			throw new Error("Hugging Face request failed");
		}
		combined.throwIfAborted();
		// Never include server-provided error bodies: they can contain credentials.
		if (response.status === 401 || response.status === 403)
			throw new Error(
				`Hugging Face authentication/access denied (HTTP ${response.status}); gated models require access approval and an HF_TOKEN`,
			);
		if (response.status === 429) throw new Error("Hugging Face rate limit reached; retry later");
		if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status}`);
		try {
			return await response.json();
		} catch {
			combined.throwIfAborted();
			throw new Error("Hugging Face returned invalid JSON");
		}
	}

	private async metadata(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (!safeId(id)) throw new Error("Invalid Hugging Face repository ID; expected owner/name");
		const model = record(await this.request(`/api/models/${id}?blobs=true`, signal));
		if (!model || !Array.isArray(model.siblings)) throw new Error("Hugging Face returned invalid model details");
		if (typeof model.sha !== "string" || !/^[a-f0-9]{40}$/iu.test(model.sha))
			throw new Error("Hugging Face did not return an immutable revision SHA");
		if (unsupported(model))
			throw new Error("Only GGUF chat text-generation models are supported (not vision/audio/nonchat)");
		return model;
	}

	async search(query: string, signal?: AbortSignal): Promise<HuggingFaceModel[]> {
		const params = new URLSearchParams({
			search: query.trim(),
			filter: "gguf",
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
			if (!model || typeof model.id !== "string" || !safeId(model.id) || unsupported(model)) continue;
			if (model.pipeline_tag !== "text-generation" || !Array.isArray(model.tags) || !model.tags.includes("gguf"))
				continue;
			models.set(model.id, {
				id: model.id,
				downloads:
					typeof model.downloads === "number" && Number.isFinite(model.downloads) && model.downloads >= 0
						? model.downloads
						: 0,
			});
		}
		const sorted = [...models.values()].sort((a, b) => b.downloads - a.downloads);
		if (query.trim()) return sorted;
		return [
			models.get(DEFAULT_LOCAL_MODEL) ?? { id: DEFAULT_LOCAL_MODEL, downloads: 0 },
			...sorted.filter((model) => model.id !== DEFAULT_LOCAL_MODEL),
		];
	}

	async variants(id: string, signal?: AbortSignal): Promise<HuggingFaceQuantization[]> {
		return availableVariants(groups(await this.metadata(id, signal)));
	}

	async details(
		id: string,
		quantization = DEFAULT_LOCAL_QUANTIZATION,
		signal?: AbortSignal,
	): Promise<GgufModelDetails> {
		const model = await this.metadata(id, signal);
		const all = groups(model);
		const selected = quantization.toUpperCase();
		const candidates = all.get(selected);
		if (!candidates)
			throw new Error(
				`Requested GGUF quantization ${selected} is unavailable; available variants: ${
					availableVariants(all)
						.map((variant) => variant.name)
						.join(", ") || "none"
				}`,
			);
		const group = selectedGroup(candidates);
		const files = group.weights.map((weight) => weight.name).sort();
		return {
			id,
			revision: model.sha as string,
			format: "gguf",
			modelFile: files[0]!,
			quantization: selected,
			files,
			// Runtime allocation limit, not a claim about the model's training context.
			contextWindow: 16384,
			size: groupSize(group),
			gated: model.gated === "auto" || model.gated === "manual" ? model.gated : false,
		};
	}
}
