---
name: quiz
argument-hint: "[commit range, e.g. main..HEAD or origin/main..HEAD]"
description: >-
  Builds one HTML page that explains a set of code changes (summary, what and why per commit, real
  git diffs with margin notes on the key lines) and ends with a multiple-choice quiz the user must
  pass before they push, merge or open a PR. Use when the user says "quiz me", "test me on the
  changes", "make a quiz/report of what you changed", or asks to understand the changes before
  shipping them.
---

# Quiz: explain the changes, then test the user on them

The user ships only after passing the quiz. The page must teach what changed and why, and the quiz must check understanding, not memory.

You write only a JSON spec (explanations, notes, questions). The bundled script reads the diffs from git, so no code on the page is typed by you. Do not hand-write HTML.

```bash
node "<directory of this SKILL.md>/scripts/quiz.mjs" spec.json [-o out.html] [--repo dir] [--no-open]
```

## 1. Pick the commits

- Arguments: `$ARGUMENTS`. If a range is given, use `git log --reverse --format=%h <range>`.
- Otherwise use the commits you made in this session, oldest first. If unsure, use `@{upstream}..HEAD` and say so.
- Uncommitted work is not in the report. If there is any of yours, say so; do not commit it to make the report.

## 2. Read every diff

Run `git show <sha>` for each commit and read it. Notes must point at real lines; questions must match what the code does.

## 3. Write the spec

Write it to a temp directory (for example `/tmp`), never into the repo.

```json
{
  "title": "What changed in raga, Nov 8-9",
  "lead": "One or two sentences: what this batch does and what is risky in it.",
  "pass": 80,
  "commits": [
    {
      "sha": "5df1ec574",
      "what": "Behavior the user can see. `code` and **bold** work. Blank line = new paragraph.",
      "why": "The problem it solves, and the reason for this design over the obvious one.",
      "notes": [
        { "file": "agent-session.ts", "match": "sessionId: this.sessionId", "text": "Why this line matters." }
      ]
    }
  ],
  "quiz": [
    {
      "q": "Why does /btw cost little on a long session?",
      "options": ["It sends only the last 10 messages", "It repeats the cached prefix under the same session id", "It uses a smaller model"],
      "answer": 1,
      "explain": "Why the right answer is right, and why the tempting wrong one is wrong.",
      "see": "5df1ec574#1"
    }
  ]
}
```

- `notes[].file` is a path or a path suffix; `match` is a substring of one diff line (added lines are searched first). The script numbers the notes 1, 2, 3 per commit in spec order and fails if a match is missing.
- Write 1-4 notes per commit on the lines that carry the idea: the condition that decides behavior, the non-obvious choice, the risk. Do not annotate imports or renames.
- `what` and `why` are 1-3 short sentences each. Lead with behavior, not file names.
- Deleted files and generated files (lockfiles, `*.generated.ts`, `schemas/*.json`) are shown as one line with no diff.

## 4. Write the quiz

- About 10 questions (at least 1 per commit that changes behavior; trivial test or docs commits can share one). Pass mark 80% unless the user set another.
- Test understanding: why a design was chosen, what happens in a given case, what breaks if a line is removed, what was not verified, which risk remains. Never ask for line numbers, file sizes or commit hashes.
- Include scenario questions ("A user sets X and does Y. What happens?").
- Include at least one question on a risk, a limit or something not tested.
- One correct option. 3-4 options, all plausible and of similar length; the right one must not be the longest or the most hedged. No "all of the above".
- `explain` says why the answer is right and why the most tempting wrong option is wrong. `see` links to `sha` or `sha#note`.
- The script shuffles questions and options on every attempt; `answer` indexes your spec order.

## 5. Render and reply

- Run the script. On `✗` errors, fix the spec and run it again.
- Reply in 2-3 lines: what the report covers, the page path from the `✓` line, and that the user should pass before pushing. Do not paste the questions or answers into the chat.
- When the user says they passed, continue with the push, merge or PR they asked for. If they failed, offer to explain the questions they missed.
