# Adapted from Prime Agent (MIT), github.com/PrimeIntellect-ai/prime-agent
"""RLM kernel: a CPython REPL speaking newline-delimited JSON over stdio.

Entry point: `python -m raga_rlm.repl`. docs/RLM.md documents protocol 1.
Cells run with top-level await in one persistent `__main__` namespace on a
single asyncio event loop.
"""

from __future__ import annotations

import ast
import asyncio
import codecs
import contextvars
import inspect
import io
import json
import linecache
import os
import pickle
import platform
import signal
import sys
import tempfile
import threading
import traceback
import types
import uuid
from typing import Any

import raga_rlm

PROTOCOL_VERSION = 1

DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024
_SNAPSHOT_MAGIC = b"RAGA-RLM-SNAPSHOT-V1\n"

_STREAM_FRAME_TEXT_CAP = 64 * 1024
# Bounds a pathological repr or exception text in transit; the host truncates further.
_RESULT_TEXT_CAP = 1024 * 1024
_HOST_REQUEST_CAP = 16 * 1024 * 1024
# After stdin EOF a synchronous cell can block the queued shutdown forever.
_EOF_EXIT_GRACE_SECONDS = 10.0

_RUNTIME_FILES = {os.path.abspath(__file__), os.path.abspath(raga_rlm.__file__)}

_protocol_fd = -1
_host_stderr_fd = -1
_write_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_serve_task: asyncio.Task[Any] | None = None

# Asyncio tasks copy the context at creation, so background tasks keep their cell id.
_current_cell: contextvars.ContextVar[str | None] = contextvars.ContextVar("_current_cell", default=None)
# Full stdout/stderr per running cell, for the `cells` record.
_cell_output: dict[str, dict[str, list[str]]] = {}
_cell_counter = 0
_pending_host: dict[str, asyncio.Future[dict[str, Any]]] = {}
_host_closed = False

# Interrupt bookkeeping shared by the reader thread and the loop thread.
_interrupt_lock = threading.Lock()
_active: dict[str, Any] = {"task": None, "rid": None, "interrupted": False}
_inflight: set[str] = set()  # execute ids received and not yet finished
_pending_interrupts: dict[str, Any] = {"ids": set(), "any": False}
_sigint_target: str | None = None


def _send(event: dict[str, Any]) -> None:
    """Write one protocol frame; the lock keeps frames whole."""
    data = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    with _write_lock:
        view = memoryview(data)
        try:
            while view:
                view = view[os.write(_protocol_fd, view) :]
        except OSError as err:
            try:
                os.write(_host_stderr_fd, f"raga_rlm.repl: dropped protocol frame: {err}\n".encode())
            except OSError:
                pass


def _protocol_error(message: str) -> None:
    _send({"event": "error", "id": None, "ename": "ProtocolError", "evalue": message, "traceback": []})


# --- host requests -----------------------------------------------------------


async def host_request(data: dict[str, Any]) -> dict[str, Any]:
    """Send one host_request and await the raw reply dict."""
    if _loop is None:
        raise RuntimeError("the RLM kernel is not serving")
    if _host_closed:
        raise RuntimeError("host connection closed; host_request cannot be answered")
    # allow_nan=False: NaN would serialize as invalid JSON and break the host's parser.
    if len(json.dumps(data, allow_nan=False)) > _HOST_REQUEST_CAP:
        raise ValueError(f"host_request payload exceeds {_HOST_REQUEST_CAP} characters")
    rid = uuid.uuid4().hex
    future: asyncio.Future[dict[str, Any]] = _loop.create_future()
    _pending_host[rid] = future
    try:
        _send({"event": "host_request", "id": rid, "cell": _current_cell.get(), "data": data})
        return await future
    finally:
        _pending_host.pop(rid, None)


def _fail_pending_host_requests() -> None:
    """No reply can arrive after EOF or shutdown; unblock every waiting cell."""
    global _host_closed
    _host_closed = True
    for future in _pending_host.values():
        if not future.done():
            future.set_exception(RuntimeError("host connection closed; host_request cannot be answered"))


def _resolve_host_reply(rid: str, data: dict[str, Any]) -> None:
    """Reader-thread half of the host bridge; replies to unknown ids are dropped."""
    assert _loop is not None

    def deliver() -> None:
        future = _pending_host.get(rid)
        if future is not None and not future.done():
            future.set_result(data)

    _loop.call_soon_threadsafe(deliver)


