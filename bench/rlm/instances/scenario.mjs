import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getBundledHarnessPath } from "../../../packages/coding-agent/src/core/instances/bundle.ts";
import { InstanceMemory } from "../../../packages/coding-agent/src/core/instances/memory.ts";
import { refineInstance } from "../../../packages/coding-agent/src/core/instances/refinement.ts";
import { sandboxCommand } from "../../../packages/coding-agent/src/core/instances/sandbox.ts";
import { activateRevision, initializeInstance, instancePaths, openInstance, readInstance, readRevisionEvidence, rollbackInstance } from "../../../packages/coding-agent/src/core/instances/store.ts";
import { collectChildChange, createChildWorkspace, integrateChildChange, removeChildWorkspace, snapshotProject } from "../../../packages/coding-agent/src/core/instances/workspaces.ts";
import { createRepository, git } from "./tasks.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const root = mkdtempSync(join(tmpdir(), "raga-instance-scenario-"));
const result = { schemaVersion: 1, kind: "deterministic-system-smoke", qualityComparison: false, modelCalls: 0, root, checks: [], success: false };
const save = () => writeFileSync(join(config.output, "scenario.json"), `${JSON.stringify(result, null, 2)}\n`);
const check = (name, data) => { result.checks.push({ name, ...data }); save(); };
const workspaces = [];
let runningWorker;
try {
	const source = config.harnessSource ?? getBundledHarnessPath();
	const a = createRepository(join(root, "atlas"), "atlas");
	const b = createRepository(join(root, "beacon"), "beacon");
	const first = await initializeInstance(a, { harnessSource: source, projectTrusted: true });
	const second = await initializeInstance(b, { forkFrom: { instanceRoot: instancePaths(a).root, revision: first.activeRevision } });
	const aRoot = instancePaths(a).root;
	const bRoot = instancePaths(b).root;
	assert.notEqual(first.id, second.id);
	const original = await openInstance(aRoot);
	const independent = await openInstance(bRoot);
	assert.equal(original.revision, independent.revision);
	check("independent instances share only the baseline content", { instances: [first.id, second.id], revisions: [original.revision, independent.revision] });

	const snapshot = await snapshotProject(a);
	mkdirSync(join(root, "writers"), { recursive: true });
	const left = await createChildWorkspace(snapshot, join(root, "writers", "left"));
	const right = await createChildWorkspace(snapshot, join(root, "writers", "right"));
	const integration = await createChildWorkspace(snapshot, join(root, "integration"));
	workspaces.push(left, right, integration);
	const writes = await Promise.all([
		sandboxCommand({ command: "python3", args: ["-I", "-B", "-c", 'from pathlib import Path; Path("left.txt").write_text("left writer\\n")'], policy: { workspace: left.path, readOnly: [], writable: [], network: false }, timeoutMs: 30_000 }),
		sandboxCommand({ command: "python3", args: ["-I", "-B", "-c", 'from pathlib import Path; Path("right.txt").write_text("right writer\\n")'], policy: { workspace: right.path, readOnly: [], writable: [], network: false }, timeoutMs: 30_000 }),
	]);
	assert(writes.every((entry) => entry.exitCode === 0));
	assert(!existsSync(join(a, "left.txt")));
	assert(!existsSync(join(a, "right.txt")));
	assert(!existsSync(join(left.path, "right.txt")));
	assert(!existsSync(join(right.path, "left.txt")));
	assert.equal(git(a, "status", "--porcelain"), "");
	check("real sandbox writers never mutate each other or the checkout", { snapshot: snapshot.commit, writers: [left, right], commands: writes });

	const leftChange = await collectChildChange(left);
	const rightChange = await collectChildChange(right);
	const mergedLeft = await integrateChildChange(integration, leftChange, { command: "python3", args: ["-I", "-B", "-c", 'from pathlib import Path; assert Path("left.txt").read_text() == "left writer\\n"'], timeoutMs: 30_000 });
	assert(mergedLeft.accepted);
	const mergedBoth = await integrateChildChange(integration, rightChange, { command: "python3", args: ["-I", "-B", "-c", 'from pathlib import Path; assert Path("left.txt").read_text() == "left writer\\n"; assert Path("right.txt").read_text() == "right writer\\n"'], timeoutMs: 30_000 });
	assert(mergedBoth.accepted);
	check("integration verifies the combined changes in its own workspace", { left: mergedLeft, combined: mergedBoth });

	const memoryA = new InstanceMemory(aRoot);
	const memoryB = new InstanceMemory(bRoot);
	const observation = await memoryA.observe({ text: "The two writer workspaces retained independent files. Combined integration verified both outputs.", scope: a, kind: "lesson", evidence: [leftChange.commit, rightChange.commit], sharing: "reusable", taskType: "integration", epistemicStatus: "observed", trust: "curated" });
	assert.equal((await memoryB.list()).length, 0);
	const transferred = await memoryB.importEntries(await memoryA.exportEntries([observation.id]), { scope: b });
	const retrieved = await memoryB.retrieve({ query: "writer workspaces integration", scope: b, taskType: "integration" });
	assert.equal(retrieved.selected.length, 1);
	assert.equal(transferred[0].importedFrom.scope, a);
	check("memory crosses project scope only through explicit export and import", { source: observation.id, imported: transferred.map(({ id }) => id), retrieval: retrieved });

	const evaluator = join(config.output, "scenario-evaluator");
	mkdirSync(evaluator, { recursive: true });
	writeFileSync(join(evaluator, "evaluate.py"), `import importlib.util, os, pathlib\nharness = pathlib.Path(os.environ["RAGA_HARNESS"])\nmodule_file = harness / "skills/scenario-transform/helper.py"\nscore = 0\nif module_file.is_file():\n    spec = importlib.util.spec_from_file_location("helper", module_file)\n    module = importlib.util.module_from_spec(spec)\n    spec.loader.exec_module(module)\n    score = int(module.unique([3, 1, 3, 2, 1]) == [3, 2, 1] and module.unique([]) == [])\nprint("RAGA_SCORE=" + str(score))\n`, { mode: 0o400 });
	const workerSpace = join(root, "pinned-worker");
	mkdirSync(workerSpace);
	const beforeInstructions = readFileSync(join(original.resourceRoot, "AGENTS.md"), "utf8");
	const workerCode = `import hashlib, json, os, pathlib, time\npin = pathlib.Path(os.environ["PINNED_HARNESS"])\nbefore = (pin / "AGENTS.md").read_text()\npathlib.Path("started").write_text("ready")\nwhile not pathlib.Path("release").exists():\n    time.sleep(0.02)\nafter = (pin / "AGENTS.md").read_text()\nprint(json.dumps({"revision": os.environ["PINNED_REVISION"], "before": hashlib.sha256(before.encode()).hexdigest(), "after": hashlib.sha256(after.encode()).hexdigest()}))\n`;
	runningWorker = sandboxCommand({ command: "python3", args: ["-I", "-B", "-c", workerCode], policy: { workspace: workerSpace, readOnly: [original.resourceRoot], writable: [], network: false, env: { PINNED_HARNESS: original.resourceRoot, PINNED_REVISION: original.revision } }, timeoutMs: config.timeoutMs });
	runningWorker.catch(() => {});
	for (let count = 0; !existsSync(join(workerSpace, "started")) && count < 500; count++) await delay(20);
	assert(existsSync(join(workerSpace, "started")), "pinned OS worker started");
	const refinement = await refineInstance({
		instanceRoot: aRoot,
		objective: "System smoke only. Install a deterministic executable transform and measure its actual output.",
		probe: { command: "python3", args: ["-I", "-B", join(evaluator, "evaluate.py")], evaluatorRoot: evaluator, timeoutMs: 30_000, repetitions: 2, externalEffects: "none", notCovered: ["No provider, learning, or adaptive quality comparison"] },
		budget: { maxCandidates: 1, maxDriverCalls: 1, maxProbeRuns: 4, deadlineMs: Math.min(config.timeoutMs, 120_000) },
		driver: {
			async propose(request) {
				const dir = join(request.checkout, "skills", "scenario-transform");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "SKILL.md"), "---\nname: scenario-transform\ndescription: Keep the last occurrence of each integer.\n---\nRun helper.py with an explicit list. This is a deterministic system fixture.\n");
				writeFileSync(join(dir, "helper.py"), "def unique(values):\n    seen = set()\n    result = []\n    for value in reversed(values):\n        if value not in seen:\n            seen.add(value)\n            result.append(value)\n    return list(reversed(result))\n");
				writeFileSync(join(request.checkout, "AGENTS.md"), `${beforeInstructions}\nSystem scenario uses the executable scenario-transform skill.\n`);
				return { hypothesis: "Execute the deterministic transformation in a fresh interpreter", modelCalls: 1 };
			},
			async compose() { throw new Error("A single-candidate scenario cannot compose"); },
		},
	});
	assert.equal(refinement.outcome.kind, "improved");
	const outcome = refinement.outcome;
	const evidence = await readRevisionEvidence(aRoot, outcome.evidenceId);
	assert.equal(evidence.candidateRevision, outcome.revision);
	assert.equal(evidence.baseRevision, original.revision);
	assert.equal(evidence.verdict, "passed");
	assert(refinement.candidates.every((candidate) => candidate.revision === outcome.revision));
	check("supervisor evaluates the exact committed candidate twice", { refinement, evidenceId: evidence.id, actualProviderCalls: 0, scriptedDriverBudgetCharges: refinement.usage.driverCalls });
	const promoted = await activateRevision(aRoot, outcome.revision, { expectedRevision: original.revision, evidenceId: outcome.evidenceId, approved: true, approvedBy: "user" });
	await assert.rejects(activateRevision(aRoot, outcome.revision, { expectedRevision: original.revision, evidenceId: outcome.evidenceId, approved: true, approvedBy: "user" }), (error) => error.code === "revision-conflict");
	assert.equal((await readInstance(bRoot)).activeRevision, independent.revision);
	assert.equal((await openInstance(aRoot)).revision, outcome.revision);
	writeFileSync(join(workerSpace, "release"), "continue\n");
	const worker = await runningWorker;
	runningWorker = null;
	assert.equal(worker.exitCode, 0);
	const identity = JSON.parse(worker.stdout.trim());
	assert.equal(identity.revision, original.revision);
	assert.equal(identity.before, identity.after);
	check("CAS promotion leaves the running pinned process and other instance unchanged", { active: promoted.activeRevision, running: identity, independentRevision: (await readInstance(bRoot)).activeRevision });
	const rolledBack = await rollbackInstance(aRoot, original.revision, promoted.activeRevision);
	assert.equal(rolledBack.activeRevision, original.revision);
	assert.equal((await memoryB.list()).length, 1);
	assert.equal(readFileSync(join(a, "solution.py"), "utf8"), readFileSync(join(b, "solution.py"), "utf8"));
	check("rollback restores the accepted revision without deleting transferred evidence", { revision: rolledBack.activeRevision });
	result.success = true;
} catch (error) {
	result.error = String(error);
	process.exitCode = 1;
} finally {
	if (runningWorker) {
		writeFileSync(join(root, "pinned-worker", "release"), "stop\n");
		try { result.workerCleanup = await runningWorker; }
		catch (error) { result.workerCleanup = { error: String(error) }; }
	}
	for (const workspace of workspaces.reverse()) await removeChildWorkspace(workspace);
	save();
}
console.log(`JSON: ${join(config.output, "scenario.json")}`);
