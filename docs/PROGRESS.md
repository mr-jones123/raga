# Raga progress

This file tracks raga's build plan. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design. Update a row's status and notes in the same commit that changes the work.

Status values are `done`, `in progress`, `not started`, and `blocked`.

## Foundation

| Item | Status | Notes |
|---|---|---|
| Fork pi at upstream `14c8118` (2026-10-23) | done | Branch `raga/foundation`. Pi package names are unchanged. |
| `docs/ARCHITECTURE.md` | done | |
| `docs/PROGRESS.md` | done | |
| Raga versioning and changelog generation | done | `scripts/raga-release.mjs` and [RELEASING.md](RELEASING.md). Baseline tag `raga-v0.0.0` on `14c8118`. Pi's remote is renamed to `upstream`. |

## Step 1. Native RLM runtime

| Milestone | Status | Scope | Done when |
|---|---|---|---|
| M1. Python kernel | done | `packages/coding-agent/python/raga_rlm/`. NDJSON over stdio, top-level `await`, a persistent namespace, cell-attributed output, interrupt, `host_request`, and `dill` snapshots. Protocol spec in [RLM.md](RLM.md). | 36 pytest tests pass on Python 3.11 and 3.12. |
| M2. `Kernel` | done | `packages/coding-agent/src/core/rlm/kernel.ts`, `protocol.ts`, and `python-env.ts`. A lifecycle state machine, ordered execution, abort as interrupt then kill and restart, a host request handler table, and a `uv` venv under a lock. | `test/rlm-kernel.test.ts` drives a real kernel through execute, host requests, interrupt, restart, snapshot, restore, and dispose. |
| M3. `python` tool and RLM mode | done | `src/core/rlm/runtime.ts` (`RlmRuntime`: kernel, host handlers, the `python` tool), `prompt.ts` (the `rlm` system prompt section), and `src/core/tools/renderers/python.ts`. `--rlm` or the `rlm.enabled` setting makes `python` the only model tool. `bash`, `edit`, and `write` stay active as hidden declarations (Python `read` reads files in the kernel), and `tool.call` runs them through `runToolCall` with the session's tool hooks. Output is cut at `rlm.outputLimit`. | `test/suite/agent-session-rlm.test.ts`: a faux-provider session edits a file with `await edit(...)` in a `python` cell, and every provider request declares only `python`. A real `--rlm -p` run with `claude-haiku-4-5` records only `python` tool calls. |
| M4. Sub-LLM calls | done | `llm_query` and `llm_batch` through `ModelRuntime.completeSimple` with the session's provider hooks and a fresh session id. Concurrency 8, the `rlm.subModel` setting, and per-cell usage on the `python` tool result. | The suite test checks that `getSessionStats()` equals the assistant usage plus the `llm_query` usage on the tool result. In the real run, `llm_batch` summarized 11 READMEs and the cell's result carries 7,073 tokens of usage. |
| M5. Context as a variable | done | The `set_context` request fills `context.task` (the first user prompt) and `context.inputs` (`--rlm-input` files, read on first access). `context.history` reads the whole session branch, so compacted messages stay reachable from the kernel. `cells` holds full cell outputs. Compaction summaries do not name kernel variables yet. | The suite test compacts a session, then a cell finds a pre-compaction tool output in `context.history()`. Other cases check `context.task`, `--rlm-input` contents, and `cells[-1]` after a cut. |
| M6. Recursive sub-agents | done | `src/core/rlm/children.ts` answers `rlm.query`: an in-process child `AgentSession` from `createAgentSession` in RLM mode that shares the parent's `ModelRuntime`, settings, and resources (with its own extension runtime) and links to the parent through `parentSession`. The child returns through `answer` (the `get_answer` request), or its last assistant text with `ready: false`. `rlm.maxDepth`, `max_turns` (default 30), the parent cell's abort signal, usage roll-up onto the parent's `python` result, and at most 4 children per session at once. `set_context` carries `data`, which the child reads as `context.data`. `await asyncio.gather(rlm_query(a), rlm_query(b))` runs children in parallel. | `test/suite/agent-session-rlm-children.test.ts`: a child answers through `answer` and its usage is in the parent's stats, `rlm.maxDepth` 1 rejects a grandchild, two children overlap under `asyncio.gather` (a file barrier), and aborting the parent interrupts the child's cell. In a real `--rlm -p` run with `claude-haiku-4-5`, the parent's one cell called `rlm_query`, the child found `packages/agent/src/agent-loop.ts` (959 lines), its session header names the parent's file, and the parent's cell result carries the child's 14,958 tokens. |
| M7. Persistence | done | One second after the last `ok` cell, the session snapshots the kernel to `<sessionDir>/<sessionId>.rlm/kernel.dill` (in-memory sessions use the temp dir) and appends one `rlm-kernel-snapshot` entry per session file. `AgentSessionRuntime` flushes a scheduled snapshot before it replaces or disposes a session. The first kernel restores the newest snapshot entry on the branch and reports `[kernel restored N variables: ...]`. Snapshot problems are notes in the next result, never cell errors. | `test/suite/agent-session-rlm-persistence.test.ts`: a variable survives a teardown and a resume, a fork restores the parent's variable and snapshots to its own file without touching the parent's, and an unpicklable variable is reported once. |
| M8. Verification and baseline | done | Faux-provider tests, protocol tests, and `bench/rlm/` with two tasks: T1, 800-message long-context classification, and T2, a multi-file refactor, each on pi and on raga. The first run found that Python `read` went through pi's truncating `read` tool, so raga saw 109 of 800 messages; `read` now reads the whole file in the kernel. | [BENCHMARKS.md](BENCHMARKS.md): Haiku 4.5, seed 1, N=3. After the fix, T1 is 0/3 exact on both arms, but raga's mean absolute error is 5.7 (answers 182/175/191, truth 181) against pi's 49.0; T2 is 2/3 on both arms, raga at $0.085 per run against pi's $0.122. |
| Memory limits | done | The `rlm.memoryLimitMb` setting (default 2048, `0` disables) reaches each kernel as `RAGA_RLM_MEMORY_LIMIT_MB`, and the kernel sets `RLIMIT_DATA` to it on Linux, so an allocation past it raises `MemoryError` in the cell and the kernel keeps serving (no hard limit on macOS). Every `execute` `done` carries `rss_mb`; the `python` result warns from 75% of the limit and explains a `MemoryError`. `cells` keeps full output for the newest 32 Mi characters. A snapshot skips a value whose `len()` or `nbytes` exceeds the per-variable cap without pickling it, and `restore` reads one record at a time. At most 8 child sessions are live across an RLM tree, next to 4 per session. See "Memory" in [RLM.md](RLM.md). | 48 pytest tests pass on Python 3.11 and 3.12, including `tests/test_memory.py`. `test/rlm-child-slots.test.ts` requests 9 children over two levels and never sees more than 8 live; `test/suite/agent-session-rlm.test.ts` checks the setting in the kernel env, the 75% warning, and the `MemoryError` note. `/tmp/rlm-mem/measure.py`: 100 cells printing 1 MB each grow the kernel to 119 MiB before and 56 MiB after; a snapshot of a 300 MB buffer raises peak RSS by 302 MiB before and 2 MiB after. |