# --- output capture ----------------------------------------------------------


class _Pump:
    """Ships the bytes of one captured fd pipe as `id: null` stream events."""

    def __init__(self, read_fd: int, write_fd: int, stream: str) -> None:
        self._read_fd = read_fd
        # Private write end: a cell closing fd 1/2 cannot break drain tokens.
        self._token_fd = os.dup(write_fd)
        self._stream = stream
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._lock = threading.Lock()
        self._watch: tuple[bytes, threading.Event] | None = None
        self._buf = b""
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def drain(self) -> None:
        """Block until every byte written to the fd so far has been shipped."""
        token = b"\xff<drain:" + uuid.uuid4().hex.encode() + b">\xff"
        seen = threading.Event()
        with self._lock:
            self._watch = (token, seen)
        try:
            os.write(self._token_fd, token)
            while not seen.wait(0.1):
                if not self._thread.is_alive():
                    return
        except OSError:
            return
        finally:
            with self._lock:
                self._watch = None

    def _run(self) -> None:
        while True:
            try:
                chunk = os.read(self._read_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self._feed(chunk)

    def _feed(self, chunk: bytes) -> None:
        data = self._buf + chunk
        self._buf = b""
        with self._lock:
            watch = self._watch
        if watch is None:
            self._emit(data)
            return
        token, seen = watch
        while True:
            i = data.find(token)
            if i == -1:
                break
            self._emit(data[:i])
            self._finish_decode()
            seen.set()
            data = data[i + len(token) :]
        # Hold back a tail that may be the start of a token split across reads.
        hold = 0
        for k in range(min(len(data), len(token) - 1), 0, -1):
            if data.endswith(token[:k]):
                hold = k
                break
        if hold:
            self._buf = data[len(data) - hold :]
            data = data[: len(data) - hold]
        self._emit(data)

    def _emit(self, data: bytes) -> None:
        if data:
            text = self._decoder.decode(data)
            if text:
                _send({"event": self._stream, "id": None, "text": text})

    def _finish_decode(self) -> None:
        text = self._decoder.decode(b"", final=True)
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        if text:
            _send({"event": self._stream, "id": None, "text": text})


class _RawBuffer(io.RawIOBase):
    """`sys.stdout.buffer`: bytes go to the captured fd pipe (id null)."""

    def __init__(self, fd: int) -> None:
        self._fd = fd

    def write(self, data: Any) -> int:
        view = memoryview(data).cast("B")
        total = len(view)
        while view:
            view = view[os.write(self._fd, view) :]
        return total

    def fileno(self) -> int:
        return self._fd

    def writable(self) -> bool:
        return True


class _TaggedWriter(io.TextIOBase):
    """`sys.stdout`/`sys.stderr` replacement that tags writes with the writer's cell id."""

    def __init__(self, stream: str, fd: int) -> None:
        self._stream = stream
        self._fd = fd
        self._frame_lock = threading.Lock()
        self._buffer = _RawBuffer(fd)

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if text:
            cell_id = _current_cell.get()
            with self._frame_lock:
                record = _cell_output.get(cell_id) if cell_id is not None else None
                if record is not None:
                    record[self._stream].append(text)
                for start in range(0, len(text), _STREAM_FRAME_TEXT_CAP):
                    chunk = text[start : start + _STREAM_FRAME_TEXT_CAP]
                    _send({"event": self._stream, "id": cell_id, "text": chunk})
        return len(text)

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fd

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    @property
    def buffer(self) -> _RawBuffer:
        return self._buffer

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "replace"


_pump_out: _Pump
_pump_err: _Pump


def _drain_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError, AttributeError):
            pass
    _pump_out.drain()
    _pump_err.drain()


# --- interrupts --------------------------------------------------------------


def _consume_task_exception(task: asyncio.Task[Any]) -> None:
    if not task.cancelled():
        task.exception()


def _sigint_handler(signum: int, frame: types.FrameType | None) -> None:
    task = _active["task"]
    # No lock here (the main thread may hold it). The rid check drops a SIGINT
    # that arrives after its cell finished, so it never hits a later cell.
    if task is None or task.done() or _active["rid"] != _sigint_target:
        return
    _active["interrupted"] = True
    running = asyncio.current_task(_loop) if _loop is not None else None
    if running is task:
        # The cell's own step (sync code or a blocking syscall): raise into it.
        raise KeyboardInterrupt
    # The loop is idle in select() or another task is mid-step: cancel the cell.
    task.cancel()
    if running is not None and running is not _serve_task:
        # A background task blocked in sync code holds the only thread; unwind it.
        running.add_done_callback(_consume_task_exception)
        raise KeyboardInterrupt


