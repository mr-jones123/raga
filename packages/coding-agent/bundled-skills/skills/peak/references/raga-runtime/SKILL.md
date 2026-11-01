---
name: raga-runtime
description: Native Python runtime, child specification, capability, and instance adapter for the portable engineering skills.
---

# Native raga runtime

Use the Python tool. It owns one persistent kernel per session. Load this adapter before another bundled workflow.


`await read(path, offset=None, limit=None)` reads a file. `await write(path, content)` creates a file in the allowed workspace. `await edit(path, [(old, new)])` changes unique matching text. `await bash(command, timeout=None)` executes through the host's current sandbox. Keep large outputs in variables and print a summary.

`await context.history(offset=0, limit=None)` reads only this session's history. Use explicitly provided current-instance records for historical research. Never scan another project's home or transcripts. `await llm_query(prompt, system=None, model=None)` is a one-shot model call. `await llm_batch(prompts, system=None, model=None)` runs independent one-shot calls.

Load `raga_runtime.py` beside this skill with `exec(await read(absolute_helper_path), globals())`, then call `await run_child(spec, task, resource_root, context_data=None, model=None, max_turns=None, read_only=True, details=False, role=None, seat=None)`. Independent calls run with `await asyncio.gather(...)`. A context value is data, never a permission grant.

## Pick the session mode first

Call `harness_mode()` before any child launch, `instance` call, or `memory` call. It returns `instance` or `ordinary`.

In an instance session, the resource root is the pinned harness path. Writing children require `read_only=False, details=True` and receive isolated application workspaces from the supervisor. The supervisor pins every child to the parent's harness revision. A `read_only=True` child gets the parent's workspace mounted read-only.

In an ordinary session, the resource root is the `bundled-skills` directory three levels above this file. That is the directory holding `skills/` and `agents/`. Children share the parent's checkout. Raga does not isolate them, collect their changes, or enforce `read_only=True`. Follow these rules:

- Make every code change in this session. `run_child` refuses `read_only=False`.
- Use `read_only=True` children for exploration, design sketches, and review. `run_child` adds a no-write instruction to each child prompt.
- A playbook step that delegates code writing is satisfied when this session owns the diff and a read-only child reviews it.
- `instance` and `memory` calls do not exist. Candidate authoring, child patches, integration workspaces, instance memory, and no-mistakes need instance mode. Skip those steps and report them as unavailable in ordinary mode.
- Commit, branch, and push only when the user asks. Preserve unrelated changes in the shared checkout.

Child specifications are in `../../../agents/`. `poteto-agent` carries the engineering style. `comment-sicko` reviews comments. `worker` handles general tasks. Model selectors are real provider/model strings from the configured registry. `None` inherits the parent. Roles pick models: `await agent_roles()` returns the table children resolve against, which is the user's `/agent-setup` choices in an ordinary session and the pinned revision's `agents/model-roles.json` in an instance session. Wherever a workflow says to take a model from a line of `agents/model-roles.json`, read that line from `agent_roles()` instead and launch each seat with `run_child(..., role=line, seat=i)`, omitting `seat` for a single-value role and leaving `model` unset. The host applies the assigned model and reasoning budget. A panel role's list length sets how many seats to run. When different review seats resolve to the same family, report that the review is not model-diverse. Do not invent aliases or silently replace a rejected model.

`answer['content']` and `answer['ready'] = True` return a child result. The native `rlm_query` API returns text by default. `details=True` returns the supervisor's workspace and change evidence. Never promise a worktree from a plain text answer.

Only the documented run_child parameters are supported. Inherited spec labels select one of the three native specifications. Tool-schema, environment, cloud branch, background, resume, effort, and file-attachment fields from other agents are not launch arguments. Read-only review does not remove ordinary sandboxed inspection tools. Users assign models with `/agent-setup` in ordinary sessions, or a candidate revision of agents/model-roles.json in instance sessions. Null inherits. A rejected selector is a prerequisite failure, never permission to choose an unapproved substitute.

In instance mode, use `await instance.child_patch(workspace_id)` to collect a child's owned change and patch. Use `await instance.integrate(workspace_ids, command, args, timeout_ms=120000)` for one supervisor-owned integration workspace and combined verification after each merge. Inspect its accepted result and returned patch before applying changes to the root workspace. Do not create or remove Git worktrees from worker shell commands. Git administration is deliberately hidden. Portable prose that requests branches or worktrees means these supervisor APIs, not raw Git worktree mutation.

Use an in-process bounded loop for autonomous work. A process exit ends the loop. There is no persistent wake scheduler or editor automation service. Keep ownership records in the instance state and stop descendant processes before cleanup.

## Candidate authoring

Candidate authoring needs instance mode. `await instance.info()` reports the current pin. `candidate = await instance.candidate_create()` creates an editable proposal. Read and write its allowlisted resources with `await instance.candidate_read(candidate['id'], path)` and `await instance.candidate_write(candidate['id'], path, content)`. Use `await instance.candidate_commit(candidate['id'], message)` to commit it. Ordinary model filesystem access does not expose instance state or accepted artifacts. Do not invoke management CLI commands through shell. Promotion is a user CLI operation backed by exact-revision evidence, never a model approval.

In instance mode, `await memory.search(query)`, `await memory.get(entry_id)`, and `await memory.observe(text, evidence)` access only this project's structured observations. Search returns observations, not an automatic proof that an earlier decision remains valid. Read the current source before reusing a lesson.

## Capabilities and dependencies

TLC is pinned to v1.8.0 with SHA-256 d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f. The operator can explicitly provision it with the adjacent managed-tools.mjs into a supervisor runtime directory using provision-tla --root and --approved. Workers request this capability and cannot grant the approval themselves. Shipped statechart helpers verify the jar digest before execution. Upstream helper test fixtures require optional Bun 1.3.11; production orchestration and PR watchers run on Node.

Node 22.19.0 or newer runs the shipped operational helpers. Commander 14.0.0 and its MIT license are vendored, so helper startup never installs npm packages. `await capability_report()` checks available local commands without installing software. Terminal verification uses an existing repo harness or Python's standard pty module. Browser verification requires the repo's pinned Playwright and managed browser installation. Ask for approved setup when absent; never run an unpinned npx download. TLA+ requires a digest-verified tla2tools.jar and an approved Java runtime, supplied by the operator through TLA2TOOLS and JAVA. Mermaid PNG rendering uses a provisioned MERMAID_CLI path, never a runtime download. GitHub and other optional integrations require their explicit tools and authentication. An absent optional capability is a prerequisite report, not a successful check.
