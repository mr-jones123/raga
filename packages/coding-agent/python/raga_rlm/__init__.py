# Adapted from Prime Agent (MIT), github.com/PrimeIntellect-ai/prime-agent
"""The names the model calls from the RLM kernel namespace.

`bootstrap(namespace)` binds them once at kernel startup. Every host-backed
function is a coroutine that sends one `host_request` and awaits the reply.
"""

from __future__ import annotations

import os
from collections.abc import Iterator, Mapping
from typing import Any

# The kernel starts in the session cwd; `read` resolves relative paths against it even after a cell chdirs.
_SESSION_CWD = os.getcwd()

__all__ = [
    "BOOTSTRAP_NAMES",
    "Context",
    "HostError",
    "Inputs",
    "ToolError",
    "answer",
    "bash",
    "bootstrap",
    "cells",
    "context",
    "edit",
    "host_request",
    "llm_batch",
    "llm_query",
    "read",
    "record_cell",
    "rlm_query",
    "set_context",
    "write",
]


class HostError(Exception):
    """The host answered a host_request with an error."""


class ToolError(Exception):
    """A pi tool reported an error; the message is the tool output."""


async def host_request(data: dict[str, Any]) -> Any:
    """Send one typed request to the host; return its result or raise HostError."""
    # Imported lazily: `python -m raga_rlm.repl` imports this package before the
    # kernel module registers itself as `raga_rlm.repl`.
    from . import repl

    reply = await repl.host_request(data)
    if reply.get("status") == "ok":
        return reply.get("result")
    raise HostError(str(reply.get("error", "host request failed")))


async def _tool(name: str, args: dict[str, Any]) -> str:
    result = await host_request({"type": "tool.call", "name": name, "args": args})
    text = str(result.get("text", "")) if isinstance(result, dict) else str(result)
    if isinstance(result, dict) and result.get("is_error"):
        raise ToolError(text)
    return text


def _drop_none(**fields: Any) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value is not None}


async def bash(command: str, timeout: float | None = None) -> str:
    """Run pi's bash tool and return its output."""
    return await _tool("bash", _drop_none(command=command, timeout=timeout))


async def read(path: str, offset: int | None = None, limit: int | None = None) -> str:
    """Return the file's text, whole unless `offset` (1-indexed first line) or `limit` (line count) is given."""
    with open(os.path.join(_SESSION_CWD, os.path.expanduser(path)), encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    if offset is None and limit is None:
        return text
    lines = text.splitlines(keepends=True)
    start = max((offset or 1) - 1, 0)
    end = len(lines) if limit is None else start + limit
    return "".join(lines[start:end])


async def edit(path: str, edits: list[Any]) -> str:
    """Run pi's edit tool. `edits` holds (old, new) tuples or {"oldText","newText"} dicts."""
    normalized: list[dict[str, str]] = []
    for item in edits:
        if isinstance(item, dict):
            if "oldText" not in item or "newText" not in item:
                raise ValueError('edit dicts need "oldText" and "newText"')
            normalized.append({"oldText": item["oldText"], "newText": item["newText"]})
        elif isinstance(item, (tuple, list)) and len(item) == 2:
            normalized.append({"oldText": item[0], "newText": item[1]})
        else:
            raise TypeError("each edit must be an (old, new) tuple or an oldText/newText dict")
    return await _tool("edit", {"path": path, "edits": normalized})


async def write(path: str, content: str) -> str:
    """Run pi's write tool and return its output."""
    return await _tool("write", {"path": path, "content": content})


async def llm_query(prompt: str, system: str | None = None, model: str | None = None) -> str:
    """One sub-LLM call with no tools."""
    result = await host_request({"type": "llm.query", **_drop_none(prompt=prompt, system=system, model=model)})
    return result["text"]


async def llm_batch(prompts: list[str], system: str | None = None, model: str | None = None) -> list[str]:
    """Parallel sub-LLM calls; the host bounds concurrency."""
    payload = _drop_none(prompts=list(prompts), system=system, model=model)
    result = await host_request({"type": "llm.batch", **payload})
    return list(result["texts"])


async def rlm_query(task: str, context: Any = None, model: str | None = None, max_turns: int | None = None) -> str:
    """Run a child RLM session and return its answer."""
    payload = _drop_none(task=task, context=context, model=model, max_turns=max_turns)
    result = await host_request({"type": "rlm.query", **payload})
    return result["answer"]


class Inputs(Mapping[str, str]):
    """Input names mapped to file contents. Each file is read the first time its key is read, then cached."""

    def __init__(self, paths: dict[str, str] | None = None) -> None:
        self._paths = dict(paths or {})
        self._texts: dict[str, str] = {}

    def __getitem__(self, name: str) -> str:
        if name not in self._texts:
            with open(self._paths[name], encoding="utf-8", errors="replace") as fh:
                self._texts[name] = fh.read()
        return self._texts[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._paths)

    def __len__(self) -> int:
        return len(self._paths)

    def path(self, name: str) -> str:
        """The file behind `name`, without reading it."""
        return self._paths[name]

    def __repr__(self) -> str:
        return f"Inputs({self._paths!r})"


class Context:
    """`task` is the first user prompt, `inputs` holds large inputs, `data` is a JSON value from the parent."""

    def __init__(self) -> None:
        self.task: str = ""
        self.inputs: Inputs = Inputs()
        self.data: Any = None

    async def history(self, offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
        """Return the session's messages as {"role", "text"} dicts."""
        result = await host_request({"type": "context.history", **_drop_none(offset=offset, limit=limit)})
        return list(result["messages"])

    def __repr__(self) -> str:
        return (
            f"Context(task={self.task!r}, inputs=<{len(self.inputs)} keys: {sorted(self.inputs)!r}>, "
            f"data=<{type(self.data).__name__}>)"
        )


context = Context()
answer: dict[str, Any] = {"content": "", "ready": False}
cells: list[dict[str, Any]] = []

BOOTSTRAP_NAMES = frozenset(
    {
        "bash",
        "read",
        "edit",
        "write",
        "llm_query",
        "llm_batch",
        "rlm_query",
        "context",
        "answer",
        "cells",
        "HostError",
        "ToolError",
    }
)


def bootstrap(namespace: dict[str, Any]) -> None:
    """Bind the Python API into the kernel namespace."""
    for name in BOOTSTRAP_NAMES:
        namespace[name] = globals()[name]


def set_context(task: str, inputs: dict[str, str], data: Any = None) -> None:
    """Fill `context.task`, `context.inputs`, and `context.data`; `inputs` maps names to file paths."""
    if not isinstance(task, str):
        raise TypeError("task must be a string")
    if not isinstance(inputs, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in inputs.items()):
        raise TypeError("inputs must map names to file paths")
    context.task = task
    context.inputs = Inputs(inputs)
    context.data = data


def record_cell(entry: dict[str, Any]) -> None:
    """Append one finished cell; called by the kernel."""
    cells.append(entry)
