import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { MlxModelDetails } from "../mlx/huggingface.ts";

/** Discovery records only: the runtime verifies the actual Hub cache before every launch. */
export class LocalModelCatalog<TModel extends MlxModelDetails = MlxModelDetails> {
	private readonly directory: string;
	private readonly format: "mlx" | "gguf";

	constructor(directory = join(getAgentDir(), "local-models", "catalog"), format: "mlx" | "gguf" = "mlx") {
		this.directory = directory;
		this.format = format;
	}

	async list(): Promise<TModel[]> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const models: TModel[] = [];
		for (const name of names.filter((entry) => entry.endsWith(".json"))) {
			try {
				const model: unknown = JSON.parse(await readFile(join(this.directory, name), "utf8"));
				if (typeof model !== "object" || model === null) continue;
				const entry = model as Partial<
					MlxModelDetails & { format: "gguf"; modelFile: string; quantization: string }
				>;
				if (
					typeof entry.id !== "string" ||
					!/^[\w.-]+\/[\w.-]+$/.test(entry.id) ||
					typeof entry.revision !== "string" ||
					!/^[a-f0-9]{40}$/.test(entry.revision) ||
					!Array.isArray(entry.files) ||
					entry.files.length === 0 ||
					!entry.files.every(
						(file) => typeof file === "string" && /^[\w.-]+$/.test(file) && !file.startsWith("."),
					) ||
					(this.format === "mlx"
						? !entry.files.includes("config.json") || !entry.files.some((file) => file.endsWith(".safetensors"))
						: entry.format !== "gguf" ||
							typeof entry.modelFile !== "string" ||
							!entry.files.includes(entry.modelFile) ||
							!entry.files.every((file) => file.endsWith(".gguf")) ||
							typeof entry.quantization !== "string" ||
							!/^[A-Z0-9_-]+$/.test(entry.quantization)) ||
					typeof entry.contextWindow !== "number" ||
					!Number.isSafeInteger(entry.contextWindow) ||
					entry.contextWindow <= 0 ||
					![false, "auto", "manual"].includes(entry.gated ?? "")
				)
					continue;
				models.push(entry as TModel);
			} catch {
				// An interrupted or invalid discovery record must not hide other downloaded models.
			}
		}
		return models.sort((left, right) => left.id.localeCompare(right.id));
	}

	async save(model: TModel): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const variant = this.format === "gguf" && "quantization" in model ? `:${model.quantization}` : "";
		const destination = join(this.directory, `${Buffer.from(model.id + variant).toString("base64url")}.json`);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
	}
}
