import assert from "node:assert/strict";
import test from "node:test";
import { publishRaga } from "./raga-publish.mjs";

function fixture({ tags = "raga-v0.9.0", npm = "11.5.1", status = 404, body } = {}) {
    const calls = [];
    const urls = [];
    return {
        calls, urls,
        options: {
            run(command, args) {
                calls.push([command, args]);
                if (command === "git") return tags;
                if (args[0] === "--version") return npm;
                return "ok";
            },
            async fetchRelease(url) {
                urls.push(url);
                return new Response(body === undefined ? null : JSON.stringify(body), { status });
            },
            log() {},
        },
    };
}

test("publishes the exact tagged raga tarball with OIDC provenance", async () => {
    const f = fixture();
    await publishRaga(f.options);
    assert.deepEqual(f.urls, ["https://registry.npmjs.org/raga-cli/0.9.0"]);
    assert.deepEqual(f.calls.slice(1), [
        ["npm", ["--version"]],
        [process.execPath, ["scripts/raga-pack.mjs"]],
        ["npm", ["publish", "packages/coding-agent/dist/raga-cli-0.9.0.tgz", "--access", "public", "--provenance", "--ignore-scripts"]],
    ]);
});

test("does not build or publish when no release was created", async () => {
    const f = fixture({ tags: "" });
    await publishRaga(f.options);
    assert.equal(f.calls.length, 1);
    assert.equal(f.urls.length, 0);
});

test("does not republish an immutable npm version on a retry", async () => {
    const f = fixture({ status: 200, body: { name: "raga-cli", version: "0.9.0" } });
    await publishRaga(f.options);
    assert.equal(f.calls.length, 1);
});

for (const status of [401, 403, 429, 500]) {
    test(`fails closed on npm HTTP ${status}`, async () => {
        const f = fixture({ status });
        await assert.rejects(publishRaga(f.options), /npm registry lookup failed/);
        assert.equal(f.calls.length, 1);
    });
}

test("rejects an unexpected registry response", async () => {
    const f = fixture({ status: 200, body: { name: "wrong", version: "0.9.0" } });
    await assert.rejects(publishRaga(f.options), /Unexpected npm registry response/);
});

test("does not publish on network failure", async () => {
    const f = fixture();
    f.options.fetchRelease = async () => { throw new Error("offline"); };
    await assert.rejects(publishRaga(f.options), /offline/);
    assert.equal(f.calls.length, 1);
});

test("rejects ambiguous release tags", async () => {
    const f = fixture({ tags: "raga-v0.9.0\nraga-v0.10.0" });
    await assert.rejects(publishRaga(f.options), /exactly one/);
    assert.equal(f.urls.length, 0);
});

for (const npm of ["10.9.3", "11.5.0"]) {
    test(`rejects npm ${npm} without OIDC support`, async () => {
        const f = fixture({ npm });
        await assert.rejects(publishRaga(f.options), /11.5.1/);
        assert.equal(f.calls.length, 2);
    });
}

test("does not publish when packing fails", async () => {
    const f = fixture();
    const run = f.options.run;
    f.options.run = (command, args) => {
        if (command === process.execPath) throw new Error("pack failed");
        return run(command, args);
    };
    await assert.rejects(publishRaga(f.options), /pack failed/);
    assert.equal(f.calls.some(([, args]) => args[0] === "publish"), false);
});
