from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import ANY

from conftest import KernelProcess, only, text_of


def test_ready_handshake(kernel: KernelProcess) -> None:
    assert kernel.ready == {
        "event": "ready",
        "protocol": 1,
        "python": ".".join(str(part) for part in sys.version_info[:3]),
    }


def test_execute_stdout_and_result(kernel: KernelProcess) -> None:
    rid, events = kernel.execute("x = 20\nprint('hello')\nx + 22")
    assert text_of(events, "stdout", rid) == "hello\n"
    assert only(events, "result") == {"event": "result", "id": rid, "text": "42"}
    assert events[-1] == {"event": "done", "id": rid, "status": "ok", "rss_mb": ANY}
    # The value is bound to `_` and the namespace persists.
    _, events = kernel.execute("_ + x")
    assert only(events, "result")["text"] == "62"


def test_none_result_is_not_sent(kernel: KernelProcess) -> None:
    _, events = kernel.execute("None")
    assert [e["event"] for e in events] == ["done"]


def test_error_traceback_names_cell(kernel: KernelProcess) -> None:
    kernel.execute("pass")
    rid, events = kernel.execute("def f():\n    return 1 / 0\n\nf()")
    error = only(events, "error")
    assert error["id"] == rid
    assert error["ename"] == "ZeroDivisionError"
    assert error["evalue"] == "division by zero"
    text = "".join(error["traceback"])
    assert '"<cell-2>", line 4' in text
    assert "return 1 / 0" in text
    assert "repl.py" not in text
    assert events[-1] == {"event": "done", "id": rid, "status": "error", "rss_mb": ANY}


def test_syntax_error(kernel: KernelProcess) -> None:
    rid, events = kernel.execute("def (")
    error = only(events, "error")
    assert error["ename"] == "SyntaxError"
    assert "<cell-1>" in "".join(error["traceback"])
    assert events[-1]["status"] == "error"


def test_top_level_await(kernel: KernelProcess) -> None:
    rid, events = kernel.execute("import asyncio\nawait asyncio.sleep(0.01)\nawait asyncio.sleep(0, result='slept')")
    assert only(events, "result")["text"] == "'slept'"
    assert events[-1]["status"] == "ok"


def test_background_task_keeps_cell_id(kernel: KernelProcess) -> None:
    code = (
        "import asyncio\n"
        "async def later():\n"
        "    await asyncio.sleep(0.2)\n"
        "    print('from background')\n"
        "task = asyncio.create_task(later())\n"
    )
    rid, events = kernel.execute(code)
    assert events[-1] == {"event": "done", "id": rid, "status": "ok", "rss_mb": ANY}
    # print() writes the text and the newline separately.
    events = [kernel.next_event(), kernel.next_event()]
    assert all(e["event"] == "stdout" and e["id"] == rid for e in events)
    assert text_of(events, "stdout", rid) == "from background\n"


def test_raw_fd_write_arrives_with_null_id_before_done(kernel: KernelProcess) -> None:
    code = (
        "import os, subprocess, sys\n"
        "subprocess.run([sys.executable, '-c', 'print(\"child out\")'])\n"
        "os.write(2, b'raw err\\n')\n"
    )
    rid, events = kernel.execute(code)
    assert text_of(events, "stdout", None) == "child out\n"
    assert text_of(events, "stderr", None) == "raw err\n"
    assert text_of(events, "stdout", rid) == ""
    assert events[-1]["event"] == "done"


def test_stdin_is_dev_null(kernel: KernelProcess) -> None:
    _, events = kernel.execute("try:\n    input()\nexcept EOFError:\n    print('eof')")
    assert text_of(events, "stdout", events[-1]["id"]) == "eof\n"


def _wait_for_stdout(kernel: KernelProcess, rid: str, marker: str) -> list[dict]:
    seen = []
    while True:
        event = kernel.next_event()
        seen.append(event)
        if event["event"] == "stdout" and event["id"] == rid and marker in event["text"]:
            return seen


