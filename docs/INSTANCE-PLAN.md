# Versioned, adaptive raga instances

Status: M9 through M16 are implemented and exercised, including the default skill bundle, real-model skill acquisition, and a seven-arm transfer comparison. [PROGRESS.md](PROGRESS.md) records the evidence. The comparison does not establish a learning-quality gain. No refinement candidate was activated, combined arms exhausted conservative dollar reservations, and each arm had only four held-out trials. Automatic promotion stays off by default.

## Goal

Two projects can run long tasks with independently evolving instructions, extensions, Python skills, and memory. An instance can be forked from another instance's accepted harness without inheriting credentials or live execution state. Children use a pinned harness revision and cannot overwrite a sibling's work.

The engine remains fixed during execution. Changes to the Node implementation are ordinary developer work, never an agent capability. The agent can propose changes to harness artifacts. A trusted supervisor controls execution, evaluation, and activation.

## Use an instance

`raga` is the dedicated executable for this workflow. It accepts every instance command
without the `instance` level: `raga init`, `raga run`, `raga status`, `raga verify run`.
Bare `raga` opens the interactive session for the project's instance. The `pi` executable
keeps `pi instance ...` for the same commands, and both share credentials under `~/.pi`.


An instance session needs Linux with bubblewrap (`bwrap`) and Python 3.11 or newer. Writing children, refinement, and skill proposals also need the project to be a Git repository with a commit at `HEAD`. Every `pi instance` command prints JSON, except `run`. `--project PATH` selects the project, and the default is the current directory. `pi instance --help` lists every command and flag.

1. Create the instance.

	```bash
	cd ~/src/atlas
	pi instance init
	```

	`init` creates `.raga/` and commits the bundled default skills as the first accepted revision. If the project already has a `.raga/` directory, `init` imports `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `agents/`, and `lessons/` from it. `init --trust` also imports `settings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `skills/`, `prompts/`, `themes/`, and `extensions/`. A file that differs from a bundled file fails `init` with a conflict list, and nothing is published.

	To move a pi project first, run `pi instance migrate --trust`, then `pi instance init --trust`. Migration copies reviewed `.pi` resources into a new `.raga/` without loading them and leaves `.pi` unchanged. It refuses an existing `.raga/`, symlinks, credential files, credential-bearing or executable settings, `sessionDir`, and resource paths outside the migrated directories.

2. Inspect the instance.

	```bash
	pi instance status
	pi instance revisions
	```

	`status` prints the manifest, the pinned resource root, the discovered skills, skill diagnostics, whether the bubblewrap sandbox works, and what no-mistakes still needs. `revisions` lists accepted revisions, committed candidates, and fork bases, newest first.

3. Run a task.

	```bash
	pi instance run -- -p "Make the failing parser test pass"
	pi instance run --revision 1f0c... -- -p "Reproduce yesterday's run"
	```

	Arguments after `--` go to `pi`. `run` stores sessions under `.raga/state/sessions/` and rejects `--session`, `--session-dir`, `--session-id`, `--fork`, `--resume`, `--continue`, `-r`, and `-c`. Running plain `pi` anywhere inside the project also finds `.raga/instance.json` and starts on the active revision. A resumed session reopens on the revision recorded in its session file, even after a newer revision was activated.

4. Fork the harness into a second project.

	```bash
	cd ~/src/beacon
	pi instance fork --from ~/src/atlas
	```

	`fork` copies one accepted revision of the source harness, the active one unless `--revision` names another. It never copies credentials, memory, sessions, kernel snapshots, evidence, or candidates. The two instances then evolve independently.

5. Record a lesson and move it to the other project.

	Write the memory input as JSON. `scope` is the absolute real path of the project the entry belongs to. Only a `lesson` with `"sharing": "reusable"` can move to another scope.

	```json
	{
		"text": "Run python3 public_check.py in the integration workspace before accepting writer changes.",
		"scope": "/home/me/src/atlas",
		"kind": "lesson",
		"evidence": [".raga/evidence/refinements/<id>.json"],
		"taskType": "integration",
		"sharing": "reusable"
	}
	```

	```bash
	cd ~/src/atlas
	pi instance memory observe --input lesson.json
	pi instance memory retrieve --query "accept writer changes" --task-type integration
	pi instance memory export --ids <entry-id> > /tmp/atlas-lessons.json
	cd ~/src/beacon
	pi instance memory import --input /tmp/atlas-lessons.json --scope /home/me/src/beacon
	pi instance memory retrieve --query "accept writer changes" --task-type integration
	```

	Without `--scope`, an imported entry keeps the source scope, and retrieval in the second project does not select it. `memory revise ID --input FILE` publishes a new version that supersedes the old one, and `memory retire ID --reason TEXT` removes an entry from retrieval. `memory get`, `memory list`, and `memory history` read entries and their versions.

