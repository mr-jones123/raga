import { execFileSync } from "node:child_process";
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activateRevision,
	commitCandidate,
	computeEvidenceId,
	createCandidate,
	getCandidate,
	InstanceStoreError,
	type InstanceStoreErrorCode,
	initializeInstance,
	inspectCandidate,
	instancePaths,
	listRevisionDecisions,
	listRevisions,
	openInstance,
	readInstance,
	rollbackInstance,
} from "../src/core/instances/store.ts";
import type { EvaluationVerdict, InstanceManifest } from "../src/core/instances/types.ts";

let sandbox: string;

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "raga-store-"));
});

afterEach(async () => {
	await rm(sandbox, { recursive: true, force: true });
});

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
}

/** Every regular file under a directory, keyed by relative path. */
async function readTree(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		files[path.slice(root.length + 1)] = await readFile(path, "utf8");
	}
	return files;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function makeBundle(name = "bundle"): Promise<string> {
	const bundle = join(sandbox, name);
	await writeFiles(bundle, {
		"AGENTS.md": "bundle instructions\n",
		"skills/review/SKILL.md": "---\nname: review\ndescription: Review code\n---\nReview.\n",
		"docs/guide.md": "guide\n",
		"bundle.json": '{"source":"test"}\n',
	});
	return bundle;
}

async function makeProject(name: string, raga: Record<string, string> = {}): Promise<string> {
	const project = join(sandbox, name);
	await mkdir(project, { recursive: true });
	await writeFiles(join(project, ".raga"), raga);
	return project;
}

async function expectStoreError(promise: Promise<unknown>, code: InstanceStoreErrorCode): Promise<readonly string[]> {
	try {
		await promise;
	} catch (error) {
		if (!(error instanceof InstanceStoreError)) throw error;
		expect(error.code).toBe(code);
		return error.details;
	}
	throw new Error(`expected InstanceStoreError ${code}`);
}

interface EvidenceFields {
	instanceId: string;
	baseRevision: string;
	candidateRevision: string;
	verdict?: EvaluationVerdict;
}

/** Write evidence the way the trusted supervisor does: content-addressed under evidence/<id>.json. */
async function recordEvidence(project: string, fields: EvidenceFields): Promise<string> {
	const body = {
		schemaVersion: 1,
		instanceId: fields.instanceId,
		baseRevision: fields.baseRevision,
		candidateRevision: fields.candidateRevision,
		createdAt: new Date().toISOString(),
		verdict: fields.verdict ?? "passed",
		command: ["python", "-m", "pytest"],
		baseline: { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false, aborted: false },
		candidate: { exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false, aborted: false },
		reason: "candidate fixes the failing check",
		refinementId: "r-1",
	};
	const id = computeEvidenceId(body);
	await writeFile(join(instancePaths(project).evidence, `${id}.json`), JSON.stringify({ id, ...body }));
	return id;
}

async function commitRevision(root: string, candidateId: string, message: string): Promise<string> {
	const { revision } = await commitCandidate(root, candidateId, message);
	if (revision === undefined) throw new Error("commitCandidate returned no revision");
	return revision;
}

async function commitEdit(project: string, files: Record<string, string>, message = "Edit harness") {
	const root = instancePaths(project).root;
	const candidate = await createCandidate(root);
	await writeFiles(candidate.path, files);
	return { id: candidate.id, revision: await commitRevision(root, candidate.id, message) };
}

async function activateEdit(project: string, manifest: InstanceManifest, files: Record<string, string>) {
	const root = instancePaths(project).root;
	const candidate = await commitEdit(project, files);
	const evidenceId = await recordEvidence(project, {
		instanceId: manifest.id,
		baseRevision: manifest.activeRevision,
		candidateRevision: candidate.revision,
	});
	return activateRevision(root, candidate.revision, {
		expectedRevision: manifest.activeRevision,
		evidenceId,
		approved: true,
		approvedBy: "user",
	});
}

function cleanGitEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

