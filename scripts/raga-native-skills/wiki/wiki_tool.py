"""Obsidian CLI helpers for the raga Python REPL. Load with exec(await read(path), globals()).

The `obsidian` CLI talks to the running Obsidian app. It reports most failures on stdout with exit
code 0, so every call here checks the output and raises ObsidianError instead.
"""

import asyncio
import json
import os
import shlex
import shutil

OBSIDIAN_TIMEOUT = 60
MAC_APP = "/Applications/Obsidian.app/Contents/MacOS/obsidian"
# The vault's own rules for agents, read before any write.
GUIDE_FILES = ("AGENTS.md", "CLAUDE.md", "README.md")


class ObsidianError(Exception):
    """The CLI is missing, timed out, or reported an error."""


def find_obsidian():
    """Path of the obsidian CLI, or None. OBSIDIAN_BIN wins, then PATH, then the macOS app bundle."""
    for candidate in (os.environ.get("OBSIDIAN_BIN"), shutil.which("obsidian"), MAC_APP):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _failed(output):
    first = output.strip().splitlines()[0] if output.strip() else ""
    return first.startswith("Error:") or first in ("Vault not found.", "Command not found.")


async def obsidian(command, *flags, vault=None, timeout=OBSIDIAN_TIMEOUT, **params):
    """Run one CLI command and return its stdout. Flags are bare words such as "total"; params are key=value.

    obsidian("read", vault="wiki", path="concepts/Note.md")
    obsidian("search", vault="wiki", query="row lock", format="json", limit=10)
    """
    binary = find_obsidian()
    if binary is None:
        raise ObsidianError("The obsidian CLI was not found. Ask the user to enable it in Obsidian: Settings > General > Command line interface.")
    args = [binary, command]
    if vault:
        args.append(f"vault={vault}")
    args += [f"{key}={value}" for key, value in params.items() if value is not None]
    args += list(flags)
    line = " ".join(shlex.quote(arg) for arg in args)
    runner = globals().get("bash")
    try:
        if runner is not None:
            output = await runner(line + " 2>&1", timeout=timeout)
        else:
            process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout)
            output = stdout.decode("utf-8", "replace")
    except Exception as error:
        raise ObsidianError(f"obsidian {command} failed or timed out. Is the Obsidian app running? {error}") from error
    if _failed(output):
        raise ObsidianError(output.strip())
    return output.rstrip("\n")


async def vaults():
    """Known vaults as [{"name", "path"}]."""
    output = await obsidian("vaults", "verbose")
    rows = [line.split("\t", 1) for line in output.splitlines() if "\t" in line]
    return [{"name": name, "path": path} for name, path in rows]


async def vault_path(vault):
    return await obsidian("vault", vault=vault, info="path")


async def vault_guide(vault):
    """The vault's agent instructions (AGENTS.md, CLAUDE.md, or README.md at its root), or None."""
    root = await vault_path(vault)
    for name in GUIDE_FILES:
        path = os.path.join(root, name)
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as handle:
                return {"path": name, "text": handle.read()}
    return None


async def note_exists(path, vault):
    try:
        await obsidian("file", vault=vault, path=path)
        return True
    except ObsidianError as error:
        if "not found" in str(error):
            return False
        raise


async def read_note(path, vault):
    return await obsidian("read", vault=vault, path=path)


async def search(query, vault, limit=20, folder=None, context=True):
    """Matches as parsed JSON. With context, each file lists its matching lines."""
    output = await obsidian("search:context" if context else "search", vault=vault, query=query, path=folder, limit=limit, format="json")
    return json.loads(output) if output.strip() else []


def _literal_escapes(content):
    # The CLI turns the two characters \n and \t into a newline and a tab, which would corrupt code.
    return "\\n" in content or "\\t" in content


async def _write_file(path, content, vault, mode):
    root = await vault_path(vault)
    target = os.path.realpath(os.path.join(root, path))
    if not target.startswith(os.path.realpath(root) + os.sep):
        raise ObsidianError(f"{path} is outside the vault")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, mode, encoding="utf-8") as handle:
        handle.write(content)
    return path


async def create_note(path, content, vault, overwrite=False):
    """Create a note at an exact path. Refuses an existing note unless overwrite=True.

    The CLI would otherwise create "Name 1.md" next to the existing note without saying so.
    """
    exists = await note_exists(path, vault)
    if exists and not overwrite:
        raise ObsidianError(f"{path} already exists. Read it and append, or pass overwrite=True after the user agrees.")
    if _literal_escapes(content):
        return await _write_file(path, content, vault, "w")
    await obsidian("create", *(["overwrite"] if exists else []), vault=vault, path=path, content=content)
    return path


async def append_note(path, content, vault, heading=None):
    """Append to a note, or to the end of one heading's section."""
    if _literal_escapes(content):
        if heading:
            raise ObsidianError("Content with literal \\n or \\t cannot go under a heading through the CLI. Append it to the end instead.")
        root = await vault_path(vault)
        with open(os.path.join(root, path), encoding="utf-8") as handle:
            existing = handle.read()
        return await _write_file(path, ("" if not existing or existing.endswith("\n") else "\n") + content, vault, "a")
    await obsidian("append", vault=vault, path=path, content=content, heading=heading)
    return path


async def set_property(path, name, value, vault, type=None):
    """Set one frontmatter property. type is text, list, number, checkbox, date, or datetime."""
    return await obsidian("property:set", vault=vault, path=path, name=name, value=value, type=type)