def test_interrupt_sync_loop(kernel: KernelProcess) -> None:
    rid = kernel.new_id()
    kernel.send({"type": "execute", "id": rid, "code": "print('start')\nwhile True:\n    pass"})
    _wait_for_stdout(kernel, rid, "start")
    kernel.send({"type": "interrupt", "id": rid})
    events = kernel.collect(rid)
    error = only(events, "error")
    assert error["ename"] == "KeyboardInterrupt"
    assert "<cell-1>" in "".join(error["traceback"])
    assert events[-1] == {"event": "done", "id": rid, "status": "error", "rss_mb": ANY}
    _, events = kernel.execute("1 + 1")
    assert only(events, "result")["text"] == "2"


def test_interrupt_sync_sleep(kernel: KernelProcess) -> None:
    rid = kernel.new_id()
    kernel.send({"type": "execute", "id": rid, "code": "import time\nprint('start')\ntime.sleep(30)"})
    _wait_for_stdout(kernel, rid, "start")
    started = time.monotonic()
    kernel.send({"type": "interrupt"})
    events = kernel.collect(rid)
    assert time.monotonic() - started < 5
    assert only(events, "error")["ename"] == "KeyboardInterrupt"


def test_interrupt_awaiting_cell(kernel: KernelProcess) -> None:
    rid = kernel.new_id()
    kernel.send({"type": "execute", "id": rid, "code": "import asyncio\nprint('start')\nawait asyncio.sleep(30)"})
    _wait_for_stdout(kernel, rid, "start")
    kernel.send({"type": "interrupt", "id": rid})
    events = kernel.collect(rid)
    error = only(events, "error")
    assert error["ename"] == "KeyboardInterrupt"
    assert error["traceback"][-1] == "KeyboardInterrupt\n"
    assert events[-1]["status"] == "error"
    _, events = kernel.execute("'still serving'")
    assert only(events, "result")["text"] == "'still serving'"


def test_interrupt_before_execute_starts(kernel: KernelProcess) -> None:
    first, second = kernel.new_id(), kernel.new_id()
    kernel.send({"type": "execute", "id": first, "code": "import time\ntime.sleep(0.5)\n'first'"})
    kernel.send({"type": "execute", "id": second, "code": "print('should not run')"})
    kernel.send({"type": "interrupt", "id": second})
    events = kernel.collect(second, timeout=10)
    first_events = [e for e in events if e["id"] == first]
    assert only(first_events, "result")["text"] == "'first'"
    assert first_events[-1] == {"event": "done", "id": first, "status": "ok", "rss_mb": ANY}
    second_events = [e for e in events if e["id"] == second]
    assert text_of(second_events, "stdout", second) == ""
    assert only(second_events, "error")["ename"] == "KeyboardInterrupt"
    assert second_events[-1] == {"event": "done", "id": second, "status": "error", "rss_mb": ANY}
    # The parked interrupt was consumed; the next cell runs normally.
    _, events = kernel.execute("3")
    assert only(events, "result")["text"] == "3"


def test_untargeted_interrupt_right_after_execute(kernel: KernelProcess) -> None:
    rid = kernel.new_id()
    kernel.send({"type": "execute", "id": rid, "code": "import time\ntime.sleep(30)"})
    kernel.send({"type": "interrupt"})
    events = kernel.collect(rid)
    assert only(events, "error")["ename"] == "KeyboardInterrupt"


def test_interrupt_for_unknown_id_is_dropped(kernel: KernelProcess) -> None:
    kernel.send({"type": "interrupt", "id": "nope"})
    kernel.send({"type": "interrupt"})
    _, events = kernel.execute("import time\ntime.sleep(0.2)\n5")
    assert only(events, "result")["text"] == "5"