describe("initializeInstance", () => {
	it("seeds the first accepted revision from the bundle and trusted project config, never credentials or state", async () => {
		const bundle = await makeBundle();
		const project = await makeProject("app", {
			"skills/local/SKILL.md": "---\nname: local\ndescription: Local\n---\n",
			"lessons/build.md": "Run the build before tests.\n",
			"settings.json": '{"theme":"dark","skills":["skills/local"]}\n',
			"auth.json": '{"anthropic":{"key":"secret"}}\n',
			"mcp.json": '{"mcpServers":{}}\n',
			"sessions/one.jsonl": "{}\n",
			"npm/node_modules/pkg/index.js": "module.exports = 1;\n",
		});
		const paths = instancePaths(project);

		const manifest = await initializeInstance(project, { harnessSource: bundle, projectTrusted: true });
		const pin = await openInstance(paths.root);

		expect(pin.revision).toBe(manifest.activeRevision);
		expect(pin.stateRoot).toBe(paths.state);
		expect(await readTree(pin.resourceRoot)).toEqual({
			"AGENTS.md": "bundle instructions\n",
			"bundle.json": '{"source":"test"}\n',
			"docs/guide.md": "guide\n",
			"skills/review/SKILL.md": "---\nname: review\ndescription: Review code\n---\nReview.\n",
			"skills/local/SKILL.md": "---\nname: local\ndescription: Local\n---\n",
			"lessons/build.md": "Run the build before tests.\n",
			"settings.json": '{"theme":"dark","skills":["skills/local"]}\n',
		});
		expect(await readFile(join(paths.root, "auth.json"), "utf8")).toContain("secret");
		expect(await exists(join(paths.root, "skills/local/SKILL.md"))).toBe(true);
		expect(await readInstance(paths.root)).toEqual(manifest);
		expect(await listRevisions(paths.root)).toEqual([
			{ revision: manifest.activeRevision, message: "Initialize harness", active: true, accepted: true },
		]);
	});

	it("leaves trust-requiring resources of an untrusted project out of the harness", async () => {
		const project = await makeProject("untrusted", {
			"extensions/tool.ts": "export default () => {};\n",
			"skills/local/SKILL.md": "---\nname: local\ndescription: Local\n---\n",
			"lessons/style.md": "Prefer small diffs.\n",
		});
		await initializeInstance(project, { harnessSource: await makeBundle() });
		const files = await readTree((await openInstance(instancePaths(project).root)).resourceRoot);

		expect(files["lessons/style.md"]).toBe("Prefer small diffs.\n");
		expect(files["extensions/tool.ts"]).toBeUndefined();
		expect(files["skills/local/SKILL.md"]).toBeUndefined();
		expect(await exists(join(project, ".raga/extensions/tool.ts"))).toBe(true);
	});

	it("rejects secrets and external executables, publishes nothing, and succeeds once they are fixed", async () => {
		const bundle = await makeBundle();
		const project = await makeProject("leaky", {
			"skills/local/SKILL.md": "---\nname: local\ndescription: Local\n---\n",
			"skills/local/.env": "TOKEN=secret\n",
			"settings.json": '{"packages":["npm:some-extension"],"extensions":["/home/user/tool.ts"]}\n',
		});
		const root = instancePaths(project).root;

		const details = await expectStoreError(
			initializeInstance(project, { harnessSource: bundle, projectTrusted: true }),
			"invalid-resource",
		);
		expect(details.join("\n")).toContain("skills/local/.env");
		await expectStoreError(readInstance(root), "not-initialized");
		expect(await readFile(join(root, "skills/local/.env"), "utf8")).toBe("TOKEN=secret\n");

		await unlink(join(root, "skills/local/.env"));
		const settingsDetails = await expectStoreError(
			initializeInstance(project, { harnessSource: bundle, projectTrusted: true }),
			"invalid-resource",
		);
		expect(settingsDetails.some((detail) => detail.includes("packages"))).toBe(true);
		expect(settingsDetails.some((detail) => detail.includes("/home/user/tool.ts"))).toBe(true);

		await writeFile(join(root, "settings.json"), '{"extensions":["extensions"]}\n');
		const manifest = await initializeInstance(project, { harnessSource: bundle, projectTrusted: true });
		expect((await readInstance(root)).activeRevision).toBe(manifest.activeRevision);
	});

	it("copies symlinks that stay inside the source and rejects ones that escape it", async () => {
		const bundle = await makeBundle();
		await symlink(join(bundle, "skills/review"), join(bundle, "skills/alias"));
		const project = await makeProject("links");
		await initializeInstance(project, { harnessSource: bundle });
		const files = await readTree((await openInstance(instancePaths(project).root)).resourceRoot);
		expect(files["skills/alias/SKILL.md"]).toBe(files["skills/review/SKILL.md"]);

		await writeFile(join(sandbox, "secret.txt"), "secret\n");
		await symlink(join(sandbox, "secret.txt"), join(bundle, "skills/review/notes.md"));
		const details = await expectStoreError(
			initializeInstance(await makeProject("escape"), { harnessSource: bundle }),
			"invalid-resource",
		);
		expect(details.join("\n")).toContain("skills/review/notes.md");
	});

	it("reports project files that collide with the bundle instead of overwriting either", async () => {
		const project = await makeProject("collide", { "AGENTS.md": "project instructions\n" });
		const details = await expectStoreError(
			initializeInstance(project, { harnessSource: await makeBundle() }),
			"resource-conflict",
		);
		expect(details).toEqual(["AGENTS.md"]);
		expect(await readFile(join(project, ".raga/AGENTS.md"), "utf8")).toBe("project instructions\n");
		await expectStoreError(readInstance(instancePaths(project).root), "not-initialized");
	});

	it("lets exactly one of two concurrent initializations win", async () => {
		const bundle = await makeBundle();
		const project = await makeProject("race");
		const results = await Promise.allSettled([
			initializeInstance(project, { harnessSource: bundle }),
			initializeInstance(project, { harnessSource: bundle }),
		]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected[0]?.reason).toMatchObject({ code: "already-initialized" });
		expect(await readInstance(instancePaths(project).root)).toEqual(fulfilled[0]?.value);
	});

	it("reinitializes cleanly after a crash before the manifest was published", async () => {
		const bundle = await makeBundle();
		const project = await makeProject("crashed");
		const paths = instancePaths(project);
		const first = await initializeInstance(project, { harnessSource: bundle });
		await unlink(paths.manifest);
		await mkdir(join(paths.root, ".staging-left-behind/tree"), { recursive: true });

		const second = await initializeInstance(project, { harnessSource: bundle });
		expect(second.id).not.toBe(first.id);
		expect((await readdir(paths.root)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
		expect((await readTree((await openInstance(paths.root)).resourceRoot))["AGENTS.md"]).toBe(
			"bundle instructions\n",
		);
	});

	it("refuses to adopt a .raga/harness it did not create", async () => {
		const project = await makeProject("foreign", { "harness/README.md": "user data\n" });
		await expectStoreError(initializeInstance(project, { harnessSource: await makeBundle() }), "resource-conflict");
		expect(await readFile(join(project, ".raga/harness/README.md"), "utf8")).toBe("user data\n");
	});

	it("rejects a .raga directory copied into another project", async () => {
		const original = await makeProject("original");
		await initializeInstance(original, { harnessSource: await makeBundle() });
		const copy = await makeProject("copy");
		await cp(join(original, ".raga"), join(copy, ".raga"), { recursive: true });

		await expectStoreError(readInstance(instancePaths(copy).root), "project-mismatch");
		await expectStoreError(openInstance(instancePaths(copy).root), "project-mismatch");
	});

	it("never writes to the user's repository index, even with inherited GIT_DIR and GIT_INDEX_FILE", async () => {
		const project = await makeProject("repo");
		const gitArgs = ["-C", project, "-c", "user.name=user", "-c", "user.email=user@example.com"];
		execFileSync("git", [...gitArgs, "init", "--quiet"], { env: cleanGitEnv() });
		await writeFile(join(project, "committed.txt"), "one\n");
		execFileSync("git", [...gitArgs, "add", "committed.txt"], { env: cleanGitEnv() });
		execFileSync("git", [...gitArgs, "commit", "--quiet", "-m", "initial"], { env: cleanGitEnv() });
		await writeFile(join(project, "staged.txt"), "staged\n");
		execFileSync("git", [...gitArgs, "add", "staged.txt"], { env: cleanGitEnv() });
		const head = execFileSync("git", [...gitArgs, "rev-parse", "HEAD"], { env: cleanGitEnv() }).toString();

		vi.stubEnv("GIT_DIR", join(project, ".git"));
		vi.stubEnv("GIT_INDEX_FILE", join(project, ".git/index"));
		vi.stubEnv("GIT_WORK_TREE", project);
		await initializeInstance(project, { harnessSource: await makeBundle() });
		await commitEdit(project, { "lessons/new.md": "lesson\n" });
		vi.unstubAllEnvs();

		const staged = execFileSync("git", [...gitArgs, "diff", "--cached", "--name-only"], { env: cleanGitEnv() });
		expect(staged.toString().trim().split("\n")).toEqual(["staged.txt"]);
		expect(execFileSync("git", [...gitArgs, "rev-parse", "HEAD"], { env: cleanGitEnv() }).toString()).toBe(head);
	});
});

describe("fork", () => {
	it("copies an accepted revision without state, evidence, or candidates and then evolves independently", async () => {
		const source = await makeProject("source");
		const sourceRoot = instancePaths(source).root;
		const sourceManifest = await initializeInstance(source, { harnessSource: await makeBundle() });
		await writeFiles(instancePaths(source).state, { "memory/observations.jsonl": '{"text":"private"}\n' });
		const draft = await createCandidate(sourceRoot);
		await writeFiles(draft.path, { "lessons/draft.md": "unreviewed\n" });
		const activated = await activateEdit(source, sourceManifest, { "lessons/accepted.md": "accepted\n" });

		const target = await makeProject("target");
		const targetRoot = instancePaths(target).root;
		const fork = await initializeInstance(target, {
			forkFrom: { instanceRoot: sourceRoot, revision: sourceManifest.activeRevision },
		});

		expect(fork.id).not.toBe(sourceManifest.id);
		expect(fork.activeRevision).toBe(sourceManifest.activeRevision);
		expect(fork.forkedFrom).toEqual({ instanceId: sourceManifest.id, revision: sourceManifest.activeRevision });
		const sourceFiles = await readTree((await openInstance(sourceRoot, sourceManifest.activeRevision)).resourceRoot);
		expect(await readTree((await openInstance(targetRoot)).resourceRoot)).toEqual(sourceFiles);
		expect(await readTree(instancePaths(target).state)).toEqual({});
		expect(await readTree(instancePaths(target).evidence)).toEqual({});
		expect((await listRevisions(targetRoot)).map((entry) => entry.revision)).toEqual([fork.activeRevision]);

		await activateEdit(target, fork, { "lessons/target.md": "target only\n" });
		expect((await readInstance(sourceRoot)).activeRevision).toBe(activated.activeRevision);
		expect((await readTree((await openInstance(sourceRoot)).resourceRoot))["lessons/target.md"]).toBeUndefined();
	});

	it("imports the target project's config on top of the forked revision", async () => {
		const source = await makeProject("source");
		const sourceManifest = await initializeInstance(source, { harnessSource: await makeBundle() });
		const target = await makeProject("target", { "lessons/target.md": "target lesson\n" });

		const fork = await initializeInstance(target, { forkFrom: { instanceRoot: instancePaths(source).root } });

		expect(fork.activeRevision).not.toBe(sourceManifest.activeRevision);
		expect(fork.forkedFrom?.revision).toBe(sourceManifest.activeRevision);
		const files = await readTree((await openInstance(instancePaths(target).root)).resourceRoot);
		expect(files["lessons/target.md"]).toBe("target lesson\n");
		expect(files["AGENTS.md"]).toBe("bundle instructions\n");
	});

	it("refuses to fork a revision the source never accepted", async () => {
		const source = await makeProject("source");
		await initializeInstance(source, { harnessSource: await makeBundle() });
		const candidate = await commitEdit(source, { "lessons/x.md": "x\n" });

		await expectStoreError(
			initializeInstance(await makeProject("target"), {
				forkFrom: { instanceRoot: instancePaths(source).root, revision: candidate.revision },
			}),
			"unaccepted-revision",
		);
	});
});

describe("candidates", () => {
	it("binds every content change to a new revision and reports unrecorded edits", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		const manifest = await initializeInstance(project, { harnessSource: await makeBundle() });

		const candidate = await createCandidate(root);
		expect(candidate.baseRevision).toBe(manifest.activeRevision);
		expect(candidate.path.startsWith(instancePaths(project).worktrees)).toBe(true);
		expect(await exists(join(candidate.path, ".git"))).toBe(false);
		expect((await inspectCandidate(root, candidate.id)).modified).toBe(false);

		await writeFiles(candidate.path, { "skills/new/SKILL.md": "---\nname: new\ndescription: New\n---\n" });
		expect((await inspectCandidate(root, candidate.id)).modified).toBe(true);
		const first = await commitCandidate(root, candidate.id, "Add new skill");
		expect(first.revision).toMatch(/^[0-9a-f]{40}$/);
		expect(await getCandidate(root, candidate.id)).toEqual(first);
		const clean = await inspectCandidate(root, candidate.id);
		expect(clean.modified).toBe(false);
		expect(clean.tree).toBe(clean.committedTree);

		expect((await commitCandidate(root, candidate.id, "Same content")).revision).toBe(first.revision);

		await writeFiles(candidate.path, { "skills/new/SKILL.md": "---\nname: new\ndescription: Changed\n---\n" });
		expect((await inspectCandidate(root, candidate.id)).modified).toBe(true);
		const second = await commitCandidate(root, candidate.id, "Change description");
		expect(second.revision).not.toBe(first.revision);

		const revisions = await listRevisions(root);
		expect(revisions.find((entry) => entry.revision === second.revision)).toEqual({
			revision: second.revision,
			message: "Change description",
			active: false,
			accepted: false,
		});
	});

	it("rejects credentials, symlinks, and unknown top-level files without recording a revision", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		await initializeInstance(project, { harnessSource: await makeBundle() });
		const candidate = await createCandidate(root);
		await writeFiles(candidate.path, {
			"auth.json": "{}\n",
			"skills/review/id_rsa": "key\n",
			"run.sh": "#!/bin/sh\n",
		});
		await symlink("/etc/passwd", join(candidate.path, "lessons-link"));

		const details = await expectStoreError(commitCandidate(root, candidate.id, "Leak"), "invalid-resource");
		const text = details.join("\n");
		for (const path of ["auth.json", "skills/review/id_rsa", "run.sh", "lessons-link"]) expect(text).toContain(path);
		expect((await getCandidate(root, candidate.id)).revision).toBeUndefined();
	});

	it("ignores caches produced by running skills", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		await initializeInstance(project, { harnessSource: await makeBundle() });
		const candidate = await createCandidate(root);
		await writeFiles(candidate.path, {
			"skills/review/__pycache__/helper.cpython-312.pyc": "bytecode",
			"skills/review/node_modules/dep/index.js": "module.exports = 1;\n",
		});
		expect((await inspectCandidate(root, candidate.id)).modified).toBe(false);
	});

	it("refuses candidate revisions, unknown revisions, and path-like candidate ids", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		await initializeInstance(project, { harnessSource: await makeBundle() });
		const candidate = await commitEdit(project, { "lessons/x.md": "x\n" });

		await expectStoreError(openInstance(root, candidate.revision), "unaccepted-revision");
		await expectStoreError(openInstance(root, "0".repeat(40)), "unknown-revision");
		await expectStoreError(openInstance(root, "HEAD"), "unknown-revision");
		await expectStoreError(getCandidate(root, "../../evidence/x"), "unknown-candidate");
	});
});

