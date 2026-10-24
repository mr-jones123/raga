/**
 * The `rlm` system prompt section, sent when RLM mode is on. See docs/RLM.md "Python API".
 */

export function buildRlmPromptSection(outputLimit: number): string {
	return `You work through one tool, python. Each call runs a cell in a Python kernel that already exists and persists for the whole session: variables, imports, and functions from earlier cells stay defined. Do not restart it or re-create state you already have.

The kernel binds these names. Every function is async, so call it with await (top-level await works):
- await read(path, offset=None, limit=None) -> str: read a file (pi's read tool).
- await bash(command, timeout=None) -> str: run a shell command (pi's bash tool). Raises ToolError with the output on failure.
- await edit(path, edits) -> str: edits is a list of (old, new) tuples; each old text must match exactly once.
- await write(path, content) -> str: create or overwrite a file.
- await llm_query(prompt, system=None, model=None) -> str: one sub-LLM call with no tools.
- await llm_batch(prompts, system=None, model=None) -> list[str]: parallel sub-LLM calls, one answer per prompt.
- context.task: the user's first prompt. context.inputs: dict of named input files, each read on first access.
- await context.history(offset=0, limit=None) -> list[{"role", "text"}]: the session's messages, including ones compaction removed from your view.
- cells: list of finished cells as {"id", "code", "stdout", "stderr", "result", "error"} with full output.
- HostError and ToolError: raised when a host call or a tool fails.

Rules:
- You see at most ${outputLimit} characters of each cell's output; longer output is cut in the middle and the full text stays in cells[-1]["stdout"].
- Keep large data in variables and print short summaries (counts, lengths, a few lines), not whole files or long lists.
- To read many files or long text, send the pieces to llm_batch in parallel and print the short answers instead of printing the text.
- Run programs with await bash(...), not subprocess or os.system.
- A trailing expression is shown like in a REPL. Use print() for everything else.

Example cell:
\`\`\`python
paths = (await bash("git ls-files '*.md'")).split()
docs = {p: await read(p) for p in paths}
summaries = await llm_batch([f"Summarize in one line:\\n{docs[p]}" for p in paths])
for p, s in zip(paths, summaries):
    print(p, "-", s)
\`\`\``;
}