def test_host_request_round_trip(kernel: KernelProcess) -> None:
    requests = []

    def host(event: dict) -> dict:
        requests.append(event)
        return {"status": "ok", "result": {"echo": event["data"]["value"] * 2}}

    code = "import raga_rlm\nr = await raga_rlm.host_request({'type': 'test.echo', 'value': 21})\nr['echo']"
    rid, events = kernel.execute(code, host)
    assert only(events, "result")["text"] == "42"
    assert requests[0]["cell"] == rid
    assert requests[0]["data"] == {"type": "test.echo", "value": 21}


def test_host_request_error_raises_host_error(kernel: KernelProcess) -> None:
    def host(event: dict) -> dict:
        return {"status": "error", "error": "unknown host request type: test.nope"}

    code = (
        "import raga_rlm\n"
        "try:\n"
        "    await raga_rlm.host_request({'type': 'test.nope'})\n"
        "except HostError as e:\n"
        "    print('caught', e)\n"
        "await raga_rlm.host_request({'type': 'test.nope'})\n"
    )
    rid, events = kernel.execute(code, host)
    assert text_of(events, "stdout", rid) == "caught unknown host request type: test.nope\n"
    error = only(events, "error")
    assert error["ename"] == "HostError"
    assert "__init__.py" not in "".join(error["traceback"])


def test_interrupt_while_awaiting_host_reply(kernel: KernelProcess) -> None:
    rid = kernel.new_id()
    kernel.send({"type": "execute", "id": rid, "code": "import raga_rlm\nawait raga_rlm.host_request({'type': 'slow'})"})
    request = kernel.next_event()
    assert request["event"] == "host_request"
    kernel.send({"type": "interrupt", "id": rid})
    events = kernel.collect(rid)
    assert only(events, "error")["ename"] == "KeyboardInterrupt"
    # A late reply to the cancelled request is ignored.
    kernel.send({"type": "host_reply", "id": request["id"], "data": {"status": "ok", "result": 1}})
    _, events = kernel.execute("7")
    assert only(events, "result")["text"] == "7"


def test_snapshot_and_restore_in_fresh_process(spawn, tmp_path: Path) -> None:
    path = str(tmp_path / "state" / "snap.bin")
    first = spawn()
    code = (
        "import os\n"
        "base = 10\n"
        "data = {'k': [1, 2, 3]}\n"
        "def add(n):\n"
        "    return base + n\n"
        "class Point:\n"
        "    def __init__(self, x):\n"
        "        self.x = x\n"
        "p = Point(5)\n"
        "gen = (i for i in range(3))\n"
        "big = 'x' * 5000\n"
        "_hidden = 1\n"
    )
    first.execute(code)
    done = first.request({"type": "snapshot", "path": path, "max_variable_bytes": 4096})
    assert done["status"] == "ok"
    assert done["saved"] == ["Point", "add", "base", "data", "p"]
    assert done["skipped"] == ["big", "gen"]
    assert done["bytes"] > 0
    assert Path(path).stat().st_size == done["bytes"]

    second = spawn()
    done = second.request({"type": "restore", "path": path})
    assert done == {
        "event": "done",
        "id": done["id"],
        "status": "ok",
        "restored": ["Point", "add", "base", "data", "p"],
        "failed": [],
    }
    # Restored functions see the live namespace.
    _, events = second.execute("base = 100\n(add(1), data['k'], p.x, isinstance(Point(1), Point))")
    assert only(events, "result")["text"] == "(101, [1, 2, 3], 5, True)"


def test_snapshot_total_cap(kernel: KernelProcess, tmp_path: Path) -> None:
    kernel.execute("a = 'a' * 1000\nb = 'b' * 1000")
    done = kernel.request({"type": "snapshot", "path": str(tmp_path / "s.bin"), "max_bytes": 1500})
    assert done["saved"] == ["a"]
    assert done["skipped"] == ["b"]