describe("activateRevision", () => {
	it("requires approval and passing evidence for exactly the active base and the candidate commit", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		const manifest = await initializeInstance(project, { harnessSource: await makeBundle() });
		const base = manifest.activeRevision;
		const runningSession = await openInstance(root);

		const candidate = await createCandidate(root);
		await writeFiles(candidate.path, { "AGENTS.md": "improved instructions\n" });
		const tested = await commitRevision(root, candidate.id, "Improve instructions");
		const testedEvidence = await recordEvidence(project, {
			instanceId: manifest.id,
			baseRevision: base,
			candidateRevision: tested,
		});
		await writeFiles(candidate.path, { "AGENTS.md": "edited after evaluation\n" });
		const untested = await commitRevision(root, candidate.id, "Edit after evaluation");
		const activate = (
			revision: string,
			evidenceId: string,
			overrides: { approved?: boolean; expected?: string } = {},
		) =>
			activateRevision(root, revision, {
				expectedRevision: overrides.expected ?? base,
				evidenceId,
				approved: overrides.approved ?? true,
				approvedBy: "user",
			});

		await expectStoreError(activate(untested, testedEvidence), "invalid-evidence");
		await expectStoreError(activate(tested, "missing"), "invalid-evidence");
		await expectStoreError(activate(tested, "../instance"), "invalid-evidence");
		const failed = await recordEvidence(project, {
			instanceId: manifest.id,
			baseRevision: base,
			candidateRevision: tested,
			verdict: "failed",
		});
		await expectStoreError(activate(tested, failed), "invalid-evidence");
		const failedPath = join(instancePaths(project).evidence, `${failed}.json`);
		const forged = JSON.parse(await readFile(failedPath, "utf8"));
		await writeFile(failedPath, JSON.stringify({ ...forged, verdict: "passed" }));
		await expectStoreError(activate(tested, failed), "invalid-evidence");
		await expectStoreError(activate(tested, testedEvidence, { approved: false }), "approval-required");
		await expectStoreError(activate(tested, testedEvidence, { expected: tested }), "revision-conflict");
		expect((await readInstance(root)).activeRevision).toBe(base);

		const next = await activate(tested, testedEvidence);
		expect(next.activeRevision).toBe(tested);
		expect(await readInstance(root)).toEqual(next);
		expect(await readFile(join(runningSession.resourceRoot, "AGENTS.md"), "utf8")).toBe("bundle instructions\n");
		expect(await readFile(join((await openInstance(root)).resourceRoot, "AGENTS.md"), "utf8")).toBe(
			"improved instructions\n",
		);
		expect((await openInstance(root, base)).resourceRoot).toBe(runningSession.resourceRoot);
		expect(await listRevisionDecisions(root)).toEqual([
			expect.objectContaining({
				kind: "activate",
				previousRevision: base,
				revision: tested,
				evidenceId: testedEvidence,
				approvedBy: "user",
			}),
		]);
	});

	it("lets exactly one of two competing promotions win", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		const manifest = await initializeInstance(project, { harnessSource: await makeBundle() });
		const left = await commitEdit(project, { "lessons/left.md": "left\n" });
		const right = await commitEdit(project, { "lessons/right.md": "right\n" });
		const promote = async (revision: string) =>
			activateRevision(root, revision, {
				expectedRevision: manifest.activeRevision,
				evidenceId: await recordEvidence(project, {
					instanceId: manifest.id,
					baseRevision: manifest.activeRevision,
					candidateRevision: revision,
				}),
				approved: true,
				approvedBy: "user",
			});

		const results = await Promise.allSettled([promote(left.revision), promote(right.revision)]);
		const winners = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		const losers = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		expect(winners).toHaveLength(1);
		expect(losers).toEqual([expect.objectContaining({ code: "revision-conflict" })]);
		expect((await readInstance(root)).activeRevision).toBe(winners[0]?.activeRevision);
		expect(await listRevisionDecisions(root)).toHaveLength(1);
	});

	it("refuses policy approval for extension and settings changes but accepts user approval", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		const manifest = await initializeInstance(project, { harnessSource: await makeBundle() });
		const extension = await commitEdit(project, { "extensions/tool.ts": "export default () => {};\n" });
		const evidenceId = await recordEvidence(project, {
			instanceId: manifest.id,
			baseRevision: manifest.activeRevision,
			candidateRevision: extension.revision,
		});
		const options = { expectedRevision: manifest.activeRevision, evidenceId, approved: true };

		const details = await expectStoreError(
			activateRevision(root, extension.revision, { ...options, approvedBy: "policy" }),
			"approval-required",
		);
		expect(details).toEqual(["extensions/tool.ts"]);
		const next = await activateRevision(root, extension.revision, { ...options, approvedBy: "user" });
		expect(next.activeRevision).toBe(extension.revision);

		const lesson = await commitEdit(project, { "lessons/policy.md": "lesson\n" });
		const policyActivation = await activateRevision(root, lesson.revision, {
			expectedRevision: next.activeRevision,
			evidenceId: await recordEvidence(project, {
				instanceId: manifest.id,
				baseRevision: next.activeRevision,
				candidateRevision: lesson.revision,
			}),
			approved: true,
			approvedBy: "policy",
		});
		expect(policyActivation.activeRevision).toBe(lesson.revision);
	});

	it("waits out a lock left by a crashed process", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		const manifest = await initializeInstance(project, { harnessSource: await makeBundle() });
		const lock = join(root, "instance.lock");
		await mkdir(lock);
		const longAgo = new Date(Date.now() - 120_000);
		await utimes(lock, longAgo, longAgo);

		const next = await activateEdit(project, manifest, { "lessons/after-crash.md": "ok\n" });
		expect((await readInstance(root)).activeRevision).toBe(next.activeRevision);
	});
});

