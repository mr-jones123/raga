from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

PYTHON_DIR = Path(__file__).resolve().parent.parent

HostHandler = Callable[[dict[str, Any]], dict[str, Any]]


class KernelProcess:
    """Drives a real `python -m raga_rlm.repl` subprocess over stdin/stdout."""

    def __init__(self, cwd: Path, extra_path: Path | None = None, env: dict[str, str] | None = None) -> None:
        pythonpath = os.pathsep.join(str(p) for p in (extra_path, PYTHON_DIR) if p is not None)
        env = {**os.environ, **(env or {}), "PYTHONPATH": pythonpath, "PYTHONUNBUFFERED": "1"}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "raga_rlm.repl"],
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.events: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._counter = 0
        threading.Thread(target=self._read, daemon=True).start()
        self.ready = self.next_event()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.events.put(json.loads(line))
        self.events.put(None)

    def send(self, request: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(request) + "\n").encode())
        self.proc.stdin.flush()

    def send_raw(self, line: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(line)
        self.proc.stdin.flush()

    def next_event(self, timeout: float = 10.0) -> dict[str, Any]:
        event = self.events.get(timeout=timeout)
        if event is None:
            raise EOFError("kernel closed stdout")
        return event

    def new_id(self) -> str:
        self._counter += 1
        return f"r{self._counter}"

    def collect(self, rid: str, host: HostHandler | None = None, timeout: float = 10.0) -> list[dict[str, Any]]:
        """Events up to and including the `done` for `rid`, answering host requests."""
        events: list[dict[str, Any]] = []
        while True:
            event = self.next_event(timeout)
            events.append(event)
            if event["event"] == "host_request":
                assert host is not None, f"unexpected host_request: {event}"
                self.send({"type": "host_reply", "id": event["id"], "data": host(event)})
            if event["event"] == "done" and event["id"] == rid:
                return events

    def execute(
        self, code: str, host: HostHandler | None = None, timeout: float = 10.0
    ) -> tuple[str, list[dict[str, Any]]]:
        rid = self.new_id()
        self.send({"type": "execute", "id": rid, "code": code})
        return rid, self.collect(rid, host, timeout)

    def request(self, request: dict[str, Any]) -> dict[str, Any]:
        rid = self.new_id()
        self.send({**request, "id": rid})
        return self.collect(rid)[-1]

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=10)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if stream is not None:
                stream.close()


def text_of(events: list[dict[str, Any]], kind: str, rid: str | None) -> str:
    return "".join(e["text"] for e in events if e["event"] == kind and e["id"] == rid)


def only(events: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    matches = [e for e in events if e["event"] == kind]
    assert len(matches) == 1, events
    return matches[0]


@pytest.fixture
def kernel(tmp_path: Path) -> Iterator[KernelProcess]:
    proc = KernelProcess(tmp_path)
    yield proc
    proc.close()


@pytest.fixture
def spawn(tmp_path: Path) -> Iterator[Callable[..., KernelProcess]]:
    procs: list[KernelProcess] = []

    def make(extra_path: Path | None = None, env: dict[str, str] | None = None) -> KernelProcess:
        proc = KernelProcess(tmp_path, extra_path, env)
        procs.append(proc)
        return proc

    yield make
    for proc in procs:
        proc.close()
