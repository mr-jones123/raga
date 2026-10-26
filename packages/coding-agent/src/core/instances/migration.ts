import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { PROJECT_CONFIG_DIR_NAME } from "../../config.ts";
import { stripBom } from "../../utils/text.ts";

export interface ProjectMigrationResult {
	source: string;
	destination: string;
	copied: string[];
	skipped: string[];
}

const RESOURCE_DIRECTORIES: Record<string, true | undefined> = {
	extensions: true,
	skills: true,
	prompts: true,
	themes: true,
	agents: true,
	lessons: true,
};
const RESOURCE_FILES: Record<string, true | undefined> = {
	"settings.json": true,
	"AGENTS.md": true,
	"AGENTS.override.md": true,
	"CLAUDE.md": true,
	"SYSTEM.md": true,
	"APPEND_SYSTEM.md": true,
};
const PRIVATE_NAMES =
	/^(?:auth\.json|oauth\.json|mcp-auth\.json|mcp\.json|models\.json|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|sessions?|state|cache|node_modules|\.git|\.npmrc|\.netrc|\.env(?:\..*)?|.*\.(?:pem|key))$/i;
const RESOURCE_SETTINGS: Record<string, true | undefined> = {
	extensions: true,
	skills: true,
	prompts: true,
	themes: true,
	packages: true,
};
const EXECUTABLE_SETTINGS: Record<string, true | undefined> = {
	shellPath: true,
	shellCommandPrefix: true,
	npmCommand: true,
};

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function assertInternalPath(source: string, value: string): string {
	const path = resolve(source, value);
	const local = relative(source, path);
	if (isAbsolute(value) || value.startsWith("~") || local === ".." || local.startsWith(`..${sep}`)) {
		throw new Error(`External resource requires manual review: ${value}`);
	}
	if (local.split(sep).some((part) => PRIVATE_NAMES.test(part))) {
		throw new Error(`Resource references private or excluded files: ${value}`);
	}
	if (!local || RESOURCE_DIRECTORIES[local.split(sep)[0]] !== true) {
		throw new Error(`Resource is outside the migrated resource directories: ${value}`);
	}
	return path;
}

function assertNoCredentials(value: unknown, path = "settings"): void {
	if (value === null || typeof value !== "object") return;
	for (const [key, entry] of Object.entries(value)) {
		if (
			/^(?:apiKeys?|(?:access|refresh|api|bearer|auth)Tokens?|.*(?:Secret|Password|Credential)s?|authorization|auth)$/i.test(
				key,
			)
		) {
			throw new Error(`Credential-bearing setting requires manual review: ${path}.${key}`);
		}
		assertNoCredentials(entry, `${path}.${key}`);
	}
}

async function validateSettings(source: string, content: string): Promise<void> {
	const settings: unknown = JSON.parse(stripBom(content));
	if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error("Project settings must be an object");
	}
	assertNoCredentials(settings);
	for (const [key, value] of Object.entries(settings)) {
		if (EXECUTABLE_SETTINGS[key] === true) {
			throw new Error(`Executable setting requires manual review: ${key}`);
		}
		if (key === "sessionDir") throw new Error("Session storage requires explicit configuration after migration");
		if (RESOURCE_SETTINGS[key] !== true) continue;
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
			throw new Error(`Resource setting requires manual review: ${key}`);
		}
		for (const entry of value as string[]) {
			const path = entry.replace(/^[+-]/, "");
			if (key === "extensions" && path.startsWith("builtin:")) continue;
			if (/[*?[\]{}!]/.test(path)) throw new Error(`Resource pattern requires manual review: ${entry}`);
			const target = assertInternalPath(source, path);
			if (!(await exists(target))) throw new Error(`Missing resource requires manual review: ${entry}`);
		}
	}
}

/** Copy reviewed project resources without loading them or changing the legacy source. */
export async function migrateProjectConfig(
	projectRoot: string,
	options: { projectTrusted: boolean },
): Promise<ProjectMigrationResult> {
	if (options.projectTrusted !== true) throw new Error("Project migration requires explicit project trust approval");
	const project = await realpath(resolve(projectRoot));
	const source = join(project, ".pi");
	const destination = join(project, PROJECT_CONFIG_DIR_NAME);
	if (await exists(destination)) throw new Error(`Migration destination already exists: ${destination}`);
	const sourceStat = await lstat(source);
	if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
		throw new Error(`Migration source must be a real directory: ${source}`);
	}
	const files: { path: string; content?: string }[] = [];
	const skipped: string[] = [];
	async function collect(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const local = relative(source, path);
			if (entry.isSymbolicLink()) throw new Error(`Symlink requires manual review: ${local}`);
			if (PRIVATE_NAMES.test(entry.name)) {
				skipped.push(local);
				continue;
			}
			if (directory === source && RESOURCE_DIRECTORIES[entry.name] !== true && RESOURCE_FILES[entry.name] !== true) {
				skipped.push(local);
				continue;
			}
			if (entry.isDirectory()) {
				if (directory === source && RESOURCE_DIRECTORIES[entry.name] !== true) {
					throw new Error(`Expected a resource file: ${local}`);
				}
				await collect(path);
			} else if (entry.isFile()) {
				if (directory === source && RESOURCE_DIRECTORIES[entry.name] === true) {
					throw new Error(`Expected a resource directory: ${local}`);
				}
				if (local === "settings.json") {
					const content = await readFile(path, "utf8");
					await validateSettings(source, content);
					files.push({ path: local, content });
				} else {
					files.push({ path: local });
				}
			} else {
				throw new Error(`Unsupported resource requires manual review: ${local}`);
			}
		}
	}
	await collect(source);
	const release = await lockfile.lock(project, { lockfilePath: join(project, ".raga-migration.lock"), retries: 0 });
	let staging: string | undefined;
	try {
		if (await exists(destination)) throw new Error(`Migration destination already exists: ${destination}`);
		staging = await mkdtemp(join(project, ".raga-migration-"));
		for (const file of files) {
			const target = join(staging, file.path);
			await mkdir(dirname(target), { recursive: true });
			if (file.content !== undefined) {
				await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
			} else {
				const original = join(source, file.path);
				const stat = await lstat(original);
				if (!stat.isFile() || (await realpath(original)) !== original) {
					throw new Error(`Resource changed during migration: ${file.path}`);
				}
				await copyFile(original, target, constants.COPYFILE_EXCL);
			}
		}
		if (await exists(destination)) throw new Error(`Migration destination already exists: ${destination}`);
		await rename(staging, destination);
		staging = undefined;
		return { source, destination, copied: files.map((file) => file.path).sort(), skipped: skipped.sort() };
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true });
		await release();
	}
}
