---
name: bend
description: Turn rules the user states in plain words into Bend laws, write the proofs, and check them with the bend CLI. Use when the user asks to formally verify, prove, or guarantee that a rule can never break.
---

# Bend formal verification

You write Bend laws and proofs for the user. The user decides the rules. Bend decides whether the proofs hold. Never claim a rule is proven unless `bend` printed `ALL PROOFS CHECK`.

By Bend convention, `LAWS.bend` states the rules and `PROOF.bend` proves them. Here you write both, so the user must approve every law before you write proofs. After approval, a law is the spec. Do not edit it to make a proof pass.

## Load the helper

Work in the Python tool. Load the helper beside this file, then find the CLI:

```python
exec(await read("<directory of this SKILL.md>/bend_tool.py"), globals())
bend = find_bend()
files = law_files()
```

`find_bend()` checks `BEND_BIN`, then `PATH`, then `~/.bend/bin/bend`. If it returns `None`, stop. Ask the user to install Bend with `curl -fsSL https://bend-lang.com/install.sh | sh`. Do not install it yourself.

Outside the Python tool, run the same commands with bash: `bend guide`, `bend PROOF.bend --check-only`.

## Read the guide first

Run `guide = await bend_guide()` and keep it in a variable. Read the sections on laws and proofs, recursion and termination, quantities, and kinds before you write Bend. Search the variable for anything else you need. `bend base --types` and `bend base <name>` print the standard library.

## Steps

1. **Ask for the rules.** Ask the user which rules must never break, then stop and wait for the answer. Offer two or three concrete examples taken from the project. Do not invent rules. If the user asks you to choose, propose rules in plain words and wait for confirmation.
2. **Write the laws.** Write `files["laws"]`. Start with `import Base`. Define, in Bend, the code or model each rule talks about, then add one `law` per rule. Put the user's own words in a `# LAW:` comment above each law. Keep each law to one rule.
3. **Check that the laws parse.** Write a `files["proof"]` that only imports `./LAWS.bend as Laws`, then run `await bend_check(files["proof"])`. Expect `SOME PROOFS FAIL` with a count of open claims. Fix any other error in the laws file.
4. **Get approval.** Show the user each law twice: the Bend text and a one-sentence plain reading. Say what the laws do not cover. Ask whether they match the intended rules. Revise and ask again until the user approves. After the user says yes, call `approve_laws(files["laws"])`. A message the user sent before you asked is not approval. `bend_check` fails until the laws are approved.
5. **Write the proofs.** In `files["proof"]`, prove each law with `def Laws.<law name>`. Do not write a `law` in the proof file, and do not move a law out of the laws file. The laws file includes its definitions. If a proof needs any change to that file, stop, show the user the change, and call `approve_laws` again only after a new yes. Run `await bend_check(files["proof"])` after each change. Read `problems` first, then the expected and observed terms in `output`. Use `?name` to print a goal while you work.
6. **Handle a law you cannot prove.** If the output shows the law is false, show the user the counterexample and ask how to change the rule. If you cannot find a proof, leave `?TODO` in that def and report the law as open. Never use `@unsafe` or foreign code in a proof.
7. **Report.** A check passes only when `bend_check` returns `verdict` `passed`, which needs `ALL PROOFS CHECK` and an empty `problems` list. Run the final check through `bend_check`, not bash. Quote its `verdict` and `problems` and the verdict line from `output`. Copy each law from the laws file as written. Do not retype or restate it in Bend. List each law as proven or open. If Lean is installed, `await bend_check(files["proof"], verdict=True)` rechecks with the Lean-proven kernel. Report its result separately.

## Where the files go

`law_files()` reads custom file names from `.raga/verification.json`.

- In an ordinary session, `files["directory"]` is `.raga/verification/`. These are the files the instance gate reads.
- In an instance session, the sandbox hides `.raga`, so `files["directory"]` is `verification-draft/`. After the user approves, tell them to copy both files into `.raga/verification/`.

## Turn on the gate

Only the user can make a revision depend on these proofs. In an instance project, give the user these commands and let them run each one:

- `raga verify install --approved --network` downloads the pinned Bend release the gate uses.
- `raga verify enable --approved` requires a passing check before a harness revision becomes active.
- `raga verify run` runs the check in the sandbox and records the verdict.

## Limits

- A law proves only the Bend code that `LAWS.bend` defines or imports. For a project in another language, the laws prove facts about a Bend model of the code. Say so in the report.
- Proofs need structural recursion. Read the termination section before you write recursive defs.
