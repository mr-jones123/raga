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
| `set_context` | `{"type":"set_context","id":str,"task":str,"inputs":{name:path},"data"?:any}` | `done`. Fails with `status: "error"` when `inputs` does not map strings to strings. |
| `get_answer` | `{"type":"get_answer","id":str}` | `done` with `answer: {"content":str,"ready":bool}` |
| `shutdown` | `{"type":"shutdown","id"?:str}` | `done` when an id is present, then exit 0 |

The kernel runs `execute`, `snapshot`, `restore`, `list_names`, `set_context`, `get_answer`, and `shutdown` in order, one at a time. It handles `interrupt` and `host_reply` on the reader thread as they arrive, so they reach a cell that is still running. A malformed line produces an `error` event with `id: null` and `ename: "ProtocolError"`. Closing stdin has the same effect as `shutdown`. If a synchronous cell blocks the shutdown, the kernel exits with code 0 after 10 seconds.

`get_answer` reads the name `answer` from the namespace, so it also sees an `answer` that a cell rebound. A string `content` is sent as is; other values are sent as JSON, or as `str()` when they are not JSON-serializable. `ready` is the truth value of `answer["ready"]`. When `answer` is not a dict, the reply is `{"content":"","ready":false}`.

### Events

| Event | Fields |
|---|---|
| `ready` | `{"event":"ready","protocol":1,"python":str}`. Sent once, first. |
| `stdout`, `stderr` | `{"event":..., "id":str\|null, "text":str}`. At most 64 Ki characters per frame. |
| `result` | `{"event":"result","id":str,"text":str}`. The `repr` of a trailing expression that is not `None`. The value is also bound to `_`. |
| `host_request` | `{"event":"host_request","id":str,"cell":str\|null,"data":{"type":str,...}}`. The host answers with `host_reply` and the same `id`. `cell` is the id of the cell whose task made the request. |
| `error` | `{"event":"error","id":str\|null,"ename":str,"evalue":str,"traceback":[str]}` |
| `done` | `{"event":"done","id":str,"status":"ok"\|"error",...}`. Exactly one per request with an id, after every other event of that request. The `done` of an `execute` has `rss_mb`, the kernel's memory in MiB: current RSS on Linux, peak RSS elsewhere. |

Before a cell's `done`, the kernel drains both output channels, so every byte that the cell wrote synchronously comes before `done`.

### Execution

The kernel compiles each cell with `PyCF_ALLOW_TOP_LEVEL_AWAIT` and runs it as a task on one persistent asyncio loop. Background tasks that a cell creates keep running after the cell ends. The kernel registers each cell's source in `linecache` as `<cell-N>`, so tracebacks show the failing line. Tracebacks leave out the kernel's own frames.

### Interrupt

An interrupt raises `KeyboardInterrupt` in the running cell. If the cell is in synchronous code, the kernel raises it directly. If the cell is waiting at an `await`, the kernel cancels the cell task and reports a `KeyboardInterrupt`. An interrupt that arrives before its cell starts waits for the cell. Both paths end with an `error` event and `done` with `status: "error"`, and the kernel keeps serving. `snapshot`, `restore`, `list_names`, `set_context`, and `get_answer` cannot be interrupted, and the kernel drops an interrupt aimed at one of them. The host sends `interrupt` only with the id of the running cell. The kernel ignores a `host_reply` whose id it no longer tracks, such as the reply to a request from an interrupted cell.

### Snapshot and restore

`snapshot` saves the user namespace with `dill`, one name at a time. It skips names that start with `_`, the names that the bootstrap binds, modules, and any name whose pickle exceeds `max_variable_bytes` (default 16 MiB) or would push the total over `max_bytes` (default 256 MiB). Before it pickles a name, it estimates the size without copying: `len()` of a `str`, `bytes`, or `bytearray`, and `nbytes` of a `memoryview` or of any object with an integer `nbytes` attribute, such as a numpy array. A name whose estimate exceeds `max_variable_bytes` is skipped without pickling, so such a value is never copied whole; a large buffer nested in a container is still pickled before the cap rejects it. It writes the file atomically. `restore` reads the record headers first and fails with `reason: "snapshot load failed: ..."` before it loads any name when the file is not a snapshot or is truncated. It then reads and loads one record at a time, so only one pickle is in memory at once, and lists the names that failed. A missing file restores nothing and reports `status: "ok"` with `reason: "snapshot not found"`. If `dill` is not installed, both requests fail with `reason: "dill not installed"`.

## Host requests

