# RLM benchmark

Compares stock pi tools (arm `pi`) with raga's RLM mode (arm `raga`, `--rlm`) on the same model and the same prompt. It reports success, tokens, cost, wall time, and tool calls per task and arm. This is the M8 baseline in [docs/PROGRESS.md](../../docs/PROGRESS.md).

## Tasks

| Task | What the agent does | Score |
|---|---|---|
| T1 | `messages.txt` holds 800 customer support messages (about 370 KB). Each has a hidden category: billing complaint, shipping delay, product question, praise, or account access. The agent reports how many are billing complaints. | Exact match with the generator's count. The JSON also records the answer and the absolute error. |
| T2 | A small Python package `ledger` (9 modules, pytest suite). The agent renames `apply_tax` to `add_sales_tax`, adds a keyword-only `rounding="half_even"` parameter, and threads it through every direct and indirect caller. | All three: the fixture's own tests pass after the run, a hidden suite passes (new name, `rounding` keyword-only with the default on every caller, correct numbers for each rounding mode), and `apply_tax` no longer appears in `ledger/*.py`. |

T1 is built so that counting keywords fails. Billing complaints come from paraphrase templates with `[a|b|c]` alternatives, many without the words "charge", "bill", or "invoice". Other categories carry distractor sentences that use those words, including resolved past problems ("Please ignore my earlier email about being charged twice, that got sorted.").

Both fixtures are generated from `--seed` (default 1), so reruns see the same data. Prompts and scorers are in `tasks.mjs`; generators are in `fixtures/`.

## Running

The CLI under test is `<RAGA_BENCH_REPO>/pi-test.sh`. Use a separate checkout so edits in your working tree do not change a running benchmark:

```bash
git worktree add /tmp/raga-bench-wt HEAD
(cd /tmp/raga-bench-wt && npm ci --ignore-scripts && npm run generate-models -w packages/ai)

RAGA_BENCH_REPO=/tmp/raga-bench-wt node bench/rlm/run.mjs --task all --arms pi,raga --runs 3 --jobs 4 \
  --extension ~/.pi/agent/extensions/exe-dev/index.ts
```

Options (`--help` prints them):

| Option | Default | Meaning |
|---|---|---|
| `--task T1\|T2\|all` | `all` | Tasks to run. |
| `--arms pi,raga` | `pi,raga` | Arms to run. |
| `--runs N` | `1` | Runs per task and arm. |
| `--model provider/id` | `exe-dev-anthropic/claude-haiku-4-5@llm` | Model for both arms. |
| `--seed N` | `1` | Fixture seed. |
| `--jobs N` | `1` | Runs in parallel. |
| `--timeout-min N` | `15` | A run that takes longer is killed and counts as a failure. |
| `--extension <path>` | none | Load only these extensions (`--no-extensions -e <path>`). Without it, pi discovers extensions as usual. The default model needs the exe-dev extension. |

Each run invokes `pi-test.sh -p --model <model> --session-dir <dir> --no-skills -nc -np --no-mcp [--rlm] <prompt>` in a fresh copy of the fixture, so skills, context files, prompt templates, and MCP do not differ between arms.

T2 needs a Python with pytest, both for the agent and for the scorer. The runner uses `RAGA_BENCH_PYTHON` when set, otherwise `bench/rlm/.venv`, which it creates with `uv` on first use. The venv's `bin` is put first on `PATH` for the agent, so `python -m pytest` works in both arms. The RLM kernel picks its own interpreter (see [docs/RLM.md](../../docs/RLM.md#python-interpreter)).

## Output

Each invocation writes `bench/rlm/results/<timestamp>/`:

- `table.md`: the markdown table that is also printed. Token, cost, wall, and tool-call columns are means over runs.
- `results.json`: the ground truths and one record per run: score fields, `usage` (input, output, cacheRead, cacheWrite, cost), `subUsage` (the part from python tool results, that is, `llm_query`, `llm_batch`, and `rlm_query`), tool calls by name, `subCallSites` (call sites of the sub-LLM functions in python cells), wall time, exit code, timeout flag, and the final answer text.
- `runs/<task>-<arm>-<n>/`: the session JSONL, stdout, and stderr of each run.

Fixture copies stay in `$TMPDIR/raga-bench/<timestamp>/runs/` for inspection.

