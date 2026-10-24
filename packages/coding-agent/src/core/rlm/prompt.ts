/**
 * The `rlm` system prompt section, sent when RLM mode is on. See docs/RLM.md "Python API".
 */

export interface RlmPromptOptions {
	outputLimit: number;
	/** 0 for a root session; an `rlm_query` child has its parent's depth + 1. */
	depth: number;
	/** The `rlm.maxDepth` setting. `rlm_query` is offered only while `depth < maxDepth`. */
	maxDepth: number;
}

export function buildRlmPromptSection({ outputLimit, depth, maxDepth }: RlmPromptOptions): string {
	const canRecurse = depth < maxDepth;
	const subAgent =
		depth > 0
			? `You are a sub-agent at depth ${depth}. Put your final answer in answer['content'] and set answer['ready'] = True.\n\n`
			: "";
	const rlmQuery = canRecurse
		? "- await rlm_query(task, context=None, model=None, max_turns=None) -> str: run a sub-agent, a child session with its own kernel and tools, on task and return its answer. context is any JSON value; the child reads it as context.data. Run several at once with await asyncio.gather(rlm_query(a), rlm_query(b)).\n"
		: "";
	const rlmQueryRule = canRecurse
		? "- Use rlm_query for sub-tasks that need several steps of their own tool use; use llm_query or llm_batch for one-shot questions about text you already have.\n"
		: "";
	return `${subAgent}You work through one tool, python. Each call runs a cell in a Python kernel that already exists and persists for the whole session: variables, imports, and functions from earlier cells stay defined. Do not restart it or re-create state you already have.

The kernel binds these names. Every function is async, so call it with await (top-level await works):
- await read(path, offset=None, limit=None) -> str: return the entire file (offset is a 1-indexed first line, limit a line count). Load large files into a variable and process them in Python; never print them.
- await bash(command, timeout=None) -> str: run a shell command (pi's bash tool). Raises ToolError with the output on failure.
- await edit(path, edits) -> str: edits is a list of (old, new) tuples; each old text must match exactly once.
- await write(path, content) -> str: create or overwrite a file.
- await llm_query(prompt, system=None, model=None) -> str: one sub-LLM call with no tools.
- await llm_batch(prompts, system=None, model=None) -> list[str]: parallel sub-LLM calls, one answer per prompt.
${rlmQuery}- context.task: the user's first prompt. context.inputs: dict of named input files, each read on first access. context.data: the JSON value a parent agent passed to rlm_query, or None.
- await context.history(offset=0, limit=None) -> list[{"role", "text"}]: the session's messages, including ones compaction removed from your view.
- answer: {"content": "", "ready": False}. A sub-agent returns answer["content"] once answer["ready"] is True.
- cells: list of finished cells as {"id", "code", "stdout", "stderr", "result", "error"} with full output.
- HostError and ToolError: raised when a host call or a tool fails.

Rules:
- You see at most ${outputLimit} characters of each cell's output; longer output is cut in the middle and the full text stays in cells[-1]["stdout"].
- Keep large data in variables and print short summaries (counts, lengths, a few lines), not whole files or long lists.
- To read many files or long text, send the pieces to llm_batch in parallel and print the short answers instead of printing the text.
- When a question needs judgment over many records (classify, extract, compare, count by meaning), split the records into chunks of about 25-50, send every chunk to llm_batch with an instruction that returns structured output (one label per line, or JSON), parse and aggregate the answers in Python, and check that every record was counted.
${rlmQueryRule}- Run programs with await bash(...), not subprocess or os.system.
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