Every `host_request` has `data.type`. The host replies with `{"status":"ok","result":...}` or `{"status":"error","error":"..."}`. A Python call raises `HostError` when the reply is an error.

| `data.type` | Payload | Result | Milestone |
|---|---|---|---|
| `tool.call` | `{"name":"bash"\|"edit"\|"write","args":{...}}` | `{"text":str,"is_error":bool}` | M3 |
| `llm.query` | `{"prompt":str,"system"?:str,"model"?:str}` | `{"text":str}` | M4 |
| `llm.batch` | `{"prompts":[str],"system"?:str,"model"?:str}` | `{"texts":[str]}` | M4 |
| `context.history` | `{"offset"?:int,"limit"?:int}` | `{"messages":[{"role":str,"text":str}],"total":int}` | M5 |
| `rlm.query` | `{"task":str,"context"?:any,"model"?:str,"max_turns"?:int}` | `{"answer":str,"ready":bool,"session_file":str\|null}` | M6 |

`args` for `tool.call` match the parameter schemas of pi's built-in tools in `src/core/tools/`. `bash` takes `{command, timeout?}`. `edit` takes `{path, edits: [{oldText, newText}]}`. `write` takes `{path, content}`. Any other `name` is an error. The host runs the tool through `runToolCall` with the session's `beforeToolCall` and `afterToolCall` hooks, so extensions see a `tool_call` and `tool_result` event whose `parentToolCallId` is the `python` call. `text` is the tool result's text content joined with newlines.

`model` is `"provider/id"`. Without it, `llm.*` uses the `rlm.subModel` setting, then the session model. Each call is `ModelRuntime.completeSimple` with the prompt as the only user message, `system` as the system prompt, no tools, a fresh session id, and the session's `before_provider_request` and `after_provider_response` hooks, so extensions that rewrite requests for their providers apply. A call that ends with `stopReason` `error` or `aborted` fails with its error message, so Python raises `HostError`. `llm.batch` runs at most 8 calls at once, and its first failure aborts the calls still running.

Usage from `llm.*` and `rlm.query` during a cell adds up on the `python` tool result's `usage`, so session totals include it.

`context.history` reads the session branch, including messages that a compaction removed from the model's context. It leaves out system messages. `total` counts the messages before `offset` and `limit` apply. Assistant tool calls appear as `[tool call <name>] <arguments JSON>` lines.

### Child sessions (`rlm.query`)

`src/core/rlm/children.ts` answers `rlm.query`. It runs `task` in a child `AgentSession` in the same process and returns the child's answer.

1. Depth. A root session has depth 0, and a child has its parent's depth + 1 (`AgentSessionConfig.rlmDepth`). When the child's depth would exceed `rlm.maxDepth`, the request fails with `RLM recursion depth limit reached (depth D, max M)`, where D is the child's depth, and no session is created. The `rlm` prompt section of a child starts with "You are a sub-agent at depth D. Put your final answer in answer['content'] and set answer['ready'] = True." A session at the maximum depth is not told about `rlm_query`.
2. Session. The child comes from `createAgentSession` with RLM mode on and shares the parent's `ModelRuntime`, `SettingsManager`, and resource loader. Its model is the payload's `model`, then `rlm.subModel`, then the parent's model; its thinking level is the parent's. When the parent is persisted, the child is `SessionManager.create(cwd, parentSessionDir, { parentSession: parentSessionFile })`, so its header names the parent's file. Otherwise it is in memory.
3. Context. The child's first user message is `task`, so its `context.task` is `task`. Its `context.data` is the payload's `context`.
4. Answer. After the child's `prompt()` settles, the host sends `get_answer` to the child's kernel. When `answer["ready"]` is true, the result is `answer["content"]` with `ready: true`. Otherwise it is the child's last assistant text with `ready: false`. A child whose last response ended with `stopReason: "error"` and no ready answer fails the request with that error. `session_file` is the child's session file, or `null` for an in-memory child.
5. Budget and abort. The child is aborted after `max_turns` `turn_end` events (default 30). The abort signal of the parent's cell aborts the child, so aborting the parent session interrupts the child's running cell. The child is disposed after it answers.
6. Usage. The usage of the child's assistant messages and tool results is combined with `combineUsage` and added to the parent cell's usage, so it lands on the parent's `python` tool result and in the parent's session stats.
7. Concurrency. The kernel serves host requests concurrently, so `await asyncio.gather(rlm_query(a), rlm_query(b))` runs both children at once. A session runs at most 4 children at a time, and the whole RLM tree runs at most 8 child sessions at a time; a child waits in a queue while either limit is full. The root session creates the tree's counter (`RlmChildSlots`) and every child passes it to its own children. A child at depth D also waits while starting it would leave fewer than `rlm.maxDepth` − D slots free, so parents that wait on their own children cannot fill the tree and wait forever; the deepest waiting parent's child can always start. With the default `rlm.maxDepth` of 2, 4 children at depth 1 leave at least 4 slots for depth 2.

