# Raga architecture

Raga is a coding harness for long tasks such as refactors, model training runs, and ports of legacy codebases. It keeps working until a goal or a metric is met, and it gets better at a task each time the task repeats. Raga is a fork of [pi](https://github.com/badlogic/pi-mono). This document explains how the pi base works and where raga's own layers attach to it. [PROGRESS.md](PROGRESS.md) tracks which of those layers exist today.

The repository still uses pi's names: the `@earendil-works/pi-*` packages, the `pi` binary, and the `~/.pi` config directory. A rename to `raga` comes later in the plan.

## Overview

Raga has three layers.

1. The pi base is a TypeScript monorepo. It provides the LLM provider layer, the agent turn loop, sessions, tools, extensions, and the terminal UI.
2. The RLM runtime is a persistent Python REPL kernel owned by each session. The model works inside the kernel. Large inputs and history live in Python variables instead of the context window. Python code can call sub-LLMs and recursive sub-agents. This follows the Recursive Language Model design from [Zhang et al.](https://arxiv.org/abs/2512.24601) and the [Prime Agent](https://www.primeintellect.ai/blog/prime-agent) harness.
3. The adaptive layer stores prompt notes, memories, skills, and sub-agent specs that the agent edits from its own trajectory. A goal loop and gate commands keep a run going until a metric passes.

The TypeScript host is the stable core. Everything raga changes about itself at runtime lives in Python modules and harness state files. Python modules reload without a rebuild, so the agent can rewrite its own helpers mid-run. Changes to the TypeScript host go through a separate path that uses a git worktree and the test suite, then restarts the host.

## Key concepts

**Session.** A session is one append-only JSONL file under `~/.pi/agent/sessions/`. Every entry has an `id` and a `parentId`, so one file holds a tree of branches. The JSONL tree is the source of truth. The in-memory transcript is rebuilt from it before every model request.

**Projection.** `buildSessionProjection` in `packages/coding-agent/src/core/session-manager.ts` turns the current branch into the messages the model sees. It applies compaction summaries and context edits on the way.

**Tool.** A tool is a `ToolDefinition` with a TypeBox parameter schema and an `execute` function. Built-in tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.

**Extension.** An extension is a TypeScript module that hooks session events, registers tools and commands, and rewrites context. Raga uses extensions for optional features, not for the RLM runtime. Section "Why the RLM runtime is native" explains why.

**Kernel.** The kernel is a Python process that speaks newline-delimited JSON over stdin and stdout. It keeps one namespace across calls and supports top-level `await`. The host owns the kernel's whole lifecycle.

**Host request.** A host request is a call from Python code back into the TypeScript host, such as `llm_query` or `bash`. The host answers it while the cell that made the call is still running.

## How a turn works

The user prompt enters `AgentSession`, which wraps the generic loop from `packages/agent`. Each turn rebuilds the context from the session file, streams one model response, runs the tool calls in that response, and persists every message.

```mermaid
flowchart TD
	U[User prompt] --> S[AgentSession.prompt]
	S --> P[prepareRequest<br/>rebuild context from JSONL projection<br/>compact if over threshold]
	P --> M[streamAssistantResponse<br/>provider stream via pi-ai]
	M --> T{tool calls?}
	T -- no --> E[turn end]
	T -- yes --> X[executeToolCalls<br/>beforeToolCall and afterToolCall hooks]
	X --> K[python tool<br/>KernelManager]
	K <-->|NDJSON stdio| PY[Python kernel]
	PY -->|host request| H[llm_query, bash, rlm_query]
	X --> P
	M --> J[(session JSONL)]
	X --> J
```

In RLM mode `python` is the only model tool. The model reads files, runs commands, and edits code by writing Python that calls `read`, `bash`, and `edit` as functions. The kernel manager starts the kernel and runs a bootstrap cell before the model first needs it. The bootstrap cell binds `context`, the tool functions, `llm_query`, `llm_batch`, `rlm_query`, and the loaded skills. The model never sets up the environment itself.

Tool output reaches the model shortened to a head and a tail. The full output stays in the kernel, so the model can search or slice it with Python instead of reading it again.

## Where things live

| Path | What it owns |
|---|---|
| `packages/ai` | Provider-agnostic LLM API, model catalog, auth. `completeSimple` and `streamSimple` make model calls. |
| `packages/agent` | The turn loop (`runLoop` in `src/agent-loop.ts`) and the `Agent` state class. |
| `packages/coding-agent/src/core/agent-session.ts` | `AgentSession`. Persistence, compaction triggers, the tool registry, extension hooks, and system prompt rebuilds. |
| `packages/coding-agent/src/core/session-manager.ts` | `SessionManager`. The JSONL tree, branching, forking, and `buildSessionProjection`. |
| `packages/coding-agent/src/core/tools/` | Built-in tools. `createAllToolDefinitions` in `index.ts` registers them. |
| `packages/coding-agent/src/core/system-prompt.ts` | `buildSystemPrompt`. Sections for tools, rules, context files, and skills. |
| `packages/coding-agent/src/core/compaction/` | Compaction. `compact` summarizes old entries and appends a compaction entry. |
| `packages/coding-agent/src/core/model-runtime.ts` | `ModelRuntime`. Session-aware model calls with the user's auth and `models.json`. |
| `packages/coding-agent/src/core/sdk.ts` | `createAgentSession`. Builds a session in code. Raga uses it for child sessions. |
| `packages/coding-agent/src/core/rlm/` | Planned. `KernelManager`, the `python` tool, and host request handlers. |
| `packages/rlm-runtime/` | Planned. The Python package with the kernel (`raga_rlm.repl`), `context`, and the sub-LLM functions. |
| `packages/codemode`, `packages/durable`, `packages/env`, `packages/mcp`, `packages/chord`, `packages/tui`, `packages/telemetry` | Pi packages that raga keeps as they are. |
| `docs/` | Raga docs. Pi's own docs are in `packages/coding-agent/docs/`. |

## Why the RLM runtime is native

An earlier attempt ran RLM as a pi extension. It gave the model a `python` tool with `llm_query`, `llm_batch`, and `tool()`. That covered the basic REPL. The rest of the runtime needs hooks that the extension API does not have.

| Need | What the extension API allows |
|---|---|
| The kernel follows the session through start, fork, resume, and shutdown | Only `session_shutdown` |
| History and large inputs live in the kernel, and compaction keeps a pointer to them | Only `context` rewrites and `session_before_compact` |
| `python` is the only tool and the system prompt is built around it | A full prompt replacement once per run, through `before_agent_start` |
| Child sessions with a depth limit, a budget, and usage rolled up to the parent | Tools and events cannot create a child `AgentSession` through the API |
| Python calls built-in tools many times per cell | `NESTED_CALL_LIMITS` caps a tool at 256 nested calls and 32 KB of arguments in total |

Raga puts the runtime in new directories and adds a few narrow hooks to `AgentSession`. That keeps merges from upstream pi small while the fork still tracks it.

## Why the kernel is not Jupyter

The kernel is a small custom Python process, the same design Prime Agent uses. It needs no ZeroMQ, no `ipykernel`, and no Jupyter protocol. The protocol has one request type per action (`execute`, `interrupt`, `host_reply`, `snapshot`, and `restore`) and one event type per output (`stdout`, `stderr`, `result`, `error`, `host_request`, and `done`). A reader thread answers host replies and interrupts while a cell runs, so Python code can `await` a host request without blocking the kernel.

## Gotchas

- `packages/codemode` looks like a REPL but is not one. It starts a fresh QuickJS worker for every call, and no state survives between calls.
- The bash tool spawns a new shell for every call. Shell state such as `cd` and exported variables does not persist between calls.
- System prompt changes reach the model as patch messages inside the transcript, not as a new system prompt. `diffSystemPromptSections` in `system-prompt.ts` builds them.
- Pi's `packages/*/CHANGELOG.md` files and `vX.Y.Z` tags belong to upstream pi. Raga's version and changelog are separate. See [Versioning](#versioning).

## Versioning

Raga's version is the newest annotated `raga-vX.Y.Z` tag behind `HEAD`. `scripts/raga-release.mjs` builds the root `CHANGELOG.md` from the conventional commit headers on the first-parent history since that tag. Upstream pi commits never become entries. A merge from upstream becomes one line under **Upstream**. [RELEASING.md](RELEASING.md) has the commands.
