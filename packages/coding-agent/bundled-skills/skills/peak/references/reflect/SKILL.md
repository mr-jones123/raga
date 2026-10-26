---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

Read [the native Python adapter](../raga-runtime/SKILL.md) before executing this workflow. Authoring targets candidate revisions. Children use run_child, not an external agent service.

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Read the current session

Use await context.history() to read this session. Pass the relevant messages and evidence as context_data to reviewers. Earlier transcripts must be explicitly supplied by the supervisor. Do not search global transcript directories or pretend that a filesystem session layout is part of the Python API.

## 2. Spawn three reviewers in parallel

One message, three `run_child` calls, `spec: worker`, agent mode (`read_only=False, details=True`). Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references, and read_only controls workspace writes.

Each reviewer and the synthesizer name a role line in the `model-roles.json` rule and a default. Set `model` to that line's value, or to the default if the rule or the line is missing. Leave `model` unset when the value is `auto` or `inherit-parent`. If a configured model is rejected, report the unavailable selector and stop that seat. Do not silently substitute another model. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **peak** skill.

| Lens | Role line | Default `model` | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `None` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `None` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `None` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `run_child` response body.

## 3. Synthesize

One `run_child` call, `spec: worker`, `model` from the `reflect judgment, divergent, synthesizer` line (default `None`), agent mode (`read_only=False, details=True`). It spot-verifies citations through MCP, and read_only controls workspace writes. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Promoted skill changes affect future sessions of this instance. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the bundled `create-skill` skill skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `create-skill` and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to `create-skill`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
