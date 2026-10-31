---
name: raga-artifacts
description: Make shareable slides and documents for developers and clients, with Mermaid diagrams rendered by Pele, exported as a self-contained HTML file and a PDF. Use when the user asks for a deck, slides, a report, a proposal, a one-pager, or another polished document to share.
---

# Raga artifacts

You make slides and documents the user can send to developers and clients. You write one static HTML source file. The builder renders its Mermaid diagrams to SVG with Pele, highlights code, inlines local images, and prints a PDF with headless Chrome. The results are `dist/<name>.html`, which works offline, and `dist/<name>.pdf`.

## Load the helper

Work in the Python tool:

```python
exec(await read("<directory of this SKILL.md>/artifact_tool.py"), globals())
artifact_setup("<directory of this SKILL.md>")
```

## Steps

1. **Ask what to make.** Ask the user, then wait for the answer:
   - Slides or a document?
   - Who reads it: developers, clients, or both?
   - What should the reader know or decide at the end?
   - Which material should it use: files, notes, or this conversation?
   - Is there a theme or brand color?

   If the user already answered these, do not ask again.
2. **Outline.** Propose an outline: one line per slide, or one line per section. Wait for approval before you write the full artifact. Keep decks to 6 to 12 slides unless the user asks for more.
3. **Start from a template.** Run `artifact_new("slides", "artifacts/<name>/<name>.html")` or `artifact_new("doc", ...)`. The default folder is `artifacts/` in the project. Use the template's markup and classes.
4. **Write the content.** Edit the source file with the edit or write tools.
5. **Build and look.** Run `result = await artifact_build(path, preview=True)`. If `result["ok"]` is false, fix every item in `problems` and build again. Fix every item in `layout`: each one is a slide or block that does not fit its page. Read every item in `warnings`. If your tools can show you images, open `result["preview"]` and fix crowded slides, unreadable diagrams, and awkward empty space. The Python REPL's `read` returns raw bytes for images, so in a REPL session rely on `layout` and ask the user to look at the PDF.
6. **Hand it over.** Give the user the PDF path and the HTML path. Report the slide or page count and any warning you did not fix. Then offer the sharing options below.

## Writing rules

- Each slide makes one point, and its title states that point as a sentence. Use at most five bullets.
- For clients, lead with the outcome and the decision you need. For developers, show the design, the trade-offs, and the code.
- Prefer a diagram, a table, or one large number over a paragraph.
- Do not invent numbers, quotes, logos, or customer names. Use only what the user or the project provides, and mark estimates as estimates.

## Markup

The templates define these pieces. Combine them instead of writing new CSS:

| Markup | Use |
|---|---|
| `<section class="slide">` | One slide. Add `title`, `section`, or `statement` for those layouts. |
| `<div class="kicker">` | Small label above a title |
| `<div class="cols" style="--cols: 3">` | Columns. The default is 2. |
| `<div class="card">` | A boxed group |
| `<div class="stat"><div class="value">42%</div><div class="label">...</div></div>` | A large number |
| `<div class="callout good">` | A highlighted note. Variants are `good`, `warn`, and `bad`. |
| `<span class="tag">` | A small label |
| `<pre class="mermaid">...</pre>` | A diagram in Mermaid syntax. Escape `<`, `>`, and `&` as `&lt;`, `&gt;`, and `&amp;`. |
| `<pre><code class="language-ts">...</code></pre>` | Code, highlighted at build time |
| `<img src="images/x.png">` | A local image, inlined at build time |
| `<div class="footer">` | Slide footer |
| `<div class="page-break">` | Start a new page in a document |

Set the theme with `data-theme` on `<html>`. The values are `light`, `dark`, and `ink`. To use a brand color, change `--accent` and `--accent-soft` in the `:root` block. Diagrams take their colors from the same variables.

## Diagrams

Pele renders these 32 diagram types. Pick the type that fits the point, not always a flowchart. Before you write a type for the first time in a session, read its example in [diagrams.md](diagrams.md). Always do this for keywords that end in `-beta` and for `eventmodeling`, because their syntax is new.

| Type | Keyword | Use for | Audience |
|---|---|---|---|
| Flowchart | `flowchart LR` | Processes, decisions, pipelines | both |
| Sequence | `sequenceDiagram` | Requests between services or people over time | developers |
| Class | `classDiagram` | Types, interfaces, and their relations | developers |
| State | `stateDiagram-v2` | Lifecycles and state machines | developers |
| Entity relationship | `erDiagram` | Database tables and relations | developers |
| C4 | `C4Context` | System context, containers, components | both |
| Architecture | `architecture-beta` | Cloud and service topology with groups and icons | both |
| Block | `block` | Layered or grid layouts of components | developers |
| Packet | `packet` | Bit and byte layouts of protocols or file formats | developers |
| Git graph | `gitGraph` | Branching and release strategy | developers |
| Agentflow | `agentflow-beta` | AI agent and tool-call workflows | developers |
| Railroad | `railroad-ebnf-beta` | Grammar and syntax rules | developers |
| Event modeling | `eventmodeling` | Commands, events, and views of an event-driven system | developers |
| Requirement | `requirementDiagram` | Requirements and what satisfies or verifies them | both |
| Gantt | `gantt` | Schedules with tasks and dependencies | clients |
| Timeline | `timeline` | Milestones and history | clients |
| Kanban | `kanban` | Work status by column | clients |
| User journey | `journey` | Steps a user takes, with satisfaction scores | clients |
| Mindmap | `mindmap` | Topics and ideas branching from one center | clients |
| Use case | `usecase-beta` | Actors and what they can do | both |
| Swimlane | `swimlane-beta` | A process split by team or role | clients |
| Tree view | `treeView-beta` | File trees and hierarchies | developers |
| Pie | `pie` | Parts of a whole, at most six slices | clients |
| XY chart | `xychart` | Bar and line charts over a series | clients |
| Quadrant chart | `quadrantChart` | Two-axis prioritization, such as effort against impact | clients |
| Sankey | `sankey` | Flows of volume, money, or traffic between stages | clients |
| Treemap | `treemap-beta` | Sizes of nested parts, such as cost or code by module | both |
| Radar | `radar-beta` | Comparing options across several criteria | clients |
| Venn | `venn-beta` | Overlap between groups | clients |
| Ishikawa | `ishikawa-beta` | Root causes of a problem, fishbone style | both |
| Cynefin | `cynefin-beta` | Sorting problems by how predictable they are | clients |
| Wardley map | `wardley-beta` | Strategy: components by visibility and maturity | clients |

Keep a slide diagram to about 15 nodes. If a diagram fails to build, the problem names the diagram number. Compare it with the example and fix the syntax.

## Limits the builder enforces

- No `<script>`, `<iframe>`, `<object>`, or `<embed>`. Artifacts are static so they print and share safely.
- No remote images, stylesheets, or fonts. Download images next to the source. Fonts come from the reader's system: the theme lists Inter first and falls back to system fonts.
- A slide whose content overflows its 1600 by 900 frame adds a PDF page. The builder warns when the page count differs from the slide count.

## Sharing

The PDF is the default deliverable. It opens everywhere and looks the same for every reader. The HTML file is a second copy for screens.

Offer these only when the user asks for a link, and run any of them only after the user agrees, because each one publishes the file:

- A secret GitHub gist: `gh gist create dist/<name>.html`. Anyone with the link can read it. GitHub shows HTML in a gist as source code, so readers must download the file to view it.
- A static host the user already uses, such as GitHub Pages.
