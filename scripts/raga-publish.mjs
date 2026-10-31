import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^raga-v(\d+\.\d+\.\d+)$/;

/** Publish only a release at HEAD. Registry failures must not look like an unpublished version. */
export async function publishRaga({
    run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim(),
    fetchRelease = (url) => fetch(url, { signal: AbortSignal.timeout(30_000) }),
    log = console.log,
} = {}) {
    const tags = run("git", ["tag", "--points-at", "HEAD", "--list", "raga-v*"]).split(/\r?\n/).filter(Boolean);
    const versions = tags.map((tag) => VERSION.exec(tag)?.[1]).filter(Boolean);
    if (versions.length === 0) {
        log("No raga release tag at HEAD; skipping npm publication.");
        return;
    }
    if (versions.length !== 1) throw new Error("Expected exactly one raga release tag at HEAD.");
    const [version] = versions;
    const response = await fetchRelease(`https://registry.npmjs.org/raga-cli/${version}`);
    if (response.ok) {
        const published = await response.json();
        if (published.name !== "raga-cli" || published.version !== version) throw new Error("Unexpected npm registry response.");
        log(`raga-cli@${version} is already published; skipping.`);
        return;
    }
    if (response.status !== 404) throw new Error(`npm registry lookup failed: HTTP ${response.status}`);
    const [major, minor, patch] = run("npm", ["--version"]).split(".").map(Number);
    if (!(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))))) {
        throw new Error("npm trusted publishing requires npm 11.5.1 or newer.");
    }
    log(run(process.execPath, ["scripts/raga-pack.mjs"]));
    log(run("npm", ["publish", `packages/coding-agent/dist/raga-cli-${version}.tgz`, "--access", "public", "--provenance", "--ignore-scripts"]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await publishRaga();
}
