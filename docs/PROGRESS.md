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
| M1. Python kernel | not started | `packages/rlm-runtime/` with `raga_rlm.repl`. NDJSON over stdio, top-level `await`, a persistent namespace, cell-attributed output, interrupt, `host_request`, and `dill` snapshots. Protocol spec in `repl.md`. | pytest covers every request and event type in the protocol. |
| M2. `KernelManager` | not started | `packages/coding-agent/src/core/rlm/`. Spawn, `ready` handshake with a protocol version, an ordered execute queue, head and tail output limits, abort as interrupt then kill, restart, a host request handler table, and a `uv` venv. `AgentSession.dispose()` stops the kernel. | A test drives a real kernel through execute, interrupt, restart, and dispose. |
| M3. `python` tool and RLM mode | not started | A built-in `python` tool with a renderer and a system prompt section. `--rlm` makes it the only tool. `read`, `bash`, `edit`, and `write` become Python functions outside `NESTED_CALL_LIMITS`. | A faux-provider session edits a file using only `python`. |
| M4. Sub-LLM calls | not started | `llm_query` and `llm_batch` through `ModelRuntime.completeSimple`. A concurrency limit, a sub-model setting, and usage entries. | Usage from sub-LLM calls appears in the session's usage total. |
| M5. Context as a variable | not started | `context.task`, `context.inputs`, `context.history`, and full cell outputs in `cells`. Compaction keeps pointers into the kernel. | After compaction, the model reads a pre-compaction tool output from `context.history`. |
| M6. Recursive sub-agents | not started | `rlm_query` runs a child `AgentSession` with its own kernel and a `parentSession` link. The child returns through `answer`. A depth limit, a budget, and usage roll-up. `rlm_spawn` runs a child in the background. | A two-level `rlm_query` returns an answer and the depth limit rejects a third level. |
| M7. Persistence | not started | A debounced kernel snapshot after each successful cell. A `rlm-kernel-snapshot` entry points to it. Resume restores it and fork copies it. | A resumed session sees variables from before the restart. |
| M8. Verification and baseline | not started | Faux-provider tests, protocol tests, and two benchmarks: a synthetic long-context task and one real refactor. Each runs on pi and on raga. | A table of success rate, tokens, and cost for both harnesses. |

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
