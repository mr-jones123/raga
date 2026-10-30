"""Hermetic model manager tests: no MLX, network, model downloads, or installs."""
import json
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
import types
from unittest.mock import patch

import pytest

from conftest import PYTHON_DIR

helper_spec = spec_from_file_location("mlx_models", PYTHON_DIR / "raga_rlm" / "mlx_models.py")
assert helper_spec is not None and helper_spec.loader is not None
manager = module_from_spec(helper_spec)
helper_spec.loader.exec_module(manager)


def spec():
    return {"id": "org/model", "revision": "a" * 40,
            "files": ["config.json", "model.safetensors"], "contextWindow": 4096}


def hub(root):
    module = types.ModuleType("huggingface_hub")
    calls = []

    def snapshot_download(**kwargs):
        calls.append(kwargs)
        return str(root)

    def hf_hub_download(**kwargs):
        calls.append(kwargs)
        path = root / kwargs["filename"]
        if not path.exists():
            raise FileNotFoundError(path)
        return str(path)

    module.snapshot_download = snapshot_download
    module.hf_hub_download = hf_hub_download
    return module, calls


def populate(root):
    (root / "config.json").write_text('{"model_type":"test"}')
    (root / "model.safetensors").write_bytes(b"weights")


def test_cache_checks_every_file_and_empty_weights_offline(tmp_path):
    module, calls = hub(tmp_path)
    with patch.dict(sys.modules, {"huggingface_hub": module}):
        assert manager.cached_snapshot(spec()) is None
        populate(tmp_path)
        assert manager.cached_snapshot(spec()) == tmp_path
        (tmp_path / "model.safetensors").write_bytes(b"")
        assert manager.cached_snapshot(spec()) is None
    assert calls and all(call["local_files_only"] is True for call in calls)


def test_cache_rejects_unselected_index_shards(tmp_path):
    populate(tmp_path)
    (tmp_path / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"x": "missing.safetensors"}}))
    module, _ = hub(tmp_path)
    with patch.dict(sys.modules, {"huggingface_hub": module}):
        assert manager.cached_snapshot(spec()) is None


@pytest.mark.parametrize("files", [["../bad"], ["/abs"], ["*.safetensors"], [], ["config.json"]])
def test_rejects_non_exact_allowlist(files):
    with pytest.raises(manager.ModelError):
        manager.validate({**spec(), "files": files})


def test_revision_must_be_pinned():
    with pytest.raises(manager.ModelError, match="pinned"):
        manager.validate({**spec(), "revision": "main"})
    manager.validate(spec())


