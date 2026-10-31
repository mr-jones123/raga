"""Artifact helpers for the raga Python REPL. Load with exec(await read(path), globals()), then call artifact_setup."""

import json
import os
import shlex
import shutil

ARTIFACT_SKILL_DIR = None


def artifact_setup(skill_dir):
    """Remember where this skill lives so the other helpers find the builder and templates."""
    global ARTIFACT_SKILL_DIR
    ARTIFACT_SKILL_DIR = os.path.abspath(skill_dir)


def _skill(path):
    if ARTIFACT_SKILL_DIR is None:
        raise RuntimeError("Call artifact_setup(<directory of the raga-artifacts SKILL.md>) first")
    return os.path.join(ARTIFACT_SKILL_DIR, path)


def artifact_new(kind, path):
    """Copy the slides or doc template to path. Refuses to overwrite an existing file."""
    if kind not in ("slides", "doc"):
        raise ValueError('kind must be "slides" or "doc"')
    path = os.path.abspath(path)
    if os.path.exists(path):
        raise FileExistsError(path + " exists. Edit it, or choose another path")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    shutil.copyfile(_skill(os.path.join("templates", kind + ".html")), path)
    return path


async def artifact_build(source, pdf=True, preview=False, out=None):
    """Build source into dist/<name>.html and, by default, dist/<name>.pdf. Returns the builder's JSON.

    ok is False with a problems list when a diagram fails, the source has scripts or remote assets,
    or no browser is found. preview=True also writes dist/<name>.png for a visual check.
    """
    command = "node " + shlex.quote(_skill("artifact.mjs")) + " build " + shlex.quote(os.path.abspath(source))
    if out:
        command += " --out " + shlex.quote(os.path.abspath(out))
    if not pdf:
        command += " --no-pdf"
    if preview:
        command += " --preview"
    runner = globals().get("bash")
    if runner is None:
        raise RuntimeError("artifact_build runs in the raga Python REPL, where bash is available")
    output = await runner(command + " 2>&1; true", timeout=300)
    start = output.find("{")
    if start < 0:
        return {"ok": False, "problems": [output.strip()], "warnings": []}
    return json.loads(output[start:])