def _request_interrupt(target: str | None) -> None:
    """Reader thread: deliver an interrupt to the running cell or park it for a queued one."""
    global _sigint_target
    with _interrupt_lock:
        rid = _active["rid"]
        if rid is not None and (target is None or target == rid):
            _sigint_target = rid
        elif target is not None:
            if target in _inflight:
                _pending_interrupts["ids"].add(target)
            return
        else:
            if _inflight:
                _pending_interrupts["any"] = True
            return
    # Cells run on the main thread, so SIGINT must land there.
    signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
    if _loop is not None:
        # Wake the selector so a cancel scheduled by the handler runs promptly.
        _loop.call_soon_threadsafe(lambda: None)


def _finish_request(rid: str) -> None:
    global _sigint_target
    with _interrupt_lock:
        if _sigint_target == rid:
            _sigint_target = None
        _inflight.discard(rid)
        _pending_interrupts["ids"].discard(rid)
        if not _inflight:
            _pending_interrupts["any"] = False


# --- execution ---------------------------------------------------------------


def _safe_str(exc: BaseException) -> str:
    try:
        return str(exc)
    except BaseException:  # noqa: BLE001 - a broken __str__ must not kill the kernel
        return "<exception str() failed>"


def _cap_text(text: str) -> str:
    if len(text) > _RESULT_TEXT_CAP:
        return text[:_RESULT_TEXT_CAP] + f"\n[... truncated at {_RESULT_TEXT_CAP} characters ...]"
    return text


def _cell_stack(stack: traceback.StackSummary) -> traceback.StackSummary | None:
    """Frames from the first cell frame on, without the kernel's own frames."""
    start = next((i for i, f in enumerate(stack) if f.filename.startswith("<cell-")), None)
    if start is None:
        return None
    frames = [f for f in stack[start:] if os.path.abspath(f.filename) not in _RUNTIME_FILES]
    return traceback.StackSummary.from_list(frames)


def _error_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    te = traceback.TracebackException.from_exception(exc)
    stack = _cell_stack(te.stack)
    if stack is None:
        # No cell frame (a SyntaxError): exception-only keeps the source line and caret.
        lines = traceback.format_exception_only(type(exc), exc)
    else:
        te.stack = stack
        lines = list(te.format())
    return {
        "event": "error",
        "id": cell_id,
        "ename": type(exc).__name__,
        "evalue": _cap_text(_safe_str(exc)),
        "traceback": [_cap_text(line) for line in lines],
    }


def _interrupt_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    """Report a cell cancelled at an await as a KeyboardInterrupt."""
    stack = _cell_stack(traceback.extract_tb(exc.__traceback__))
    lines = []
    if stack:
        lines = ["Traceback (most recent call last):\n", *stack.format()]
    lines.append("KeyboardInterrupt\n")
    return {"event": "error", "id": cell_id, "ename": "KeyboardInterrupt", "evalue": "", "traceback": lines}


def _compile_cell(code: str, filename: str) -> tuple[list[types.CodeType], bool]:
    """Compile a cell; a trailing expression compiles separately in eval mode."""
    linecache.cache[filename] = (len(code), None, code.splitlines(keepends=True), filename)
    tree = ast.parse(code, filename)
    trailing: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        trailing = ast.Expression(tree.body.pop().value)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    codes: list[types.CodeType] = []
    if tree.body:
        codes.append(compile(tree, filename, "exec", flags=flags, dont_inherit=True))
    if trailing is not None:
        codes.append(compile(trailing, filename, "eval", flags=flags, dont_inherit=True))
    return codes, trailing is not None


async def _run_codes(codes: list[types.CodeType], ns: dict[str, Any]) -> Any:
    value: Any = None
    for code_obj in codes:
        value = eval(code_obj, ns)  # noqa: S307 - running the model's cell is the kernel's job
        if code_obj.co_flags & inspect.CO_COROUTINE:
            value = await value
    return value


