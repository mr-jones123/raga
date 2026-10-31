"""Bend helpers for the raga Python REPL. Load with exec(await read(path), globals())."""

import asyncio
import hashlib
import json
import os
import re
import shlex
import shutil

BEND_INSTALL = "curl -fsSL https://bend-lang.com/install.sh | sh"
CHECK_TIMEOUT = 600


def find_bend():
    """Path of the bend executable, or None. BEND_BIN wins, then PATH, then the installer's default."""
    for candidate in (os.environ.get("BEND_BIN"), shutil.which("bend"), os.path.expanduser("~/.bend/bin/bend")):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def law_files(project="."):
    """Where LAWS.bend and PROOF.bend belong, and whether this session may write there.

    An ordinary session writes the files the instance gate reads: .raga/verification/<laws> and <proof>,
    named by .raga/verification.json. An instance session cannot write .raga, so it drafts under
    verification-draft/ for the user to copy.
    """
    project = os.path.abspath(project)
    names = {"laws": "LAWS.bend", "proof": "PROOF.bend"}
    config = os.path.join(project, ".raga", "verification.json")
    if os.path.isfile(config):
        with open(config, encoding="utf-8") as handle:
            data = json.load(handle)
        names = {key: data.get(key) or default for key, default in names.items()}
    instance = bool(os.environ.get("RAGA_INSTANCE_ID"))
    directory = os.path.join(project, "verification-draft" if instance else os.path.join(".raga", "verification"))
    return {
        "directory": directory,
        "laws": os.path.join(directory, names["laws"]),
        "proof": os.path.join(directory, names["proof"]),
        "mode": "instance" if instance else "ordinary",
    }


async def _run(command, cwd):
    line = "cd " + shlex.quote(cwd) + " && " + command + " 2>&1; printf '\\nEXIT=%s\\n' $?"
    runner = globals().get("bash")
    if runner is not None:
        output = await runner(line, timeout=CHECK_TIMEOUT)
    else:
        process = await asyncio.create_subprocess_shell(line, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        stdout, _ = await asyncio.wait_for(process.communicate(), CHECK_TIMEOUT)
        output = stdout.decode("utf-8", "replace")
    body, _, code = output.rstrip().rpartition("\nEXIT=")
    return body.strip(), int(code) if code.strip().isdigit() else None


async def bend_guide(topic=None):
    """The Bend guide text, or one named sub-guide such as "shaders"."""
    bend = find_bend()
    if bend is None:
        raise RuntimeError("bend is not installed. Ask the user to run: " + BEND_INSTALL)
    output, code = await _run(shlex.quote(bend) + " guide" + ((" " + shlex.quote(topic)) if topic else ""), os.getcwd())
    if code != 0:
        raise RuntimeError(output)
    return output


def _digest(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def approve_laws(laws_path):
    """Record the laws the user approved. Call only after the user says yes."""
    with open(laws_path + ".approved", "w", encoding="utf-8") as handle:
        handle.write(_digest(laws_path) + "\n")


def _problems(proof_path):
    with open(proof_path, encoding="utf-8") as handle:
        proof = handle.read()
    imported = re.search(r"^import\s+\./(\S+)\s+as\s+Laws\s*$", proof, re.M)
    if not imported:
        return ["PROOF.bend must import the laws file as Laws"]
    problems = []
    if re.search(r"^law\s", proof, re.M):
        problems.append("PROOF.bend states a law. Laws belong only in the laws file")
    laws_path = os.path.join(os.path.dirname(proof_path), imported.group(1))
    with open(laws_path, encoding="utf-8") as handle:
        laws = handle.read()
    if not re.search(r"^law\s", laws, re.M):
        problems.append("the laws file states no law")
    problems.extend(_unused_variables(laws))
    approval = laws_path + ".approved"
    if not os.path.isfile(approval):
        problems.append("the user has not approved these laws. Show them to the user and call approve_laws after a yes")
    else:
        with open(approval, encoding="utf-8") as handle:
            if handle.read().strip() != _digest(laws_path):
                problems.append("the laws changed after the user approved them. Ask the user to approve them again")
    return problems


def _unused_variables(laws):
    """A law whose statement ignores one of its `for` variables usually does not say what the user meant."""
    problems = []
    for name, body in re.findall(r"^law\s+([\w.]+)\s*:[^\n]*\n((?:[ \t]+[^\n]*(?:\n|$))+)", laws, re.M):
        lines = [line.split("#", 1)[0].strip() for line in body.splitlines()]
        binders = [line[4:].split(":", 1)[0] for line in lines if line.startswith("for ")]
        statement = " ".join(line for line in lines if line and not line.startswith("for "))
        for binder in binders:
            for variable in (part.strip().lstrip("+-") for part in binder.split(",")):
                if variable and not re.search(r"(?<![\w.])" + re.escape(variable) + r"(?!\w)", statement):
                    problems.append("law " + name + " never uses its variable " + variable)
    return problems


async def bend_check(proof_path, verdict=False):
    """Run the gate on PROOF.bend. Passed needs exit 0, ALL PROOFS CHECK, and no problems.

    Problems are structural: a law stated in the proof file, a laws file without laws, or laws that
    differ from the approved ones. verdict=True adds --verdict, which rechecks with the Lean-proven
    kernel and needs Lean installed.
    """
    bend = find_bend()
    if bend is None:
        raise RuntimeError("bend is not installed. Ask the user to run: " + BEND_INSTALL)
    proof_path = os.path.abspath(proof_path)
    problems = _problems(proof_path)
    command = shlex.quote(bend) + " " + shlex.quote(os.path.basename(proof_path)) + (" --verdict" if verdict else " --check-only")
    output, code = await _run(command, os.path.dirname(proof_path))
    passed = code == 0 and "ALL PROOFS CHECK" in output and not problems
    if problems:
        output = "CHECK REJECTED: " + "; ".join(problems) + ". Bend's own output follows and does not count.\n" + output
    return {
        "verdict": "passed" if passed else ("failed" if code is not None else "inconclusive"),
        "problems": problems,
        "exit_code": code,
        "output": output,
        "command": command,
    }
