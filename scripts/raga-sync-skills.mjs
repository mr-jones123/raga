#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const commit = "eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10";
const nmCommit = "4822244e763fd4c3d7f48be6433f92df10bb5b33";
const [source, noMistakes, commander] = process.argv.slice(2).map((path) => resolve(path));
if (!source || !noMistakes || !commander) throw new Error("Usage: node scripts/raga-sync-skills.mjs <pinned cursor/plugins tree> <pinned no-mistakes tree> <commander 14.0.0 package tree>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/coding-agent/bundled-skills");
const previousFiles = JSON.parse(readFileSync(join(root, "bundle.json"), "utf8")).files;
const sourceHashes = new Map(previousFiles.map((entry) => [entry.source, entry.sourceSha256]));
const manifest = { schemaVersion: 1, adaptationRevision: "raga-2", sources: [
  { repository: "https://github.com/cursor/plugins", commit, license: "licenses/pstack", companionsLicense: "licenses/cursor-team-kit" },
  { repository: "https://github.com/kunchenguid/no-mistakes", commit: nmCommit, tag: "v1.84.0", license: "licenses/no-mistakes" },
  { repository: "https://github.com/tj/commander.js", version: "14.0.0", commit: "395cf7145fe28122f5a69026b310e02df114f907", integrity: "sha512-2uM9rYjPvyq39NwLRqaiLtWHyDC1FvryJDa2ATTVims5YAS4PupsEQsDvP14FqhFr0P49CYDugi59xaxJlTXRA==", license: "licenses/commander" },
], skills: [], files: [], exclusions: ["make-bot-ui", "editor automation endpoints", "editor custom modes", "editor dashboard", "persistent wake scheduler", "OMP overlays", "global credential installation"] };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = new Map();
const provenance = new Map();
const pinnedSource = /^(pstack\/|cursor-team-kit\/|no-mistakes(?:@|\/)|commander@)/;
const consumedSources = new Set();
function emit(path, content, origin, original) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const expected = sourceHashes.get(origin);
  if (pinnedSource.test(origin)) {
    if (!expected || digest(original ?? bytes) !== expected) throw new Error(`Unrecorded or changed pinned source bytes: ${origin}`);
    consumedSources.add(origin);
  }
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
  if (bytes.subarray(0, 2).toString() === "#!") chmodSync(join(root, path), 0o755);
  files.set(path, bytes);
  const pinned = provenance.get(path) ?? { source: origin, sourceSha256: digest(original ?? bytes) };
  provenance.set(path, pinned);
  manifest.files.push({ path, sha256: digest(bytes), ...pinned, adaptation: origin });
}
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error(`Symlink in pinned source ${join(directory, entry.name)}`);
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const forbidden = /make-bot-ui|api2\.cursor|Cursor Automations|Cursor cloud agents|cloud-agent dashboard|Custom Modes?|Use as Mode|Bugbot.*(start|wait|configure)|(?:start|wait|configure).*Bugbot|\/automations\/|\/plugin (?:install|marketplace)|\/add-plugin|cursor\.com|\/in-cloud/i;
function adapt(text) {
  text = text.split(/\n\s*\n/).filter((block) => !forbidden.test(block)).join("\n\n");
  text = text.replace(/^.*(?:make-bot-ui|api2\.cursor|Automations webhook).*\n?/gim, "");
  const replacements = [
    ["~/.cursor/rules/pstack-models.mdc", "agents/model-roles.json"],
    ["pstack-models.mdc", "model-roles.json"],
    ["claude-opus-5-5-xhigh-fast", "None"],
    ["claude-opus-5-5-xhigh", "None"],
    ["grok-4.7-xhigh-fast", "None"],
    ["grok-4.7-xhigh", "None"],
    ["~/.cursor/skills/", "skills/"],
    [".cursor/skills/", "skills/"],
    ["~/.cursor/projects/*/", "the current instance state/sessions/"],
    ["~/.cursor/plugins/", "<pinned-resource-root>/"],
    ["~/.cursor/projects/", "<current-instance-session-records>/"],
    ["agent-transcripts/", "state/sessions/"],
    ["~/.cursor/rules/", "lessons/"],
    [".cursor/rules/", "lessons/"],
    [".cursor/worktrees/", ".raga/state/workspaces/"],
    [".cursor/", ".raga/"],
    [".mdc", ".md"],
    ["Cursor's built-in `create-skill`", "the bundled `create-skill` skill"],
    ["Cursor's built-in for authoring SKILL.md files", "the raga candidate authoring workflow"],
    ["Cursor's built-in", "the bundled"],
    ["Cursor built-ins", "native raga workflows"],
    ["Cursor cloud agent", "isolated raga child"],
    ["cloud agents", "isolated raga children"],
    ["cloud agent", "isolated raga child"],
    ["cloud VM", "isolated child workspace"],
    ["Cursor transcripts", "instance session records"],
    ["[the Claude Code adapter](../harness/claude-code.md)", "[the native runtime](../../skills/raga-runtime/SKILL.md)"],
    ["Cursor", "raga"],
    ["cursor-grok-", "grok-"],
    ["Bugbot", "reviewer"],
    ["bugbot", "reviewer"],
    ["`/loop`", "the in-process bounded loop"],
    ["/loop until", "continue the in-process loop until"],
    ["/loop 1h", "an in-process hourly audit"],
    ["/loop", "the in-process loop"],
    ["`/visualize`", "a Mermaid diagram"],
    ["Task tool", "native Python child API"],
    ["Task subagent", "native raga child"],
    ["Task call", "run_child call"],
    ["`Task`", "`run_child`"],
    ["AskQuestion", "ask the user in the final response"],
    ["subagent_type", "spec"],
    ["generalPurpose", "worker"],
    ["run_in_background: true", "asyncio.gather for independent child calls"],
    ["environment: \"cloud\"", "read_only=False, details=True"],
    ["environment: cloud", "read_only=False, details=True"],
    ["environment: \"local\"", "the same native sandbox policy"],
    ["environment: local", "the same native sandbox policy"],
    ["readonly: true", "read_only=True"],
    ["`Read`", "`await read(...)`"],
    ["`Write`", "`await write(...)`"],
    ["`StrReplace`", "`await edit(...)`"],
    ["`Shell`", "`await bash(...)`"],
    ["`Grep`", "Python re over files read through the sandbox"],
    ["`Glob`", "Python pathlib inside the sandbox"],
    ["Task spawn", "native child call"],
    ["readonly: false", "read_only=False, details=True"],
    ["file_attachments", "context"],
    ["bun run ", "node "],
    ["bun scripts/", "node scripts/"],
    ["cloud_base_branch", "the supervisor-pinned project snapshot"],
    ["omit Task `model`", "pass model=None"],
    ["readonly strips MCPs", "read_only controls workspace writes"],
    ["readonly strips MCP", "read_only controls workspace writes"],
    ["Cloud agents", "Native children"],
    ["the full Task schema including model selection", "the run_child signature documented in raga-runtime"],
    ["full Task schema", "documented run_child signature"],
    ["cloud-agent URL", "supervisor-supplied session record"],
  ];
  for (const [before, after] of replacements) text = text.replaceAll(before, after);
  text = text.replace(/https:\/\/github\.com\/raga\/plugins/g, "https://github.com/cursor/plugins");
  text = text.replace(/raga-team-kit/g, "bundled companion skills");
  text = text.replace(/~\/Library\/Application Support\/raga[^`\n]*/g, "the current instance's disposable cache");
  text = text.replace(/^Transcripts live at .*$/gm, "Read this session with await context.history(). Retrieve earlier project observations through await memory.search(query) and await memory.get(id). Historical transcripts must be explicitly supplied by the supervisor. Do not invent a home-directory transcript layout.");
  text = text.replace(/\[([^\]]+)\]\(url\)/g, "$1 (<source URL>)");
  text = text.replace(/(?:under `skills\/`, `skills\/`, or `<pinned-resource-root>\/`)/g, "under the pinned resource root");
  text = text.replace(/When a worker must start from a non-default pushed branch, pass `the supervisor-pinned project snapshot`\./g, "Every child starts from the supervisor-pinned project snapshot. Include a required base revision in the brief, not an unsupported launch option.");
  text = text.replace(/If the (?:native Python child API|Task tool) rejects[^.]*\./g, "If a configured model is rejected, report the unavailable selector and stop that seat.");
  text = text.replace(/If it rejects (?:the default|the default too)[^.]*\./g, "Do not silently substitute another model.");
  text = text.replace(/If the (?:rule|file) or that line is missing, (?:default to|use) [^.]*\./g, "If no role is configured, inherit the parent model and report that the seats are not model-diverse.");
  text = text.replace(/Families go by prefix:[^.]*\./g, "Compare actual configured provider/model families, not editor aliases.");
  text = text.replace(/An? (?:refused|rejected) `composer-[^`]*` entry [^.]*\./g, "Report an unavailable configured selector instead of replacing it.");
  text = text.replace(/With no family match, use `None`\./g, "An unconfigured role inherits the parent model.");
  text = text.replace(/If it rejects a default, use the closest valid slug of the same family from its error message\./g, "An unavailable model is a prerequisite failure.");
  text = text.replace(/agent mode \(`read_only=False`\)/g, "`read_only=True`");
  text = text.replace(/Use the `ask the user in the final response` tool \(structured multi-choice\) rather than asking the user to type from scratch\./g, "Ask a plain-language question in the final response. There is no structured question tool.");
  text = text.replace(/Shape: one or two questions with 4-6 options each, `allow_multiple: true` for category questions\.[^\n]*/g, "Ask one or two questions in ordinary language. The user can answer with their own words and select more than one category.");
  text = text.replace(/The system prompt names the workspace's `state\/sessions\/` directory\. Use only that path\. Don't glob across `the current instance state\/sessions\/`\.[^\n]*/g, "Use await context.history() for this session. For previous work, use await memory.search(query), then await memory.get(id). Only mine earlier transcripts explicitly supplied by the supervisor.");
  text = text.replace(/a git worktree where possible, otherwise `\/tmp\/arena-<slug>\/candidate-<n>\/`/g, "a supervisor-owned child workspace for code, or an independent returned artifact for a read-only design");
  text = text.replace(/Work in a worktree off main\. Commit and open a PR\. Don't push to main directly\./g, "Write the skill through instance.candidate_write and commit through instance.candidate_commit. Return the candidate and evidence for explicit operator promotion. Do not open an application PR for an instance-only proposal.");
  text = text.replace(/Step 4 edits the existing file in place\./g, "Step 4 edits only the supervisor-created candidate.");
  text = text.replace(/Skill changes affect every future agent in the org\./g, "Promoted skill changes affect future sessions of this instance.");
  return text;
}
function copyTree(from, to, sourceLabel, transform = true) {
  for (const path of walk(from)) {
    const destination = join(to, relative(from, path)).replaceAll("bugbot", "reviewer");
    if (/\/(?:bootstrap\.ts|bun\.lock|package\.json)$/.test(destination)) continue;
    const original = readFileSync(path);
    let output = original;
    if (transform && /\.(?:md|ts|mjs|json|sh)$/.test(path)) output = Buffer.from(adapt(original.toString()));
    emit(destination, output, `${sourceLabel}/${relative(from, path)}`, original);
  }
}
const upstreamSkills = join(source, "pstack/skills");
const names = readdirSync(upstreamSkills).filter((name) => name !== "make-bot-ui" && existsSync(join(upstreamSkills, name, "SKILL.md"))).sort();
if (names.length !== 56 || names.filter((name) => name.startsWith("principle-")).length !== 24) throw new Error("Source is not the pinned 56-skill portable inventory");
for (const name of names) {
  copyTree(join(upstreamSkills, name), `skills/${name}`, `pstack/skills/${name}`);
  manifest.skills.push({ name, path: `skills/${name}/SKILL.md`, source: "pstack" });
}
for (const name of ["deslop", "control-cli", "control-ui", "verify-this"]) {
  copyTree(join(source, "cursor-team-kit/skills", name), `skills/${name}`, `cursor-team-kit/skills/${name}`);
  manifest.skills.push({ name, path: `skills/${name}/SKILL.md`, source: "cursor-team-kit" });
}
copyTree(join(source, "pstack/docs/guide"), "docs/guide", "pstack/docs/guide");
for (const name of ["pstack", "cursor-team-kit"]) emit(`licenses/${name}`, readFileSync(join(source, name, "LICENSE")), `${name}/LICENSE`);
emit("licenses/no-mistakes", readFileSync(join(noMistakes, "LICENSE")), "no-mistakes/LICENSE");
if (JSON.parse(readFileSync(join(commander, "package.json"))).version !== "14.0.0") throw new Error("Commander source version mismatch");
for (const path of walk(commander)) {
  const name = relative(commander, path);
  if (name === "LICENSE" || /\.(?:js|mjs|ts|mts)$/.test(name)) emit(`skills/poteto-mode/scripts/vendor/commander/${name}`, readFileSync(path), `commander@14.0.0/${name}`);
}
emit("skills/poteto-mode/scripts/vendor/commander/package.json", JSON.stringify({ name: "commander", version: "14.0.0", type: "commonjs", main: "index.js" }), "raga adaptation of commander package metadata");
emit("licenses/commander", readFileSync(join(commander, "LICENSE")), "commander@14.0.0/LICENSE");

// Native helper executables do not install dependencies or download browser packages.
for (const path of ["skills/poteto-mode/scripts/orch/orch.ts", "skills/poteto-mode/scripts/watch-pr/cli.ts", "skills/poteto-mode/scripts/watch-pr/watch-pr"]) {
  const original = files.get(path);
  if (!original) continue;
  const text = original.toString().replace("#!/usr/bin/env bun", "#!/usr/bin/env node")
    .replace(/^import \{ ensureDependenciesInstalled \} from .*;\n/gm, "")
    .replace(/^ensureDependenciesInstalled\(\);\n/gm, "")
    .replaceAll('from "commander"', 'from "../vendor/commander/esm.mjs"')
    .replace(/const \{([\s\S]*?)\} = await import\("commander"\);/, 'import {$1} from "../vendor/commander/esm.mjs";')
    .replace('const { main } = await import("./cli.ts");', 'import { main } from "./cli.ts";')
    .replaceAll("Command: CommanderCommand", "Command as CommanderCommand");
  emit(path, text, `raga native Node adaptation of ${path}`, original);
}
const storePath = "skills/poteto-mode/scripts/orch/store.ts";
const store = files.get(storePath);
emit(storePath, store.toString().replace(
  `export class NotFoundError extends UserError {
  public constructor(
    message: string,
    public readonly output?: NotFoundOutput
  ) {
    super(message);
  }
}`,
  `export class NotFoundError extends UserError {
  public readonly output?: NotFoundOutput;
  public constructor(message: string, output?: NotFoundOutput) {
    super(message);
    this.output = output;
  }
}`,
), "raga Node erasable-syntax adaptation", store);
const chartPath = "skills/statechart/scripts/statechart.mjs";
const chart = files.get(chartPath);
emit(chartPath, chart.toString().replaceAll("npx @mermaid-js/mermaid-cli", "the managed MERMAID_CLI executable")
  .replaceAll("https://github.com/tlaplus/tlaplus/releases", "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar")
  .replace('"npx",\n      ["-y", "@mermaid-js/mermaid-cli",', 'process.env.MERMAID_CLI || "mmdc",\n      ['), "raga offline Mermaid adapter", chart);
const tlcPath = "skills/statechart/scripts/lib.mjs";
const tlc = files.get(tlcPath);
emit(tlcPath, 'import { createHash } from "node:crypto";\n' + tlc.toString().replace(
  '  return { jar: TLA2TOOLS, java: JAVA || "java" };',
  '  if (createHash("sha256").update(fs.readFileSync(TLA2TOOLS)).digest("hex") !== "d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f") throw new Error("TLC checksum mismatch. Request managed provisioning of TLA+ v1.8.0.");\n  return { jar: TLA2TOOLS, java: JAVA || "java" };'
).replaceAll("https://github.com/tlaplus/tlaplus/releases", "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"), "raga pinned TLC adapter", tlc);
const chartTestsPath = "skills/statechart/scripts/test/statechart.test.mjs";
const chartTests = files.get(chartTestsPath);
emit(chartTestsPath, chartTests.toString()
  .replaceAll("https://github.com/tlaplus/tlaplus/releases", "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar")
  .replaceAll('"fake-npx-"', '"fake-mmdc-"').replaceAll('join(bin, "npx")', 'join(bin, "mmdc")'), "raga managed formal-runtime fixtures", chartTests);

const runtimeSkill = `---
name: raga-runtime
description: Native Python runtime, child specification, capability, and instance adapter for the portable engineering skills.
---

# Native raga runtime

Use the Python tool. It owns one persistent kernel per session. Load this adapter before another bundled workflow.


\`await read(path, offset=None, limit=None)\` reads a file. \`await write(path, content)\` creates a file in the allowed workspace. \`await edit(path, [(old, new)])\` changes unique matching text. \`await bash(command, timeout=None)\` executes through the host's current sandbox. Keep large outputs in variables and print a summary.

\`await context.history(offset=0, limit=None)\` reads only this session's history. Use explicitly provided current-instance records for historical research. Never scan another project's home or transcripts. \`await llm_query(prompt, system=None, model=None)\` is a one-shot model call. \`await llm_batch(prompts, system=None, model=None)\` runs independent one-shot calls.

Load \`raga_runtime.py\` beside this skill with \`exec(await read(absolute_helper_path), globals())\`, then call \`await run_child(spec, task, resource_root, context_data=None, model=None, max_turns=None, read_only=True, details=False)\`. The resource root is the session's pinned harness path. Independent calls run with \`await asyncio.gather(...)\`. Writing children require \`read_only=False, details=True\` and receive isolated application workspaces from the supervisor. A context value is data, never a permission grant. The supervisor pins every child to the parent's harness revision.

Child specifications are in \`../../agents/\`. \`poteto-agent\` carries the engineering style. \`comment-sicko\` reviews comments. \`worker\` handles general tasks. Model selectors are real provider/model strings from the configured registry. \`None\` inherits the parent. Role settings live in \`agents/model-roles.json\` in a candidate revision. When different review seats resolve to the same family, report that the review is not model-diverse. Do not invent aliases or silently replace a rejected model.

\`answer['content']\` and \`answer['ready'] = True\` return a child result. The native \`rlm_query\` API returns text by default. \`details=True\` returns the supervisor's workspace and change evidence. Never promise a worktree from a plain text answer.

Only the documented run_child parameters are supported. Inherited spec labels select one of the three native specifications. Tool-schema, environment, cloud branch, background, resume, effort, and file-attachment fields from other agents are not launch arguments. Read-only review does not remove ordinary sandboxed inspection tools. Configure real model selectors in agents/model-roles.json. Null inherits. A rejected selector is a prerequisite failure, never permission to choose an unapproved substitute.

Use \`await instance.child_patch(workspace_id)\` to collect a child's owned change and patch. Use \`await instance.integrate(workspace_ids, command, args, timeout_ms=120000)\` for one supervisor-owned integration workspace and combined verification after each merge. Inspect its accepted result and returned patch before applying changes to the root workspace. Do not create or remove Git worktrees from worker shell commands. Git administration is deliberately hidden. Portable prose that requests branches or worktrees means these supervisor APIs, not raw Git worktree mutation.

Use an in-process bounded loop for autonomous work. A process exit ends the loop. There is no persistent wake scheduler or editor automation service. Keep ownership records in the instance state and stop descendant processes before cleanup.

## Candidate authoring

\`await instance.info()\` reports the current pin. \`candidate = await instance.candidate_create()\` creates an editable proposal. Read and write its allowlisted resources with \`await instance.candidate_read(candidate['id'], path)\` and \`await instance.candidate_write(candidate['id'], path, content)\`. Use \`await instance.candidate_commit(candidate['id'], message)\` to commit it. Ordinary model filesystem access does not expose instance state or accepted artifacts. Do not invoke management CLI commands through shell. Promotion is a user CLI operation backed by exact-revision evidence, never a model approval.

\`await memory.search(query)\`, \`await memory.get(entry_id)\`, and \`await memory.observe(text, evidence)\` access only this project's structured observations. Search returns observations, not an automatic proof that an earlier decision remains valid. Read the current source before reusing a lesson.

## Capabilities and dependencies

TLC is pinned to v1.8.0 with SHA-256 d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f. The operator can explicitly provision it with the adjacent managed-tools.mjs into a supervisor runtime directory using provision-tla --root and --approved. Workers request this capability and cannot grant the approval themselves. Shipped statechart helpers verify the jar digest before execution. Upstream helper test fixtures require optional Bun 1.3.11; production orchestration and PR watchers run on Node.

Node 22.19.0 or newer runs the shipped operational helpers. Commander 14.0.0 and its MIT license are vendored, so helper startup never installs npm packages. \`await capability_report()\` checks available local commands without installing software. Terminal verification uses an existing repo harness or Python's standard pty module. Browser verification requires the repo's pinned Playwright and managed browser installation. Ask for approved setup when absent; never run an unpinned npx download. TLA+ requires a digest-verified tla2tools.jar and an approved Java runtime, supplied by the operator through TLA2TOOLS and JAVA. Mermaid PNG rendering uses a provisioned MERMAID_CLI path, never a runtime download. GitHub and other optional integrations require their explicit tools and authentication. An absent optional capability is a prerequisite report, not a successful check.
`;
emit("skills/raga-runtime/SKILL.md", runtimeSkill, "raga native adaptation");
emit("skills/raga-runtime/raga_runtime.py", `import asyncio
import json
import os
import shlex
from pathlib import PurePosixPath

async def run_child(spec, task, resource_root, context_data=None, model=None, max_turns=None, read_only=True, details=False):
    if spec not in ("worker", "poteto-agent", "comment-sicko"):
        raise ValueError("Unknown bundled child specification")
    if not read_only and not details:
        raise ValueError("Writing children require details=True for supervisor-owned change evidence")
    root = resource_root.rstrip("/")
    definition = json.loads(await read(root + "/agents/" + spec + ".json"))
    definition_path = PurePosixPath(definition["instructions"])
    if definition_path.is_absolute() or ".." in definition_path.parts:
        raise ValueError("Child instructions must stay in the pinned resource root")
    instructions = await read(root + "/" + definition["instructions"])
    for name in definition["skills"]:
        instructions += "\\n\\n" + await read(root + "/skills/" + name + "/SKILL.md")
    roles = json.loads(await read(root + "/agents/model-roles.json"))
    if model is None:
        model = roles.get(definition["modelRole"])
    prompt = instructions + "\\n\\nPinned resource root: " + root + "\\n\\n# Assignment\\n" + task
    return await rlm_query(prompt, context=context_data, model=model, max_turns=max_turns, read_only=read_only, details=details)

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
`, "raga native Python adapter");

const authoring = `---
name: create-skill
description: Author or revise a portable Agent Skills workflow in a candidate harness revision with explicit inputs and behavioral checks.
---

# Author a candidate skill

Define the trigger, input data, observable result, dependencies, side effects, approval boundaries, and failure behavior. Read nearby skills before choosing a shape. Use the native adapter at [raga-runtime](../raga-runtime/SKILL.md).

Request a candidate with \`candidate = await instance.candidate_create()\`. Read an existing resource with \`await instance.candidate_read(candidate['id'], path)\`. Write the proposed text with \`await instance.candidate_write(candidate['id'], path, content)\`. Never edit an accepted revision or a global skill installation. Use \`skills/<name>/SKILL.md\`, with lowercase hyphenated name and a description in YAML frontmatter. Keep references and helpers beside the skill. Resolve relative references from that directory.

Exercise success, input variation, failure, and ambiguous cases with real input. Executable Python helpers must pass fresh sandboxed interpreter probes without session globals. Record dependencies and external effects. A source-text assertion does not prove behavior. An unsupported capability reports its setup prerequisites.

Commit through \`await instance.candidate_commit(candidate['id'], message)\` and hand the candidate ID and evidence to the user. Promotion belongs to the trusted supervisor and explicit user approval. Host extension activation requires separate review. A skill cannot grant itself network or publication authority.
`;
emit("skills/create-skill/SKILL.md", authoring, "raga native skill authoring");
for (const name of ["raga-runtime", "create-skill"]) manifest.skills.push({ name, path: `skills/${name}/SKILL.md`, source: "raga" });
for (const name of ["poteto-agent", "comment-sicko"]) {
  const original = readFileSync(join(source, "pstack/agents", `${name}.md`));
  const native = original.toString().replace(/Use the absolute path your parent gave you[\s\S]*?If no such file exists, stop and tell your parent\./, "The native helper supplies the pinned resource root and the complete required skill bodies. Resolve every additional leaf from that root. Never search a global plugin installation.");
  emit(`agents/${name}.md`, adapt(native.replace(/^---\n[\s\S]*?\n---\n/, "")), `pstack/agents/${name}.md`, original);
  emit(`agents/${name}.json`, JSON.stringify({ name, instructions: `agents/${name}.md`, modelRole: name === "poteto-agent" ? "code" : "judgment", skills: ["raga-runtime", "poteto-mode"] }, null, 2), "raga native child specification");
}
emit("agents/worker.md", "Read the pinned native runtime adapter. Follow the assignment and its permissions. Preserve unrelated changes. Return concrete evidence, assumptions, and unresolved blockers. Do not promote revisions, publish, or control an outer no-mistakes gate.\n", "raga child instructions");
emit("agents/worker.json", JSON.stringify({ name: "worker", instructions: "agents/worker.md", modelRole: "code", skills: ["raga-runtime"] }, null, 2), "raga native child specification");
const roles = { schemaVersion: 1, code: null, judgment: null, verification: null, rules: "Null inherits the current model. Set real provider/model selectors in a candidate revision. Same-family seats are not model diversity." };
for (const role of ["feature, refactoring", "bug-fix", "perf-issue", "hillclimb", "hardest tasks", "judgment and prose", "how explorer", "how explainer", "why investigator", "why synthesizer", "teach explainer", "swarm workers", "arena cross-judge", "reflect synthesizer"]) roles[role] = null;
for (const role of ["architect runners", "arena runners", "arena cross-judge pool", "interrogate reviewers", "reflect reviewers"]) roles[role] = [null, null];
emit("agents/model-roles.json", JSON.stringify(roles, null, 2), "raga native model roles");

const upstreamNm = readFileSync(join(noMistakes, "skills/no-mistakes/SKILL.md"));
if (digest(upstreamNm) !== "7ee4d49f3fbe9d639a19aee37f40d43bcac013ba7cf212f9fd2a70c21dafad44") throw new Error("Source is not the pinned no-mistakes v1.84.0 public skill");
emit("skills/no-mistakes/upstream/SKILL.md", upstreamNm, `no-mistakes@${nmCommit}/skills/no-mistakes/SKILL.md`);
emit("skills/no-mistakes/SKILL.md", `---
name: no-mistakes
description: Drive the explicitly enabled, pinned no-mistakes validation backend through the trusted instance supervisor. Use when asked to validate or gate committed code changes.
---

# Managed no-mistakes validation

The paired upstream public skill is preserved in [upstream/SKILL.md](upstream/SKILL.md). Read it for intent, findings, branch custody, and result semantics. This file owns raga's stronger authorization policy. Do not run a global no-mistakes binary or its installer.

Call \`await instance.no_mistakes('inspect')\`. If prerequisites are missing, report the exact pinned setup and repository-enablement requirements. Only an operator can provision, enable, start, or stop the backend through trusted management. Discovery never enables a repository. The managed backend isolates HOME and NM_HOME, disables telemetry and updates, and never installs an OS service or copies global credentials.

A validation-step child never initializes, runs, responds to, synchronizes, aborts, or controls the outer gate. If NO_MISTAKES_GATE or a nested_gate_context refusal is present, return the assigned phase result to the outer executor. Safe status inspection does not grant control authority.

For an enabled repository, inspect \`await instance.no_mistakes('status')\`. Validate committed feature-branch history with \`await instance.no_mistakes('run', intent=complete_user_intent)\`. The supervisor holds network authorization. The default skips push, PR, and CI. Every publication capability and automatic yes mode requires a separate operator grant. A model-supplied approval boolean is not authorization.

The pinned v1.84.0 executable accepts --intent, not --intent-file. The backend writes a private intent file and passes its exact text through --intent with --skip push,pr,ci. Do not issue a nonexistent upstream --intent-file flag. Local gate validation can fetch authoritative remote configuration and is not offline or side-effect-free.

At a gate, report findings and ask-user choices without silently accepting them. Only the operator's trusted CLI or a UI-confirmed supervisor action can respond, approve, fix, skip, or answer review questions. The model-facing instance adapter does not grant this authority. Never change the pipeline-owned branch directly. Preserve branch_sync guidance and exact commits.

Report the raw outcome, requested skips, automatic skips, overrides, missing evidence, and custody instructions. Passed-with-override, passed-with-skips, timeout, cancellation, and an unknown result are not a fully verified pass. Default restricted validation does not establish push, PR, CI, or merge readiness. The backend returns fullyVerified=false deliberately.
`, "raga authorization policy");
manifest.skills.push({ name: "no-mistakes", path: "skills/no-mistakes/SKILL.md", source: "no-mistakes" });

const cleanup = `### Worktree cleanup

1. Read the current instance's supervisor-owned workspace and session records. Run git worktree list --porcelain in the bound application repository. Match each path and base commit to its owner. Unknown ownership means keep it.
2. Inspect dirty files, unpushed commits, accepted revisions, active jobs, and process liveness. A stopped chat or a merged branch alone is not proof that a descendant workspace is unused.
3. Ask the supervisor to remove only its own stopped child workspace through the managed lifecycle. Never run git worktree remove --force or delete a user's unknown directory.
4. Report what was removed and what remains, with owner and reason. Destructive removal of user data needs explicit operator approval.
`;
emit("skills/poteto-mode/playbooks/worktree-cleanup.md", cleanup, "raga ownership-aware cleanup adaptation");
emit("skills/poteto-mode/scripts/worktree-audit.sh", `#!/bin/sh
set -eu
printf '%s\\n' 'Use the supervisor workspace ownership records and git worktree list --porcelain. Unknown ownership means keep the worktree.'
git worktree list --porcelain
`, "raga read-only workspace inventory");
const setup = `---
name: setup-pstack
description: Configure real native model selectors for the bundled engineering workflows through a candidate harness revision.
---

# Configure native model roles

Read [the native runtime](../raga-runtime/SKILL.md). Inspect the currently configured model registry through the host's model selection interface. Use exact provider/model selectors, not editor slugs or worker aliases. Preserve operator credentials outside the candidate.

Use \`await instance.candidate_read(id, 'agents/model-roles.json')\` and \`await instance.candidate_write(id, 'agents/model-roles.json', content)\` to edit the proposal. The supervisor checks candidate paths and preserves the accepted revision.

Read agents/model-roles.json from the pinned resource root. Null inherits the session model. Choose code, judgment, and verification roles from available models. Record when roles use one family so reviews do not claim diversity. Never silently replace a rejected selector.

Use the candidate authoring workflow to propose the model-role JSON. The supervisor validates selectors against its registry. Commit the candidate and request explicit promotion. This does not change a running session's pinned configuration.
`;
emit("skills/setup-pstack/SKILL.md", setup, "raga native role setup");
emit("docs/guide/01-setup.md", "# Set up the bundled workflows\n\nEvery initialized instance already contains this pinned portable bundle. There is no plugin installation step. Read [the native runtime](../../skills/raga-runtime/SKILL.md), then [configure model roles](../../skills/setup-pstack/SKILL.md) through a candidate revision. A null role inherits the session model. Verify available tools with capability_report before choosing a terminal, browser, or formal-verification workflow. Optional integrations require explicit setup. Start with /skill:poteto-mode and a goal with observable acceptance criteria.\n", "raga native setup guide");
emit("skills/poteto-help/SKILL.md", `---
name: poteto-help
description: Find the bundled engineering skill or playbook for understanding, design, implementation, verification, and communication.
---

# Find an engineering workflow

Read [raga-runtime](../raga-runtime/SKILL.md) for tools, permissions, history, and native child execution. Start structured work with [poteto-mode](../poteto-mode/SKILL.md). Its playbooks select the workflow.

Understanding uses [how](../how/SKILL.md), [why](../why/SKILL.md), [teach](../teach/SKILL.md), and [recall](../recall/SKILL.md). Design uses [architect](../architect/SKILL.md), [arena](../arena/SKILL.md), and [statechart](../statechart/SKILL.md). Parallel execution uses [swarm](../swarm/SKILL.md). Review uses [interrogate](../interrogate/SKILL.md) and [no-comments](../no-comments/SKILL.md).

Use [control-cli](../control-cli/SKILL.md) for terminals and [control-ui](../control-ui/SKILL.md) for browser apps. Use [verify-this](../verify-this/SKILL.md) to attach evidence. Use [create-skill](../create-skill/SKILL.md) for candidate authoring and [no-mistakes](../no-mistakes/SKILL.md) for the explicitly enabled validation gate.

The [guide](../../docs/guide/README.md) explains the portable workflows. The bundle includes all 24 principle leaf skills. Load only the bodies relevant to the task. User invocation is /skill:<name>. There is no editor automation service, global installation requirement, or persistent loop after process exit.
`, "raga skill routing");
emit("AGENTS.md", `# Default engineering workflows

Load skills on demand from skills/<name>/SKILL.md. Read skills/raga-runtime/SKILL.md before following a portable workflow. Tool names in inherited prose refer to the native Python adapter, not external editor APIs. Use native children and isolated workspaces. All skill authoring is candidate-only. The supervisor owns evidence, promotion, credentials, publication, and backend lifecycle.

No-mistakes is available but not enabled automatically. Its managed runtime requires explicit provisioning and repository enablement. A validation-step child cannot control an outer gate. Never interpret a skipped or overridden check as fully verified.
`, "raga default instructions");
emit("README.md", `# Portable default skills

New instances copy this pack into their first accepted revision. Each session reads its pinned copy. Updating package assets does not rewrite an existing instance.

The pack contains 56 portable pstack skills, four companion skills, the native create-skill and raga-runtime adapters, and the managed no-mistakes skill. It excludes make-bot-ui and editor-only services. The original public no-mistakes skill stays unchanged under skills/no-mistakes/upstream.

Read [the native runtime](skills/raga-runtime/SKILL.md) for the Python API. Read [the workflow guide](docs/guide/README.md) for skill selection. Workers return supervisor-owned workspace changes rather than Git commits. Skill changes go through candidate_read, candidate_write, and candidate_commit. Promotion remains a trusted operator operation.

## Sources and regeneration

bundle.json records source commits, source-file hashes, adapted-file hashes, licenses, and runtime dependencies. Regenerate from cursor/plugins at ${commit}, no-mistakes at ${nmCommit}, and the published commander 14.0.0 package tree. From the repository root, run node scripts/raga-sync-skills.mjs with those three source directories as positional arguments. The generator compares every imported asset with the checked-in source hashes and refuses missing, added, or modified source files. A deliberate upstream update must review the source hashes and license changes as well as the adaptation.

Pstack's MIT notice is in [licenses/pstack](licenses/pstack). Companion notices are in [licenses/cursor-team-kit](licenses/cursor-team-kit). No-mistakes and Commander have their own [no-mistakes](licenses/no-mistakes) and [Commander](licenses/commander) notices.

## Optional capabilities and authorization

Run capability_report() in the native Python session to inspect Node, Git, terminal support, Java, GitHub, the local Playwright browser, Mermaid, and the pinned TLC jar. Missing optional tools report prerequisites without installing dependencies. Runtime versions and pinned assets are in dependencies.json.

No-mistakes v1.84.0 requires separate operator approvals for provisioning, network-enabled repository enablement, validation, gate responses, and lifecycle changes. The model API permits inspect, status, and restricted run after explicit enablement. It cannot supply approval or respond to a gate. Push, PR, CI, and automatic yes mode require separate operator grants. A stopped daemon requires explicit start before another run.

The backend keeps HOME and NM_HOME below instance state, disables telemetry and update checks, and avoids OS service installation. It does not copy credentials or inherit ambient credentials. A runnable pipeline adapter must receive credentials through an explicitly approved wrapper or explicit trusted environment values. Version, JSON events, and durable sessions are probed before enablement.

## Integration checks

From packages/coding-agent, run the focused Vitest files test/instances-bundle.test.ts and test/instances-no-mistakes.test.ts after integration. The separate test/instances-no-mistakes-smoke.test.ts is opt-in with RAGA_NM_SMOKE=1, RAGA_NM_AGENT_EXECUTABLE, and RAGA_NM_AGENT_VERSION. Its optional JSON RAGA_NM_AGENT_ARGS and RAGA_NM_AGENT_ENV are explicit adapter inputs. The smoke creates a disposable Git remote, uses the actual pinned backend, and asserts that the feature branch is not published. It can use network and paid model calls. Do not enable it without authorization.
`, "raga bundle maintenance guide");
emit("dependencies.json", JSON.stringify({ schemaVersion: 1, runtime: { node: ">=22.19.0", python: ">=3.11" }, vendored: { commander: "14.0.0" }, managed: { noMistakes: { tag: "v1.84.0", commit: nmCommit, skillSha256: digest(upstreamNm), provisioning: "trusted supervisor, pinned per-platform archive SHA-256" }, tla: { tag: "v1.8.0", url: "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar", sha256: "d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f" } }, optional: { upstreamHelperTests: { bun: "1.3.11" }, terminal: "repository harness or Python stdlib pty", browser: "repository-pinned Playwright and browser; explicit setup", tlaJava: "approved Java >=11", mermaid: "repository-pinned and digest-verified MERMAID_CLI path", github: "explicit authenticated gh CLI" }, policy: "No helper auto-install, latest installer, global home mutation, or credential copy" }, null, 2), "raga dependency contract");
emit("skills/raga-runtime/managed-tools.mjs", `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const directory = args[args.indexOf("--root") + 1];
if (args[0] !== "provision-tla" || !args.includes("--approved") || !args.includes("--root") || !directory || !isAbsolute(directory)) {
  throw new Error("Operator use: node managed-tools.mjs provision-tla --root <absolute supervisor runtime directory> --approved");
}
if (process.env.NO_MISTAKES_GATE || process.env.RAGA_VALIDATION_STEP) throw new Error("Nested validation agents cannot provision runtimes");
const harness = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(directory);
const within = relative(harness, root);
if (!within || (!within.startsWith(".." + sep) && within !== ".." && !isAbsolute(within))) throw new Error("Runtime provisioning cannot write a pinned harness");
await mkdir(root, { recursive: true, mode: 0o700 });
const digest = "d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f";
const destination = join(root, "tla2tools-v1.8.0.jar");
const valid = (bytes) => createHash("sha256").update(bytes).digest("hex") === digest;
let installed = false;
try { installed = valid(await readFile(destination)); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!installed) {
  const response = await fetch("https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar", { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error("Pinned TLC download failed: " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw new Error("Pinned TLC checksum mismatch");
  const temporary = destination + "." + process.pid;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
console.log(JSON.stringify({ TLA2TOOLS: destination, version: "1.8.0", sha256: digest }));
`, "raga explicit managed TLC provisioning");
const dependencies = JSON.parse(files.get("dependencies.json").toString());
dependencies.managed.noMistakes.assets = {
  "linux-x64": "b0fb8a9df412c5fa1fb92a3584ffa1d4d5b4d6e0d1738efa2f8b88320f8bf1c2",
  "linux-arm64": "8d8cefd927b7f921c207e4dd6c575081dc255dc068f0205f74b52e482bf2f7ab",
  "darwin-x64": "88b1a481924488f55456b3f96070f739b109e19555232e4f8be0a7ebae7c08ac",
  "darwin-arm64": "2e5f838303ab727edccd1a60a4834068024606c68ae7d97fdc0fdeecd7bd4d90",
};
emit("dependencies.json", JSON.stringify(dependencies, null, 2), "raga pinned runtime dependency assets");
manifest.dependencies = dependencies;

// Native execution semantics are adjacent to every workflow, even when loaded without AGENTS.md.
for (const entry of manifest.skills.filter((entry) => entry.source === "pstack" || entry.source === "cursor-team-kit")) {
  const original = files.get(entry.path);
  const text = original.toString();
  const front = /^---\n[\s\S]*?\n---\n/.exec(text);
  if (!front) throw new Error(`Missing skill frontmatter ${entry.path}`);
  emit(entry.path, text.slice(0, front[0].length) + "\nRead [the native Python adapter](../raga-runtime/SKILL.md) before executing this workflow. Authoring targets candidate revisions. Children use run_child, not an external agent service.\n" + text.slice(front[0].length), `raga execution adaptation of ${entry.path}`, original);
}
for (const path of ["skills/reflect/SKILL.md", "skills/poteto-mode/playbooks/session-pickup.md", "skills/poteto-mode/playbooks/eval.md", "skills/show-me-your-work/SKILL.md"]) {
  const original = files.get(path);
  let text = original.toString();
  if (path === "skills/reflect/SKILL.md") {
    text = text.replace(/## 1\. Locate the active transcript[\s\S]*?(?=## 2\.)/, "## 1. Read the current session\n\nUse await context.history() to read this session. Pass the relevant messages and evidence as context_data to reviewers. Earlier transcripts must be explicitly supplied by the supervisor. Do not search global transcript directories or pretend that a filesystem session layout is part of the Python API.\n\n");
  } else if (path.endsWith("session-pickup.md")) {
    text = text.replace(/^1\. Locate the prior trail\..*$/m, "1. Locate the prior trail in the supplied state capsule, await context.history(), or project-scoped await memory.search(query). Read full entries with await memory.get(id). Earlier transcripts require an explicit supervisor-provided export. Preserve the original evidence and distinguish missing history from an empty result.");
  } else if (path.endsWith("eval.md")) {
    text = text.replace(/^6\. \*\*Verify the chain.*$/m, "6. **Verify the chain from evidence, not self-report.** Inspect the supervisor-returned child result and workspace change evidence. Use explicitly supplied session records for tool-level claims. If those records are unavailable, mark chain-following unverified rather than search an invented transcript path.");
  } else {
    text = text.replace(/^At the end of the run, before handing back,.*$/m, "At the end of the run, compare the log with await context.history() and the supervisor-returned child evidence. Read earlier session exports only when explicitly supplied. Each stretch of rows begins at this run's start row and ends at the next start row from another run.");
  }
  emit(path, text, `raga scoped-history adaptation of ${path}`, original);
}
const potetoPath = "skills/poteto-mode/SKILL.md";
const potetoOriginal = files.get(potetoPath);
emit(potetoPath, potetoOriginal.toString()
  .replace(/^\*\*Defaults for every `run_child` call\.\*\*.*$/m, "**Defaults for every run_child call.** Use the pinned resource root and one of worker, poteto-agent, or comment-sicko. Read-only reviewers use read_only=True. Writing children use read_only=False, details=True. Run independent calls with asyncio.gather. Select models from agents/model-roles.json. Null inherits the parent. Same-family seats are not model-diverse.")
  .replace(/^\*\*Match the model to the job\.\*\*.*$/m, "**Match the model to the job.** Use real configured provider/model selectors. The runtime does not accept separate effort, speed, cloud environment, or resume fields. Include each seat's configured selector in its assignment. Report an unavailable selector rather than substitute another model.")
  .replace(/set their own `spec` for diverse-model review/g, "choose a native specification and configured model for review"), "raga native delegation policy", potetoOriginal);
manifest.skills.sort((a, b) => a.name.localeCompare(b.name));
// A path has one final record, while source hashes retain the pinned input for copied assets.
manifest.files = [...new Map(manifest.files.map((entry) => [entry.path, entry])).values()].sort((a, b) => a.path.localeCompare(b.path));
for (const origin of sourceHashes.keys()) {
  if (pinnedSource.test(origin) && !consumedSources.has(origin)) throw new Error(`Missing pinned source asset: ${origin}`);
}
for (const previous of previousFiles) {
  if (!files.has(previous.path) && existsSync(join(root, previous.path))) {
    const destination = resolve(root, previous.path);
    if (!destination.startsWith(root + "/") || lstatSync(destination).isSymbolicLink()) throw new Error("Unsafe generated asset removal");
    if (digest(readFileSync(join(root, previous.path))) !== previous.sha256) throw new Error(`Refusing to remove modified generated asset ${previous.path}`);
    rmSync(join(root, previous.path));
  }
}
writeFileSync(join(root, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Generated ${manifest.skills.length} discoverable skills and ${files.size} assets from pinned sources`);