async def _run_guarded(task: asyncio.Task[Any], rid: str) -> tuple[str, Any, dict[str, Any] | None]:
    """Await a cell task; returns (status, value, error event or None)."""
    with _interrupt_lock:
        _active.update(task=task, rid=rid, interrupted=False)
        if _pending_interrupts["any"] or rid in _pending_interrupts["ids"]:
            _pending_interrupts["any"] = False
            _pending_interrupts["ids"].discard(rid)
            # Interrupt parked before the cell started: cancel before its first step.
            _active["interrupted"] = True
            task.cancel()
    try:
        return "ok", await task, None
    except asyncio.CancelledError as exc:
        if _active["interrupted"]:
            return "error", None, _interrupt_event(rid, exc)
        return "error", None, _error_event(rid, exc)
    except BaseException as exc:  # noqa: BLE001 - every cell failure becomes an error event
        return "error", None, _error_event(rid, exc)
    finally:
        with _interrupt_lock:
            _active.update(task=None, rid=None)


async def _handle_execute(req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _cell_counter
    rid: str = req["id"]
    code: str = req["code"]
    _cell_counter += 1
    filename = f"<cell-{_cell_counter}>"
    output: dict[str, list[str]] = {"stdout": [], "stderr": []}
    _cell_output[rid] = output
    token = _current_cell.set(rid)
    status, result_text, error = "ok", None, None
    try:
        try:
            codes, has_trailing = _compile_cell(code, filename)
        except BaseException as exc:  # noqa: BLE001 - SyntaxError, RecursionError, ...
            status, error = "error", _error_event(rid, exc)
        else:
            assert _loop is not None
            status, value, error = await _run_guarded(_loop.create_task(_run_codes(codes, ns)), rid)
            if status == "ok" and has_trailing and value is not None:
                try:
                    ns["_"] = value
                    result_text = _cap_text(repr(value))
                except BaseException as exc:  # noqa: BLE001 - a broken __repr__ is a cell error
                    status, error = "error", _error_event(rid, exc)
        _drain_output()
    finally:
        _current_cell.reset(token)
        _cell_output.pop(rid, None)
        _finish_request(rid)
    if result_text is not None:
        _send({"event": "result", "id": rid, "text": result_text})
    if error is not None:
        _send(error)
    raga_rlm.record_cell(
        {
            "id": rid,
            "code": code,
            "stdout": "".join(output["stdout"]),
            "stderr": "".join(output["stderr"]),
            "result": result_text,
            "error": "".join(error["traceback"]) if error else None,
        }
    )
    _send({"event": "done", "id": rid, "status": status})


# --- snapshot and restore ----------------------------------------------------


class _TooLarge(Exception):
    pass


class _CappedWriter:
    def __init__(self, sink: io.BytesIO, limit: int) -> None:
        self._sink = sink
        self._limit = limit
        self._written = 0

    def write(self, chunk: Any) -> int:
        size = len(chunk)
        if self._written + size > self._limit:
            raise _TooLarge()
        self._sink.write(chunk)
        self._written += size
        return size


def _user_names(ns: dict[str, Any]) -> list[str]:
    return sorted(
        name
        for name, value in ns.items()
        if isinstance(name, str)
        and not name.startswith("_")
        and name not in raga_rlm.BOOTSTRAP_NAMES
        and not isinstance(value, types.ModuleType)
    )


def _snapshot(ns: dict[str, Any], path: str, max_bytes: int, max_variable_bytes: int) -> dict[str, Any]:
    try:
        import dill
    except ImportError:
        return {"status": "error", "reason": "dill not installed"}
    # Format: magic, then per name a 4-byte name length, the UTF-8 name, an
    # 8-byte blob length, and the dill blob. One blob per name lets restore
    # load each name on its own.
    saved: list[str] = []
    skipped: list[str] = []
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            total = fh.write(_SNAPSHOT_MAGIC)
            for name in _user_names(ns):
                try:
                    encoded = name.encode("utf-8")
                    buffer = io.BytesIO()
                    dill.dump(ns[name], _CappedWriter(buffer, max_variable_bytes))
                except Exception:  # noqa: BLE001 - _TooLarge or unpicklable: skip this name only
                    skipped.append(name)
                    continue
                blob = buffer.getvalue()
                size = 12 + len(encoded) + len(blob)
                if total + size > max_bytes:
                    skipped.append(name)
                    continue
                fh.write(len(encoded).to_bytes(4, "little"))
                fh.write(encoded)
                fh.write(len(blob).to_bytes(8, "little"))
                fh.write(blob)
                total += size
                saved.append(name)
        os.replace(tmp, path)
    except OSError as err:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return {"status": "error", "reason": f"snapshot write failed: {err}"}
    return {"status": "ok", "saved": saved, "skipped": skipped, "bytes": total}


def _read_records(path: str) -> dict[str, bytes]:
    with open(path, "rb") as fh:
        data = fh.read()
    if not data.startswith(_SNAPSHOT_MAGIC):
        raise ValueError("not a raga RLM snapshot")
    records: dict[str, bytes] = {}
    pos = len(_SNAPSHOT_MAGIC)
    while pos < len(data):
        if pos + 4 > len(data):
            raise ValueError("truncated snapshot record")
        name_len = int.from_bytes(data[pos : pos + 4], "little")
        pos += 4
        if pos + name_len + 8 > len(data):
            raise ValueError("truncated snapshot record")
        name = data[pos : pos + name_len].decode("utf-8")
        pos += name_len
        blob_len = int.from_bytes(data[pos : pos + 8], "little")
        pos += 8
        if pos + blob_len > len(data):
            raise ValueError("truncated snapshot record")
        records[name] = data[pos : pos + blob_len]
        pos += blob_len
    return records


def _snapshot_unpickler(dill: Any) -> type:
    """dill pickles a pipe-backed file as its fd number; reopening that number
    here would later close whatever owns the fd now (e.g. the loop's self-pipe)."""
    create_filehandle = dill._dill._create_filehandle

    def refuse_raw_fd(name: Any, *args: Any) -> Any:
        if isinstance(name, int):
            raise pickle.UnpicklingError(f"refusing to reopen raw file descriptor {name} from a snapshot")
        return create_filehandle(name, *args)

    class GuardedUnpickler(dill.Unpickler):
        def find_class(self, module: str, name: str) -> Any:
            target = super().find_class(module, name)
            return refuse_raw_fd if target is create_filehandle else target

    return GuardedUnpickler


def _restore(ns: dict[str, Any], path: str) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"status": "ok", "restored": [], "failed": [], "reason": "snapshot not found"}
    try:
        import dill
    except ImportError:
        return {"status": "error", "reason": "dill not installed"}
    try:
        records = _read_records(path)
    except (OSError, ValueError) as err:
        return {"status": "error", "reason": f"snapshot load failed: {err}"}
    unpickler = _snapshot_unpickler(dill)
    restored: list[str] = []
    failed: list[str] = []
    for name, blob in records.items():
        if name.startswith("_") or name in raga_rlm.BOOTSTRAP_NAMES:
            continue
        try:
            ns[name] = unpickler(io.BytesIO(blob)).load()
        except Exception:  # noqa: BLE001 - one broken name must not abort the restore
            failed.append(name)
            continue
        restored.append(name)
    return {"status": "ok", "restored": sorted(restored), "failed": sorted(failed)}


