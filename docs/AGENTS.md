# Subagents and `/agents-tui`

Every `rlm_query` child is a Raga session. It has a generated name such as `SwiftFalcon`, its own Python kernel, and its own session file next to the parent's (when the parent is saved). `/agents-tui` shows them as a tree, and lets you open their sessions, read their transcripts and cells, and talk to them. It never starts, restarts, or copies agents, and closing it never stops a subagent.

## Tree chart

`/agents-tui` opens on a chart of the current session's subagents. The session itself is the box at depth 0. Each subagent is a box under the agent that started it, so the children of the session are at depth 1, their children at depth 2, and so on. The `D0`, `D1`, ... gutter on the left stays visible while the chart scrolls.

```
                       ┏━━━━━━━━━━━━━━━━━━━━━━━━━┓
D0                     ┃ main session · 3 agents ┃
                       ┗━━━━━━━━━━━━┯━━━━━━━━━━━━┛
                    ┌───────────────┴───────────────┐
    ╭───────────────┴───────────────╮  ╭────────────┴───────────╮
D1  │          SwiftFalcon          │  │       CalmHeron        │
    │ ● running · claude-sonnet-4-5 │  │ ✓ done · gpt-5.4-mini  │
    │     48.2k · $0.121 · 7/30     │  │ 22.1k · $0.034 · 11/30 │
    ╰───────────────┬───────────────╯  ╰────────────────────────╯
                    │
    ╭───────────────┴──────────────╮
D2  │          QuietOtter          │
    │ ● running · claude-haiku-4-5 │
    │    12.9k · $0.008 · 3/30     │
    ╰──────────────────────────────╯
```

Each box shows the subagent's name, state, model, total tokens, cost, and turns used out of its budget. The border takes the state's color, and the selected box is highlighted. Wide terminals show a details panel with the task, parent, token breakdown, session file, stop reason, and error.

Two list views remain for long runs: a tree list with one row per subagent, and a flat list that puts running subagents first. `t` cycles chart, tree list, and flat list.

| Default key | Action |
|---|---|
| Up / Down | Chart: parent / first child. Lists: previous / next row |
| Left / Right | Chart: previous / next subagent at the same depth |
| Page Up / Page Down, Home / End | Jump through the subagents |
| Enter | Open its session |
| Tab | Toggle the details panel |
| `t` | Cycle chart, tree list, and flat list |
| `x`, then `x` again | Stop the selected subagent |
| Esc | Close |

Keys are configurable (`app.agents.*` and the `tui.select.*` actions).

States: `queued` waits for a free slot; `running`; `done`; `partial` stopped at its turn budget (`max_turns`) and returned partial work; `failed` hit a provider or runtime error; `stopped` was cancelled. `(parked)` marks a subagent whose session was closed to save memory (see "Lifetime and memory").

### Inside a subagent's session

Enter replaces the main view with the subagent's session: its transcript, its Python cells rendered exactly like the main session's, and a footer with its model, tokens, and cost. A banner above the footer names the subagent and shows whether the main session is still working.

- Type a message to steer the subagent while it works, or to continue with it after it answered. Its reply is saved to its own session, not returned to the parent's `rlm_query`.
- Esc (with an empty editor) returns to the main session. It does not interrupt the subagent; stop it with `x` in `/agents-tui`.
- Slash commands, `!` shell commands, model and thinking changes, and session commands act on the main session, so they are refused until you return.

A subagent that wrote into an isolated instance workspace is read-only after it answers: its workspace change was already returned to the parent, and later edits would not be collected.

## Assign models to roles: `/agent-setup`

The bundled workflows (Peak skills such as `/arena`, `/interrogate`, `/swarm`, `/how`, `/why`, `/reflect`) launch subagents by role, for example `bug-fix`, `how explorer`, or `arena runners`. `/agent-setup` decides which model each role runs on. It works like pstack's `/setup-pstack`:

1. **Budget.** The first row sets the reasoning budget for roles that name a model: `unlimited` (xhigh thinking), `large` (high), `medium` (medium), or `small` (low). Enter cycles it. With no budget, children keep the parent's thinking level.
2. **Roles.** Every role is listed with its current model. Enter opens the model picker, which lists only models you are logged in to. `i` makes the role inherit the parent session's model.
3. **Panels.** Panel roles (`architect runners`, `arena runners`, `arena cross-judge pool`, `interrogate reviewers`, `reflect reviewers`) have one row per seat; one subagent runs per seat. `a` adds a seat and `d` removes one. A panel whose seats all use one provider is marked "not model-diverse".
4. **Save.** Ctrl+S checks that every chosen model is available and saves to your global settings (`agentRoles` in `~/.raga/agent/settings.json`). Esc asks before discarding changes.

A workflow launches a seat with `rlm_query(task, role="arena runners", seat=1)`, and Raga applies the assigned model and budget. An explicit `model=` always wins. A role with no model, or `inherit`, runs on `rlm.subModel` if set, otherwise the parent's model. The details panel shows each subagent's role.

Instance sessions keep their pinned `agents/model-roles.json`, so a running instance never changes under you. Change an instance's roles through a candidate revision (`/skill:peak`, then peak-setup); `/agent-setup` choices apply to ordinary sessions.

## Lifetime and memory

A subagent's session and kernel stay in memory after it answers, so you can open it immediately. Up to four finished subagents per session stay live; older ones are parked: Raga saves their kernel snapshot and closes them. Opening a parked subagent reloads it from its session file. A subagent open in the main view is never parked. Subagents of an unsaved (`--no-session`) session have no file to reload from, so they are never parked.

When the main session ends or is replaced, its subagents are closed with it.
