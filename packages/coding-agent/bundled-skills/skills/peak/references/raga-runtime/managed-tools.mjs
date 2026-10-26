#!/usr/bin/env node
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
const harness = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
