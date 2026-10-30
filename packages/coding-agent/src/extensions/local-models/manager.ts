import { formatBytes } from "../llama/client.ts";
import type { LlamaUi } from "../llama/ui.ts";
import { runWithProgress } from "../llama/ui.ts";
import type { MlxModelDetails } from "../mlx/huggingface.ts";
import type { LocalModelProgress, MlxRuntime } from "../mlx/runtime.ts";

export type ManagedLocalModelRuntime = Pick<
	MlxRuntime,
	"installed" | "install" | "cached" | "download" | "start" | "stop"
>;

/** All side effects requiring user consent are kept here, independently of the TUI and process backend. */
export async function prepareLocalModel(
	model: MlxModelDetails,
	ui: LlamaUi,
	runtime: ManagedLocalModelRuntime,
	options: {
		downloadOnly: boolean;
		backend?: "mlx" | "llama.cpp";
		save(): Promise<void>;
		beforeStart?(): Promise<boolean>;
	},
): Promise<{ baseUrl: string } | "downloaded" | undefined> {
	const cpp = options.backend === "llama.cpp";
	const progress = <T>(
		title: string,
		run: (signal: AbortSignal, update: (value: LocalModelProgress) => void) => Promise<T>,
		stopServer = false,
	) =>
		runWithProgress(ui, {
			title,
			model: model.id,
			initialMessage: "Starting…",
			cancelTitle: "Cancel operation?",
			cancelMessage: "Completed downloads stay in the Hugging Face cache and can be reused.",
			run: (signal, update) =>
				run(signal, (value) =>
					update({
						message: value.message,
						...(value.percent === undefined ? {} : { ratio: value.percent / 100 }),
					}),
				),
			cancel: async () => {
				if (stopServer) await runtime.stop();
			},
		});

	if (!(await runtime.installed())) {
		if (
			!(await ui.confirm(
				cpp ? "Install local llama.cpp runtime?" : "Install local MLX runtime?",
				cpp
					? "Requires uv on PATH. Installs a private Python Hugging Face/Xet downloader. On macOS, this may also install or upgrade the system llama.cpp package using Homebrew. On Linux, install a recent llama-server yourself first. LFM3 requires llama.cpp v0.8.0 / b11960 or newer. This downloads and runs third-party installation code. No MLX packages are installed."
					: "Requires Apple Silicon and uv on PATH. Creates an isolated Python environment and installs mlx-lm, huggingface_hub, and hf_xet. This downloads and runs third-party package installation code; model repositories are not trusted as Python code.",
			))
		)
			return undefined;
		const installed = await progress(
			cpp ? "Installing llama.cpp runtime" : "Installing MLX runtime",
			(signal, update) => runtime.install(signal, update),
		);
		if (installed.cancelled) return undefined;
	}

	ui.showStatus("Checking local model", model.id);
	if (!(await runtime.cached(model))) {
		const size = model.size === undefined ? "Size unavailable" : formatBytes(model.size);
		const access = model.gated
			? `\nAccept the repository's access terms at https://huggingface.co/${model.id} and configure HF_TOKEN or hf auth login before downloading.`
			: "";
		if (
			!(await ui.confirm(
				"Model is not downloaded. Download it now?",
				`${model.id}\n${size} · revision ${model.revision.slice(0, 12)}\nDownloads selected ${cpp ? "GGUF" : "MLX"} inference files to the shared Hugging Face cache using the accelerated Xet backend where supported.${access}`,
			))
		)
			return undefined;
		const downloaded = await progress(cpp ? "Downloading GGUF model" : "Downloading MLX model", (signal, update) =>
			runtime.download(model, signal, update),
		);
		if (downloaded.cancelled) return undefined;
	}
	await options.save();
	if (options.downloadOnly) return "downloaded";
	if (options.beforeStart && !(await options.beforeStart())) return undefined;
	const started = await progress(
		cpp ? "Starting local llama.cpp server" : "Starting local MLX server",
		(signal, update) => runtime.start(model, signal, update),
		true,
	);
	return started.cancelled ? undefined : started.value;
}
