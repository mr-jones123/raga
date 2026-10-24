# RLM runtime

This document is the reference for raga's Recursive Language Model runtime. [ARCHITECTURE.md](ARCHITECTURE.md) explains why the runtime exists and where it sits. [PROGRESS.md](PROGRESS.md) tracks which parts are built.

In RLM mode the model has one tool, `python`. Each `AgentSession` owns one Python kernel process. The kernel keeps one namespace for the whole session. Code in the kernel calls back into the TypeScript host to run pi's tools, call sub-LLMs, and start child sessions.

## Files

| Path | Owner |
|---|---|
| `packages/coding-agent/python/raga_rlm/repl.py` | The kernel process. Runs `python -m raga_rlm.repl`. |
| `packages/coding-agent/python/raga_rlm/__init__.py` | The functions the model calls: `bash`, `read`, `edit`, `write`, `llm_query`, `llm_batch`, `rlm_query`, and `context`. |
| `packages/coding-agent/python/tests/` | pytest tests for the kernel and the API. |
| `packages/coding-agent/src/core/rlm/protocol.ts` | Wire types for requests and events. Parses every event line. |
| `packages/coding-agent/src/core/rlm/python-env.ts` | Finds or creates the Python interpreter. |
| `packages/coding-agent/src/core/rlm/kernel.ts` | `Kernel`. Starts, runs cells, answers host requests, interrupts, restarts, snapshots, and stops one kernel process. |
| `packages/coding-agent/src/core/rlm/runtime.ts` | `RlmRuntime`. The RLM mode of one `AgentSession`: owns the `Kernel`, answers host requests, sums sub-LLM usage per cell, and defines the `python` tool and its output formatting. |
| `packages/coding-agent/src/core/rlm/prompt.ts` | The `rlm` system prompt section. |
| `packages/coding-agent/src/core/tools/renderers/python.ts` | The TUI renderer of the `python` tool. |
| `packages/coding-agent/src/core/rlm/children.ts` | Child sessions for `rlm_query`. |

`packages/coding-agent/python/` ships in the npm package and next to the standalone binary. `getPackageDir()` in `src/config.ts` locates it.

## Wire protocol

The kernel speaks protocol version `1`. The format is newline-delimited JSON over stdin and stdout, one UTF-8 object per line. The design is a subset of Prime Agent's REPL protocol (`prime-agent-runtime/src/rlm/repl.md`, MIT license).

### Channels

- The host writes requests to the kernel's stdin.
- The kernel writes events to a private duplicate of its original fd 1, made before user code runs. One lock guards each frame, so frames never interleave.
- Python-level writes to `sys.stdout` and `sys.stderr` become `stdout` and `stderr` events tagged with the id of the cell that wrote them. An asyncio task inherits the id of the cell that created it.
- fds 1 and 2 are redirected into pipes. Pump threads ship raw fd bytes (subprocesses, C extensions, `os.write`) as `stdout` and `stderr` events with `id: null`.
- fd 0 is rebound to `/dev/null` after the reader thread takes it, so `input()` sees end of file.

### Requests

| Request | Fields | Reply |
|---|---|---|
| `execute` | `{"type":"execute","id":str,"code":str}` | Events for the cell, then `done` |
| `interrupt` | `{"type":"interrupt","id"?:str}` | None |
| `host_reply` | `{"type":"host_reply","id":str,"data":{"status":"ok","result":any}}` or `{"status":"error","error":str}` | None |
| `snapshot` | `{"type":"snapshot","id":str,"path":str,"max_bytes"?:int,"max_variable_bytes"?:int}` | `done` with `saved`, `skipped`, `bytes` |
| `restore` | `{"type":"restore","id":str,"path":str}` | `done` with `restored`, `failed` |
| `list_names` | `{"type":"list_names","id":str}` | `done` with `names` |
| `set_context` | `{"type":"set_context","id":str,"task":str,"inputs":{name:path}}` | `done`. Fails with `status: "error"` when `inputs` does not map strings to strings. |
| `shutdown` | `{"type":"shutdown","id"?:str}` | `done` when an id is present, then exit 0 |

The kernel runs `execute`, `snapshot`, `restore`, `list_names`, `set_context`, and `shutdown` in order, one at a time. It handles `interrupt` and `host_reply` on the reader thread as they arrive, so they reach a cell that is still running. A malformed line produces an `error` event with `id: null` and `ename: "ProtocolError"`. Closing stdin has the same effect as `shutdown`. If a synchronous cell blocks the shutdown, the kernel exits with code 0 after 10 seconds.

### Events