describe("rollbackInstance", () => {
	it("returns only to previously accepted revisions and changes what new sessions load", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		const initial = await initializeInstance(project, { harnessSource: await makeBundle() });
		const improved = await activateEdit(project, initial, { "AGENTS.md": "improved\n" });
		const draft = await commitEdit(project, { "AGENTS.md": "draft\n" });

		await expectStoreError(rollbackInstance(root, draft.revision, improved.activeRevision), "unaccepted-revision");
		await expectStoreError(
			rollbackInstance(root, initial.activeRevision, initial.activeRevision),
			"revision-conflict",
		);

		const rolledBack = await rollbackInstance(root, initial.activeRevision, improved.activeRevision);
		expect(rolledBack.activeRevision).toBe(initial.activeRevision);
		expect(await readFile(join((await openInstance(root)).resourceRoot, "AGENTS.md"), "utf8")).toBe(
			"bundle instructions\n",
		);

		const forward = await rollbackInstance(root, improved.activeRevision, initial.activeRevision);
		expect(forward.activeRevision).toBe(improved.activeRevision);
		expect((await listRevisionDecisions(root)).map((decision) => decision.kind)).toEqual([
			"activate",
			"rollback",
			"rollback",
		]);
		const accepted = (await listRevisions(root)).filter((entry) => entry.accepted).map((entry) => entry.revision);
		expect(accepted.sort()).toEqual([initial.activeRevision, improved.activeRevision].sort());
	});
});

describe("openInstance", () => {
	it("restores a tampered pinned checkout to the exact revision content", async () => {
		const project = await makeProject("app");
		const root = instancePaths(project).root;
		await initializeInstance(project, { harnessSource: await makeBundle() });
		const pin = await openInstance(root);
		const original = await readTree(pin.resourceRoot);

		await writeFile(join(pin.resourceRoot, "AGENTS.md"), "tampered\n");
		await writeFiles(pin.resourceRoot, { "skills/injected/SKILL.md": "injected\n" });

		const reopened = await openInstance(root);
		expect(reopened.resourceRoot).toBe(pin.resourceRoot);
		expect(await readTree(reopened.resourceRoot)).toEqual(original);
	});
});
