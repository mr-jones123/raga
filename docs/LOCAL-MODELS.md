# Local models

`/local-models` searches Hugging Face, downloads selected files, and starts a local inference server. The default is the standard **LFM3-1.7B model in GGUF format, running through llama.cpp**, not the currently unsupported MLX conversion. Nothing is installed or downloaded automatically at startup.

## Run LFM3

Run raga and enter:

```text
/local-models
```

The first recommendation is [`LiquidAI/LFM3-1.7B-GGUF:Q4_K_M`](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF). This is LiquidAI's official 4-bit GGUF build, about 1.10 GB. It is the same LFM3 model family, packaged for llama.cpp rather than MLX. You can also enter it directly:

```text
/local-models LiquidAI/LFM3-1.7B-GGUF:Q4_K_M
```

Select **Run locally** or **Download only**. If required files are missing or empty in the shared Hugging Face cache, raga asks **Model is not downloaded. Download it now?** Declining does not download weights or start inference.

After a successful start, raga selects the model and exposes it under **Local llama.cpp** in `/model`. The server runs offline against the checked local GGUF file; it is never given a Hugging Face repository to download at inference time.

### Runtime setup

LFM3 requires **llama.cpp v0.8.0 / b11960 or newer**, according to LiquidAI's official model card. Raga checks that version before claiming the runtime is installed.

If dependencies are absent, a separate confirmation asks to install the runtime:

- `uv` must already be on PATH. Raga creates a private Python Hugging Face/Xet downloader environment, separate from the RLM kernel and MLX environments.
- On macOS, with explicit confirmation, setup can install or upgrade the system `llama.cpp` package through Homebrew. Homebrew must already be installed; raga does not bootstrap it.
- On Linux, install a recent `llama-server` yourself first. Raga does not run arbitrary system package managers.
- `LLAMA_SERVER_PATH` can select an existing llama-server executable.

The llama.cpp backend does not install `mlx-lm`, MLX, or Transformers. Download-only operations never start an inference server, although runtime setup may still be needed for the managed downloader.

The default server uses a 16k context and LiquidAI's recommended sampling: temperature 0.1, top-k 50, repetition penalty 1.1. Jinja chat templates are enabled for tool calling. Model tool-calling quality varies; being runnable does not establish that a model is a capable coding agent.

## Search and quantizations

Choose **Search Hugging Face models…** to search GGUF and MLX text-generation repositories together. Raga identifies the backend from validated model files, not the repository name, and displays it before download or launch. You can also enter `owner/repository[:quantization]`. When the quantization is omitted, raga offers available variants, with Q4_K_M first when available.

Only the selected GGUF file or complete selected shard set is downloaded, never every quantization in the repository. Missing shards and ambiguous selections are rejected. Raga pins downloads to an immutable repository revision.

Previously downloaded selections appear in the manager. Use `/local-models` after restarting raga to launch them again without querying Hugging Face. Discovery records are not treated as proof that weights still exist: every selected file is checked again before startup.

One managed local server runs per session, using either backend; switching models or backends requires confirmation before stopping the previous server. **Stop local server** stops managed servers and removes their providers. Select another model with `/model` before continuing. Servers are also stopped when the session shuts down.

## Optional MLX models

On Apple Silicon Macs, select an MLX repository in the same `/local-models` search or enter `/local-models owner/repository` directly. Saved MLX and GGUF selections appear in the same menu, labeled with their runtime. Repositories with supported GGUF quantizations use llama.cpp; otherwise the files must pass MLX model validation. An explicit `:quantization` selects GGUF.

This uses the MLX search/download/start flow for supported MLX text models. Its private environment installs pinned `mlx-lm`, `huggingface_hub`, and `hf_xet` packages only after confirmation. Root-layout safetensors models can be MLX-quantized or full precision explicitly published for MLX.

LiquidAI's LFM3 MLX card still reports runtime support in progress. The pinned MLX runtime does not run LFM3; those conversions remain clearly marked download-only. Use the main `/local-models` GGUF recommendation to run LFM3 now rather than enabling untrusted repository Python code.

The MLX working context is capped at 32k tokens and output at 4k; llama.cpp uses a 16k context. A training context limit is not a laptop memory budget, and larger weights or contexts can exceed available memory. Switching backends stops the previous managed server after confirmation rather than keeping both models in memory.

## Transfers, cache, and access

Both backends use `huggingface_hub` with Xet high-performance mode and up to eight concurrent file transfers. This is the same accelerated backend as the modern Hugging Face CLI, not a guarantee of higher throughput than that CLI. Speed depends on the network, disk, Hub service, and repository storage backend.

The progress view reports transferred bytes and speed where supplied by the backend. Press the configured cancel key (Escape by default), then confirm cancellation. Completed blobs remain cached; retrying reuses the Hub cache and its interrupted-download recovery.

Weights use Hugging Face's standard cache; `HF_HOME` and `HF_HUB_CACHE` are respected. Small discovery records and private runtime environments live under raga's agent directory (`~/.raga/agent/local-models`, or the configured agent directory). Records contain neither tokens nor server URLs.

For gated/private repositories, accept the terms or request access on Hugging Face, then set `HF_TOKEN` or authenticate with `hf auth login`. Tokens are inherited by the downloader, not passed as process arguments or stored in model records.

## Boundaries

- Managed llama.cpp inference currently supports macOS and Linux. MLX requires macOS on Apple Silicon. `/llama` still manages a separately configured llama.cpp server.
- Audio/vision models, adapters, arbitrary Transformers checkpoints, and repository Python code are not supported by the local catalog.
- Servers bind only `127.0.0.1` on ephemeral ports, not public network interfaces.
- `/model` lists active managed models, not every Hub repository. Search, consent, download, and startup happen in the local managers.
- No model weights or runtime packages are installed until the user approves the corresponding operation.