| Event | Fields |
|---|---|
| `ready` | `{"event":"ready","protocol":1,"python":str}`. Sent once, first. |
| `stdout`, `stderr` | `{"event":..., "id":str\|null, "text":str}`. At most 64 Ki characters per frame. |
| `result` | `{"event":"result","id":str,"text":str}`. The `repr` of a trailing expression that is not `None`. The value is also bound to `_`. |
| `host_request` | `{"event":"host_request","id":str,"cell":str\|null,"data":{"type":str,...}}`. The host answers with `host_reply` and the same `id`. `cell` is the id of the cell whose task made the request. |
| `error` | `{"event":"error","id":str\|null,"ename":str,"evalue":str,"traceback":[str]}` |
| `done` | `{"event":"done","id":str,"status":"ok"\|"error",...}`. Exactly one per request with an id, after every other event of that request. |

Before a cell's `done`, the kernel drains both output channels, so every byte that the cell wrote synchronously comes before `done`.

### Execution

The kernel compiles each cell with `PyCF_ALLOW_TOP_LEVEL_AWAIT` and runs it as a task on one persistent asyncio loop. Background tasks that a cell creates keep running after the cell ends. The kernel registers each cell's source in `linecache` as `<cell-N>`, so tracebacks show the failing line. Tracebacks leave out the kernel's own frames.

### Interrupt

An interrupt raises `KeyboardInterrupt` in the running cell. If the cell is in synchronous code, the kernel raises it directly. If the cell is waiting at an `await`, the kernel cancels the cell task and reports a `KeyboardInterrupt`. An interrupt that arrives before its cell starts waits for the cell. Both paths end with an `error` event and `done` with `status: "error"`, and the kernel keeps serving. `snapshot`, `restore`, `list_names`, and `set_context` cannot be interrupted, and the kernel drops an interrupt aimed at one of them. The host sends `interrupt` only with the id of the running cell. The kernel ignores a `host_reply` whose id it no longer tracks, such as the reply to a request from an interrupted cell.

### Snapshot and restore

`snapshot` saves the user namespace with `dill`, one name at a time. It skips names that start with `_`, the names that the bootstrap binds, modules, and any name whose pickle exceeds `max_variable_bytes` (default 16 MiB) or would push the total over `max_bytes` (default 256 MiB). It writes the file atomically. `restore` loads each name on its own and lists the names that failed. A missing file restores nothing and reports `status: "ok"` with `reason: "snapshot not found"`. If `dill` is not installed, both requests fail with `reason: "dill not installed"`.

## Host requests

Every `host_request` has `data.type`. The host replies with `{"status":"ok","result":...}` or `{"status":"error","error":"..."}`. A Python call raises `HostError` when the reply is an error.

| `data.type` | Payload | Result | Milestone |
|---|---|---|---|
| `tool.call` | `{"name":"bash"\|"read"\|"edit"\|"write","args":{...}}` | `{"text":str,"is_error":bool}` | M3 |
| `llm.query` | `{"prompt":str,"system"?:str,"model"?:str}` | `{"text":str}` | M4 |
| `llm.batch` | `{"prompts":[str],"system"?:str,"model"?:str}` | `{"texts":[str]}` | M4 |
| `context.history` | `{"offset"?:int,"limit"?:int}` | `{"messages":[{"role":str,"text":str}],"total":int}` | M5 |
| `rlm.query` | `{"task":str,"context"?:any,"model"?:str,"max_turns"?:int}` | `{"answer":str,"ready":bool,"session_file":str\|null}` | M6 |

`args` for `tool.call` match the parameter schemas of pi's built-in tools in `src/core/tools/`. `bash` takes `{command, timeout?}`. `read` takes `{path, offset?, limit?}`. `edit` takes `{path, edits: [{oldText, newText}]}`. `write` takes `{path, content}`. Any other `name` is an error. The host runs the tool through `runToolCall` with the session's `beforeToolCall` and `afterToolCall` hooks, so extensions see a `tool_call` and `tool_result` event whose `parentToolCallId` is the `python` call. `text` is the tool result's text content joined with newlines.

`model` is `"provider/id"`. Without it, `llm.*` uses the `rlm.subModel` setting, then the session model. Each call is `ModelRuntime.completeSimple` with the prompt as the only user message, `system` as the system prompt, no tools, a fresh session id, and the session's `before_provider_request` and `after_provider_response` hooks, so extensions that rewrite requests for their providers apply. A call that ends with `stopReason` `error` or `aborted` fails with its error message, so Python raises `HostError`. `llm.batch` runs at most 8 calls at once, and its first failure aborts the calls still running.

