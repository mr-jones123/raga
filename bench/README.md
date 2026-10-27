# Raga learning pilot

Compare plain pi, fresh Raga, and learning Raga on 24 pinned DeepSWE tasks.
All model calls use `exe-dev-openai/gpt-6.1-sol@llm` with medium reasoning.
This is a small pilot, not a production qualification or a claim of improvement.

## Methodological source

This pilot draws on Ruiyao Xu et al.,
[Harness²: Recursive Agent Harnessing for an Open World](https://arxiv.org/abs/2610.14224),
arXiv:2610.14224v1, 9 October 2026.
The [full paper](https://arxiv.org/html/2610.14224v1) describes the relevant methods.

- Section 2.3 describes retaining harness components and improvement experience
  across tasks. Each new task starts from the common base execution harness;
  accumulated experience guides its adaptation.
- Section 3.1 describes sequential evaluation with an initially empty library
  and three runs with shuffled task orders.
- Section 4, Table 3, compares adaptation with and without the cross-task
  library. This motivates our learning-Raga versus fresh-Raga comparison.

Our three conditions are our experimental design, not the paper's exact
baseline set. Our repository-paired held-out split and source-first stream
ordering are also our choices. The pilot retains prose lessons only, while
Harness² can retain executable harness components and improvement experience.
Our default single repetition does not reproduce the paper's three-run setup.
We use independent DeepSWE verification rather than the paper's professional
benchmarks. This is an adaptation of its evaluation ideas, not a replication.

## Conditions

| Condition | Within-task adaptation | Between-task state |
|---|---|---|
| `pi` | None. Native pi tools. | None. |
| `fresh-raga` | Reference attempt, lesson consolidation, clean final attempt. | None. |
| `learning-raga` | The same adaptation pipeline. | Bounded lessons from earlier tasks. |

Raga adaptation in this pilot changes textual lesson memory only. It does not
measure unrestricted executable harness evolution or reproduce Harness² exactly.
The consolidator produces at most three prose lessons. Structural validation
checks fields, lengths, and obvious patch payloads. It does not prove truth or
prevent every form of solution memorization. Imported lessons are explicitly
marked as guidance. Their provenance remains available for inspection.

Every reference and final attempt starts from the task's original image.
Consolidation uses another clean checkout and a bounded record of the reference
attempt. Only the final patch enters the independent DeepSWE verifier.
Verifier grades never enter consolidation or determine which lessons persist.
No source patches, conversations, kernels, or working directories cross tasks.

## Sample and protocols

`deepswe/benchmark.config.json` freezes 12 same-repository pairs, source commits,
image digests, dataset revision, and budgets before outcomes are observed.
Repository matching is the selection rule. It does not establish that paired
changes require the same technique. This is a convenience sample across Go,
Python, and TypeScript projects. Dataset language labels are retained verbatim
and can be inaccurate. The upstream `koota-entity-snapshot-rollback` task was
excluded because its base commit field is not a full commit hash.

- `stream` runs all source tasks, then all target tasks. Seeded shuffling changes
  order within each half and interleaves conditions per task. Learning Raga
  retains lessons throughout the stream. This deliberately provides a gap
  between related tasks. It is not an unconstrained random workload.
- `transfer` keeps a separate learning state per pair. Learning Raga retains
  source lessons, then evaluates its target without retaining target lessons.
  Final solves still perform the same within-task adaptation in both Raga
  conditions. Target rows are the held-out comparison.

Each full protocol has 72 scored attempts per repetition. Analysis separates
source and target outcomes. Multiple task orders are needed before interpreting
small differences. One extra success among 24 tasks changes the rate by about
four percentage points. Do not claim significance from a single run.

## Run

Requirements are Linux, Docker, Python 3.11 or newer, installed repository
dependencies, and a configured exe.dev provider extension. Source images and
runtime provisioning require network access. Task and verifier containers have
no network. Host credentials remain in the host broker, not in containers.

Run from the repository root.

```sh
node --import ./packages/coding-agent/src/experimental/source-resolver.ts bench/run.mjs list
node --import ./packages/coding-agent/src/experimental/source-resolver.ts bench/run.mjs preflight
node --import ./packages/coding-agent/src/experimental/source-resolver.ts bench/run.mjs smoke
node --import ./packages/coding-agent/src/experimental/source-resolver.ts bench/run.mjs run --protocol stream
node --import ./packages/coding-agent/src/experimental/source-resolver.ts bench/run.mjs run --protocol transfer
node --import ./packages/coding-agent/src/experimental/source-resolver.ts bench/run.mjs analyze bench/deepswe/results/RUN_DIRECTORY
```

Use `bench/deepswe/results/RUN_DIRECTORY` when invoking analysis from the
repository root. `--families anko,httpx` runs a subset. `--seed` and
`--repetitions` control task orders. `--provider-extension` and
`--host-agent-dir` override host provider discovery. No fallback model is allowed.

Smoke uses one paired family and twelve calls per task. It verifies execution,
lesson handling, patch collection, and scoring. Its outcomes are not quality
measurements. A failed smoke run must be fixed before a full run starts.

## Budgets and isolation

The default task allowance is 40 model calls and a 20-minute inference deadline
for reference, consolidation, and final solving combined. Stage setup counts
against that deadline. Archival, patch collection, and cleanup are separate
supervisor work. Process termination has a short grace period. Total reported
wall time includes that overhead and the verifier. The verifier scores the
produced patch even if the final attempt exhausts its allowance. A final prose
answer is not required. Execution termination is recorded separately. Reference is capped at ten calls and
consolidation at six. Unused calls flow to the final solve. Plain pi receives
all 40 calls. Nested calls debit the same broker ledger. The external verifier
has a separate 30-minute limit. Actual tokens, reported cost, errors, and wall
time remain in the artifacts.

The default run-wide reservation cap is $30. `--max-dollars` changes it. The
broker reserves the full model context and maximum response cost before each
request. Concurrent calls share that reservation account. A failed request
without reliable accounting consumes its full reservation. This is a
conservative accounting guard, not a promise about an external provider's bill.
A cap interruption makes the matrix incomplete. Analysis does not present an
incomplete run as a completed comparison. There is no automatic paid retry.

Each run freezes a source snapshot under `/tmp/cedar-*`. Runtime containers
read that snapshot, so concurrent development does not change their agent code.
Installed dependencies are copied into the snapshot and mounted read-only. Each container receives two CPUs and 6 GiB RAM. Image preparation
is lazy. The runner stops below 3 GiB free rather than deleting existing caches.
Large source images can still exceed available storage during a pull.

Raga masks Git metadata. All conditions receive the same clarification that the
supervisor handles branches and commits. The supervisor captures the final
workspace patch. This differs from DeepSWE's original commit instruction.
Nested bubblewrap requires the extra container capabilities and relaxed seccomp,
AppArmor, and system-path settings recorded in environment metadata. Containers
are not privileged, but this is not a hardened multi-tenant sandbox.

## Artifacts and checks

New runs go under `bench/deepswe/results/`. Existing results and cached datasets
are preserved. Each run writes fsynced configuration, event, and result JSONL.
Trial directories contain every stage's output, session records, imported and
proposed lessons, retained-state snapshots, patch, and raw verifier output.
The configuration includes task order, source digest, and experiment policy.
A truncated JSONL line is an error. Trial IDs cannot repeat within a journal.
There is no automatic resume. A new invocation starts a new experiment.

```sh
node --import ./packages/coding-agent/src/experimental/source-resolver.ts --test bench/deepswe/protocol.test.mjs bench/deepswe/broker.test.mjs
```

The previous synthetic RLM and handoff runners have been removed. Their existing
cached data and result directories are not deleted.
