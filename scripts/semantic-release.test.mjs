import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";
import { parse } from "yaml";
import config from "../release.config.mjs";

const logger = { log() {} };
const cwd = process.cwd();
const commits = (messages) => messages.map((message, index) => ({ message, hash: String(index).padStart(40, "a") }));

test("release configuration keeps the raga tag line and publishes only the changelog and GitHub release", () => {
	assert.deepEqual(config.branches, ["main"]);
	assert.equal(config.tagFormat.replace("${version}", "0.9.0"), "raga-v0.9.0");
	assert.deepEqual(config.plugins.map(([name]) => name), [
		"@semantic-release/commit-analyzer",
		"@semantic-release/release-notes-generator",
		"@semantic-release/changelog",
		"@semantic-release/git",
		"@semantic-release/github",
	]);
	assert.deepEqual(config.plugins[3][1].assets, ["CHANGELOG.md"]);
	assert.match(config.plugins[3][1].message, /\[skip ci\]/);
	assert.equal(config.plugins[4][1].successCommentCondition, false);
	assert.equal(config.plugins[4][1].failCommentCondition, false);
});

for (const [messages, expected] of [
	[["fix(auth): repair callback"], "patch"],
	[["perf: reduce startup time"], "patch"],
	[["feat: add a command", "fix: repair callback"], "minor"],
	[["feat!: change the command API"], "major"],
	[["refactor: replace API\n\nBREAKING CHANGE: use the new API"], "major"],
	[["docs: explain login", "chore: maintain dependencies", "ci: automate releases"], null],
]) {
	test(`configured analyzer selects ${expected} for ${messages.join("; ")}`, async () => {
		assert.equal(await analyzeCommits(config.plugins[0][1], { cwd, logger, commits: commits(messages) }), expected);
	});
}

test("release notes link raga tags and include breaking-change migration notes", async () => {
	const notes = await generateNotes(config.plugins[1][1], {
		cwd,
		commits: commits(["feat!: change the command API\n\nBREAKING CHANGE: use the new API"]),
		lastRelease: { gitTag: "raga-v0.8.0" },
		nextRelease: { version: "1.0.0", gitTag: "raga-v1.0.0" },
		options: { repositoryUrl: config.repositoryUrl },
	});
	assert.match(notes, /compare\/raga-v0\.8\.0\.\.\.raga-v1\.0\.0/);
	assert.match(notes, /use the new API/);
});

test("CI gates releases on all checks, restricts publishing, and fetches full history", () => {
	const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
	const release = workflow.jobs.release;
	assert.deepEqual(release.needs, ["build-check-test", "mcp-conformance"]);
	assert.match(release.if, /github.event_name == 'push'/);
	assert.match(release.if, /github.event_name == 'workflow_dispatch'/);
	assert.match(release.if, /github.ref == 'refs\/heads\/main'/);
	assert.match(release.if, /github.repository == 'mr-jones123\/raga'/);
	assert.deepEqual(release.permissions, { contents: "write", "id-token": "write" });
	assert.equal(release.steps[0].with["fetch-depth"], 0);
	assert.equal(release.steps.at(-2).run, "npx --no-install semantic-release");
	assert.equal(release.steps.at(-2).if, "github.event_name == 'push'");
	assert.equal(release.steps.at(-1).run, "node scripts/raga-publish.mjs");
	assert.equal(release.steps.find((step) => step.name === "Setup Node.js").with["node-version"], 24);
	assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
});


test("manual npm recovery tests the requested tag and does not create another release", () => {
    const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.required, true);
    for (const name of ["build-check-test", "mcp-conformance", "release"]) {
        assert.equal(workflow.jobs[name].steps[0].with.ref, "${{ inputs.release_tag || github.sha }}");
    }
    const validation = workflow.jobs.release.steps.find((step) => step.name === "Validate recovery tag");
    assert.equal(validation.if, "github.event_name == 'workflow_dispatch'");
    assert.equal(validation.env.RELEASE_TAG, "${{ inputs.release_tag }}");
    assert.match(validation.run, /refs\/tags\/\$RELEASE_TAG/);
    assert.match(validation.run, /git rev-parse HEAD/);
});
