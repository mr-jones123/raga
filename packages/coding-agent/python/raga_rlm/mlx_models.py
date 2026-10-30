"""Private local model manager protocol. Model specs arrive on stdin, never argv.

No mode installs uv or fetches executable model code. Only download uses network.
"""
from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import time
import threading

DEPENDENCIES = {"mlx-lm": "0.32.2", "huggingface-hub": "2.4.0", "hf-xet": "1.7.1"}
OUTPUT_LOCK = threading.Lock()


class ModelError(Exception):
    """A safe, user-facing diagnostic (no hub exceptions or credentials)."""


def emit(**fields: object) -> None:
    with OUTPUT_LOCK:
        print(json.dumps(fields), flush=True)


def validate(spec: dict) -> None:
    if not isinstance(spec.get("id"), str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", spec["id"]):
        raise ModelError("Invalid Hugging Face model id")
    if not isinstance(spec.get("revision"), str) or not re.fullmatch(r"[0-9a-fA-F]{40}", spec["revision"]):
        raise ModelError("Model revision must be a pinned 40-character commit SHA")
    files = spec.get("files")
    if not isinstance(files, list) or not files or not all(isinstance(f, str) for f in files):
        raise ModelError("An exact model file allowlist is required")
    for name in files:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or str(path) != name or any(c in name for c in "*?[]\\"):
            raise ModelError("Model files must be exact relative paths, not patterns")
    if spec.get("format") == "gguf":
        if not all(f.endswith(".gguf") for f in files):
            raise ModelError("GGUF selection must contain only exact GGUF files")
        model_file = spec.get("modelFile", files[0])
        if model_file not in files:
            raise ModelError("GGUF modelFile must be in the selected files")
        context = spec.get("contextWindow")
        if type(context) is not int or not 1 <= context <= 16384:
            raise ModelError("GGUF contextWindow must be between 1 and 16384")
        for name in files:
            shard = re.fullmatch(r"(.+)-(\d{5})-of-(\d{5})\.gguf", name)
            if shard:
                prefix, number, count = shard.groups()
                total = int(count)
                if not 1 <= int(number) <= total <= len(files) or any(
                    f"{prefix}-{i:05d}-of-{count}.gguf" not in files for i in range(1, total + 1)
                ):
                    raise ModelError("GGUF selection must include all shards")
        first = re.fullmatch(r"(.+)-(\d{5})-of-(\d{5})\.gguf", model_file)
        if first and first[2] != "00001":
            raise ModelError("GGUF modelFile must be the first shard")
        return
    if spec.get("format") is not None:
        raise ModelError("Unsupported model format")
    if "config.json" not in files or not any(f.endswith(".safetensors") for f in files):
        raise ModelError("Model files must include config.json and safetensors weights")


def backend() -> str:
    value = os.environ.get("RAGA_LOCAL_MODEL_BACKEND", "mlx")
    if value not in ("mlx", "llama.cpp"):
        raise ModelError("Unknown local model backend")
    return value


def llama_server() -> str:
    instructions = ("llama-server >= v0.8.0 / b11960 is required. Install or upgrade llama.cpp "
                    "and put llama-server on PATH, or set LLAMA_SERVER_PATH.")
    binary = shutil.which(os.environ.get("LLAMA_SERVER_PATH", "llama-server"))
    if binary is None:
        raise ModelError(instructions)
    try:
        result = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=15, check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ModelError(instructions) from exc
    text = result.stdout + result.stderr
    build = re.search(r"\bversion:\s*b?(\d+)(?![\d.])\b", text, re.I) or re.search(r"\bb(\d+)\b", text, re.I)
    release = re.search(r"(?:\bversion:\s*v?|\bv)(\d+)\.(\d+)\.(\d+)\b", text)
    if not (int(build[1]) >= 11960 if build else
            release and tuple(map(int, release.groups())) >= (0, 8, 0)):
        raise ModelError(instructions)
    return binary


def probe() -> None:
    gguf = backend() == "llama.cpp"
    if gguf:
        if platform.system() not in ("Darwin", "Linux"):
            raise ModelError("llama.cpp requires macOS or Linux (POSIX process groups)")
        llama_server()
    elif platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ModelError("MLX requires macOS on Apple Silicon (arm64)")
    for name, version in DEPENDENCIES.items():
        if gguf and name == "mlx-lm":
            continue
        if importlib.metadata.version(name) != version:
            raise ModelError("Local model dependencies need installation or repair")
    modules = ("huggingface_hub", "hf_xet") if gguf else ("mlx.core", "mlx_lm.server", "huggingface_hub", "hf_xet")
    for module in modules:
        importlib.import_module(module)


def cached_snapshot(spec: dict) -> Path | None:
    """Check every selected file without network, including empty/broken blobs."""
    from huggingface_hub import hf_hub_download, snapshot_download
    try:
        root = Path(snapshot_download(repo_id=spec["id"], revision=spec["revision"],
                                      allow_patterns=spec["files"], local_files_only=True))
        for name in spec["files"]:
            path = Path(hf_hub_download(repo_id=spec["id"], revision=spec["revision"],
                                        filename=name, local_files_only=True))
            if not path.is_file() or path.stat().st_size == 0 or not (root / name).is_file() or (root / name).stat().st_size == 0:
                return None
        # A partial selection must not omit weight shards referenced by the index.
        index = root / "model.safetensors.index.json"
        if spec.get("format") != "gguf" and index.is_file():
            shards = set(json.loads(index.read_text())["weight_map"].values())
            if not shards.issubset(spec["files"]):
                return None
        return root
    except (OSError, ValueError, KeyError):
        return None
    except Exception:
        # Hub cache misses use library-specific exception classes. Never echo auth errors.
        return None


def preflight(root: Path) -> None:
    from mlx_lm.utils import _get_classes
    config = json.loads((root / "config.json").read_text())
    model_type = config.get("model_type", "")
    if not isinstance(model_type, str) or not re.fullmatch(r"[a-zA-Z0-9_]+", model_type):
        raise ModelError("Unsupported MLX model architecture")
    architectures = config.get("architectures") or []
    if isinstance(architectures, str):
        architectures = [architectures]
    if "lfm3" in model_type.lower().replace("_", "") or any(
        "lfm3" in str(arch).lower().replace("_", "") for arch in architectures
    ):
        raise ModelError("Unsupported MLX architecture: LFM3. Official mlx-lm support is pending.")
    try:
        _get_classes(config)
    except (ImportError, ValueError, KeyError) as exc:
        raise ModelError(f"Unsupported MLX architecture: {model_type}. mlx-lm support may be pending (including LFM3).") from exc


def progress_class():
    from huggingface_hub.utils import tqdm

    class Progress(tqdm):
        def __init__(self, *args, **kwargs):
            self.last_report = 0.0
            super().__init__(*args, **kwargs)

        def display(self, msg=None, pos=None):
            now = time.monotonic()
            if now - self.last_report < 0.2:
                return
            self.last_report = now
            if self.unit != "B" or not self.desc.startswith("Downloading"):
                return
            total = self.total or 0
            rate = self.format_dict.get("rate") or 0
            size = f"{self.n / 1048576:.1f} / {total / 1048576:.1f} MiB"
            emit(message=f"Downloading {size} · {rate / 1048576:.1f} MiB/s")

    return Progress


def download(spec: dict) -> None:
    os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
    from huggingface_hub import snapshot_download
    import hf_xet  # noqa: F401 -- ensure the pinned transfer backend is available
    # Downloading is allowed even when mlx-lm cannot yet run the architecture (e.g. LFM3).
    emit(message="Downloading selected model files via Hugging Face cache")
    snapshot_download(repo_id=spec["id"], revision=spec["revision"], allow_patterns=spec["files"],
                      max_workers=8, tqdm_class=progress_class())
    if cached_snapshot(spec) is None:
        raise ModelError("Download incomplete: selected model files are missing or empty")
    emit(message="Model download complete", percent=100)


def serve(spec: dict, port: int) -> None:
    # Set before importing HF/transformers/mlx_lm: their constants are import-time.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    root = cached_snapshot(spec)
    if root is None:
        raise ModelError("Selected model files are not fully cached; download first")
    root = root.resolve()
    if backend() == "llama.cpp":
        if spec.get("format") != "gguf":
            raise ModelError("llama.cpp requires a GGUF model spec")
        binary = llama_server()
        model = root / spec.get("modelFile", spec["files"][0])
        emit(modelPath=str(model))
        os.execv(binary, [binary, "--model", str(model), "--host", "127.0.0.1", "--port", str(port),
                          "--alias", spec["id"], "--ctx-size", str(spec["contextWindow"]), "--jinja",
                          "--temp", "0.1", "--top-k", "50", "--repeat-penalty", "1.1"])
        return
    if spec.get("format") == "gguf":
        raise ModelError("GGUF models require the llama.cpp backend")
    preflight(root)
    emit(modelPath=str(root))
    from mlx_lm import server

    class LocalModelProvider(server.ModelProvider):
        def __init__(self, cli_args: argparse.Namespace) -> None:
            # mlx-lm 0.32.2 otherwise loads in a background thread, and /models
            # can advertise the path before weights/tokenizer have loaded.
            cli_args.trust_remote_code = False
            super().__init__(cli_args)
            self._model_map[spec["id"]] = str(root)
            self.load_default()

    server.ModelProvider = LocalModelProvider
    # No --trust-remote-code: pinned mlx-lm defaults to false for tokenizers.
    sys.argv = ["mlx_lm.server", "--model", str(root), "--host", "127.0.0.1", "--port", str(port)]
    server.main()


def main() -> int:
    try:
        mode = sys.argv[1]
        if mode == "probe":
            probe()
            emit(installed=True)
            return 0
        spec = json.load(sys.stdin)
        validate(spec)
        if mode == "cache":
            os.environ["HF_HUB_OFFLINE"] = "1"
            emit(cached=cached_snapshot(spec) is not None)
        elif mode == "download":
            download(spec)
        elif mode == "serve":
            serve(spec, int(sys.argv[2]))
        else:
            raise ModelError("Unknown local model helper mode")
        return 0
    except ModelError as exc:
        emit(error=str(exc))
    except Exception as exc:
        # Deliberately omit exception text: requests/hub errors can include credentials.
        emit(error=f"Local model operation failed ({type(exc).__name__}); check installation, cache, and Hugging Face access")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
