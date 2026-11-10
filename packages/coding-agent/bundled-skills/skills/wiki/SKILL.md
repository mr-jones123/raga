---
name: wiki
description: Read, search, write, and organize notes in the user's Obsidian vault through the Obsidian CLI. Use when the user asks to save something to their notes, wiki, or vault, look something up in it, ingest a source, update a project page, work with the daily note, tasks, tags, or properties, or tidy up links.
---

# Obsidian wiki

The user's vault holds their long-lived notes. Read it before you answer from memory, and write to it only what the user asked for or agreed to. You work through the `obsidian` CLI, which drives the running Obsidian app, so links, properties, and the search index stay consistent.

## Load the helper

Work in the Python tool. Load the helper beside this file:

```python
exec(await read("<directory of this SKILL.md>/wiki_tool.py"), globals())
print(find_obsidian(), await vaults())
```

If `find_obsidian()` returns `None`, ask the user to enable the CLI in Obsidian under Settings > General > Command line interface. If a call times out, ask the user to open Obsidian. Do not install anything.

`obsidian(command, *flags, vault=..., **params)` runs any CLI command and raises `ObsidianError` on failure. The CLI prints errors such as `Error: File "x.md" not found.` with exit code 0, so check results through the helper, not with a bare `bash` call.

## Pick the vault

Call `await vaults()`. If the user named a vault, use it. If there is only one, use it. Otherwise ask which vault before you write anything. Pass `vault=` on every call; never rely on whichever vault is active.

## Read the vault's rules first

Call `await vault_guide(vault)` before your first write. A vault's `AGENTS.md`, `CLAUDE.md`, or `README.md` overrides the defaults below: folder layout, templates, required frontmatter, files agents must never edit, search tools, logs to append to, and commit rules. Follow it exactly. If it names a search tool other than the CLI, use that tool for search.

Without a guide, learn the conventions from the vault itself: `obsidian("folders", vault=v)`, `obsidian("templates", vault=v)`, `obsidian("properties", "counts", vault=v)`, `obsidian("tags", "counts", vault=v)`, and two or three existing notes in the target folder.

## Find and read

- `await search(query, vault)` returns files with matching lines. Narrow with `folder=` and `limit=`.
- `await read_note(path, vault)` reads one note. Use `path=` with the folder and `.md` extension. `file=` resolves a name like a wikilink and can pick the wrong note when names repeat.
- `obsidian("backlinks", vault=v, path=p, format="json")` and `obsidian("links", vault=v, path=p)` show how a note connects. `orphans`, `deadends`, and `unresolved` find gaps.
- `obsidian("outline", vault=v, path=p, format="json")` lists headings. `property:read`, `tags`, `tasks`, and `daily:read` read the rest.

When you answer from the vault, name the notes you used as `[[Note title]]` links.

## Write

1. Search first. Update an existing note rather than creating a near duplicate.
2. Create with `await create_note(path, content, vault)`. It refuses an existing path, because the CLI would silently create `Name 1.md` next to it. Pass `overwrite=True` only after the user agrees to replace that note.
3. Add to a note with `await append_note(path, content, vault, heading=None)`. With `heading=`, the text goes at the end of that section. Prefer appending over rewriting, and never rewrite text the user wrote in their own voice.
4. Set frontmatter with `await set_property(path, name, value, vault, type=None)`. Fill every property the vault's notes or templates use.
5. Start a new note from the vault's template for that kind of note. Copy its frontmatter and headings, and replace template placeholders such as `<% ... %>` or `{{date}}` with real values. Write dates as absolute dates.
6. Link related notes with `[[wikilinks]]` in both directions. Embed images with `![[file.png]]`.
7. Read the note back and confirm the change landed where you meant.

The CLI turns the characters `\n` and `\t` in content into a newline and a tab. The helpers detect content that contains them, such as code, and write that file directly on disk instead, which keeps it intact.

## Organize

- `obsidian("move", vault=v, path=p, to="folder/")` and `obsidian("rename", vault=v, path=p, name="New title")` let Obsidian update links to the note. Never move or rename notes with shell commands.
- `obsidian("delete", vault=v, path=p)` moves a note to the trash. Delete only when the user asks. Use the `permanent` flag only when they ask for permanent deletion.
- `obsidian("task", "done", vault=v, ref="path.md:12")` marks a task done. `daily:append` and `daily:prepend` add to today's daily note.

## Leave alone unless asked

Do not run `eval`, `dev:*`, `plugin:*`, `theme:*`, `snippet:*`, `sync`, `sync:restore`, `history:restore`, `restart`, or `reload` unless the user asks for that action. Do not edit files under `.obsidian/`. Do not send note contents to external services. Run `obsidian("help", "<command>")` to see one command's options; bare `obsidian help` may not exit.

## Report

Tell the user which notes you read, created, or changed, by path, and what you changed in each. Mention any rule from the vault guide you could not follow and why.
