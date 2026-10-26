---
name: no-mistakes
description: Drive the explicitly enabled, pinned no-mistakes validation backend through the trusted instance supervisor. Use when asked to validate or gate committed code changes.
---

# Managed no-mistakes validation

The paired upstream public skill is preserved in [upstream/SKILL.md](upstream/SKILL.md). Read it for intent, findings, branch custody, and result semantics. This file owns raga's stronger authorization policy. Do not run a global no-mistakes binary or its installer.

Call `await instance.no_mistakes('inspect')`. If prerequisites are missing, report the exact pinned setup and repository-enablement requirements. Only an operator can provision, enable, start, or stop the backend through trusted management. Discovery never enables a repository. The managed backend isolates HOME and NM_HOME, disables telemetry and updates, and never installs an OS service or copies global credentials.

A validation-step child never initializes, runs, responds to, synchronizes, aborts, or controls the outer gate. If NO_MISTAKES_GATE or a nested_gate_context refusal is present, return the assigned phase result to the outer executor. Safe status inspection does not grant control authority.

For an enabled repository, inspect `await instance.no_mistakes('status')`. Validate committed feature-branch history with `await instance.no_mistakes('run', intent=complete_user_intent)`. The supervisor holds network authorization. The default skips push, PR, and CI. Every publication capability and automatic yes mode requires a separate operator grant. A model-supplied approval boolean is not authorization.

The pinned v1.84.0 executable accepts --intent, not --intent-file. The backend writes a private intent file and passes its exact text through --intent with --skip push,pr,ci. Do not issue a nonexistent upstream --intent-file flag. Local gate validation can fetch authoritative remote configuration and is not offline or side-effect-free.

At a gate, report findings and ask-user choices without silently accepting them. Only the operator's trusted CLI or a UI-confirmed supervisor action can respond, approve, fix, skip, or answer review questions. The model-facing instance adapter does not grant this authority. Never change the pipeline-owned branch directly. Preserve branch_sync guidance and exact commits.

Report the raw outcome, requested skips, automatic skips, overrides, missing evidence, and custody instructions. Passed-with-override, passed-with-skips, timeout, cancellation, and an unknown result are not a fully verified pass. Default restricted validation does not establish push, PR, CI, or merge readiness. The backend returns fullyVerified=false deliberately.