6. Refine the harness.

	`--evaluator DIR` is required. Put the evaluator in an absolute directory outside `.raga/`. The evaluator command runs after each solver replay, in the sandbox, with the probe's fresh project copy as its working directory. It reads the project path from `RAGA_PROJECT`, the measured harness from `RAGA_HARNESS`, and its own directory from `RAGA_EVALUATOR`. A last stdout line `RAGA_SCORE=n` sets the score. Otherwise exit code 0 scores 1 and any failure scores 0.

	```bash
	pi instance refine \
		--goal "Make writers run the public check before they answer" \
		--check '["python3", "/home/me/evaluators/atlas/check.py"]' \
		--evaluator /home/me/evaluators/atlas \
		--max-model-calls 40
	```

	The result's `refinement.outcome.kind` is `improved`, `no-improvement`, `insufficient-evidence`, `blocked`, or `cancelled`. The active revision does not change. To activate an `improved` result, copy its `revision`, its `evidenceId`, and `refinement.baseRevision`:

	```bash
	pi instance activate <revision> --approved --evidence <evidenceId> --expected-base <baseRevision>
	```

	`refine --approved` performs the same activation at the end of the run when the outcome is `improved`. Inside a session, `/refine` takes the same flags plus `--probe-task`, `--max-candidates`, `--repetitions`, and `--max-probe-runs`, and asks for confirmation before it activates.

7. Propose a learned Python skill.

	A skill directory holds `SKILL.md` and `raga-skill.json`. The manifest declares the entry function, exact dependency versions, permitted file writes, and behavior cases.

	```bash
	pi instance skill verify --directory ./skills/normalize-rows
	pi instance skill propose --directory ./skills/normalize-rows
	pi instance skill verify --revision <revision> --skill normalize-rows
	```

	`propose` commits the skill into a new candidate, validates that exact commit, and prints the candidate and an `evidenceId`. Activate it with `pi instance activate` as in step 6.

8. Roll back.

	```bash
	pi instance rollback <earlier-accepted-revision> --expected-base <current-active-revision>
	```

	New sessions start on the earlier revision. Running sessions keep their pins. Project files, memory, and external side effects stay as they are.

9. Opt in to checkpoint refinement.

	Automation is off until you enable it with explicit limits:

	```json
	{
		"minIntervalMs": 3600000,
		"maxRunsPerDay": 4,
		"maxDriverCallsPerDay": 160,
		"maxWallMsPerDay": 7200000,
		"maxConsecutiveNoProgress": 3,
		"run": { "maxCandidates": 2, "maxDriverCalls": 40, "maxProbeRuns": 8, "deadlineMs": 1800000 }
	}
	```

	```bash
	pi instance automation enable --limits limits.json --approved
	pi instance automation checkpoint \
		--goal "Make writers run the public check before they answer" \
		--check '["python3", "/home/me/evaluators/atlas/check.py"]' \
		--evaluator /home/me/evaluators/atlas
	pi instance automation status
	pi instance automation disable --reason "pausing"
	```

	Each `checkpoint` call runs at most one bounded refinement, clipped to the per-run and daily limits, and refuses to start while another run is active or the interval has not passed. Raga does not schedule checkpoints. Call the command from your own task runner or job loop. After `maxConsecutiveNoProgress` runs without progress, automation disables itself. A measured improvement still needs `pi instance activate` unless automatic promotion is on.

	`pi instance automation approve --report FILE --margin N --min-trials N --approved` turns on automatic promotion only when the held-out report, stored outside the project, shows the adaptive arm beating both the fixed arm and the equal-budget retry arm by at least the margin. A weak or negative report leaves promotion with you. Changes to `extensions/` or `settings.json` always need your approval. `pi instance automation manual` returns promotion to approval mode.

10. Enable no-mistakes for one repository.

	Each step needs its own approval flag:

	```bash
	pi instance no-mistakes inspect
	pi instance no-mistakes provision --approved
	pi instance no-mistakes enable --approved --network
	pi instance no-mistakes start --approved
	pi instance no-mistakes run --intent-file intent.txt --approved --network
	pi instance no-mistakes respond --action approve --approved
	pi instance no-mistakes stop --approved
	```

	`provision` downloads the pinned v1.84.0 archive and checks its SHA-256. `enable` verifies the current `pi` executable as the pipeline agent, runs upstream `init` in the project, and starts the backend daemon. The adapter check sends a probe prompt in JSON mode, so it makes model calls. `run` skips push, PR creation, and CI unless you add `--push`, `--pr`, or `--ci`. `--pr` requires `--push`, and `--ci` requires both. `--yes` passes upstream's automatic yes mode.

	For a custom provider or credential setup, add `--agent-config /absolute/path/agent.json` to `enable`. The file contains `{"executable":"/absolute/path/to/approved-wrapper","version":"1.4.0","args":[]}`. Use the version printed by that executable. The wrapper supplies any explicitly authorized provider configuration. Raga validates the adapter with real model calls and persists its executable, hash, arguments, and version. It does not copy ambient credentials or accept environment values in this configuration file. The wrapper and backend run as trusted external processes, not as sandboxed instance children.

