import asyncio
import json
import os
import shlex
from pathlib import PurePosixPath

ORDINARY_READ_ONLY = "This child shares the parent's checkout in an ordinary raga session, and raga does not enforce read-only access here. Do not create, edit, delete, format, stage, or commit files. Do not run commands that write to the project."


def harness_mode():
    return "instance" if os.environ.get("RAGA_INSTANCE_ID") else "ordinary"


async def agent_roles():
    """Role table children resolve against: /agent-setup choices in ordinary sessions, the pinned agents/model-roles.json in instance sessions."""
    from raga_rlm import host_request
    return await host_request({"type": "agent.roles"})


async def run_child(spec, task, resource_root, context_data=None, model=None, max_turns=None, read_only=True, details=False, role=None, seat=None):
    if spec not in ("worker", "poteto-agent", "comment-sicko"):
        raise ValueError("Unknown bundled child specification")
    if not read_only and not details:
        raise ValueError("Writing children require details=True for supervisor-owned change evidence")
    ordinary = harness_mode() == "ordinary"
    if ordinary and not read_only:
        raise ValueError("Ordinary raga sessions have no isolated child workspaces. Make the change in this session and use read_only=True children for exploration and review")
    root = resource_root.rstrip("/")
    definition = json.loads(await read(root + "/agents/" + spec + ".json"))
    definition_path = PurePosixPath(definition["instructions"])
    if definition_path.is_absolute() or ".." in definition_path.parts:
        raise ValueError("Child instructions must stay in the pinned resource root")
    instructions = await read(root + "/" + definition["instructions"])
    for name in definition["skills"]:
        path = root + ("/skills/peak/SKILL.md" if name == "peak" else "/skills/peak/references/" + name + "/SKILL.md")
        instructions += "\n\n" + await read(path)
    if model is None and role is None:
        role = definition["modelRole"]
    notice = "\n\n" + ORDINARY_READ_ONLY if ordinary else ""
    prompt = instructions + "\n\nPinned resource root: " + root + notice + "\n\n# Assignment\n" + task
    if model is not None:
        role, seat = None, None
    return await rlm_query(prompt, context=context_data, model=model, max_turns=max_turns, read_only=read_only, details=details, role=role, seat=seat)

async def capability_report():
    commands = {
        "node": "node -e " + shlex.quote("const [major,minor]=process.versions.node.split('.').map(Number); if(major<22 || (major===22 && minor<19)) throw new Error('Node >=22.19.0 required'); console.log(process.versions.node)"),
        "git": "git --version",
        "terminal": "python3 -c " + shlex.quote("import pty; print('pty available')"),
        "java": "java -version",
        "github": "gh --version",
        "browser": "node -e " + shlex.quote("const p=require('playwright'); const fs=require('node:fs'); const exe=p.chromium.executablePath(); if(!fs.existsSync(exe)) throw new Error('Approved browser provisioning required'); console.log(JSON.stringify({version:require('playwright/package.json').version,executable:exe}))"),
        "mermaid": shlex.quote(os.environ.get("MERMAID_CLI", "mmdc")) + " --version",
        "tla": "python3 -c " + shlex.quote("import hashlib,os,pathlib; path=os.environ.get('TLA2TOOLS'); assert path, 'Approved TLC provisioning required'; assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() == 'd15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f', 'TLC checksum mismatch'; print('TLC 1.8.0')"),
    }
    report = {}
    for name, command in commands.items():
        try:
            report[name] = {"available": True, "output": await bash(command, timeout=10)}
        except Exception as error:
            report[name] = {"available": False, "reason": str(error)}
    return report
