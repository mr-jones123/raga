import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MLX_MODEL, MlxHuggingFaceClient } from "../src/extensions/mlx/huggingface.ts";

const SHA = "a".repeat(40);
const ID = "owner/model";
const config = { model_type: "lfm3", quantization: { bits: 4, group_size: 64 }, max_position_embeddings: 131072 };
const names = ["config.json", "tokenizer.json", "tokenizer_config.json", "model.safetensors"];

function mockRepo(
	options: {
		config?: unknown;
		names?: string[];
		index?: unknown;
		metadata?: Record<string, unknown>;
		missingSize?: boolean;
	} = {},
) {
	const fetcher = vi.fn(async (url: string | URL | Request) => {
		const path = new URL(String(url)).pathname;
		if (path.startsWith("/api/models/"))
			return Response.json({
				sha: SHA,
				pipeline_tag: "text-generation",
				gated: false,
				siblings: (options.names ?? names).map((rfilename) => ({
					rfilename,
					size: options.missingSize ? undefined : 10,
				})),
				...options.metadata,
			});
		if (path === `/${ID}/resolve/${SHA}/config.json`) return Response.json(options.config ?? config);
		if (path === `/${ID}/resolve/${SHA}/model.safetensors.index.json`) return Response.json(options.index);
		throw new Error(`Unexpected request: ${url}`);
	});
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}

afterEach(() => vi.unstubAllGlobals());

describe("MLX Hugging Face catalog", () => {
	it("filters and sorts MLX text search and recommends the default first without duplicates", async () => {
		const entry = (id: string, downloads: number, extra = {}) => ({
			id,
			downloads,
			tags: ["mlx"],
			pipeline_tag: "text-generation",
			...extra,
		});
		const fetcher = vi.fn(async (_url: string) =>
			Response.json([
				entry("a/popular", 100),
				entry(DEFAULT_MLX_MODEL, 1),
				entry("a/medium", 20),
				entry("a/vision", 200, { tags: ["mlx", "vision"] }),
				entry("a/audio", 200, { pipeline_tag: "text-to-audio" }),
				entry("a/gguf", 500, { tags: ["gguf", "mlx"] }),
				entry("../unsafe", 100),
			]),
		);
		vi.stubGlobal("fetch", fetcher);
		const client = new MlxHuggingFaceClient();
		expect((await client.search("")).map((model) => model.id)).toEqual([DEFAULT_MLX_MODEL, "a/popular", "a/medium"]);
		expect((await client.search("model")).map((model) => model.id)).toEqual([
			"a/popular",
			"a/medium",
			DEFAULT_MLX_MODEL,
		]);
		const url = new URL(String(fetcher.mock.calls[0]?.[0]));
		expect(url.searchParams.get("filter")).toBe("mlx");
		expect(url.searchParams.get("pipeline_tag")).toBe("text-generation");
		expect(url.searchParams.get("sort")).toBe("downloads");
	});

	it("returns a pinned LFM3 spec, exact inference files and complete size without fetching weights", async () => {
		const fetcher = mockRepo({
			names: [
				...names,
				"generation_config.json",
				"chat_template.jinja",
				"model.py",
				"optimizer.safetensors",
				"training_args.json",
				"sub/model.safetensors",
				"model.gguf",
			],
		});
		const details = await new MlxHuggingFaceClient("secret", "https://example.test/").details(ID);
		expect(details).toEqual({
			id: ID,
			revision: SHA,
			files: [...names, "generation_config.json", "chat_template.jinja"].sort(),
			contextWindow: 131072,
			gated: false,
			size: 60,
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher.mock.calls[1]?.[0]).toBe(`https://example.test/${ID}/resolve/${SHA}/config.json`);
	});

	it("accepts LFM3's empty vision_config placeholder without treating it as a vision model", async () => {
		mockRepo({ config: { ...config, vision_config: {} } });
		expect(await new MlxHuggingFaceClient().details(ID)).toMatchObject({ id: ID, revision: SHA });
	});

	it("accepts full precision weights explicitly published as an MLX model", async () => {
		mockRepo({ config: { ...config, quantization: undefined }, metadata: { library_name: "mlx" } });
		expect(await new MlxHuggingFaceClient().details(ID)).toMatchObject({ id: ID, revision: SHA });
	});

	it("preserves gating and defaults context, leaving incomplete sizes unknown", async () => {
		mockRepo({
			config: { ...config, max_position_embeddings: -1 },
			missingSize: true,
			metadata: { gated: "manual" },
		});
		expect(await new MlxHuggingFaceClient().details(ID)).toMatchObject({
			gated: "manual",
			contextWindow: 32768,
			size: undefined,
		});
	});

	it("validates indexed shards and includes only referenced weights", async () => {
		mockRepo({
			names: [...names, "model-00001-of-00001.safetensors", "model.safetensors.index.json"],
			index: { weight_map: { "layers.0": "model-00001-of-00001.safetensors" } },
		});
		const details = await new MlxHuggingFaceClient().details(ID);
		expect(details.files).toContain("model.safetensors.index.json");
		expect(details.files).toContain("model-00001-of-00001.safetensors");
		expect(details.files).not.toContain("model.safetensors");
	});

	it.each(["../model.safetensors", "sub/model.safetensors", "missing.safetensors", "model.py"])(
		"rejects unsafe or absent index shard %s",
		async (shard) => {
			mockRepo({ names: [...names, "model.safetensors.index.json"], index: { weight_map: { weight: shard } } });
			await expect(new MlxHuggingFaceClient().details(ID)).rejects.toThrow("shard");
		},
	);

	it.each([
		"owner",
		"../owner/model",
		"owner/../model",
		"owner/model?x=1",
		"owner/model%2fother",
		"https://host/model",
	])("rejects unsafe ID %s before HTTP", async (id) => {
		const fetcher = mockRepo();
		await expect(new MlxHuggingFaceClient().details(id)).rejects.toThrow("repository ID");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects mutable revisions and unsupported weight formats before config requests", async () => {
		let fetcher = mockRepo({ metadata: { sha: "main" } });
		await expect(new MlxHuggingFaceClient().details(ID)).rejects.toThrow("immutable");
		expect(fetcher).toHaveBeenCalledTimes(1);
		fetcher = mockRepo({ names: ["config.json", "model.gguf"] });
		await expect(new MlxHuggingFaceClient().details(ID)).rejects.toThrow("safetensors");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ quantization: config.quantization },
		{ ...config, vision_config: { model_type: "clip" } },
		{ ...config, audio_config: {} },
		{ ...config, quantization: undefined },
		{ ...config, quantization: { bits: 4, group_size: 64, quant_method: "gptq" } },
	])("rejects invalid or non-text config %j", async (invalid) => {
		mockRepo({ config: invalid });
		await expect(new MlxHuggingFaceClient().details(ID)).rejects.toThrow();
	});

	it("reports gated authentication failures clearly and sends bearer auth", async () => {
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
			return Response.json({ error: "Access denied" }, { status: 403 });
		});
		vi.stubGlobal("fetch", fetcher);
		await expect(new MlxHuggingFaceClient("secret").details(ID)).rejects.toThrow(/gated.*HF_TOKEN/u);
	});

	it("composes caller cancellation with a timeout", async () => {
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			init?.signal?.throwIfAborted();
			return Response.json([]);
		});
		await expect(new MlxHuggingFaceClient().search("", controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
