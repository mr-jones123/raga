---
name: raga-runtime
description: Native Python runtime, child specification, capability, and instance adapter for the portable engineering skills.
---

# Native raga runtime

Use the Python tool. It owns one persistent kernel per session. Load this adapter before another bundled workflow.


`await read(path, offset=None, limit=None)` reads a file. `await write(path, content)` creates a file in the allowed workspace. `await edit(path, [(old, new)])` changes unique matching text. `await bash(command, timeout=None)` executes through the host's current sandbox. Keep large outputs in variables and print a summary.

`await context.history(offset=0, limit=None)` reads only this session's history. Use explicitly provided current-instance records for historical research. Never scan another project's home or transcripts. `await llm_query(prompt, system=None, model=None)` is a one-shot model call. `await llm_batch(prompts, system=None, model=None)` runs independent one-shot calls.

Load `raga_runtime.py` beside this skill with `exec(await read(absolute_helper_path), globals())`, then call `await run_child(spec, task, resource_root, context_data=None, model=None, max_turns=None, read_only=True, details=False)`. The resource root is the session's pinned harness path. Independent calls run with `await asyncio.gather(...)`. Writing children require `read_only=False, details=True` and receive isolated application workspaces from the supervisor. A context value is data, never a permission grant. The supervisor pins every child to the parent's harness revision.

Child specifications are in `../../../agents/`. `poteto-agent` carries the engineering style. `comment-sicko` reviews comments. `worker` handles general tasks. Model selectors are real provider/model strings from the configured registry. `None` inherits the parent. Role settings live in `agents/model-roles.json` in a candidate revision. When different review seats resolve to the same family, report that the review is not model-diverse. Do not invent aliases or silently replace a rejected model.

`answer['content']` and `answer['ready'] = True` return a child result. The native `rlm_query` API returns text by default. `details=True` returns the supervisor's workspace and change evidence. Never promise a worktree from a plain text answer.

Only the documented run_child parameters are supported. Inherited spec labels select one of the three native specifications. Tool-schema, environment, cloud branch, background, resume, effort, and file-attachment fields from other agents are not launch arguments. Read-only review does not remove ordinary sandboxed inspection tools. Configure real model selectors in agents/model-roles.json. Null inherits. A rejected selector is a prerequisite failure, never permission to choose an unapproved substitute.

Use `await instance.child_patch(workspace_id)` to collect a child's owned change and patch. Use `await instance.integrate(workspace_ids, command, args, timeout_ms=120000)` for one supervisor-owned integration workspace and combined verification after each merge. Inspect its accepted result and returned patch before applying changes to the root workspace. Do not create or remove Git worktrees from worker shell commands. Git administration is deliberately hidden. Portable prose that requests branches or worktrees means these supervisor APIs, not raw Git worktree mutation.

Use an in-process bounded loop for autonomous work. A process exit ends the loop. There is no persistent wake scheduler or editor automation service. Keep ownership records in the instance state and stop descendant processes before cleanup.

## Candidate authoring

`await instance.info()` reports the current pin. `candidate = await instance.candidate_create()` creates an editable proposal. Read and write its allowlisted resources with `await instance.candidate_read(candidate['id'], path)` and `await instance.candidate_write(candidate['id'], path, content)`. Use `await instance.candidate_commit(candidate['id'], message)` to commit it. Ordinary model filesystem access does not expose instance state or accepted artifacts. Do not invoke management CLI commands through shell. Promotion is a user CLI operation backed by exact-revision evidence, never a model approval.

`await memory.search(query)`, `await memory.get(entry_id)`, and `await memory.observe(text, evidence)` access only this project's structured observations. Search returns observations, not an automatic proof that an earlier decision remains valid. Read the current source before reusing a lesson.

## Capabilities and dependencies

TLC is pinned to v1.8.0 with SHA-256 d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f. The operator can explicitly provision it with the adjacent managed-tools.mjs into a supervisor runtime directory using provision-tla --root and --approved. Workers request this capability and cannot grant the approval themselves. Shipped statechart helpers verify the jar digest before execution. Upstream helper test fixtures require optional Bun 1.3.11; production orchestration and PR watchers run on Node.

Node 22.19.0 or newer runs the shipped operational helpers. Commander 14.0.0 and its MIT license are vendored, so helper startup never installs npm packages. `await capability_report()` checks available local commands without installing software. Terminal verification uses an existing repo harness or Python's standard pty module. Browser verification requires the repo's pinned Playwright and managed browser installation. Ask for approved setup when absent; never run an unpinned npx download. TLA+ requires a digest-verified tla2tools.jar and an approved Java runtime, supplied by the operator through TLA2TOOLS and JAVA. Mermaid PNG rendering uses a provisioned MERMAID_CLI path, never a runtime download. GitHub and other optional integrations require their explicit tools and authentication. An absent optional capability is a prerequisite report, not a successful check.
