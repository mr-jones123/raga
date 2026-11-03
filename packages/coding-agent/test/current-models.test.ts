import type { AnyModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { filterCurrentModels } from "../src/core/current-models.ts";

function ids(list: string[], extra: Partial<AnyModel>[] = []): string[] {
	const models = [...list.map((id) => ({ id, type: "chat" }) as unknown as AnyModel), ...(extra as AnyModel[])];
	return filterCurrentModels(models).map((model) => model.id);
}

describe("filterCurrentModels", () => {
	it("keeps the newest GPT of each family in the newest generation", () => {
		expect(
			ids([
				"o1",
				"o3-pro",
				"o4-mini-deep-research",
				"chatgpt-4o-latest",
				"gpt-4",
				"gpt-4o",
				"gpt-4o-mini",
				"gpt-4o-2024-11-20",
				"gpt-4.1-mini",
				"gpt-5",
				"gpt-5-chat-latest",
				"gpt-5.4-mini",
				"gpt-5.5",
				"gpt-5.5-pro",
				"gpt-5.6-sol",
				"gpt-5.6-terra",
				"gpt-6-sol",
				"gpt-6-luna",
				"gpt-6.1-sol",
				"gpt-6.1-terra",
				"gpt-daybreak-blue-latest",
			]),
		).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-daybreak-blue-latest"]);
	});

	it("judges each list on its own, so a lagging provider keeps its newest generation", () => {
		expect(ids(["gpt-5.5", "gpt-6-luna", "gpt-6.1-sol"])).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
	});

	it("keeps the newest Claude of each family", () => {
		expect(
			ids([
				"claude-3-5-sonnet-20241022",
				"claude-haiku-4-5",
				"claude-haiku-4-5-20251001",
				"claude-opus-4-8",
				"claude-opus-5",
				"claude-opus-5-5",
				"claude-sonnet-5",
				"claude-sonnet-5-5",
				"claude-haiku-5-5",
				"claude-fable-5",
				"claude-fable-5-1",
			]),
		).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
	});

	it("leaves non-chat models alone", () => {
		expect(ids(["gpt-6.1-sol"], [{ id: "gpt-4o-transcribe", type: "classifier" } as Partial<AnyModel>])).toEqual([
			"gpt-6.1-sol",
			"gpt-4o-transcribe",
		]);
	});
});
