# DeepSWE sample benchmark

Runs two pinned [DeepSWE](https://github.com/datacurve-ai/deep-swe) tasks against
this checkout on `exe-dev-openai/gpt-6.1-sol@llm` with high reasoning. It compares the
same agent in three conditions:

- **base pi**: native tools from this checkout, RLM and instance skills disabled.
- **fresh raga**: a new instance on the shipped harness, no experience from the other task.
- **experienced raga**: the same instance protocol after a validated skill was acquired
  from the earlier task and activated.

It also measures mid-task handoff: one raga run is paused at a completed tool boundary,
the container is committed, and three continuations start from that checkpoint with the
same remaining budget.

Nothing here claims a quality gain. `analyze` prints outcomes and activation counts only.

## Requirements

- Linux, Docker, and `git`.
- A host `~/.pi/agent` with credentials for `exe-dev-openai/gpt-6.1-sol@llm` and the
  `exe-dev` provider extension, or explicit `--host-agent-dir` and
  `--provider-extension` paths.
- Python 3.11+ on the host for task TOML parsing.
- About 30 GB of free image storage.

Host credentials and extensions never enter a task container. Only the host broker
process loads them; containers reach the broker through a per-trial Unix socket.

## Run it

```bash
# No model calls: print the pinned task and experiment configuration.
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  bench/deepswe/run.mjs list

# Fetch the pinned task files and build agent and verifier images.
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  bench/deepswe/run.mjs prepare

# Three-call pipeline check on the first task. Not a quality comparison.
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  bench/deepswe/run.mjs smoke

# Matched comparisons. Every trial records its own budget.
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  bench/deepswe/run.mjs run --protocol baseline --repetitions 3

node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  bench/deepswe/run.mjs run --protocol handoff --repetitions 3

node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  bench/deepswe/run.mjs run --protocol transfer --repetitions 3

# Summarize one run folder. Reads only the recorded JSONL.
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  bench/deepswe/run.mjs analyze bench/deepswe/results/<run-id>
```

`run` accepts `--task`, `--max-model-calls`, `--timeout-min`, `--handoff-after`,
`--learning-calls`, `--output`, and `--cache`. The model, reasoning level, dataset
revision, task IDs, base commits, and image digests are fixed in
`benchmark.config.json`; changing the model is refused.

## Artifacts

Each invocation writes one folder under `results/` containing append-only JSONL:

| File | Contents |
|---|---|
| `config.jsonl` | One row: model, limits, protocol, source digest, and policy statements. |
| `events.jsonl` | Image preparation, container creation, every model call, checkpoints, verifier start and end. |
| `results.jsonl` | One row per trial: status, reward, patch digest, ledger, learning activation, and errors. |

Rows are fsynced and carry a sequence number. `results.jsonl` rejects duplicate trial
IDs, and a truncated final line is an error rather than silently dropped data.
Per-trial folders hold `stdout.jsonl`, `stderr.log`, `session-artifacts/`, `model.patch`,
and the verifier's raw output. These are not tracked by git.

## Protocol

**Baseline.** Both arms receive the same instruction, 2 CPUs, 8 GB, no network, and the
same model-call and wall-clock caps. The only difference is the agent: base pi versus a
fresh raga instance.

**Handoff.** Raga is paused at the first completed root tool boundary after
`handoffAfterCalls`. The broker exposes a per-trial Unix socket and refuses the next
request with `CHECKPOINT`, which lets the CLI dispose and flush its kernel snapshot. The
trial only counts as a checkpoint when the CLI exited, the session ends at a completed
tool result, and, for raga, the snapshot file exists. The container is then committed.
Three continuations start from that image with the same remaining call allowance:

- the original session resumed with one recorded continue prompt;
- a new session with a handoff note produced from a separate short continuation;
- a new session with the task instruction only.

The raga variants may differ in harness state: a new session still has the accepted
harness and instance memory records, but not the earlier conversation or kernel.

**Transfer.** The source task runs, then a charged learning session writes a portable
Python skill into an isolated directory with no evaluator access. The supervisor
validates it in a fresh interpreter with bubblewrap and seccomp, activates it only if
every case passes, and exports the accepted harness. Only new files under
`skills/anko-engineering/` may differ from the baseline harness. The target task then
runs base pi, fresh raga, and raga seeded with that accepted skill. No source workspace,
conversation, patch, or memory crosses over.

Activation means the skill exists in the target harness. It does not mean the agent read
or used it; the target session transcripts are kept so that use can be inspected.
Grading remains DeepSWE's verifier in a separate offline container.

## Budget

Limits are per trial, not shared across arms: `taskModelCalls`, `taskTimeoutMs`,
`learningModelCalls`, `learningTimeoutMs`, and a per-request `maxOutputTokens`. Worst-case
output tokens are therefore `taskModelCalls × maxOutputTokens`. Actual provider usage and
cost are recorded per call, or `null` when the provider reports none; there is no hard
dollar cap. `handoffAfterCalls` counts root calls. Every continuation's allowance is
`taskModelCalls − all prefix calls`, so the prefix plus a continuation cannot exceed one
task budget.

## Known limits

- Two tasks from one repository family. Neither result generalizes to other languages,
  repositories, or models.
- The supervisor creates the patch commit for both arms, because raga's sandbox masks
  `.git`. This is a recorded protocol deviation from DeepSWE's own harness.
- The task images need extra container capabilities (`SETUID`, `SETGID`, `SETFCAP`) and
  unconfined seccomp, AppArmor, and system paths so nested bubblewrap can create
  namespaces. There is no `SYS_ADMIN` and no privileged container; all task containers
  still run with `--network none`.
- Base pi's shell can reach its broker socket; raga's sandbox cannot. The broker meters
  and caps every request either way, but the reachability asymmetry is recorded.
- Task images declare no volumes. A checkpoint is a Docker image commit of `/app` and
  the session state.
- Results are valid only for the recorded source and image digests. Re-running after any
  edit produces a different `sourceDigest` in `config.jsonl`.

## When a trial fails

Provider failures are recorded, not retried: an exhausted quota, a rejected key, or a
transport error ends the agent process, and the trial keeps the verifier's reward for
whatever patch existed (usually 0). Check `events.jsonl` for `model_error` and the
provider's message, then rerun after fixing credentials or quota. A handoff run without a
real `checkpoint` outcome records `protocol_incomplete` instead of fabricating a
continuation.
