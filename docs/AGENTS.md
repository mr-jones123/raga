# Subagents and `/agents`

Every `rlm_query` child is a Raga session. It has a generated name such as `SwiftFalcon`, its own Python kernel, and its own session file next to the parent's (when the parent is saved). `/agents` lets you open those sessions, read their transcripts and cells, and talk to them.

## Choose a view

`/agents` always offers two views. The last one you used is highlighted, not opened automatically.

- **TUI dashboard**: built in.
- **Rex workspace**: one Rex pane per subagent. Rex is optional. If it is not installed, the choice is disabled with an explanation; Raga never installs it. If its server is not running, you can retry or explicitly approve `rex server start`. Errors are reported and offer the TUI instead.

Neither view starts, restarts, or copies agents. Closing a view never stops a subagent.

## TUI dashboard

```
 Agents  2 running · 1 done · 1 failed        tokens 92.4k in / 11.0k out   $0.184
 NAME            STATUS      MODEL               TOKENS     COST   TURNS   TIME
▶ SwiftFalcon    ● running   claude-sonnet-4-5    48.2k   $0.121   7/30   2m14s
  │ cell: rg -n "parseArgs" packages/…
  └ QuietOtter   ● running   claude-haiku-4-5     12.9k   $0.008   3/30     41s
  CalmHeron      ✓ done      gpt-5.4-mini         22.1k   $0.034  11/30   4m02s
  KeenMoth       ✗ failed    claude-sonnet-4-5     4.3k   $0.011   2/30     12s
```

Each row shows the subagent's name, state, model, tokens, cost, turns used out of its budget, and elapsed time. Nested subagents appear under their parent. Wide terminals show a details panel with the task, parent, token breakdown, session file, stop reason, and error.

| Default key | Action |
|---|---|
| Up / Down, Page Up / Page Down, Home / End | Select a subagent |
| Enter | Open its session |
| Tab | Toggle the details panel |
| `t` | Tree or flat view |
| `x`, then `x` again | Stop the selected subagent |
| Esc | Close |

Keys are configurable (`app.agents.*` and the `tui.select.*` actions).

States: `queued` waits for a free slot; `running`; `done`; `partial` stopped at its turn budget (`max_turns`) and returned partial work; `failed` hit a provider or runtime error; `stopped` was cancelled.

### Inside a subagent's session

Enter replaces the main view with the subagent's session: its transcript, its Python cells rendered exactly like the main session's, and a footer with its model, tokens, and cost. A banner above the footer names the subagent and shows whether the main session is still working.

- Type a message to steer the subagent while it works, or to continue with it after it answered. Its reply is saved to its own session, not returned to the parent's `rlm_query`.
- Esc (with an empty editor) returns to the main session. It does not interrupt the subagent; stop it with `x` in the dashboard.
- Slash commands, `!` shell commands, model and thinking changes, and session commands act on the main session, so they are refused until you return.

A subagent that wrote into an isolated instance workspace is read-only after it answers: its workspace change was already returned to the parent, and later edits would not be collected.

## Rex workspace

Choosing Rex creates one Rex session for the Raga session, labelled `raga · <session name>`, and asks the Rex app to show it. Each subagent gets its own pane, added as subagents start. Pane labels show the name, state, model, tokens, and cost, and update as they change. Panes are tiled by splitting the largest Raga pane; a tab holds at most nine, then a new tab opens.

Each pane runs `raga agent-attach`, a small Raga view of that subagent's live session: the same transcript and cell rendering, an editor that steers it, and a footer with its model, tokens, and cost. Ctrl+C closes the pane without stopping the subagent. A pane you close stays closed until you choose Rex in `/agents` again.

Panes reach the subagent through a local socket owned by the Raga process. The socket lives in a private temporary directory (mode 0700, socket 0600), accepts only subagents of that Raga session, and is removed when Raga exits. When Raga exits, panes report that the session ended.

Raga only touches the Rex session it created. It never adopts sessions by label or splits panes you created.

## Assign models to roles: `/agent-setup`

The bundled workflows (Peak skills such as `/arena`, `/interrogate`, `/swarm`, `/how`, `/why`, `/reflect`) launch subagents by role, for example `bug-fix`, `how explorer`, or `arena runners`. `/agent-setup` decides which model each role runs on. It works like pstack's `/setup-pstack`:

1. **Budget.** The first row sets the reasoning budget for roles that name a model: `unlimited` (xhigh thinking), `large` (high), `medium` (medium), or `small` (low). Enter cycles it. With no budget, children keep the parent's thinking level.
2. **Roles.** Every role is listed with its current model. Enter opens the model picker, which lists only models you are logged in to. `i` makes the role inherit the parent session's model.
3. **Panels.** Panel roles (`architect runners`, `arena runners`, `arena cross-judge pool`, `interrogate reviewers`, `reflect reviewers`) have one row per seat; one subagent runs per seat. `a` adds a seat and `d` removes one. A panel whose seats all use one provider is marked "not model-diverse".
4. **Save.** Ctrl+S checks that every chosen model is available and saves to your global settings (`agentRoles` in `~/.raga/agent/settings.json`). Esc asks before discarding changes.

A workflow launches a seat with `rlm_query(task, role="arena runners", seat=1)`, and Raga applies the assigned model and budget. An explicit `model=` always wins. A role with no model, or `inherit`, runs on `rlm.subModel` if set, otherwise the parent's model. The dashboard shows each subagent's role.

Instance sessions keep their pinned `agents/model-roles.json`, so a running instance never changes under you. Change an instance's roles through a candidate revision (`/skill:peak`, then peak-setup); `/agent-setup` choices apply to ordinary sessions.

## Lifetime and memory

A subagent's session and kernel stay in memory after it answers, so you can open it immediately. Up to four finished subagents per session stay live; older ones are parked: Raga saves their kernel snapshot and closes them. Opening a parked subagent reloads it from its session file. A subagent open in the TUI is never parked. A Rex pane keeps showing a parked subagent's last state, and sending it a message reloads it. Subagents of an unsaved (`--no-session`) session have no file to reload from, so they are never parked.

When the main session ends or is replaced, its subagents are closed with it.
