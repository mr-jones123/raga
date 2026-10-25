<p align="center">
  <img alt="The eight-handled wheel of Mahoraga" src="docs/images/mahoraga-wheel.png" width="560">
</p>

<h1 align="center">raga</h1>

<p align="center"><i>あらゆる事象への適応<br>Adaptation to every phenomenon.</i></p>

In *Jujutsu Kaisen*, the wheel above Mahoraga turns each time it takes a hit, and after every turn the same attack works less well. Raga is a coding harness built on that idea. Give it a long task, such as a refactor, a model training run, or a port of a legacy codebase, and it keeps working until a goal or a metric is met. Each error and each finished feature should make the next run of the same task smoother, with fewer mistakes.

Raga is a fork of [pi](https://github.com/badlogic/pi-mono). It adds a native [Recursive Language Model](https://arxiv.org/abs/2512.24601) runtime. The model works inside a persistent Python REPL, keeps large inputs and its history in variables instead of its context window, and calls sub-LLMs and recursive sub-agents from code.

## Status

The RLM runtime works end to end. The adaptive layer, which lets the harness rewrite its own prompts, memories, and skills, is the next step. [docs/PROGRESS.md](docs/PROGRESS.md) tracks every milestone with the evidence for it.

| Part | State |
|---|---|
| Persistent Python kernel owned by each session | Done |
| `--rlm` mode, with `python` as the only model tool | Done |
| `llm_query` and `llm_batch` sub-LLM calls, counted in session cost | Done |
| `context.task`, `context.inputs`, and `context.history()`, which includes compacted messages | Done |
| `rlm_query` recursive sub-agents, with a depth limit and parallel runs | Done |
| Kernel variables saved and restored across resume and fork | Done |
| Kernel memory limit and memory reporting | Done |
| Self-editing harness state (prompt notes, memories, skills) with rollback | Not started |
| Goal and metric loop (`--goal`, `--gate`, `--metric`) | Not started |
| Native engineering skills (pstack, no-mistakes) | Not started |

The packages and the binary still use pi's names (`@earendil-works/pi-*`, `pi`, `~/.pi`). A rename to `raga` comes later.

## Run it from source

Raga needs Node.js 22.19 or newer, `uv`, and an AI provider that pi supports.

```bash
git clone https://github.com/mr-jones123/raga.git
cd raga
npm ci --ignore-scripts
npm run generate-models -w packages/ai
./pi-test.sh --rlm
```

On the first `--rlm` run, raga creates a Python 3.11 environment with `uv` at `~/.pi/agent/rlm/venv`. To use another interpreter, set `RAGA_PYTHON`.

Without `--rlm`, raga behaves like pi, with `read`, `bash`, `edit`, and `write` as model tools.

## What the model does in RLM mode

The kernel already exists when the model's first turn starts. Each `python` call runs a cell, and variables stay defined for the whole session. The model sees at most `rlm.outputLimit` characters of each cell's output. The full output stays in `cells`.

```python
import collections

text = await read("messages.txt")              # the whole file, kept in a variable
lines = text.splitlines()
chunks = [lines[i:i + 40] for i in range(0, len(lines), 40)]
labels = await llm_batch(
    ["Label each message, one label per line:\n" + "\n".join(c) for c in chunks]
)
counts = collections.Counter(l.strip() for answer in labels for l in answer.splitlines())
print(counts.most_common(5))
```

| Name | Use |
|---|---|
| `read`, `bash`, `edit`, `write` | Files and the shell. |
| `llm_query`, `llm_batch` | One sub-LLM call, or many in parallel. |
| `rlm_query` | Run a child session with its own kernel and return its answer. |
| `context` | The task, input files from `--rlm-input`, and the session history. |
| `cells` | The full output of every finished cell. |

[docs/RLM.md](docs/RLM.md) is the reference for the protocol, the Python API, the settings, and the memory limit.

## Benchmarks

`bench/rlm/` runs the same tasks with pi's tools and with raga's RLM mode on the same model. The table shows Claude Haiku 4.5, seed 1, and 3 runs per row.

| Task | Harness | Success | Mean answer error | Cost per run |
|---|---|---|---|---|
| T1: count billing complaints among 800 messages (truth 181) | pi | 0/3 | 49.0 | $0.337 |
| | raga | 0/3 | 5.7 | $0.225 |
| T2: multi-file Python refactor | pi | 2/3 | | $0.122 |
| | raga | 2/3 | | $0.085 |

[docs/BENCHMARKS.md](docs/BENCHMARKS.md) has the full numbers, the first run before a fix, and what limits each result.

## Docs

| File | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pi base works and where raga's layers attach. |
| [docs/RLM.md](docs/RLM.md) | The RLM runtime reference. |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Milestones, status, and decisions. |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Benchmark tasks and results. |
| [docs/RELEASING.md](docs/RELEASING.md) | Versioning, the generated changelog, and merging upstream pi. |
| [packages/coding-agent/docs/](packages/coding-agent/docs/) | Pi's own docs, which still apply to everything raga inherits. |

## Development

```bash
npm run check                                     # Lint, format, and type check
./test.sh                                         # Tests without API keys
uv run --no-project --with pytest --with dill \
  pytest packages/coding-agent/python/tests -q     # Python kernel tests
node scripts/raga-release.mjs check               # Commit headers since the last release
```

Commit headers follow Conventional Commits, and `scripts/raga-release.mjs` builds `CHANGELOG.md` from them. [AGENTS.md](AGENTS.md) has the rules for humans and agents.

## Credits

- [pi](https://github.com/badlogic/pi-mono) by Mario Zechner and contributors, the base of this repository (MIT).
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) by Prime Intellect, whose REPL design the kernel adapts (MIT).
- [Recursive Language Models](https://arxiv.org/abs/2512.24601) by Alex L. Zhang, Tim Kraska, and Omar Khattab.
- The wheel image is from *Jujutsu Kaisen* by Gege Akutami (Shueisha), taken from the [Jujutsu Kaisen Wiki](https://jujutsu-kaisen.fandom.com/wiki/Eight-Handled_Sword_Divergent_Sila_Divine_General_Mahoraga). It is used here as a fan reference and is not covered by this repository's license.

## License

MIT
