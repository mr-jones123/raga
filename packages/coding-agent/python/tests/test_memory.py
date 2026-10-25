from __future__ import annotations

import sys
from pathlib import Path

import pytest
from conftest import KernelProcess, only, text_of

MIB = 1024 * 1024


def result_of(kernel: KernelProcess, code: str, timeout: float = 30.0) -> str:
    _, events = kernel.execute(code, timeout=timeout)
    assert events[-1]["status"] == "ok", events
    return only(events, "result")["text"]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="RLIMIT_DATA is enforced on Linux only")
def test_memory_limit_raises_memory_error_and_kernel_survives(spawn) -> None:
    kernel = spawn(env={"RAGA_RLM_MEMORY_LIMIT_MB": "256"})
    assert result_of(kernel, "import resource\nresource.getrlimit(resource.RLIMIT_DATA)") == repr(
        (256 * MIB, 256 * MIB)
    )
    kernel.execute("keep = list(range(1000))")
    for code in ("big = bytearray(512 * 1024 * 1024)", "many = [str(i) * 5 for i in range(20_000_000)]"):
        rid, events = kernel.execute(code, timeout=60)
        assert only(events, "error")["ename"] == "MemoryError"
        assert events[-1]["status"] == "error"
    # The kernel keeps serving and earlier variables are intact.
    assert result_of(kernel, "(len(keep), 'big' in globals(), 'many' in globals())") == "(1000, False, False)"


def test_no_memory_limit_without_env(spawn) -> None:
    kernel = spawn(env={"RAGA_RLM_MEMORY_LIMIT_MB": "0"})
    assert result_of(kernel, "import resource\nresource.getrlimit(resource.RLIMIT_DATA)[0] == resource.RLIM_INFINITY") == "True"


def test_rss_mb_on_execute_done(kernel: KernelProcess) -> None:
    _, events = kernel.execute("1")
    before = events[-1]["rss_mb"]
    assert isinstance(before, int) and before > 0
    _, events = kernel.execute("blob = b'x' * (64 * 1024 * 1024)")
    assert events[-1]["rss_mb"] >= before + 60
    # Only execute replies carry it.
    assert "rss_mb" not in kernel.request({"type": "list_names"})


def test_cells_keep_newest_outputs_within_budget(kernel: KernelProcess) -> None:
    size = 5 * MIB + 1  # print() adds the newline
    ids = [kernel.execute(f"print('y' * {5 * MIB})", timeout=30)[0] for _ in range(8)]
    stats = result_of(
        kernel,
        "import raga_rlm\n"
        "full = [len(c['stdout']) for c in cells if not c['stdout'].startswith('[output dropped')]\n"
        "(raga_rlm.CELLS_OUTPUT_BUDGET, sum(full), [c['id'] for c in cells], [c['code'] for c in cells[:2]],"
        " [c['stdout'] for c in cells[:2]], [len(c['stdout']) for c in cells[2:]])",
    )
    budget = 32 * MIB
    # 6 cells of 5 MiB fit in 32 MiB; the 2 oldest lose their output and keep their code.
    assert stats == repr(
        (
            budget,
            6 * size,
            ids,
            [f"print('y' * {5 * MIB})"] * 2,
            [f"[output dropped to bound memory: {size} characters]"] * 2,
            [size] * 6,
        )
    )


def test_newest_cell_keeps_output_over_budget(kernel: KernelProcess) -> None:
    kernel.execute("print('a')")
    kernel.execute(f"print('z' * {33 * MIB})", timeout=60)
    assert result_of(kernel, "[cells[0]['stdout'], len(cells[1]['stdout'])]") == repr(
        ["[output dropped to bound memory: 2 characters]", 33 * MIB + 1]
    )


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads VmHWM from /proc")
def test_snapshot_skips_large_buffer_without_pickling_it(kernel: KernelProcess, tmp_path: Path) -> None:
    hwm = (
        "int(next(line for line in open('/proc/self/status') if line.startswith('VmHWM')).split()[1]) // 1024"
    )
    kernel.execute(
        "blob = bytearray(b'x') * (300 * 1024 * 1024)\n"
        "small = {'k': 1}\n"
        "class Buffer:\n"
        "    def __init__(self):\n"
        "        self.nbytes = 300 * 1024 * 1024\n"
        "fake_array = Buffer()\n",
        timeout=60,
    )
    before = int(result_of(kernel, hwm))
    done = kernel.request({"type": "snapshot", "path": str(tmp_path / "s.bin")})
    after = int(result_of(kernel, hwm))
    assert done["status"] == "ok"
    assert done["saved"] == ["Buffer", "small"]
    assert done["skipped"] == ["blob", "fake_array"]
    assert after - before <= 50, (before, after)


def test_streaming_restore_round_trip(spawn, tmp_path: Path) -> None:
    path = str(tmp_path / "s.bin")
    first = spawn()
    first.execute(
        "text = 'abc' * 1_000_000\n"
        "data = {'nested': [1, 2.5, None, b'bytes']}\n"
        "def twice(n):\n"
        "    return 2 * n\n"
    )
    done = first.request({"type": "snapshot", "path": path})
    assert done["saved"] == ["data", "text", "twice"]

    second = spawn()
    done = second.request({"type": "restore", "path": path})
    assert (done["status"], done["restored"], done["failed"]) == ("ok", ["data", "text", "twice"], [])
    assert result_of(second, "(len(text), text[:6], data, twice(21))") == repr(
        (3_000_000, "abcabc", {"nested": [1, 2.5, None, b"bytes"]}, 42)
    )

    # A truncated last record fails the restore before any name loads.
    truncated = tmp_path / "t.bin"
    truncated.write_bytes(Path(path).read_bytes()[:-10])
    third = spawn()
    done = third.request({"type": "restore", "path": str(truncated)})
    assert done["status"] == "error"
    assert done["reason"] == "snapshot load failed: truncated snapshot record"
    rid, events = third.execute("print(sorted(n for n in globals() if n in ('data', 'text', 'twice')))")
    assert text_of(events, "stdout", rid) == "[]\n"
