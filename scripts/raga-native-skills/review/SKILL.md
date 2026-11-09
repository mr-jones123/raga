---
name: review
argument-hint: "[commit range, e.g. main..HEAD; default: upstream..HEAD plus uncommitted changes]"
description: >-
  Reviews a set of code changes for bugs, including bugs outside the diff: read-only rlm_query
  explorers follow callers, callees and tests recursively, and each finding is proved by an isolated
  verifier that writes a failing test in a throwaway checkout. Reports only proved findings, each with
  a patch that adds its failing test. Use for /review, "review my changes", "find bugs in this
  branch", or before pushing or opening a PR.
---

# Review: find bugs beyond the diff, prove each with a failing test

A finding counts only if a test fails because of it. Explorers read; verifiers prove. Nothing in this review edits the user's checkout.

Run the phases from the `python` tool. Keep state (the diff, findings, verdicts) in kernel variables between cells.

## 1. Map the change

- The user's arguments, if any, follow this skill text. With a range, use `git diff <range>`. Without one, use `git diff $(git merge-base @{upstream} HEAD)` (committed and uncommitted work since the branch left its upstream). If there is no upstream, use `git diff HEAD` and say so.
- From the diff, list the changed functions, types, and config keys with their files. Group them into at most 6 groups that belong together (one feature, one module).

## 2. Explore (read-only, recursive)

Run one explorer per group at once:

```python
import asyncio, json
explore = [rlm_query(task_for(group), context=group, read_only=True, role="judgment", details=True) for group in groups]
results = await asyncio.gather(*explore, return_exceptions=True)
```

Tell each explorer, in its task:
- the changed symbols and the diff hunks for its group (pass them as `context`);
- to read every caller and callee of each changed symbol, and the tests that cover them, not just the diff;
- that it may start its own `read_only=True` children for a caller chain too long to follow itself;
- which bugs to look for: a changed contract that a caller still relies on, a missed edge case (empty, None, concurrent, error path), a resource leak, a security boundary, a stale test that still passes;
- to answer only with JSON: `[{"file": str, "line": int, "claim": str, "severity": "high"|"medium"|"low", "evidence": str, "test_hint": str}]`, and `[]` when it finds nothing. `claim` names the input and the wrong result. `test_hint` says how a test would trigger it.

Parse each answer with `json.loads`. Report an explorer that failed or returned invalid JSON as "not explored"; do not guess its findings.

## 3. Deduplicate

Merge findings with the same `file` and nearby `line` (within 5 lines) and the same claim. Sort by severity. Keep at most 8 (or the count the user asked for). List the dropped ones in the report as "not verified".

## 4. Verify (isolated)

Run one verifier per finding, at most 4 at once:

```python
verify = [rlm_query(verifier_task(f), context=f, isolated=True, role="verification", details=True) for f in findings]
```

`isolated=True` gives each verifier a throwaway checkout with `node_modules` cloned; its edits come back as `details["change"]` and never touch the user's checkout. Tell each verifier, in its task:
- to write the smallest test, in the project's existing test framework and style, that fails on the current code because of this finding;
- to run only that test file, inside `async with test_lock():`, never the whole suite;
- not to fix the bug;
- to answer only with JSON: `{"verdict": "confirmed"|"refuted"|"inconclusive", "test_file": str|null, "command": str, "output": str}`. `confirmed` means the test fails for the stated reason; `refuted` means the code is correct (the test passes or the scenario cannot happen); `inconclusive` means the test could not run. `output` is the end of the test output (at most 40 lines).

A `confirmed` verdict counts only if `details["change"]["files"]` contains its `test_file`. Otherwise mark it inconclusive.

## 5. Report

Reply in markdown:

1. **Confirmed findings**, most severe first. For each, give:
   - severity, `file:line`, and the claim;
   - the failing assertion (one or two lines from `output`);
   - how to get the failing test: `git diff <change.baseCommit> <change.commit> | git apply`.
2. **Refuted and inconclusive**: one line each, with the reason.
3. **Not explored or not verified**: one line each.
4. **Cost**: the number of explorers and verifiers run.

Do not fix the bugs unless the user asks. Do not claim a finding is real without a confirmed verdict.

## Limits

- Defaults: 6 explorers, 4 verifiers. Raise them only when the user asks.
- Verifiers share the machine: `test_lock()` runs their tests one at a time. Tests that need a network service or credentials come back inconclusive; say so instead of retrying.
