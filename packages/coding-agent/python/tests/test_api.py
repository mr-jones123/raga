from __future__ import annotations

from typing import Any

from conftest import KernelProcess, only, text_of


class FakeHost:
    def __init__(self, results: dict[str, Any]) -> None:
        self.results = results
        self.requests: list[dict[str, Any]] = []

    def __call__(self, event: dict[str, Any]) -> dict[str, Any]:
        data = event["data"]
        self.requests.append(data)
        key = data["type"] if data["type"] != "tool.call" else f"tool.{data['name']}"
        result = self.results[key]
        if isinstance(result, Exception):
            return {"status": "error", "error": str(result)}
        return {"status": "ok", "result": result}


def test_bootstrap_names(kernel: KernelProcess) -> None:
    code = (
        "names = ['bash', 'read', 'edit', 'write', 'llm_query', 'llm_batch', 'rlm_query',\n"
        "         'context', 'answer', 'cells', 'HostError', 'ToolError']\n"
        "[n for n in names if n not in globals()]"
    )
    _, events = kernel.execute(code)
    assert only(events, "result")["text"] == "[]"
    _, events = kernel.execute("(answer, context.task, context.inputs, len(cells))")
    assert only(events, "result")["text"] == "({'content': '', 'ready': False}, '', Inputs({}), 1)"


def test_tool_calls(kernel: KernelProcess) -> None:
    host = FakeHost(
        {
            "tool.bash": {"text": "hi\n", "is_error": False},
            "tool.edit": {"text": "edited", "is_error": False},
            "tool.write": {"text": "wrote", "is_error": False},
        }
    )
    code = (
        "out = [await bash('echo hi'), await bash('sleep 1', timeout=5),\n"
        "       await edit('a.txt', [('old', 'new'), {'oldText': 'x', 'newText': 'y'}]),\n"
        "       await write('b.txt', 'content')]\n"
        "out"
    )
    _, events = kernel.execute(code, host)
    assert only(events, "result")["text"] == repr(["hi\n", "hi\n", "edited", "wrote"])
    assert host.requests == [
        {"type": "tool.call", "name": "bash", "args": {"command": "echo hi"}},
        {"type": "tool.call", "name": "bash", "args": {"command": "sleep 1", "timeout": 5}},
        {
            "type": "tool.call",
            "name": "edit",
            "args": {"path": "a.txt", "edits": [{"oldText": "old", "newText": "new"}, {"oldText": "x", "newText": "y"}]},
        },
        {"type": "tool.call", "name": "write", "args": {"path": "b.txt", "content": "content"}},
    ]


def test_tool_error_raises(kernel: KernelProcess) -> None:
    host = FakeHost({"tool.bash": {"text": "command failed: exit 2", "is_error": True}})
    code = "try:\n    await bash('false')\nexcept ToolError as e:\n    print(repr(str(e)))"
    rid, events = kernel.execute(code, host)
    assert text_of(events, "stdout", rid) == "'command failed: exit 2'\n"


def test_context_history_and_set_context(kernel: KernelProcess, tmp_path) -> None:
    doc = tmp_path / "doc.txt"
    doc.write_text("big text")
    host = FakeHost({"context.history": {"messages": [{"role": "user", "text": "hi"}], "total": 1}})
    code = (
        "import raga_rlm\n"
        f"raga_rlm.set_context('the task', {{'doc': {str(doc)!r}}})\n"
        "(context.task, context.inputs['doc'], await context.history(limit=5))"
    )
    _, events = kernel.execute(code, host)
    assert only(events, "result")["text"] == repr(("the task", "big text", [{"role": "user", "text": "hi"}]))
    assert host.requests == [{"type": "context.history", "offset": 0, "limit": 5}]