def test_restore_missing_file(kernel: KernelProcess, tmp_path: Path) -> None:
    done = kernel.request({"type": "restore", "path": str(tmp_path / "missing.bin")})
    assert done["status"] == "ok"
    assert done["restored"] == [] and done["failed"] == []
    assert done["reason"] == "snapshot not found"


def test_restore_reports_failed_names(kernel: KernelProcess, tmp_path: Path) -> None:
    path = tmp_path / "s.bin"
    kernel.execute("good = 1")
    assert kernel.request({"type": "snapshot", "path": str(path)})["saved"] == ["good"]
    magic = b"RAGA-RLM-SNAPSHOT-V1\n"
    record = len(b"bad").to_bytes(4, "little") + b"bad" + (3).to_bytes(8, "little") + b"\x00\x01\x02"
    path.write_bytes(path.read_bytes() + record)
    assert magic == path.read_bytes()[: len(magic)]
    done = kernel.request({"type": "restore", "path": str(path)})
    assert done["restored"] == ["good"]
    assert done["failed"] == ["bad"]


def test_list_names(kernel: KernelProcess) -> None:
    kernel.execute("import json\nalpha = 1\n_private = 2\ndef beta(): pass")
    done = kernel.request({"type": "list_names"})
    assert done["status"] == "ok"
    assert done["names"] == ["alpha", "beta"]


def test_malformed_line_yields_protocol_error(kernel: KernelProcess) -> None:
    kernel.send_raw(b"{not json\n")
    event = kernel.next_event()
    assert event["event"] == "error"
    assert event["id"] is None
    assert event["ename"] == "ProtocolError"
    kernel.send({"type": "bogus", "id": "x"})
    event = kernel.next_event()
    assert event["ename"] == "ProtocolError"
    assert "bogus" in event["evalue"]
    _, events = kernel.execute("'ok'")
    assert only(events, "result")["text"] == "'ok'"


def test_stdin_eof_exits_zero(kernel: KernelProcess) -> None:
    kernel.execute("x = 1")
    assert kernel.proc.stdin is not None
    kernel.proc.stdin.close()
    assert kernel.proc.wait(timeout=10) == 0


def test_shutdown_request(kernel: KernelProcess) -> None:
    done = kernel.request({"type": "shutdown"})
    assert done["status"] == "ok"
    assert kernel.proc.wait(timeout=10) == 0


def test_cells_record_full_output(kernel: KernelProcess) -> None:
    big = 70 * 1024
    rid1, events = kernel.execute(f"import sys\nprint('a' * {big})\nprint('warn', file=sys.stderr)\n'value'")
    # Large writes split into frames of at most 64 Ki characters.
    assert all(len(e["text"]) <= 64 * 1024 for e in events if e["event"] == "stdout")
    rid2, _ = kernel.execute("1 / 0")
    _, events = kernel.execute("[(c['id'], len(c['stdout']), c['stderr'], c['result'], c['error'] is None) for c in cells]")
    assert only(events, "result")["text"] == repr(
        [(rid1, big + 1, "warn\n", "'value'", True), (rid2, 0, "", None, False)]
    )
    _, events = kernel.execute("print(cells[1]['code']); print(cells[1]['error'])")
    out = text_of(events, "stdout", events[-1]["id"])
    assert out.startswith("1 / 0\nTraceback")
    assert "ZeroDivisionError: division by zero" in out


def test_snapshot_without_dill(spawn, tmp_path: Path) -> None:
    shadow = tmp_path / "shadow"
    shadow.mkdir()
    (shadow / "dill.py").write_text("raise ImportError('blocked for test')\n")
    kernel = spawn(shadow)
    kernel.execute("x = 1")
    for request in ({"type": "snapshot", "path": str(tmp_path / "s.bin")}, {"type": "restore", "path": __file__}):
        done = kernel.request(request)
        assert done["status"] == "error"
        assert done["reason"] == "dill not installed"