## Python API

The bootstrap binds these names in the kernel namespace. Every function is a coroutine, so the model calls it with `await`.

| Name | Signature | Behavior |
|---|---|---|
| `bash` | `await bash(command, timeout=None) -> str` | Runs pi's `bash` tool. Raises `ToolError` with the output when the tool reports an error. |
| `read` | `await read(path, offset=None, limit=None) -> str` | Reads the file in the kernel, without pi's `read` tool, so nothing is truncated. A relative path resolves against the session cwd; the text is decoded as UTF-8 with undecodable bytes replaced. With no `offset` or `limit` it returns the whole file; `offset` is the 1-indexed first line and `limit` a line count. |
| `edit` | `await edit(path, edits) -> str` | `edits` is a list of `(old, new)` tuples or `{"oldText","newText"}` dicts. |
| `write` | `await write(path, content) -> str` | Runs pi's `write` tool. |
| `llm_query` | `await llm_query(prompt, system=None, model=None) -> str` | One sub-LLM call with no tools. |
| `llm_batch` | `await llm_batch(prompts, system=None, model=None) -> list[str]` | Parallel sub-LLM calls. The host limits concurrency to 8. |
| `rlm_query` | `await rlm_query(task, context=None, model=None, max_turns=None) -> str` | Runs a child RLM session on `task` and returns its answer (see "Child sessions"). `context` is any JSON value and becomes the child's `context.data`. Run several children at once with `await asyncio.gather(rlm_query(a), rlm_query(b))`. |
| `context` | object | `context.task` is the first user prompt. `context.inputs` maps input names to file contents; each file is read the first time its key is read, then cached, and `context.inputs.path(name)` returns the path. `context.data` is the `context` argument of the parent's `rlm_query`, or `None`. `await context.history(offset=0, limit=None)` returns the session's messages as `{"role","text"}` dicts. |
| `answer` | `{"content": "", "ready": False}` | A child session returns `answer["content"]` when `answer["ready"]` is true. |
| `cells` | `list[dict]` | One entry per finished cell: `{"id","code","stdout","stderr","result","error"}`. `error` is the formatted traceback string, or `None`. The newest entries keep their full `stdout` and `stderr` up to 32 Mi characters in total, and the newest entry always keeps its own. In older entries each non-empty `stdout` and `stderr` becomes `"[output dropped to bound memory: N characters]"`, where N is its length; `code`, `result`, and `error` stay. |

## The python tool

The tool's parameters are `{"code": str}`. It runs as `executionMode: "sequential"`. Its result text is the cell's stdout, stderr, result `repr`, traceback, and background output, in that order. Each non-empty part starts with a label line (`[stdout]`, `[stderr]`, `[result]`, `[error]`, `[background]`), and empty parts are left out. A cell with no output returns `(no output)`. When the text exceeds the `rlm.outputLimit` setting (default 16,000 characters), the tool keeps the first three quarters and the last quarter of the limit and puts `[... N characters cut; full output in cells[-1] ...]` between them. `isError` is true when the cell ends with `status: "error"`.

After the output come memory lines when `rlm.memoryLimitMb` is not 0. When the cell's `done` reports `rss_mb` of at least 75% of the limit, the result ends with `[kernel memory: X MiB of Y MiB limit; free large variables with del]`. When the cell fails with `MemoryError`, it ends with `[kernel memory limit Y MiB reached; free large variables with del, or process data in chunks]`.

Before the first cell on each kernel process, the host sends `set_context` with `context.task`, the input paths, and `context.data`. `context.task` is the text of the first user message on the session branch.

The session starts the kernel when it is created. If the start fails, the first `python` call returns the reason as an error result, and the next call tries again. When the session is aborted, the tool sends `interrupt`, waits 1 second, then kills and restarts the kernel. The first result from a new kernel process starts with `[kernel restarted: the namespace is empty]`.

## Memory

Each kernel is a separate process. An idle kernel uses about 21 MiB of RSS. A tree holds the root's kernel and at most 8 child kernels at once (see "Child sessions").

