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