Usage from `llm.*` and `rlm.query` during a cell adds up on the `python` tool result's `usage`, so session totals include it.

`context.history` reads the session branch, including messages that a compaction removed from the model's context. It leaves out system messages. `total` counts the messages before `offset` and `limit` apply. Assistant tool calls appear as `[tool call <name>] <arguments JSON>` lines.

## Python API

The bootstrap binds these names in the kernel namespace. Every function is a coroutine, so the model calls it with `await`.

| Name | Signature | Behavior |
|---|---|---|
| `bash` | `await bash(command, timeout=None) -> str` | Runs pi's `bash` tool. Raises `ToolError` with the output when the tool reports an error. |
| `read` | `await read(path, offset=None, limit=None) -> str` | Runs pi's `read` tool. |
| `edit` | `await edit(path, edits) -> str` | `edits` is a list of `(old, new)` tuples or `{"oldText","newText"}` dicts. |
| `write` | `await write(path, content) -> str` | Runs pi's `write` tool. |
| `llm_query` | `await llm_query(prompt, system=None, model=None) -> str` | One sub-LLM call with no tools. |
| `llm_batch` | `await llm_batch(prompts, system=None, model=None) -> list[str]` | Parallel sub-LLM calls. The host limits concurrency to 8. |
| `rlm_query` | `await rlm_query(task, context=None, model=None, max_turns=None) -> str` | Runs a child RLM session and returns its answer. |
| `context` | object | `context.task` is the first user prompt. `context.inputs` maps input names to file contents; each file is read the first time its key is read, then cached, and `context.inputs.path(name)` returns the path. `await context.history(offset=0, limit=None)` returns the session's messages as `{"role","text"}` dicts. |
| `answer` | `{"content": "", "ready": False}` | A child session returns `answer["content"]` when `answer["ready"]` is true. |
| `cells` | `list[dict]` | One entry per finished cell: `{"id","code","stdout","stderr","result","error"}`, with full output. `error` is the formatted traceback string, or `None`. |

## The python tool

The tool's parameters are `{"code": str}`. It runs as `executionMode: "sequential"`. Its result text is the cell's stdout, stderr, result `repr`, traceback, and background output, in that order. Each non-empty part starts with a label line (`[stdout]`, `[stderr]`, `[result]`, `[error]`, `[background]`), and empty parts are left out. A cell with no output returns `(no output)`. When the text exceeds the `rlm.outputLimit` setting (default 16,000 characters), the tool keeps the first three quarters and the last quarter of the limit and puts `[... N characters cut; full output in cells[-1] ...]` between them. `isError` is true when the cell ends with `status: "error"`.

Before the first cell on each kernel process, the host sends `set_context` with `context.task` and the input paths. `context.task` is the text of the first user message on the session branch.

The session starts the kernel when it is created. If the start fails, the first `python` call returns the reason as an error result, and the next call tries again. When the session is aborted, the tool sends `interrupt`, waits 1 second, then kills and restarts the kernel. The first result from a new kernel process starts with `[kernel restarted: the namespace is empty]`.

## Settings and flags

| Setting | Default | Meaning |
|---|---|---|
| `rlm.enabled` | `false` | RLM mode. The `--rlm` flag sets it for one run. `--rlm-input <path>` or `--rlm-input <name>=<path>` adds a file to `context.inputs`; the default name is the file name. |
| `rlm.subModel` | none | `"provider/id"` for `llm_query`, `llm_batch`, and `rlm_query`. |
| `rlm.outputLimit` | `16000` | Characters of cell output that the model sees per cell. |
| `rlm.maxDepth` | `2` | How many levels of `rlm_query` children may nest. |

In RLM mode the session's active tools are `python` plus `read`, `bash`, `edit`, and `write` as hidden declarations. Hidden tools stay callable from the host and do not reach the model. The `defaultTools` setting, `--tools`, `--no-tools`, and `--no-builtin-tools` do not apply; `--exclude-tools` still removes tools, and extension tools that activate on registration stay declared next to `python`. The system prompt gets an `rlm` section that describes the kernel and its names.

## Python interpreter

`python-env.ts` picks the interpreter in this order:

1. The `RAGA_PYTHON` environment variable.
2. `~/.pi/agent/rlm/venv/bin/python`, when it exists.
3. A new venv at that path, when `uv` is on `PATH`. The host runs `uv venv --python 3.11` and `uv pip install dill`.
4. `python3` on `PATH`. Snapshots fail with `dill not installed` if `dill` is missing.

The interpreter must be Python 3.11 or newer. The kernel starts with `PYTHONPATH` set to `packages/coding-agent/python`.
