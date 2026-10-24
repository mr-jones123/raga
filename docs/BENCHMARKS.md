# Benchmarks

The RLM benchmark in [`bench/rlm/`](../bench/rlm/README.md) runs the same model and prompt on two arms: `pi` (stock tools: `read`, `bash`, `edit`, `write`) and `raga` (`--rlm`, where `python` is the only model tool). It reports success, tokens, cost, wall time, and tool calls per task and arm.

## Tasks

| Task | What it measures |
|---|---|
| T1 | Long-context judgment. `messages.txt` holds 800 customer support messages (about 370 KB) with hidden categories; the agent reports how many are billing complaints. Billing complaints are paraphrased and other categories carry billing words as distractors, so keyword counting fails. Success is an exact match with the generator's count. |
| T2 | A real multi-file refactor. In a 9-module Python package, rename `apply_tax` to `add_sales_tax`, add a keyword-only `rounding="half_even"` parameter, and thread it through every direct and indirect caller. Success needs the visible tests, a hidden suite, and no leftover `apply_tax` in `ledger/*.py`. |

## Rerunning

```bash
git worktree add /tmp/raga-bench-wt HEAD
(cd /tmp/raga-bench-wt && npm ci --ignore-scripts && npm run generate-models -w packages/ai)
RAGA_BENCH_REPO=/tmp/raga-bench-wt node bench/rlm/run.mjs --task all --arms pi,raga --runs 3 --jobs 4 --seed 1 \
  --extension ~/.pi/agent/extensions/exe-dev/index.ts
```

Each invocation writes `bench/rlm/results/<timestamp>/` with `table.md`, `results.json`, and the session of every run. See the [README](../bench/rlm/README.md) for options.

## Results

Both runs: 2026-10-24, model `exe-dev-anthropic/claude-haiku-4-5@llm`, seed 1, N = 3 runs per task and arm. Token, cost, wall, and tool-call columns are means.

### Before the `read` fix (`results/2026-10-24T21-05-31-972Z`)

| Task | Arm | Success | Input tok | Output tok | Cache read/write tok | Cost $ | Wall s | Tool calls | Detail |
|---|---|---|---|---|---|---|---|---|---|
| T1 | pi | 0/3 | 2,189 | 5,623 | 407,379/78,434 | 0.1691 | 63 | 11.3 (bash 5.7, read 5.7) | answers 160/156/102 (truth 181); mean abs err 41.7 |
| T1 | raga | 0/3 | 33,414 | 10,529 | 131,672/15,235 | 0.1183 | 96 | 13.7 (python 13.7) | answers 24/53/27 (truth 181); mean abs err 146.3; sub-LLM $0.0348 |
| T2 | pi | 3/3 | 22,824 | 9,066 | 337,126/17,166 | 0.1233 | 101 | 40.3 (bash 11.0, edit 8.7, read 20.0, write 0.7) | visible 3/3, hidden 3/3, old name gone 3/3 |
| T2 | raga | 3/3 | 8,576 | 10,534 | 259,954/21,172 | 0.1137 | 111 | 26.7 (python 26.7) | visible 3/3, hidden 3/3, old name gone 3/3 |

In RLM mode, Python `read()` went through pi's `read` tool, which stops at 2000 lines or 50 KB and appends the truncation note at the end. In all three raga T1 runs the model loaded messages 1-109 of 800 into a variable and never saw the note. On those 109 messages its `llm_batch` count matched the truth.

### After the `read` fix (`results/2026-10-24T21-25-22-039Z`)

Python `read()` now reads the file in the kernel and returns all of it, and the `rlm` prompt section says to load large files into a variable and to classify many records with chunked `llm_batch` calls that return structured output, parsed and checked in Python.

| Task | Arm | Success | Input tok | Output tok | Cache read/write tok | Cost $ | Wall s | Tool calls | Detail |
|---|---|---|---|---|---|---|---|---|---|
| T1 | pi | 0/3 | 2,286 | 16,977 | 1,567,569/74,487 | 0.3370 | 188 | 27.3 (bash 23.3, read 4.0) | answers 125/169/102 (truth 181); mean abs err 49.0 |
| T1 | raga | 0/3 | 140,106 | 6,701 | 20,989/39,786 | 0.2254 | 60 | 8.0 (python 8.0) | answers 182/175/191 (truth 181); mean abs err 5.7; sub-LLM $0.1922 |
| T2 | pi | 2/3 | 20,217 | 9,425 | 303,259/19,197 | 0.1217 | 100 | 35.7 (bash 9.0, edit 8.3, read 18.0, write 0.3) | visible 3/3, hidden 2/3, old name gone 3/3 |
| T2 | raga | 2/3 | 11,717 | 7,500 | 169,426/14,738 | 0.0846 | 78 | 21.0 (python 21.0) | visible 3/3, hidden 2/3, old name gone 3/3 |

### What limits each number

- T1 pi: the model reads the file in pages, then writes regex classifiers in bash/python and tunes them against spot checks, so paraphrased complaints without billing words are missed (T1-pi-1 counted 125, T1-pi-3 counted 102).
- T1 raga: all 800 messages now reach the sub-LLM in every run and every record is counted; what remains is per-message classification error of the sub-model. T1-raga-1 got 182 with exactly one false positive (MSG 0681, an installment question that mentions an already refunded late fee) and no misses; T1-raga-3 classified one message per prompt and got 191, with praise and product questions also off (126 and 141 against 144 and 134).
- T2 pi: T2-pi-1 left `daily_report` without the `rounding` parameter, an indirect caller, so 4 hidden tests fail.
- T2 raga: T2-raga-2 left `build_invoice` without `rounding`, so 18 hidden tests fail; it stopped after 53 s and 17 cells, earlier than the passing runs (90 s, 23 cells).