11. Optionally require proofs before activation.

	Verification is off by default, and none of it belongs to the harness.

	```bash
	mkdir -p .raga/verification
	$EDITOR .raga/verification/LAWS.bend      # you write the laws
	$EDITOR .raga/verification/PROOF.bend     # proofs can be drafted, but you review them
	pi instance verify install --approved --network
	pi instance verify enable --approved
	pi instance verify run --revision REV
	```

	`verify suggest` asks the configured agent for draft laws. Drafts land in `.raga/verification/suggestions/`, are marked unverified, and never become active on their own. A law proves only the Bend code it imports; for other languages, treat a pass as evidence about the model.

## Decisions

1. Use `.raga` for project instance storage. Provide an explicit migration from project `.pi`. Do not silently merge both directories or keep an automatic legacy fallback. Package and executable branding is a separate migration.
2. Give each independently evolving instance its own host process, resource root, session storage, and project binding. No raga supervisor daemon is required. External skill backends with daemon requirements need explicit setup and lifecycle ownership.
3. Store the harness in a dedicated local Git repository, separate from the application's repository. Use commit hashes as revision IDs. Materialize candidates and pinned executions as plain checkouts.
4. Keep credentials, sessions, raw memory observations, evidence, and the active-revision pointer outside the agent-editable Git repository. Do not copy them when forking an instance.
5. Pin sessions and children to accepted harness commits. Activation affects new sessions. Code changes require fresh execution state.
6. Keep one promotion owner per instance and one integration owner per task workspace. Concurrent agents submit proposals. They do not replace active state themselves.
7. Separate memory promotion from retrieval. Retaining a lesson does not mean injecting it into every prompt.
8. Begin with explicit refinement and user-approved promotion. Automatic promotion is a later policy, enabled only by external held-out evidence. Host extensions always require explicit approval.
9. Ship the portable pstack pack and the public no-mistakes skill in every new harness by default. Availability does not imply automatic invocation, publication permission, or injection of every skill into the model's context.
10. Use Linux bubblewrap as the restricted execution backend. Restricted execution fails closed on any other platform or when the bubblewrap probe fails.

## Storage and identities

`.raga/` holds the instance. Add it to the outer application's `.gitignore`.

```text
project/.raga/
	instance.json            # Instance ID, bound project path, active revision, fork source
	instance.lock            # Serializes init, activation, rollback, and pin creation
	harness/                 # Bare Git repository of harness revisions
	candidates/              # Candidate records
	worktrees/
		pins/<revision>/       # Read-only checkout of an accepted revision, no .git
		candidates/<id>/       # Writable candidate checkout, no .git
		refinement/<run>/      # Probe workspaces of a running refinement
	state/
		sessions/              # Instance session files
		kernels/<session>/     # Kernel snapshots
		children/<uuid>/       # Writer child checkouts
		integrations/<uuid>/   # Integration workspaces
		memory/<id>/<n>.json   # Immutable memory versions
		backends/no-mistakes/  # Pinned binary, HOME, NM_HOME, daemon log, run authorizations
		refinement-sessions/   # Session scratch of a running model refinement
	evidence/
		<evidence-id>.json     # Supervisor evidence, ID is the SHA-256 of its content
		refinements/<id>.json  # Refinement results, written once
		decisions/             # Activation and rollback decisions, numbered
```

A harness revision holds only `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `README.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `settings.json`, `bundle.json`, `dependencies.json`, and the `skills/`, `prompts/`, `themes/`, `extensions/`, `agents/`, `lessons/`, `docs/`, and `licenses/` directories. The store rejects `.git`, `auth.json`, `.env`, private keys, `sessions`, and symlinks, and it skips caches such as `node_modules` and `__pycache__`. `readInstance` rejects a `.raga/` directory copied away from its bound project.

Accepted revisions are the only state that `fork` copies and that a session loads. Sessions, kernel snapshots, child checkouts, memory, backend state, and evidence are transient instance state. Rollback does not rewrite them, and `fork` does not copy them.

Every session records a `raga-instance-pin` entry with the instance ID, instance root, revision, and project root. Children, memory retrievals, observations, owned candidates, child workspaces, collected changes, and integration checks append their own custom entries to the session. Git versions files, not external services or running processes.

Instance metadata lives in `.raga/`. User credentials and model configuration stay in `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`. An instance session reads them from there and never copies them into a revision, a fork, or a worker environment.

## Default engineering skills

