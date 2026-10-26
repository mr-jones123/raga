import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getPackageDir } from "../../config.ts";
import { loadSkillsFromDir } from "../skills.ts";

export function getBundledHarnessPath(): string {
	return join(getPackageDir(), "bundled-skills");
}

export async function inspectBundledSkills(): Promise<{ name: string; path: string; source: string }[]> {
	const root = await realpath(getBundledHarnessPath());
	const parsed: unknown = JSON.parse(await readFile(join(root, "bundle.json"), "utf8"));
	if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid bundled harness manifest");
	const manifest = parsed as Record<string, unknown>;
	if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills) || !Array.isArray(manifest.files)) {
		throw new Error("Unsupported bundled harness manifest");
	}
	const declared = new Map<string, { path: string; source: string }>();
	for (const value of manifest.skills as unknown[]) {
		if (typeof value !== "object" || value === null) throw new Error("Invalid bundled skill declaration");
		const entry = value as Record<string, unknown>;
		if (
			typeof entry.name !== "string" ||
			!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) ||
			typeof entry.path !== "string" ||
			typeof entry.source !== "string" ||
			declared.has(entry.name)
		) {
			throw new Error("Invalid or duplicate bundled skill declaration");
		}
		if (entry.path !== `skills/${entry.name}/SKILL.md`) throw new Error(`Invalid bundled skill path ${entry.path}`);
		declared.set(entry.name, { path: join(root, entry.path), source: entry.source });
	}
	const assets = new Set<string>();
	for (const value of manifest.files as unknown[]) {
		if (typeof value !== "object" || value === null) throw new Error("Invalid bundled asset declaration");
		const asset = value as Record<string, unknown>;
		if (typeof asset.path !== "string" || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
			throw new Error("Invalid bundled asset checksum declaration");
		}
		if (
			assets.has(asset.path) ||
			asset.path.includes("\\") ||
			asset.path.split("/").some((part) => !part || part === "." || part === "..")
		) {
			throw new Error(`Invalid or duplicate bundled asset path: ${asset.path}`);
		}
		assets.add(asset.path);
		const path = resolve(root, asset.path);
		const within = relative(root, path);
		if (
			!within ||
			within === ".." ||
			within.startsWith(`..${sep}`) ||
			isAbsolute(within) ||
			(await realpath(path)) !== path
		) {
			throw new Error(`Bundled asset escapes its resource root: ${asset.path}`);
		}
		if (!(await stat(path)).isFile()) throw new Error(`Bundled asset is not a regular file: ${asset.path}`);
		const bytes = await readFile(path);
		if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
			throw new Error(`Bundled asset checksum mismatch: ${asset.path}`);
	}
	for (const entry of declared.values()) {
		if (!assets.has(relative(root, entry.path).split(sep).join("/")))
			throw new Error("Bundled skill is missing its asset checksum");
	}
	const pending = [root];
	while (pending.length) {
		const directory = pending.pop()!;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (
				entry.isSymbolicLink() ||
				!entry.isFile() ||
				(path !== join(root, "bundle.json") && !assets.has(relative(root, path).split(sep).join("/")))
			) {
				throw new Error(`Unmanifested or unsupported bundled asset: ${relative(root, path)}`);
			}
		}
	}
	const loaded = loadSkillsFromDir({ dir: join(root, "skills"), source: "bundle" });
	if (loaded.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		throw new Error(
			`Bundled skill discovery failed: ${loaded.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
		);
	}
	if (loaded.skills.length !== declared.size) throw new Error("Bundled skill inventory differs from its manifest");
	return loaded.skills
		.map((skill) => {
			const entry = declared.get(skill.name);
			if (!entry || entry.path !== skill.filePath) throw new Error(`Unexpected bundled skill ${skill.name}`);
			return { name: skill.name, path: skill.filePath, source: entry.source };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
