<p align="center">
  <img alt="The eight-handled wheel of Mahoraga" src="docs/images/mahoraga-wheel.png" width="560">
</p>

<h1 align="center">raga</h1>

<p align="center"><i>あらゆる事象への適応<br>Adaptation to every phenomenon.</i></p>

Raga is an opinionated coding harness, forked from [pi](https://github.com/badlogic/pi-mono). It makes a few choices for you instead of leaving them as options:

- The model works inside a persistent Python REPL, a native [Recursive Language Model](https://arxiv.org/abs/2512.24601) runtime. It keeps large inputs and its history in variables instead of its context window, and calls sub-LLMs and recursive sub-agents from code.
- Every session loads one engineering playbook skill, `peak`, with its references and the no-mistakes workflow.
- `/tenmo` tracks every running session across folders and worktrees, and `/diff` reviews changes without leaving the terminal.
- `/btw <question>` asks a side question about the conversation, even mid-run. The answer reuses the prompt cache and is not saved to the session.
- Model pickers show only current OpenAI and Anthropic models.

The name comes from Mahoraga in *Jujutsu Kaisen*, whose wheel turns after each hit so the same attack works less well. A harness that improves at a task each time the task repeats is still the long-term goal. The pieces for it exist as experimental instance mode (Linux only), and no measurement has shown that improvement yet.

## Status

The RLM runtime, subagents, `peak`, and tenmo work end to end. Instance mode, which lets a project's harness revise its own prompts, memories, and skills, is experimental and needs Linux. [docs/PROGRESS.md](docs/PROGRESS.md) tracks every milestone with the evidence for it.

| Part | State |
|---|---|
| Persistent Python kernel owned by each session | Done |
| `--rlm` mode, with `python` as the only model tool | Done |
| `llm_query` and `llm_batch` sub-LLM calls, counted in session cost | Done |
| `context.task`, `context.inputs`, and `context.history()`, which includes compacted messages | Done |
| `rlm_query` recursive sub-agents, with a depth limit and parallel runs | Done |
| Kernel variables saved and restored across resume and fork | Done |
| Kernel memory limit and memory reporting | Done |
| Session tracking across folders (`/tenmo`) | Done |
| Native engineering skills (`peak`, no-mistakes) | Done |
| Self-editing harness state (prompt notes, memories, skills) with rollback | Experimental, Linux only |
| Benchmarks: pi against raga, and transfer across instances | Planned |
| Goal and metric loop (`--goal`, `--gate`, `--metric`) | Not started |

User-facing commands and messages use Raga branding. The SDK packages retain their upstream names (`@earendil-works/pi-*`); imports, extension APIs, and protocol identifiers are not renamed. The `raga` command keeps its own user directory, `~/.raga/agent`, for logins, settings, sessions, skills, extensions, and packages. Set `RAGA_CODING_AGENT_DIR` to move it. It does not read `~/.pi/agent` or the shared `~/.agents/skills` folder, so an existing pi setup does not carry over. The `pi` command still uses `~/.pi/agent`.

## Run it

Raga needs Node.js 22.19 or newer, `uv`, and an AI provider that pi supports. On macOS, Linux, or WSL, the installer sets these up, asks you to log in, and offers to install Bend for the `bend` skill:

```bash
curl -fsSL https://raw.githubusercontent.com/mr-jones123/raga/main/install.sh | sh
```

Or install it from npm:

```bash
npm install -g raga-cli
raga --login
```

### Update

Exit raga, then run:

```bash
raga update
raga --version
```

This installs the latest published `raga-cli` release without deleting your settings or sessions. Restart raga afterward. If an older version cannot update itself, run `npm install -g raga-cli@latest`. See [docs/UPDATING.md](docs/UPDATING.md) for other update targets, source checkouts, and troubleshooting.

### Run from source

To run from source instead:

```bash
git clone https://github.com/mr-jones123/raga.git
cd raga
npm ci --ignore-scripts
npm run generate-models -w packages/ai
npm run build
./raga
```

`./raga` runs the bundled build. It reaches the first frame in roughly half a second.

```bash
./raga-test.sh
```

Every session loads one skill, `peak`. It indexes 62 engineering references under `skills/peak/references/`, including the pstack playbooks and the managed no-mistakes workflow. Run `/skill:peak` and let it pick the reference for the task.

While Python cells run, a small dashboard shows each active cell with a spinning wheel and its own color.

`./raga-test.sh` runs the TypeScript sources through the resolver, so edits apply without a build. Module loading costs about a second more, because Node strips and resolves the whole source graph on every start. Use it while changing the code, and `./raga` otherwise.

On the first `--rlm` run, raga creates a Python 3.11 environment with `uv` at `~/.raga/agent/rlm/venv`. To use another interpreter, set `RAGA_PYTHON`.

Without `--rlm`, raga behaves like pi, with `read`, `bash`, `edit`, and `write` as model tools.

## Track sessions

If you keep many worktrees, or run one or two sessions per project, `/tenmo` shows every running raga session on the machine in one list: its folder, whether it is working, waiting on you, or idle, the message it was started with, and what it is doing now. Press Enter to jump to its tmux pane, or `x` twice to end it and delete its history.

```
/tenmo                                              # the dashboard
/tenmo @../theHub-v2-flaky-test fix the flaky test  # start a session there in a new tmux window
raga tenmo                                          # the same list from any terminal
```

See [docs/TENMO.md](docs/TENMO.md).

## Review changes

`/diff` opens a read-only Git review dashboard. Browse changes by category (tests, modules, GitHub workflows, documentation, dependencies, configuration), inspect staged or working-tree changes, or pick a commit from history. Open a file to scroll its diff, and toggle to its full contents without leaving raga. See [docs/DIFF.md](docs/DIFF.md) for controls.

## Subagents

Each `rlm_query` child is its own named Raga session with its own Python kernel. Run `/agents-tui` to see them as a tree, from the session at depth 0 down through each level of subagents, with each one's state, model, tokens, cost, and turns. Open one to read its cells or steer it. Run `/agent-setup` to choose which model each workflow role (such as `arena runners` or `bug-fix`) uses. See [docs/AGENTS.md](docs/AGENTS.md).

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

## Docs

| File | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pi base works and where raga's layers attach. |
| [docs/RLM.md](docs/RLM.md) | The RLM runtime reference. |
| [docs/AGENTS.md](docs/AGENTS.md) | Subagent sessions and the `/agents-tui` tree. |
| [docs/TENMO.md](docs/TENMO.md) | Track, start, and delete sessions across folders and worktrees. |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Milestones, status, and decisions. |
| [docs/UPDATING.md](docs/UPDATING.md) | Install and update the CLI, extensions, and model catalogs. |
| [docs/RELEASING.md](docs/RELEASING.md) | Automatic npm publishing, versioning, and merging upstream pi. |
| [packages/coding-agent/docs/](packages/coding-agent/docs/) | Pi's own docs, which still apply to everything raga inherits. |

## Development

```bash
npm run check                                     # Lint, format, and type check
./test.sh                                         # Tests without API keys
uv run --no-project --with pytest --with dill \
  pytest packages/coding-agent/python/tests -q     # Python kernel tests
node scripts/raga-release.mjs version             # Version from raga release tags
```

Commit headers follow Conventional Commits. Semantic-release generates `CHANGELOG.md`, version tags, and GitHub Releases after CI passes on `main`. See [docs/RELEASING.md](docs/RELEASING.md). [AGENTS.md](AGENTS.md) has the rules for humans and agents.

## Credits

- [pi](https://github.com/badlogic/pi-mono) by Mario Zechner and contributors, the base of this repository (MIT).
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) by Prime Intellect, whose REPL design the kernel adapts (MIT).
- [Recursive Language Models](https://arxiv.org/abs/2512.24601) by Alex L. Zhang, Tim Kraska, and Omar Khattab.
- The wheel image is from *Jujutsu Kaisen* by Gege Akutami (Shueisha), taken from the [Jujutsu Kaisen Wiki](https://jujutsu-kaisen.fandom.com/wiki/Eight-Handled_Sword_Divergent_Sila_Divine_General_Mahoraga). It is used here as a fan reference and is not covered by this repository's license.

## License

MIT