def _int_field(req: dict[str, Any], field: str, default: int) -> int:
    value = req.get(field, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


# --- serving -----------------------------------------------------------------


async def _serve(queue: asyncio.Queue[dict[str, Any]], ns: dict[str, Any]) -> None:
    while True:
        req = await queue.get()
        # A cell may have rebound SIGINT; the kernel must own it for every request.
        signal.signal(signal.SIGINT, _sigint_handler)
        rtype = req["type"]
        rid = req.get("id")
        if rtype == "shutdown":
            if isinstance(rid, str):
                _send({"event": "done", "id": rid, "status": "ok"})
            return
        try:
            if rtype == "execute":
                await _handle_execute(req, ns)
                continue
            if rtype == "snapshot":
                reply = _snapshot(
                    ns,
                    req["path"],
                    _int_field(req, "max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES),
                    _int_field(req, "max_variable_bytes", DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
                )
            elif rtype == "restore":
                reply = _restore(ns, req["path"])
            elif rtype == "set_context":
                raga_rlm.set_context(req["task"], req.get("inputs", {}))
                reply = {"status": "ok"}
            else:
                reply = {"status": "ok", "names": _user_names(ns)}
            _send({"event": "done", "id": rid, **reply})
        except BaseException as exc:  # noqa: BLE001 - one broken request fails alone
            _send({"event": "done", "id": rid, "status": "error", "reason": f"{type(exc).__name__}: {_safe_str(exc)}"})


_REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "execute": ("id", "code"),
    "snapshot": ("id", "path"),
    "restore": ("id", "path"),
    "list_names": ("id",),
    "set_context": ("id", "task"),
    "shutdown": (),
}


def _handle_line(raw: bytes, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    req = json.loads(raw)
    if not isinstance(req, dict):
        raise ValueError("request is not a JSON object")
    rtype = req.get("type")
    if rtype == "interrupt":
        target = req.get("id")
        if target is not None and not isinstance(target, str):
            _protocol_error("interrupt id must be a string")
            return
        _request_interrupt(target)
        return
    if rtype == "host_reply":
        # Bypasses the queue: the waiting cell is the running execute.
        rid, data = req.get("id"), req.get("data")
        if isinstance(rid, str) and isinstance(data, dict):
            _resolve_host_reply(rid, data)
        else:
            _protocol_error("host_reply needs a string id and a dict data")
        return
    if not isinstance(rtype, str) or rtype not in _REQUIRED_FIELDS:
        _protocol_error(f"unknown request type: {rtype!r}")
        return
    missing = [field for field in _REQUIRED_FIELDS[rtype] if not isinstance(req.get(field), str)]
    if missing:
        _protocol_error(f"{rtype} request needs string fields: {', '.join(missing)}")
        return
    if rtype == "shutdown" and "id" in req and not isinstance(req["id"], str):
        _protocol_error("shutdown id must be a string")
        return
    if rtype == "execute":
        with _interrupt_lock:
            duplicate = req["id"] in _inflight
            if not duplicate:
                _inflight.add(req["id"])
        if duplicate:
            _protocol_error(f"duplicate in-flight execute id: {req['id']!r}")
            return
    if rtype == "shutdown":
        # A cell waiting on a host reply would block the queued shutdown forever.
        _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, req)


def _read_requests(stdin_fd: int, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    with os.fdopen(stdin_fd, "rb") as stream:
        for raw in stream:
            raw = raw.strip()
            if not raw:
                continue
            try:
                _handle_line(raw, queue)
            except BaseException as err:  # noqa: BLE001 - hostile input must not kill the reader
                _protocol_error(f"{type(err).__name__}: {_safe_str(err)}")
    # stdin closed: same as shutdown.
    _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, {"type": "shutdown"})
    threading.Timer(_EOF_EXIT_GRACE_SECONDS, os._exit, args=(0,)).start()


def _setup_fds() -> int:
    """Reserve the original fd 1 for protocol frames; route fds 1 and 2 through pumped pipes."""
    global _protocol_fd, _host_stderr_fd, _pump_out, _pump_err
    _protocol_fd = os.dup(1)
    os.set_inheritable(_protocol_fd, False)
    _host_stderr_fd = os.dup(2)
    os.set_inheritable(_host_stderr_fd, False)
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    os.dup2(out_w, 1)
    os.dup2(err_w, 2)
    os.close(out_w)
    os.close(err_w)
    sys.stdout = _TaggedWriter("stdout", os.dup(1))
    sys.stderr = _TaggedWriter("stderr", os.dup(2))
    stdin_fd = os.dup(0)
    os.set_inheritable(stdin_fd, False)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(os.devnull)  # noqa: SIM115 - input() sees EOF, never protocol frames
    _pump_out = _Pump(out_r, 1, "stdout")
    _pump_err = _Pump(err_r, 2, "stderr")
    return stdin_fd


def main() -> None:
    global _loop, _serve_task
    stdin_fd = _setup_fds()

    # `python -m` runs this file as `__main__`; alias it so `raga_rlm.repl` is this module.
    sys.modules["raga_rlm.repl"] = sys.modules[__name__]
    # A real `__main__` module makes dill pickle cell functions and classes by value.
    user_module = types.ModuleType("__main__")
    user_module.__dict__["__builtins__"] = __builtins__
    sys.modules["__main__"] = user_module
    ns = user_module.__dict__
    raga_rlm.bootstrap(ns)

    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    signal.signal(signal.SIGINT, _sigint_handler)
    threading.Thread(target=_read_requests, args=(stdin_fd, queue), daemon=True).start()

    _send({"event": "ready", "protocol": PROTOCOL_VERSION, "python": platform.python_version()})

    _serve_task = _loop.create_task(_serve(queue, ns))
    # A KeyboardInterrupt raised into a cell or background task escapes
    # run_until_complete; the cell already recorded it, so keep serving.
    while not _serve_task.done():
        try:
            _loop.run_until_complete(_serve_task)
        except KeyboardInterrupt:
            continue
    _drain_output()
    # Hard exit: pending background tasks and user threads must not hold the process.
    os._exit(0)


if __name__ == "__main__":
    main()