def test_set_context_request_reads_inputs_lazily(kernel: KernelProcess, tmp_path) -> None:
    doc = tmp_path / "doc.txt"
    missing = tmp_path / "missing.txt"
    done = kernel.request(
        {"type": "set_context", "task": "summarize", "inputs": {"doc": str(doc), "gone": str(missing)}}
    )
    assert done["status"] == "ok"
    # The file is read on first access, after set_context, and then cached.
    doc.write_text("first")
    _, events = kernel.execute("(context.task, sorted(context.inputs), context.inputs['doc'])")
    assert only(events, "result")["text"] == repr(("summarize", ["doc", "gone"], "first"))
    doc.write_text("second")
    _, events = kernel.execute("context.inputs['doc']")
    assert only(events, "result")["text"] == repr("first")
    _, events = kernel.execute("context.inputs['gone']")
    assert only(events, "error")["ename"] == "FileNotFoundError"


def test_set_context_rejects_bad_inputs(kernel: KernelProcess) -> None:
    done = kernel.request({"type": "set_context", "task": "t", "inputs": {"doc": 1}})
    assert done["status"] == "error"
    assert "inputs must map names to file paths" in done["reason"]


def test_set_context_data(kernel: KernelProcess) -> None:
    done = kernel.request({"type": "set_context", "task": "t", "inputs": {}, "data": {"rows": [1, 2], "name": "x"}})
    assert done["status"] == "ok"
    _, events = kernel.execute("(context.task, context.data)")
    assert only(events, "result")["text"] == repr(("t", {"rows": [1, 2], "name": "x"}))
    kernel.request({"type": "set_context", "task": "t2", "inputs": {}})
    _, events = kernel.execute("context.data")
    assert [e for e in events if e["event"] == "result"] == []


def test_get_answer(kernel: KernelProcess) -> None:
    assert kernel.request({"type": "get_answer"})["answer"] == {"content": "", "ready": False}
    kernel.execute("answer['content'] = 'forty-two'\nanswer['ready'] = True")
    assert kernel.request({"type": "get_answer"})["answer"] == {"content": "forty-two", "ready": True}
    # A rebound answer counts, and non-string content is sent as JSON.
    kernel.execute("answer = {'content': {'n': 1}, 'ready': 1}")
    assert kernel.request({"type": "get_answer"})["answer"] == {"content": '{"n": 1}', "ready": True}
    kernel.execute("answer = None")
    assert kernel.request({"type": "get_answer"})["answer"] == {"content": "", "ready": False}


def test_host_error_from_api(kernel: KernelProcess) -> None:
    host = FakeHost({"llm.query": RuntimeError("no model configured")})
    rid, events = kernel.execute("await llm_query('q')", host)
    error = only(events, "error")
    assert error["ename"] == "HostError"
    assert error["evalue"] == "no model configured"


def test_parallel_host_requests(kernel: KernelProcess) -> None:
    host = FakeHost({"llm.query": {"text": "x"}})
    code = "import asyncio\nawait asyncio.gather(*(llm_query(str(i)) for i in range(5)))"
    _, events = kernel.execute(code, host)
    assert only(events, "result")["text"] == repr(["x"] * 5)
    assert sorted(r["prompt"] for r in host.requests) == ["0", "1", "2", "3", "4"]


def test_bootstrap_names_are_not_snapshotted(kernel: KernelProcess, tmp_path) -> None:
    kernel.execute("answer['content'] = 'done'\nmine = 1")
    done = kernel.request({"type": "snapshot", "path": str(tmp_path / "s.bin")})
    assert done["saved"] == ["mine"]
    done = kernel.request({"type": "list_names"})
    assert done["names"] == ["mine"]


def test_read_returns_the_whole_file_without_a_host_call(kernel: KernelProcess, tmp_path) -> None:
    lines = [f"line {i}" for i in range(1, 3001)]
    path = tmp_path / "big.txt"
    path.write_bytes(("\n".join(lines) + "\n").encode() + b"bad \xff byte\n")
    host = FakeHost({})
    code = (
        f"whole = await read({str(path)!r})\n"
        f"part = await read({str(path)!r}, offset=2, limit=3)\n"
        f"tail = await read({str(path)!r}, offset=3000)\n"
        "(len(whole.splitlines()), whole.splitlines()[-1], part, tail)"
    )
    _, events = kernel.execute(code, host)
    expected = (3001, "bad \ufffd byte", "line 2\nline 3\nline 4\n", "line 3000\nbad \ufffd byte\n")
    assert only(events, "result")["text"] == repr(expected)
    assert host.requests == []