def test_download_uses_exact_selection_and_xet(tmp_path, monkeypatch):
    populate(tmp_path)
    module, calls = hub(tmp_path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    monkeypatch.setitem(sys.modules, "hf_xet", types.ModuleType("hf_xet"))
    monkeypatch.setattr(manager, "progress_class", lambda: object)
    monkeypatch.setattr(manager, "preflight", lambda root: pytest.fail("Download must not require runtime architecture support"))
    manager.download(spec())
    assert calls[0] == {"repo_id": "org/model", "revision": "a" * 40, "allow_patterns": spec()["files"],
                        "max_workers": 8, "tqdm_class": object}
    assert manager.os.environ["HF_XET_HIGH_PERFORMANCE"] == "1"


def test_unsupported_architecture_is_explicit(tmp_path, monkeypatch):
    (tmp_path / "config.json").write_text('{"model_type":"lfm3"}')
    utils = types.ModuleType("mlx_lm.utils")

    def unsupported(config):
        raise ValueError("unsupported")

    utils._get_classes = unsupported
    monkeypatch.setitem(sys.modules, "mlx_lm.utils", utils)
    with pytest.raises(manager.ModelError, match="Unsupported MLX architecture: LFM3"):
        manager.preflight(tmp_path)


def test_serve_is_offline_local_only_and_never_trusts_remote_code(tmp_path, monkeypatch):
    populate(tmp_path)
    module, calls = hub(tmp_path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    utils = types.ModuleType("mlx_lm.utils")
    utils._get_classes = lambda config: (object, object)
    monkeypatch.setitem(sys.modules, "mlx_lm.utils", utils)
    mlx = types.ModuleType("mlx_lm")
    observed = []
    class StubProvider:
        def __init__(self, args):
            assert args.trust_remote_code is False
            self._model_map = {}

        def load_default(self):
            assert self._model_map[spec()["id"]] == str(tmp_path.resolve())
            observed.append("loaded")

    server = types.SimpleNamespace(ModelProvider=StubProvider)

    def server_main():
        server.ModelProvider(types.SimpleNamespace(trust_remote_code=True))
        observed.append(list(sys.argv))

    server.main = server_main
    mlx.server = server
    monkeypatch.setitem(sys.modules, "mlx_lm", mlx)
    monkeypatch.setattr(sys, "argv", [])
    manager.serve(spec(), 12345)
    assert observed == ["loaded", ["mlx_lm.server", "--model", str(tmp_path.resolve()), "--host", "127.0.0.1", "--port", "12345"]]
    assert all(call["local_files_only"] for call in calls)
    assert manager.os.environ["HF_HUB_OFFLINE"] == "1"
    assert manager.os.environ["TRANSFORMERS_OFFLINE"] == "1"


def test_probe_rejects_unsupported_host(monkeypatch):
    monkeypatch.setattr(manager.platform, "system", lambda: "Linux")
    with pytest.raises(manager.ModelError, match="Apple Silicon"):
        manager.probe()


def test_download_progress_reports_bytes_and_rate_without_terminal_escapes(monkeypatch):
    class FakeTqdm:
        def __init__(self, **kwargs):
            self.unit = "B"
            self.desc = "Downloading bytes"
            self.total = 20 * 1048576
            self.n = 10 * 1048576
            self.format_dict = {"rate": 2 * 1048576}
            self.display()

    hub_module = types.ModuleType("huggingface_hub")
    utils_module = types.ModuleType("huggingface_hub.utils")
    utils_module.tqdm = FakeTqdm
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub_module)
    monkeypatch.setitem(sys.modules, "huggingface_hub.utils", utils_module)
    events = []
    monkeypatch.setattr(manager, "emit", lambda **fields: events.append(fields))
    manager.progress_class()()
    assert events == [{"message": "Downloading 10.0 / 20.0 MiB · 2.0 MiB/s"}]


def gguf_spec():
    return {"id": "LiquidAI/LFM3-1.7B-GGUF", "revision": "b" * 40,
            "files": ["LFM3-1.7B-Q4_K_M-00001-of-00002.gguf", "LFM3-1.7B-Q4_K_M-00002-of-00002.gguf"],
            "modelFile": "LFM3-1.7B-Q4_K_M-00001-of-00002.gguf", "format": "gguf", "contextWindow": 16384}


def test_gguf_validation_and_all_selected_shards(tmp_path, monkeypatch):
    selected = gguf_spec()
    manager.validate(selected)
    for changes in ({"files": selected["files"][:1]}, {"modelFile": "missing.gguf"},
                    {"contextWindow": 16385}, {"contextWindow": True}, {"modelFile": selected["files"][1]}):
        with pytest.raises(manager.ModelError):
            manager.validate({**selected, **changes})
    module, calls = hub(tmp_path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    assert manager.cached_snapshot(selected) is None
    for name in selected["files"]:
        (tmp_path / name).write_bytes(b"gguf")
    # Unselected cached metadata must not constrain the GGUF selection.
    (tmp_path / "model.safetensors.index.json").write_text("invalid")
    assert manager.cached_snapshot(selected) == tmp_path
    (tmp_path / selected["files"][1]).write_bytes(b"")
    assert manager.cached_snapshot(selected) is None
    assert all(call["local_files_only"] for call in calls)


@pytest.mark.parametrize("version,accepted", [
    ("version: 11960 (abc)", True), ("version: b12000", True), ("llama.cpp v0.8.0", True),
    ("llama.cpp v1.0.0", True), ("version: 11959 (abc)", False), ("v0.7.9", False), ("unknown", False), ("version: 11959 (abc)\nbuilt with Apple clang version 17.0.0", False),
    ("version: 0.8.0", True),
])
def test_llama_version_probe(version, accepted, monkeypatch):
    monkeypatch.setattr(manager.shutil, "which", lambda value: "/bin/llama-server")
    def run(args, **kwargs):
        assert args == ["/bin/llama-server", "--version"]
        assert kwargs["timeout"] == 15
        return types.SimpleNamespace(stdout="", stderr=version)
    monkeypatch.setattr(manager.subprocess, "run", run)
    if accepted:
        assert manager.llama_server() == "/bin/llama-server"
    else:
        with pytest.raises(manager.ModelError, match="b11960"):
            manager.llama_server()


def test_llama_probe_has_only_downloader_dependencies(monkeypatch):
    monkeypatch.setenv("RAGA_LOCAL_MODEL_BACKEND", "llama.cpp")
    monkeypatch.setenv("LLAMA_SERVER_PATH", "/custom/llama-server")
    monkeypatch.setattr(manager.platform, "system", lambda: "Linux")
    monkeypatch.setattr(manager, "llama_server", lambda: "/custom/llama-server")
    checked, imported = [], []
    def version(name):
        checked.append(name)
        return manager.DEPENDENCIES[name]
    monkeypatch.setattr(manager.importlib.metadata, "version", version)
    monkeypatch.setattr(manager.importlib, "import_module", imported.append)
    manager.probe()
    assert checked == ["huggingface-hub", "hf-xet"]
    assert imported == ["huggingface_hub", "hf_xet"]


def test_gguf_download_does_not_import_mlx_or_read_config(tmp_path, monkeypatch):
    selected = gguf_spec()
    for name in selected["files"]:
        (tmp_path / name).write_bytes(b"gguf")
    module, calls = hub(tmp_path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    monkeypatch.setitem(sys.modules, "hf_xet", types.ModuleType("hf_xet"))
    monkeypatch.setattr(manager, "progress_class", lambda: object)
    monkeypatch.setattr(manager, "preflight", lambda root: pytest.fail("No MLX preflight for GGUF"))
    manager.download(selected)
    assert calls[0]["allow_patterns"] == selected["files"]
    assert calls[0]["max_workers"] == 8


def test_gguf_serve_execs_local_first_shard_with_tool_and_sampling_flags(tmp_path, monkeypatch):
    monkeypatch.setenv("RAGA_LOCAL_MODEL_BACKEND", "llama.cpp")
    selected = gguf_spec()
    for name in selected["files"]:
        (tmp_path / name).write_bytes(b"gguf")
    module, calls = hub(tmp_path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    monkeypatch.setitem(sys.modules, "mlx_lm", None)
    monkeypatch.setattr(manager, "llama_server", lambda: "/custom/llama-server")
    observed = []
    monkeypatch.setattr(manager.os, "execv", lambda binary, args: observed.append((binary, args)))
    manager.serve(selected, 12345)
    assert observed == [("/custom/llama-server", ["/custom/llama-server", "--model",
        str(tmp_path.resolve() / selected["files"][0]), "--host", "127.0.0.1", "--port", "12345",
        "--alias", selected["id"], "--ctx-size", "16384", "--jinja", "--temp", "0.1", "--top-k", "50",
        "--repeat-penalty", "1.1"])]
    assert all(call["local_files_only"] for call in calls)
    assert manager.os.environ["HF_HUB_OFFLINE"] == "1"
