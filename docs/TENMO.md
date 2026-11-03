# Tenmo

Tenmo tracks every running raga session on your machine, across folders. It is for the moment you have three sessions open in three worktrees and no longer remember which one was doing what.

## Why

Example: you run one session in `theHub-v2`, one in `theHub-software-factory`, and a second one in a worktree of `theHub-v2` that is fixing a flaky test. An hour later you have three tmux windows and no record of what each was started for. Before tenmo, the only way to check was to open each session.

Tenmo shows all of them in one list, with the message each session was started with. It works well when you keep many worktrees and want one or two sessions per project.

## The dashboard

Run `/tenmo` in any session.

```
tenmo  3 sessions · 1 working · 1 waiting

Sessions
› ● working ~/Programming/offshorly/theHub-v2  anthropic/claude-opus-5-5  4s ago
            intent  add the importer for broker CSV files
            latest  now add tests for the date parser
            now     running python

  ◆ waiting ~/Programming/offshorly/theHub-v2-flaky-test  openai/gpt-6.1-sol  1m ago
            intent  fix the flaky checkout test

  ○ idle    ~/Programming/offshorly/theHub-software-factory (this session)  anthropic/claude-opus-5-5  12m ago
            intent  review the factory pipeline config

up/down select · enter jump to tmux pane · x delete · esc close
```

| Field | Meaning |
|---|---|
| status | `working`: the agent is running. `waiting`: it is blocked on a question or confirmation from you. `idle`: it finished and waits for your next message. |
| intent | The first message of the session: what it was started for. |
| latest | Your most recent message, when it differs from the intent. |
| now | The tool the agent is running, or the start of its last reply. |

Keys:

- **Enter** jumps to the session's tmux pane. This needs an attached tmux client.
- **x** twice ends the session and deletes it (see below). Any other key cancels.
- **Esc** closes the dashboard.

The delete key is configurable as `app.tenmo.delete` in `keybindings.json`.

## Start a session

```
/tenmo make a raga session at @../theHub-v2-flaky-test. it needs to fix the flaky checkout test
/tenmo @../theHub-v2-flaky-test fix the flaky checkout test
```

The folder is the first `@path` (quote paths with spaces: `@"my app"`). A leading "make/create/start ... at" phrase is dropped, so the new session's first message is "it needs to fix the flaky checkout test".

Tenmo opens a tmux window named after the folder, starts raga there, and sends the task as the first message. Inside tmux, the window opens in the background of your current tmux session. Outside tmux, it goes to a tmux session named `tenmo`; attach with `tmux attach -t tenmo`. Each start is logged in `<folder>/.raga/tenmo.json`. That file does not turn on instance mode or trigger the project trust prompt.

Sessions you start yourself, in any terminal, are tracked the same way. Tenmo does not need to start a session to see it.

## Delete a session

Pressing **x** twice ends the selected session and deletes its history:

1. Its tmux pane is closed, or, outside tmux, the process gets `SIGTERM` (then `SIGKILL` after 5 seconds).
2. Its session file is deleted, together with its subagent sessions, forks of it, and their Python kernel snapshots (`<id>.rlm`). Sessions that are still running elsewhere are kept.

This cannot be undone. You cannot delete the session you are in; quit it instead.

## From the terminal

```bash
raga tenmo                          # list running sessions
raga tenmo --json                   # the same, as JSON
raga tenmo watch                    # refresh every 2 seconds until Ctrl+C
raga tenmo spawn @<path> <task>     # start a session in a tmux window
```

A skill or script can call `raga tenmo spawn` to start sessions.

## How it works

Each raga process writes one record to `~/.raga/agent/tenmo/<pid>.json` and updates it as the session changes: status, model, intent, and current activity. The record is deleted when the process exits. If a process crashes, the next reader sees that the process is gone and removes its record. Subagents (`rlm_query` children) are not listed; they belong to their parent's session.

Code: `packages/coding-agent/src/core/tenmo.ts` (records, spawn, delete), `src/extensions/tenmo/` (tracking and the dashboard), and `src/cli/tenmo-command.ts` (the CLI).

## Limits

- Tenmo sees sessions on this machine only.
- Sessions started with `pi` use `~/.pi/agent` and are listed only by `pi tenmo`.
- Tenmo watches and deletes sessions. It does not send messages to them.
