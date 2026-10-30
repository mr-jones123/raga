import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LOCAL_MODEL,
	DEFAULT_LOCAL_QUANTIZATION,
	GgufHuggingFaceClient,
} from "../src/extensions/local-models/huggingface.ts";

const SHA = "a".repeat(40);
const Q4 = "LFM3-1.7B-Q4_K_M.gguf";
const QAD = "LFM3-1.7B-QAD-Q4_0.gguf";
const Q0 = "LFM3-1.7B-Q4_0.gguf";

function mockRepo(names = [Q4, QAD, Q0], metadata: Record<string, unknown> = {}) {
	const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
		Response.json({
			sha: SHA,
			pipeline_tag: "text-generation",
			siblings: names.map((rfilename) => ({ rfilename, size: 10 })),
			...metadata,
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}

afterEach(() => vi.unstubAllGlobals());

describe("GGUF local model catalog", () => {
	it("selects only the official default quantization and pins metadata without downloading weights", async () => {
		const fetcher = mockRepo([
			Q4,
			QAD,
			Q0,
			"mmproj-Q4_K_M.gguf",
			"sub/model-Q4_K_M.gguf",
			"config.json",
			"model.safetensors",
			"adapter-Q4_K_M.gguf",
		]);
		const result = await new GgufHuggingFaceClient("secret", "https://example.test/").details(DEFAULT_LOCAL_MODEL);
		expect(DEFAULT_LOCAL_QUANTIZATION).toBe("Q4_K_M");
		expect(result).toEqual({
			id: DEFAULT_LOCAL_MODEL,
			revision: SHA,
			files: [Q4],
			format: "gguf",
			modelFile: Q4,
			quantization: "Q4_K_M",
			size: 10,
			contextWindow: 16384,
			gated: false,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]?.[0]).toBe(`https://example.test/api/models/${DEFAULT_LOCAL_MODEL}?blobs=true`);
		expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer secret");
	});

	it("keeps QAD-Q4_0 distinct from Q4_0 and exposes selectable variants", async () => {
		mockRepo();
		const client = new GgufHuggingFaceClient();
		expect((await client.variants(DEFAULT_LOCAL_MODEL)).map((item) => item.name)).toEqual([
			"Q4_K_M",
			"Q4_0",
			"QAD-Q4_0",
		]);
		expect((await client.details(DEFAULT_LOCAL_MODEL, "qad-q4_0")).files).toEqual([QAD]);
		expect((await client.details(DEFAULT_LOCAL_MODEL, "Q4_0")).files).toEqual([Q0]);
	});

	it("reports missing requested quantization instead of silently falling back", async () => {
		mockRepo([QAD]);
		await expect(new GgufHuggingFaceClient().details(DEFAULT_LOCAL_MODEL)).rejects.toThrow(
			/Q4_K_M.*available variants: QAD-Q4_0/u,
		);
	});

	it("selects a complete sorted shard group and sums only its sizes", async () => {
		const shards = ["LFM3-1.7B-Q4_K_M-00002-of-00002.gguf", "LFM3-1.7B-Q4_K_M-00001-of-00002.gguf"];
		mockRepo([...shards, QAD], { gated: "auto" });
		expect(await new GgufHuggingFaceClient().details(DEFAULT_LOCAL_MODEL)).toMatchObject({
			files: [...shards].sort(),
			modelFile: shards[1],
			size: 20,
			gated: "auto",
		});
	});

	it.each([
		["model-Q4_K_M-00001-of-00002.gguf"],
		["model-Q4_K_M-00001-of-00002.gguf", "model-Q4_K_M-00002-of-00003.gguf"],
		["model-Q4_K_M-00000-of-00001.gguf"],
		["model-Q4_K_M-00002-of-00001.gguf"],
		["model-Q4_K_M-00001-of-00002.gguf", "model-Q4_K_M-00001-of-00002.gguf"],
		[Q4, "different-Q4_K_M.gguf"],
		[Q4, "LFM3-1.7B-Q4_K_M-00001-of-00001.gguf"],
	])("rejects incomplete, inconsistent, duplicate, or ambiguous group %j", async (...names) => {
		mockRepo(names);
		await expect(new GgufHuggingFaceClient().details(DEFAULT_LOCAL_MODEL)).rejects.toThrow(/shards|Ambiguous/u);
		expect(await new GgufHuggingFaceClient().variants(DEFAULT_LOCAL_MODEL)).toEqual([]);
	});

	it("leaves size unknown if any selected shard size is absent or invalid", async () => {
		for (const size of [undefined, -1, 1.5]) {
			mockRepo([], { gated: "manual", siblings: [{ rfilename: Q4, size }] });
			expect(await new GgufHuggingFaceClient().details(DEFAULT_LOCAL_MODEL)).toMatchObject({
				size: undefined,
				gated: "manual",
			});
		}
	});

	it.each([
		"owner",
		"../owner/repo",
		"owner/../repo",
		"owner/repo:Q4_K_M",
		"owner/repo?x=1",
		"owner/repo#x",
		"owner/repo%2Fother",
		"https://host/repo",
	])("rejects unsafe ID %s before HTTP", async (id) => {
		const fetcher = mockRepo();
		const client = new GgufHuggingFaceClient();
		await expect(client.details(id)).rejects.toThrow("repository ID");
		await expect(client.variants(id)).rejects.toThrow("repository ID");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each(["main", "a".repeat(39), "g".repeat(40), undefined])("rejects nonimmutable SHA %s", async (sha) => {
		mockRepo([Q4], { sha });
		await expect(new GgufHuggingFaceClient().details(DEFAULT_LOCAL_MODEL)).rejects.toThrow("immutable");
	});

	it.each([
		{ tags: ["gguf", "vision"] },
		{ tags: ["gguf", "audio"] },
		{ tags: ["gguf", "nonchat"] },
		{ pipeline_tag: "feature-extraction" },
		{ config: { vision_config: { model_type: "clip" } } },
		{ config: { audio_config: {} } },
	])("rejects unsupported metadata %j", async (metadata) => {
		mockRepo([Q4], metadata);
		await expect(new GgufHuggingFaceClient().details(DEFAULT_LOCAL_MODEL)).rejects.toThrow("Only GGUF chat");
	});

	it("accepts an empty vision placeholder and ignores claimed training context", async () => {
		mockRepo([Q4], { config: { vision_config: {}, max_position_embeddings: 131072 } });
		expect((await new GgufHuggingFaceClient().details(DEFAULT_LOCAL_MODEL)).contextWindow).toBe(16384);
	});

	it("filters search, sorts downloads, recommends first only for empty searches and deduplicates", async () => {
		const entry = (id: string, downloads: number, extra = {}) => ({
			id,
			downloads,
			tags: ["gguf"],
			pipeline_tag: "text-generation",
			...extra,
		});
		const fetcher = vi.fn(async (_url: unknown) =>
			Response.json([
				entry("a/popular", 100),
				entry(DEFAULT_LOCAL_MODEL, 1),
				entry(DEFAULT_LOCAL_MODEL, 1),
				entry("a/medium", 20),
				entry("a/vision", 999, { tags: ["gguf", "vision"] }),
				entry("a/audio", 999, { config: { audio_config: {} } }),
				entry("a/base", 999, { tags: ["gguf", "nonchat"] }),
				entry("a/embed", 999, { pipeline_tag: "feature-extraction" }),
				entry("a/mlx", 999, { tags: ["mlx"] }),
				entry("a/repo:quant", 999),
			]),
		);
		vi.stubGlobal("fetch", fetcher);
		const client = new GgufHuggingFaceClient();
		expect((await client.search(" ")).map((model) => model.id)).toEqual([
			DEFAULT_LOCAL_MODEL,
			"a/popular",
			"a/medium",
		]);
		expect((await client.search("x&filter=mlx")).map((model) => model.id)).toEqual([
			"a/popular",
			"a/medium",
			DEFAULT_LOCAL_MODEL,
		]);
		const params = new URL(String(fetcher.mock.calls[1]?.[0])).searchParams;
		expect(Object.fromEntries(params)).toMatchObject({
			search: "x&filter=mlx",
			filter: "gguf",
			pipeline_tag: "text-generation",
			sort: "downloads",
			direction: "-1",
		});
	});

	it("recommends the default when empty search has no results", async () => {
		vi.stubGlobal("fetch", async () => Response.json([]));
		expect(await new GgufHuggingFaceClient().search("")).toEqual([{ id: DEFAULT_LOCAL_MODEL, downloads: 0 }]);
	});

	it.each([401, 403, 429, 500])("reports HTTP %s without echoing tokens", async (status) => {
		vi.stubGlobal("fetch", async () => Response.json({ error: "secret" }, { status }));
		const promise = new GgufHuggingFaceClient("secret").details(DEFAULT_LOCAL_MODEL);
		await expect(promise).rejects.toThrow(
			status === 429 ? "rate limit" : status < 500 ? /gated.*HF_TOKEN/u : "HTTP 500",
		);
		await expect(promise).rejects.not.toThrow("secret");
	});

	it("does not expose fetch errors containing credentials", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("Bearer secret");
		});
		await expect(new GgufHuggingFaceClient("secret").search("")).rejects.toThrow("Hugging Face request failed");
	});

	it("honors cancellation before requests and during requests", async () => {
		const controller = new AbortController();
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
			controller.abort();
			init?.signal?.throwIfAborted();
			return Response.json([]);
		});
		vi.stubGlobal("fetch", fetcher);
		const client = new GgufHuggingFaceClient();
		await expect(client.search("", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		await expect(client.search("", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