## Later steps

| Step | Status | Scope |
|---|---|---|
| Continual harness | not started | Create, read, update, and delete prompt notes, memories, skills, and sub-agent specs. `/refine` with rollback. The agent writes and reloads its own Python modules. |
| Goal and metric loop | not started | `--goal`, `--gate <cmd>`, and `--metric <cmd> --target`. Budgets and a stop after runs that make no progress. |
| Guarded host self-patching | not started | TypeScript changes in a git worktree. `npm run check` and `./test.sh` must pass before merge and restart. |
| Native engineering skills | not started | Port pstack and no-mistakes as Python skill packages that the kernel imports at startup. |
| Rename to raga | not started | Package scope, the `raga` binary, and `~/.raga`. Planned after M3 to M5 settle. |

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-10-24 | The RLM runtime is native, not an extension. | See "Why the RLM runtime is native" in ARCHITECTURE.md. |
| 2026-10-24 | The kernel is a custom NDJSON process, not Jupyter. | No ZeroMQ or `ipykernel` dependency. Prime Agent runs the same design. |
| 2026-10-24 | Self-modification targets Python modules and harness state first. | Python reloads in a running session. TypeScript changes need a rebuild and a restart. |
| 2026-10-24 | Child sessions run in the host process for step 1. | One `ModelRuntime` and no daemon. A daemon can come later. |