Token and cost totals sum the usage of every assistant message, every tool result that carries usage (raga's python cells add their sub-LLM usage there), standalone usage entries, and compactions.

## Adaptive instance transfer evaluation

`instances/run.mjs` is the M16 evaluator. It creates two independent Git repositories, `atlas` and `beacon`, with recurring record-normalization and decimal-rounding tasks. Each repository has separate development, selection, and held-out cases. These are synthetic transfer fixtures, not evidence of general coding quality.

The CLI prints validated configuration without contacting a provider. `--list` prints the seven arms and twelve task cases.

```bash
node bench/rlm/instances/run.mjs --help
node bench/rlm/instances/run.mjs --list
node bench/rlm/instances/run.mjs --max-model-calls 80 --budget-usd 5
```

The following commands execute the system smoke or an explicitly authorized provider comparison.

```bash
node bench/rlm/instances/run.mjs --scenario --output /tmp/raga-instance-smoke
node bench/rlm/instances/run.mjs --run --model "$RAGA_MODEL" \
	--runs 5 --seed 1 --max-model-calls 80 --budget-usd 5 \
	--timeout-min 20 --output /tmp/raga-instance-matrix
```

Output directories must be new and outside the checkout, baseline harness, and auth directory. Linux bubblewrap, Python 3, Git with `merge-tree --write-tree`, and the source loader's installed package dependencies are required. The supervisor must be able to create user namespaces. Sandbox failures are failures, not permission to execute unsandboxed.

### Experimental arms

| Arm | Information available to task solvers |
|---|---|
| `fixed` | The unchanged baseline harness. |
| `equal-budget` | The same unchanged harness, with two independent attempts per selection or held-out task. The second attempt receives only the first attempt's public-check output. |
| `memory` | The unchanged harness plus frozen, supervisor-selected lessons from actual development failures. |
| `skills` | A portable Python skill induced by a real model session from development evidence and validated with `proposeSkill`. |
| `refinement` | Model-proposed changes to `skills/transfer-helper/`, evaluated by real task-solving sessions on selection cases. No cross-task memory retrieval. |
| `combined` | Acquired skills, refinement, and gated lexical memory retrieval. |
| `combined-scoped` | The combined arm with simple scoped retrieval instead of applicability, relevance, and conflict gates. |

All arms start from the same baseline content digest. The bundled pstack and no-mistakes resources remain unchanged. `--harness-source PATH` supplies an explicit trusted baseline, including any custom provider extension. `--agent-dir PATH` supplies host-only `auth.json` and `models.json`. Neither auth files nor supervisor output are model-readable.

The runner shuffles the arm order in each repetition and the task order within each split with `--seed`. Every arm finishes development before acquisition or refinement. No selection or held-out result enters cross-task memory or skill acquisition.

Development failures produce reusable lessons with evidence IDs and failure categories. Transfer between repositories uses explicit memory export and import. The runner freezes the selected text and version references for each task attempt. `instanceMemory: false` disables live memory methods and automatic retrieval in root sessions and descendants. The scoped ablation includes active in-scope entries without task filtering, relevance ranking, or conflict rejection, under the same 6,000-character context limit. The report records excluded entries and context bytes. It does not treat excluded entries as proven causal retrieval misses.

Acquisition writes a skill in an isolated scratch workspace. The supervisor validates the model-produced manifest, declared dependencies, fresh-interpreter cases, and side effects before approval-based activation. There is no hand-authored learned helper. Refinement can create the helper when acquisition is absent. Its editable paths are restricted to `skills/transfer-helper/`; changes to the default pack invalidate a candidate before probing.

Each refinement probe runs a real solver against the exact committed baseline or candidate harness in a fresh project workspace. The external selection evaluator scores the resulting `solution.py`. It does not score a hypothetical answer or inspect only the acquired helper. A frozen memory string is identical across the baseline and candidate replays of that refinement. The model driver does not mount the evaluator root into proposer, composer, or solver sessions. Selection scores can guide candidate choice but never enable automatic promotion.

Held-out expected values stay in the supervisor output directory. The held-out observer receives only inputs and returns actual function results, mutation checks, and alias checks. The supervisor compares those results with truth outside the worker. Each task attempt has a fresh session and writer workspace. Held-out changes also pass through the real integration API in a separate workspace. The runner records integration rejection separately from function correctness.

### Budget accounting

`--max-model-calls`, `--budget-usd`, and `--timeout-min` apply to each arm and repetition, including acquisition, proposal, composition, probe solvers, failed requests, and descendant calls. All arms have identical ceilings. No call budget carries between arms.

For a call ceiling `C`, `budgetPlan` allocates the following limits:

- Each development task and each ordinary selection or held-out task receives `max(1, floor(C / 24))` calls.
- Each repository's acquisition receives `floor(0.15 * C / 2)` calls.
- Each repository's refinement receives `floor(0.35 * C / 2)` calls, including its probe solvers.
- The equal-budget control spends the remaining ceiling after its four development tasks across eight selection or held-out tasks. Each task divides its allocation across two retries.

Unused allocations do not move to later phases. At the default ceiling of 80, ordinary tasks receive three calls, acquisition receives six calls per repository, and refinement receives fourteen calls per repository. The equal-budget control receives eight calls per post-development task, split four per retry. Both it and the combined arm can admit at most 76 calls under these allocations. The fixed arm deliberately uses no learning allocation. The equal-budget arm controls for that extra inference.

`--max-output-tokens` defaults to 2,048. Before a request starts, the meter reserves the model's full context-window input cost plus capped output cost. Reservations never decrease, even after failure or cancellation. This can exhaust the dollar ceiling well before the call ceiling. Price overrides are available through `--input-usd-per-million` and `--output-usd-per-million`; the meter uses the larger of each override and the model's configured rates. It rejects missing positive prices or context limits. Unmetered operations and different-model routing are disabled.

Provider-reported usage and dollars remain separate from conservative token-cost estimates. Missing usage or unpriced provider dollars remain `null`. The report includes partial known spend, reservations, unknown counts, and failed calls. A phase-call limit can fail an attempt without consuming a request. Deadline and external cancellation abort the active session. Small limits can prevent a candidate from completing its required repeated probes; that is insufficient evidence, not a quality improvement.

The first 80-call pilot allowed three calls per ordinary task. Its traces stopped during file inspection, and its 30-second refinement replay deadline expired before solving finished. That run cannot establish a learning benefit. A second comparison used `--max-model-calls 240 --budget-usd 50`, with the same ceilings for every arm. It still exhausted conservative dollar reservations in the combined arms. These settings are a recorded pilot, not a validated quality-evaluation recommendation. Refinement allows up to ten minutes per repository and two minutes per replay, clipped to the arm deadline. Assistant error messages, including phase-call exhaustion, are retained in attempt records.

### Results and limits

The CLI prints the JSON result path. Provider runs write `results.json`, raw session JSONL files, and external selection and held-out inputs. Comparisons that include `fixed`, `equal-budget`, and `combined` also write `holdout.json` in the supervisor output directory. The deterministic scenario writes `scenario.json`.

`results.json` records configuration, model, environment, baseline and evaluator digests, pinned harness revisions, task order, all observed attempts, learning results, rejected candidates, and per-request ledgers. Summaries include held-out successes with the full planned denominator, missing attempts, per-repetition success-rate median and range, costs, wall time, failure statuses, repeated mistake categories, integration failures, and per-project differences from the fixed arm. The final scheduled retry determines the equal-budget arm's score. Held-out truth never chooses the best retry. Missing final attempts count as failures.

The scenario uses real instance storage, Git commits, memory transfer, concurrent sandboxed OS writers, isolated integration, repeated exact-commit evaluation, compare-and-swap promotion, a running pinned process, and rollback. Its scripted transformation is an explicit system fixture. It makes zero provider calls and is not a learned-quality comparison.

No script enables checkpoint automation or automatic promotion. A held-out report must beat both controls by the configured policy margin with sufficient trials before that policy can even be considered independently. A smoke run, incomplete matrix, budget-exhausted run, or helper validation alone is not that evidence. Repeated synthetic cases do not establish statistical confidence or cross-model generalization. Causal retrieval omissions and performance limiters remain unmeasured.

### Recorded Haiku pilot

The completed 2026-10-25 run used `exe-dev-anthropic/claude-haiku-4-5@llm`, seed 2, one repetition, two repositories, and four held-out tasks per arm. Each arm had ceilings of 240 model calls, $50 in conservative reservations, and 20 minutes. Raw evidence is in `/tmp/raga-instance-matrix-seed2/results.json` and its adjacent `holdout.json` and session transcripts.

| Arm | Held-out successes | Total model calls |
|---|---:|---:|
| Fixed | 2/4 | 115 |
| Equal-budget retries | 3/4 | 192 |
| Memory | 3/4 | 115 |
| Skills | 1/4 | 150 |
| Refinement | 4/4 | 192 |
| Combined | 0/4 | 192 |
| Combined, scoped retrieval | 0/4 | 192 |

These are outcomes under the configured limits, not evidence of a learning gain. No refinement candidate was activated. Rejections included exhausted probe-call budgets, an empty candidate, and edits outside the permitted surface. The refinement arm's score therefore cannot be attributed to an accepted harness change.

Both combined arms exhausted conservative dollar reservations during their first held-out task. Their remaining held-out attempts admitted no model calls and count as failures under the planned denominator. Some skill proposals also failed metadata validation. These outcomes do not isolate whether the learned artifacts would improve solving under a different allocation.

The policy gate refused promotion because four trials per arm are below its minimum of 20. The combined arm also failed to outperform either control. Automatic promotion remains disabled. A larger trial count alone would not fix the allocation and activation limitations observed here.