The bundled harness in `packages/coding-agent/bundled-skills/` installs one skill, `peak`, which indexes 62 references: 55 portable [pstack](https://github.com/cursor/plugins/tree/main/pstack) workflows, the `deslop`, `control-cli`, `control-ui`, and `verify-this` companion workflows from `cursor-team-kit`, the native `create-skill` and `raga-runtime` adapters, and the managed [no-mistakes workflow](https://github.com/kunchenguid/no-mistakes/blob/main/skills/no-mistakes/SKILL.md). The original public no-mistakes text is unchanged under `skills/peak/references/no-mistakes/upstream/`.

### Portable pstack manifest

`bundle.json` pins `cursor/plugins` commit `eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10`, no-mistakes commit `4822244e763fd4c3d7f48be6433f92df10bb5b33` (tag `v1.84.0`), and the published Commander 14.0.0 package. It records the source hash and the adapted hash of every file, the licenses, and adaptation revision `raga-2`. `scripts/raga-sync-skills.mjs` regenerates the bundle from those three source trees and refuses missing, added, or modified source files. `inspectBundledSkills` in `src/core/instances/bundle.ts` checks every declared checksum and rejects unmanifested files.

These 56 upstream pstack skills are included after adaptation:

| Group | Included skills |
|---|---|
| Entry and setup | `peak`, `poteto-help`, `peak-setup` |
| Understanding | `how`, `why`, `teach`, `recall` |
| Design | `architect`, `arena`, `figure-it-out`, `sharpen`, `statechart` |
| Delegation and review | `swarm`, `interrogate`, `no-comments`, `blast-radius`, `reflect` |
| Verification | `create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, `maintain-formal-verification-skill`, `benchmark-checklist`, `tdd`, `show-me-your-work` |
| Communication | `unslop`, `technical-writing`, `bro`, `in-your-own-words`, `ketchup` |
| Code and personalization | `typescript-best-practices`, `correct`, `automate-me` |
| Principles | All 24 `principle-*` skills in the pinned inventory, including their relative references. |

`bundle.json` lists the exclusions: `make-bot-ui`, editor automation endpoints, editor custom modes, the editor dashboard, a persistent wake scheduler, OMP overlays, and global credential installation. `make-bot-ui` depends on Cursor Automations, its webhook service, and the editor's agent panel. `pstack-omp` and OMP worker names are not shipped as raga APIs.

Portable workflows call raga's Python API. Parallel work maps to `rlm_query` children with their own checkouts. Skill authoring goes through `instance.candidate_create`, `candidate_write`, and `candidate_commit`, never through direct writes to an accepted revision. `agents/` holds the `poteto-agent`, `comment-sicko`, and `worker` child specifications and `model-roles.json`. Same-family review seats are not model diversity.

`dependencies.json` declares Node 22.19.0 or newer, Python 3.11 or newer, the vendored Commander, the managed no-mistakes archive digests, and the pinned TLA+ `tla2tools.jar` digest. Bun, a terminal harness, Playwright, Java, Mermaid, and an authenticated `gh` CLI are optional capabilities. A missing optional capability reports its prerequisite and installs nothing.

`init` copies the bundle into the first harness revision. It does not symlink projects to a shared directory. A later package update does not rewrite an existing instance. Bundle updates become reviewed candidate revisions. A fork keeps the source's bundle revision. The skill loader advertises names and descriptions and loads skill bodies on demand, independently of memory retrieval.

### No-mistakes backend contract

The bundle ships the generated public skill, which drives `no-mistakes axi`, not the upstream `.agents/skills/*` maintenance guides. Raga does not reimplement the review, approval, branch-custody, or publication state machines. `NoMistakesBackend` in `src/core/instances/no-mistakes.ts` runs the pinned upstream binary.

- Provisioning downloads `no-mistakes-v1.84.0-<platform>-<arch>.tar.gz` from the tagged GitHub release, checks the per-platform SHA-256 recorded in `NO_MISTAKES_PIN`, extracts only the executable, and checks `--version`. The upstream latest-version installer is never used. Linux and macOS on x64 and arm64 have pinned assets.
- The executable, `HOME`, `NM_HOME`, the XDG directories, the daemon log, and run authorizations live under `.raga/state/backends/no-mistakes/`, outside the harness and the user's home. Ambient environment values and credentials are not copied.
- Discovery stops at an enclosing `.raga` administration directory. Backend agents and their run workspaces do not inherit the parent's instance, memory, sessions, or writable project mount. They remain explicitly authorized external backend processes, not sandboxed `rlm_query` children.
- `NO_MISTAKES_TELEMETRY=off` and `NO_MISTAKES_NO_UPDATE_CHECK=1` are set. `NM_TEST_START_DAEMON=1` keeps upstream from installing an OS service. Raga starts and stops the daemon itself.
- `enable` checks the agent executable's version, its `--mode`, `--session`, `--no-session`, and `--no-context-files` flags, and a JSON-mode probe followed by a resumed probe. The probe answer passes as the bare JSON object or as one fenced JSON block that holds only that object. The probe also requires a session ID, the same ID on resume, and an `agent_end` event. `enable` then writes the backend config and runs upstream `init`, which adds the gate to the project repository.
- `run` passes `axi run --intent <text> --wait 8m --no-publish-intent` and, by default, `--skip push,pr,ci`. The local gate still runs and can fetch remote configuration, so a run is neither offline nor free of side effects. Every result reports `fullyVerified: false` and the skipped steps. Raga records the skipped steps and an intent hash for each run ID, and it reads v1.84.0 run IDs with or without double quotes. Reattaching to an active gate with a different intent or authorization fails.
- The model's Python API allows only `inspect`, `status`, and `run` after you enable the repository. Provisioning, enablement, daemon lifecycle, gate responses, and publication flags are CLI-only operator actions. A nested run inside an outer gate fails.

## Execution boundaries

An instance session always runs in RLM mode with `python` as its only model tool. MCP tools are excluded. The Python kernel runs inside bubblewrap.

- The bubblewrap sandbox starts from an empty root with `--unshare-all`, `--die-with-parent`, `--new-session`, and `--cap-drop ALL`. It mounts system runtime directories and the interpreter's runtime read-only, the pinned harness read-only, and the session's kernel snapshot directory writable. It masks `.git` and `.raga` under every mounted root. It has no network unless a trusted caller sets `network: true`, and no instance session does.
- The root session's writable workspace is the project checkout. A writing child's workspace is its own checkout. `bash()` runs `/bin/bash --noprofile --norc -c` in a fresh sandbox with the session's policy. `edit()` and `write()` run inside the kernel, and the host refuses its own `edit` and `write` tools.
- Sandboxed processes inherit no host environment variables, so credentials do not reach them. Model calls from `llm_query`, `llm_batch`, and children go through the host's model runtime.
- Learned-skill validation adds a seccomp filter to the bubblewrap boundary. A fresh `python -I -B` runner installs the filter before it imports skill code, and the filter refuses process creation and socket creation for the rest of that interpreter's life. The kernel of an ordinary session has no seccomp filter, so its code can start subprocesses inside the sandbox.
- Host extensions in a pinned revision's `extensions/` directory load in the host process with host permissions. Bubblewrap does not confine them. Activation by policy refuses any change to `extensions/` or `settings.json`.
- On macOS, Windows, or a Linux host where the bubblewrap probe fails, an instance session cannot start its kernel. Learned-skill validation and refinement probes also refuse to run.
- Harness proposals cannot target the Node engine, supervisor, evaluator, or permission rules. The bubblewrap guarantee covers instance kernels and probes, not trusted host extensions or the separately enabled external no-mistakes backend.

## Milestones

Each milestone delivers an exercised behavior, not just interfaces or directory scaffolding.

### M9. Instance identity and `.raga` discovery

**Delivered.** `src/core/instances/store.ts` initializes, opens, inspects, and forks instances. `PROJECT_CONFIG_DIR_NAME` in `src/config.ts` is `.raga`, and project discovery of settings, skills, prompts, extensions, packages, MCP configuration, and trust uses it. User configuration stays in `~/.pi`. `src/core/instances/migration.ts` performs the explicit `.pi` migration. `createAgentSession` and `createAgentSessionServices` accept `instance`, open the pin, and load resources only from the pinned checkout. Instance sessions disable project resource discovery, so project files cannot override the pin. `src/cli/instance-command.ts` provides `pi instance`.

**Acceptance.** Two temporary projects load different instructions and skills and keep separate sessions. A harness-only fork contains no credentials, raw memory, or kernel snapshots. Migration with both source and destination present reports the conflict without data loss. Untrusted project extensions remain inactive.

### M9a. Default portable engineering skills

**Delivered.** The bundle, its manifest, licenses, adapters, and child specifications are described in "Default engineering skills". `init` seeds them into every new instance. Conflicts with imported project files fail initialization instead of shadowing a skill. The managed no-mistakes backend implements explicit provisioning, enablement, daemon lifecycle, validation, gate responses, and stop.

**Acceptance.** A fresh instance discovers the complete portable manifest and no-mistakes without manual skill copying. Representative understanding, design, delegation, terminal and browser verification, and skill-authoring workflows execute through real raga adapters. Unsupported optional external capabilities report their prerequisites. No core workflow calls a Cursor endpoint or relies on OMP tools. All bundled references resolve, and licenses and provenance are present.

On an explicitly enabled temporary repository with an authorized test remote and a runnable pipeline agent, no-mistakes runs its real validation path, reports failures and approval requests correctly, and performs no upstream push, PR, or CI operation by default. Initialization leaves the user's home and accepted skill files unchanged. Daemon and process cleanup is observed, and nested gate-control attempts fail. Listing a skill or parsing its Markdown alone is not completion.

### M10. Git-backed revisions and pinned loading

**Delivered.** The harness is a bare Git repository with accepted revisions under `refs/raga/accepted/`. Candidates are writable checkouts committed with `pi instance candidate commit` or by the supervisor. Recommitting unchanged content returns the same revision, and changed content gets a new one, so evidence never covers edited content. `activateRevision` requires explicit approval, the caller's expected active revision, and supervisor evidence whose base is the active revision and whose candidate is the exact commit. The manifest rename under `instance.lock` publishes the new revision, and each decision is recorded first. Pins are read-only plain checkouts. A session's resource loader rejects `extendResources`, and its recorded pin wins over a newer active revision on resume. Changing instances or revisions during a resume fails.

A manual candidate has no evidence of its own. Run `refine` or `skill propose` to produce evidence that `activate` accepts.

**Acceptance.** A session stays on revision A while a new session starts on B. Two competing promotions cannot silently overwrite each other. Resume restores the recorded revision or reports why it is unavailable. Rollback changes subsequent execution without pretending to undo project or external side effects.

### M11. Child workspaces and enforced execution boundaries

**Delivered.** `src/core/instances/workspaces.ts` snapshots the project's tracked files plus explicitly named untracked paths into a commit, using a private index, so the user's index, worktree, and `HEAD` stay unchanged. A writing child gets a plain checkout of that snapshot with no `.git` entry, under `.raga/state/children/`. A nested writer starts from a snapshot of its parent's checkout. Only the supervisor runs Git on these checkouts. It uses config-free Git metadata, the project's object store, and a private index, so project and worker configuration cannot install filters, merge drivers, hooks, or `fsmonitor` for these operations. A `read_only=True` child shares its parent's workspace mounted read-only and needs no Git repository.

Children open settings and resources from the same pin as their parent, not from the parent's loaders. When a child ends, fails, or is cancelled, the supervisor records its files as a change commit under `refs/raga/changes/`. `instance.integrate` merges selected children into a fresh integration checkout one at a time, runs your check command in the sandbox after each merge, and accepts only a passing check that leaves the merged tree unchanged. A conflict leaves the workspace unchanged. A failed, timed out, or aborted check keeps the merged state under `refs/raga/rejected/` and restores the previous head. Removing a workspace first preserves unrecorded work. "Execution boundaries" describes the sandbox.

**Acceptance.** Overlapping edits, conflicting renames, and a clean textual merge that breaks an API contract are exercised. Two child checks passing must not bypass combined verification. Dirty parent snapshots, nested children, stale bases, cancellation, and crash recovery are exercised. Attempts to write the engine, evaluator, parent workspace, or accepted harness fail through both Python and host tools. Worker subprocesses do not inherit credentials.

### M12. Structured memory and promotion

**Delivered.** `src/core/instances/memory.ts` stores every entry version as an immutable file under `.raga/state/memory/`, outside the harness repository. An entry has a stable ID, scope, kind (`observation` or `lesson`), evidence references, an epistemic status (`observed`, `hypothesis`, or `guidance`), a trust level (`unreviewed` or `curated`), applicability conditions, sharing (`project` or `reusable`), and supersession links. `revise` takes an optional `expectedVersion` and fails on a concurrent change. Revision cannot change scope.

A session's `memory.observe` always records an `unreviewed` `hypothesis` in the project's scope. The operator promotes it by revising it through `pi instance memory revise` with curated trust and a stronger epistemic status. Reusable guidance enters the harness only as a `lessons/` file in a candidate revision, which then needs evidence and approval. Cross-project transfer is an explicit `memory export` and `memory import`. Import assigns new IDs, records `importedFrom`, refuses retired entries, and remaps scope only for reusable lessons.

**Acceptance.** Concurrent proposals do not lose updates. Superseded guidance is not treated as current. Project A's facts do not appear in Project B without explicit export. Evidence survives a restart and can be traced from a promoted lesson to its source execution.

### M13. Retrieval gate

**Delivered.** `InstanceMemory.retrieve` filters by scope first, then excludes retired, superseded, unreviewed, hypothesis, task-mismatched, revision-mismatched, and tool-mismatched entries. It ranks the rest lexically, flags declared conflicts and entries that share a `conflictKey` with different text, and selects within a limit and a character budget. Every exclusion is reported with its reason. An empty selection is a valid result. Selected text starts with a header that marks it as untrusted reference data that cannot override goals, policy, acceptance criteria, or limits.

Sessions retrieve at task start (4,000 characters, five entries) and after a failing cell, and the model can call `memory.search` and `memory.get`. Each retrieval is recorded in the session as `raga-memory-retrieval`. A child retrieves for its own task. Refinement sessions turn live memory off and receive only the frozen `probeMemory` text.

**Acceptance.** Relevant lessons are found despite unrelated stored material. Wrong-project, wrong-version, superseded, and contradictory entries are excluded or explicitly flagged. Empty retrieval is valid. Context stays within the configured bound. A comparison of the gate against simple scoped retrieval detects useful lessons it wrongly excludes.

### M14. Portable executable skills

**Delivered.** `src/core/instances/skills.ts` validates a skill directory with `SKILL.md` and `raga-skill.json`. Each behavior case runs in its own fresh sandboxed interpreter with an empty scratch directory as the only writable path and the seccomp filter described in "Execution boundaries". The interpreter sees a copy of the skill code and the case input, never the expected outcome. The supervisor compares outcomes, calls the entry function twice to detect nondeterminism, and rejects undeclared imports, hidden globals, undeclared writes, network or process use, dependency mismatches, timeouts, and a skill directory that changed during validation. The runner's report is parsed as untrusted input, so it can reject a skill but cannot prove an effect is absent.

`proposeSkill` commits the skill into a candidate, validates the exact commit, and records evidence against the base revision. It never activates. Dependencies must already be installed in the interpreter at the declared exact version. Validation installs nothing.

**Acceptance.** A helper learned in one session succeeds in a fresh session on different inputs. A helper relying on an undeclared global fails promotion. Invalid dependencies and attempted sandbox escapes do not produce accepted revisions. Rejected skills leave the active harness unchanged.

### M15. Explicit Propose-Probe-Compose refinement

**Delivered.** `src/core/instances/refinement.ts` owns measurement, and `src/core/instances/model-refinement.ts` drives it with real model sessions. Each proposal or composition is an agent session on the accepted harness whose only writable harness path is its candidate checkout. The editable surface is `AGENTS.md`, `lessons/`, `skills/`, and `agents/`. A checkout that changes anything else, or fails validation of the skill named by `--skill`, is refused before it is committed or measured.

Each probe replay builds a fresh project workspace from one snapshot, runs a real solver session on a private copy of exactly the harness being measured, and then runs your evaluator command in the sandbox. The baseline gets the same replays. Every arm runs at least two replays. With the default zero noise tolerance, any score spread within an arm marks it flaky. A candidate is an improvement only when every replay succeeds and its lowest score exceeds the baseline's highest. Two or more improving proposals are composed, committed, and measured as one exact revision. Outcomes are `improved`, `no-improvement`, `insufficient-evidence`, `blocked` (probes with uncontrolled external effects), and `cancelled`, and the baseline stays eligible in all of them.

`--evaluator` is required for `pi instance refine`, `/refine`, and `pi instance automation checkpoint`. The evaluator directory is absolute, outside the instance, mounted read-only only for the evaluator, and digest-checked during the run, so a change to it ends the run as `insufficient-evidence`. One metered model runtime counts every proposal, composition, solver turn, `llm_query`, `llm_batch`, child, and compaction call against `--max-model-calls` and disables provider retries. Defaults are 30 minutes, 40 model calls, two candidates, two replays, and five minutes per probe. Evidence records what the probe does not cover, such as other tasks, network behavior, live memory, and host extensions. Activation needs `--approved` or a confirmed `/refine`.

**Acceptance.** An improvement, a regression, a neutral edit, a flaky or inconclusive result, a failed composition, budget exhaustion, and an attempt to alter measurement are exercised. A denied or interrupted promotion leaves the active revision intact. Every accepted revision points to the tested commit and evidence. A long-running task can continue unchanged while a candidate is assessed separately.

### M16. Transfer evaluation and bounded automation

**Delivered.** `bench/rlm/instances/` defines recurring task families across repositories with development, selection, and held-out splits, and seven arms: `fixed`, `equal-budget`, `memory`, `skills`, `refinement`, `combined`, and `combined-scoped`. `node bench/rlm/instances/run.mjs --list` prints the arms and cases without contacting a provider. `--scenario` runs the deterministic two-project system scenario with zero model calls. `--run --model provider/id` runs the paid comparison with one call, dollar, and time ledger per arm and repetition. The scenario exercises the system mechanisms only and makes no learning-quality comparison.

`src/core/instances/automation.ts` implements opt-in checkpoint refinement with a minimum interval, daily run, call, and wall-time caps, a stop after repeated runs without progress, and a lock that holds across processes. `src/core/instances/checkpoint.ts` runs one bounded model refinement per admitted call. Policy promotion requires a held-out report outside the project, and its digest is rechecked at each decision.

**Acceptance.** A two-project scenario shows independent evolution, pinned running children, deliberate sharing, and rollback. Held-out comparisons separate the benefit of learning from additional inference spending. Do not claim an adaptive quality gain unless the measured evidence supports it. A negative result keeps automatic promotion disabled.

### Optional verification with Bend

**Delivered.** An instance can require a proof before a harness revision becomes active. The layer stays off unless the operator creates `.raga/verification.json` with `enabled: true` and writes `.raga/verification/LAWS.bend` and `PROOF.bend`. None of those files belong to a harness revision, forks do not copy them, and the sandbox masks `.raga`. Agents therefore cannot enable the layer, weaken a law, or supply their own proof. `pi instance verify enable --approved` writes configuration only and refuses while either file is missing.

`pi instance verify install --approved --network` downloads Bend 2.0.39 for the current platform, checks the pinned SHA-256, keeps the release tree, and records the executable hash. `pi instance verify run [--revision REV]` copies the user's files into a private workspace and runs `bend PROOF.bend` under bubblewrap with no network. A pass requires exit code 0 and `ALL PROOFS CHECK`. The record binds the instance, revision, law digest, proof digest, and tool digest. `activateRevision` refuses a revision with no passing record, or with a record invalidated by an edited law, proof, or tool. `--verdict` is not used because it needs a Lean kernel; run it yourself for that second check.

Inside an interactive session, `/bend-formal` offers three choices: write the laws
yourself (raga creates `LAWS.bend` and `PROOF.bend` templates), describe the rules in
natural language (an agent drafts both files for your review), or check the current laws.
Drafts are written only after you confirm, and enabling remains a separate confirmation.

`pi instance verify suggest` asks the configured agent for law drafts and writes them under `.raga/verification/suggestions/` with `verified: false`. Suggestions carry no proof, never reach the active directory, and cannot satisfy the gate. A human decides what to promote.

**Limits.** A law proves only the Bend code it imports. For a TypeScript or Go project the agent must model the rule in Bend, so a pass is evidence about the model, not about the application. The gate runs on demand and at activation; it is not a commit hook, and it does not run inside every child.

## Dependency order and parallel work

M9 -> M9a -> M10 -> M11 -> M12 -> M13 -> M14 -> M15 -> M16 was the delivery order. M9a packages and adapts existing engineering skills. M14 acquires new executable skills from task experience. Memory retrieval and learned-skill validation depend on the isolation boundary before they execute learned code. Do not parallelize migrations of shared configuration contracts.

## Research mapping

| Source | Mechanism used | Boundary |
|---|---|---|
| [Harness2](https://arxiv.org/abs/2610.14224) | Contrastive proposals, probes, composition, and retained experience. | Add baseline eligibility, explicit rejection, independent evaluation, and safe activation. Checkpoint probes are our adaptation. |
| [ACE](https://arxiv.org/abs/2510.04618) | Itemized lessons, curator deltas, retirement, provenance. | Model-attributed usefulness is not causal evidence. Retrieval gating is a separate design choice. |
| [Voyager](https://arxiv.org/abs/2305.16291) | Reusable executable skill acquisition and retrieval. | Minecraft evidence does not establish coding transfer. Require fresh-kernel and held-out checks. |
| [GEPA](https://arxiv.org/abs/2507.19457) | Diagnostic trace-driven prompt candidates and diverse selection. | Add after M16 establishes reliable evaluation. Do not equate prompt optimization with arbitrary code safety. |
| [Darwin Godel Machine](https://arxiv.org/abs/2505.22954) | Archived alternative lineages and stepping stones. | Preserve Git history now. Defer automated lineage search. Never enable host self-patching or editable evaluators. |
| [SICA](https://arxiv.org/abs/2504.15228) | Cost and time-aware improvement and execution oversight. | Use trusted budget and cancellation controls first. A model overseer is optional and not a security boundary. |
| [Scaling Agent Systems](https://arxiv.org/abs/2512.08296) | Task-dependent delegation and centralized checking. | Compare against sequential execution. More children are not automatically better. |

## Verification and documentation policy

For each implementation milestone, run focused behavior tests and a real smoke scenario for its changed path. Reuse existing suites. Add permanent cases for consumer-visible failures and state transitions, not source layout or forwarding. Use isolated faux-provider tests for deterministic session behavior. Paid model evaluation is a separate, explicitly budgeted benchmark run.

Update [RLM.md](RLM.md), [ARCHITECTURE.md](ARCHITECTURE.md), [PROGRESS.md](PROGRESS.md), relevant configuration, CLI, and session documentation, and broken callers and tests in the same implementation change. Follow repository release rules. Do not hand-edit generated changelogs or upstream package changelogs.

## Not part of this implementation sequence

- Agent-written changes to the Node engine, supervisor, permissions, or evaluator.
- Automatic in-process loading of generated host extensions.
- Live, unreviewed replacement of a running session's harness.
- A vector database before scoped lexical retrieval is measured.
- Full evolutionary population search before candidate evaluation is reliable.
- Automatic publishing of private harnesses or project memory.
- A scheduler that triggers checkpoint refinement on its own.
- Renaming npm packages and the executable as a prerequisite for `.raga` instances.

The goal and metric loop remains a later roadmap item. It will use the same instance, revision, and budget boundaries rather than introduce a second raga lifecycle.