1. Limit. The host starts every kernel with the environment variable `RAGA_RLM_MEMORY_LIMIT_MB` set to the `rlm.memoryLimitMb` setting (default 2048). Before the bootstrap, the kernel sets the soft and hard `RLIMIT_DATA` to that many MiB, or to the existing hard limit when that is lower. `0` sets no limit.
2. Linux. `RLIMIT_DATA` covers the heap and private anonymous mappings, so an allocation past the limit raises `MemoryError` in the cell. The cell ends with `status: "error"`, the kernel keeps serving, and earlier variables stay in the namespace.
3. Other platforms. The kernel sets the limit only on Linux. macOS does not enforce `RLIMIT_DATA`, so there is no hard limit there; the memory lines in the `python` result still appear.
4. Subprocesses. A process started from Python code (`subprocess`, `os.system`) inherits the limit. `bash()` runs pi's `bash` tool in the host process, so its commands do not.
5. Visibility. The `done` of every `execute` carries `rss_mb`, and the `python` result warns from 75% of the limit (see "The python tool").
6. Growth that the kernel bounds itself: `cells` keeps full output for at most 32 Mi characters (see "Python API"), a snapshot skips a large buffer without pickling it, and `restore` holds one pickle in memory at a time (see "Snapshot and restore").

## Persistence

The kernel namespace survives a resume and a fork through a `dill` snapshot.

1. File. A persisted session snapshots to `<sessionDir>/<sessionId>.rlm/kernel.dill`, and an in-memory session to `<os.tmpdir()>/raga-rlm/<sessionId>/kernel.dill`.
2. Schedule. One second after a cell that ends `ok`, the host sends `snapshot`. A new cell restarts the wait, so a run of quick cells snapshots once. `AgentSession.flushRlmSnapshot()` writes a scheduled snapshot at once and waits for it. `AgentSessionRuntime` calls it before it disposes a session (new, resume, fork, import, quit), and before a fork or resume reads the session file. `AgentSession.dispose()` alone drops a scheduled snapshot, so a child session never writes one after it answers.
3. Entry. The first successful snapshot of a session file appends a custom entry `rlm-kernel-snapshot` with `{path}`.
4. Restore. Before the first cell, the host finds the newest `rlm-kernel-snapshot` entry on the current branch and, when its file exists, sends `restore`. The first `python` result then starts with `[kernel restored N variables: a, b, c]`, listing at most 20 names, followed by `; K failed: ...` when some names fail to load. A resumed session finds its own entry. A forked session finds its parent's entry, because a fork copies the branch, and restores the parent's file; its own snapshots go to its own path with its own entry, so it never writes the parent's file.
5. Failures. A failed snapshot (no `dill`, a write error) or names that the snapshot leaves out (unpicklable values, values over the size caps) never fail a cell. Each distinct problem appears once, as a line at the start of the next `python` result.

## Settings and flags

| Setting | Default | Meaning |
|---|---|---|
| `rlm.enabled` | `false` | RLM mode. The `--rlm` flag sets it for one run. `--rlm-input <path>` or `--rlm-input <name>=<path>` adds a file to `context.inputs`; the default name is the file name. |
| `rlm.subModel` | none | `"provider/id"` for `llm_query`, `llm_batch`, and `rlm_query`. |
| `rlm.outputLimit` | `16000` | Characters of cell output that the model sees per cell. |
| `rlm.maxDepth` | `2` | How many levels of `rlm_query` children may nest. |
| `rlm.memoryLimitMb` | `2048` | Memory limit of each kernel in MiB, applied as `RLIMIT_DATA` on Linux. `0` disables it. See "Memory". |

In RLM mode the session's active tools are `python` plus `bash`, `edit`, and `write` as hidden declarations. Hidden tools stay callable from the host and do not reach the model. The `defaultTools` setting, `--tools`, `--no-tools`, and `--no-builtin-tools` do not apply; `--exclude-tools` still removes tools, and extension tools that activate on registration stay declared next to `python`. The system prompt gets an `rlm` section that describes the kernel and its names.

## Python interpreter

`python-env.ts` picks the interpreter in this order:

1. The `RAGA_PYTHON` environment variable.
2. `~/.pi/agent/rlm/venv/bin/python`, when it exists.
3. A new venv at that path, when `uv` is on `PATH`. The host runs `uv venv --python 3.11` and `uv pip install dill`.
4. `python3` on `PATH`. Snapshots fail with `dill not installed` if `dill` is missing.

The interpreter must be Python 3.11 or newer. The kernel starts with `PYTHONPATH` set to `packages/coding-agent/python`.
