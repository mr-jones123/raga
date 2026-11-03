import { type AnyModel, isModelType, type Provider } from "@earendil-works/pi-ai";

/**
 * Hides superseded OpenAI and Anthropic chat models. Provider catalogs keep every model the API still
 * serves, so pickers fill with o-series, deep-research, GPT-4, and Claude 4 entries nobody picks.
 *
 * A model stays when it is the newest version of its family (`gpt-6.1-sol` over `gpt-5.6-sol`,
 * `claude-opus-5-5` over `claude-opus-5`) and belongs to the provider's newest major generation, so a
 * family the newest generation dropped (`gpt-5.4-mini`) goes too. Dated snapshots, o-series,
 * deep-research, `chatgpt-*`, GPT-3/4 (including `gpt-4o`), and `claude-3-*` style ids always go. Ids that follow neither naming scheme,
 * and non-chat models, are left alone. Each provider is judged on its own list, since a subscription
 * provider such as `openai-codex` may lag the API.
 */

export const CURRENT_MODEL_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openai-codex", "anthropic"]);

interface Version {
	family: string;
	major: number;
	minor: number;
}

const DATED = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/;
const OPENAI_RETIRED = /^(?:o\d|chatgpt-|gpt-[34](?:[.o-]|$)|codex-mini)|deep-research/;
const GPT = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/;
const CLAUDE_RETIRED = /^claude-\d/;
const CLAUDE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/;

function version(id: string): Version | "retired" | undefined {
	if (DATED.test(id) || OPENAI_RETIRED.test(id) || CLAUDE_RETIRED.test(id)) return "retired";
	const gpt = GPT.exec(id);
	if (gpt) return { family: `gpt:${gpt[3] ?? ""}`, major: Number(gpt[1]), minor: Number(gpt[2] ?? 0) };
	const claude = CLAUDE.exec(id);
	if (claude) return { family: `claude:${claude[1]}`, major: Number(claude[2]), minor: Number(claude[3] ?? 0) };
	return undefined;
}

function newer(a: Version, b: Version): boolean {
	return a.major > b.major || (a.major === b.major && a.minor > b.minor);
}

/** The models of one provider's list that are current, in their original order. */
export function filterCurrentModels<T extends AnyModel>(models: readonly T[]): T[] {
	const versions = new Map<T, Version | "retired" | undefined>();
	const newest = new Map<string, Version>();
	const newestMajor = new Map<string, number>();
	for (const model of models) {
		if (!isModelType(model, "chat")) continue;
		const v = version(model.id);
		versions.set(model, v);
		if (!v || v === "retired") continue;
		const vendor = v.family.split(":")[0];
		const best = newest.get(v.family);
		if (!best || newer(v, best)) newest.set(v.family, v);
		newestMajor.set(vendor, Math.max(newestMajor.get(vendor) ?? 0, v.major));
	}
	return models.filter((model) => {
		if (!versions.has(model)) return true;
		const v = versions.get(model);
		if (v === undefined) return true;
		if (v === "retired") return false;
		const best = newest.get(v.family);
		return best !== undefined && !newer(best, v) && v.major === newestMajor.get(v.family.split(":")[0]);
	});
}

/** Wrap a provider so its model lists contain only current models. */
export function withCurrentModelsOnly(provider: Provider): Provider {
	const cache = new WeakMap<readonly AnyModel[], AnyModel[]>();
	const current = <T extends AnyModel>(models: readonly T[]): T[] => {
		let filtered = cache.get(models);
		if (!filtered) {
			filtered = filterCurrentModels(models);
			cache.set(models, filtered);
		}
		return filtered as T[];
	};
	const getAllModels = provider.getAllModels;
	return {
		...provider,
		getModels: () => current(provider.getModels()),
		...(getAllModels ? { getAllModels: () => current(getAllModels.call(provider)) } : {}),
	};
}
