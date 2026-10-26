/**
 * Optional user-owned verification gates. See docs/INSTANCE-PLAN.md.
 *
 * The layer is off unless the operator writes `.raga/verification.json` and its law files.
 * Harness revisions never contain either, and the sandbox masks `.raga`, so agents cannot
 * enable the layer, edit active laws, or supply their own proofs. Suggestions are inert
 * files that a human must review before promoting.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { sandboxCommand } from "./sandbox.ts";
import type { CommandResult } from "./types.ts";

const execFileAsync = promisify(execFile);

export const VERIFICATION_DIR = "verification";
export const VERIFICATION_CONFIG = "verification.json";
const RECORD_DIR = "verification";
const TOOLS_DIR = "tools";
const FILE_NAME = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const DEFAULT_LAWS = "LAWS.bend";
const DEFAULT_PROOF = "PROOF.bend";
const DEFAULT_TIMEOUT_MS = 300_000;

/** Pinned Bend releases. Each archive is checksum-verified before extraction. */
export const BEND_PIN = {
	version: "2.0.39",
	assets: {
		"linux-x64": {
			url: "https://github.com/bendlang/bend/releases/download/v2.0.39/bend-2.0.39-linux-x64.tar.gz",
			sha256: "6cf462fd8f70b094a4950ebb709a9c4ffd8f1d1189d9cedf1fd63cd5d041c7ab",
		},
		"linux-arm64": {
			url: "https://github.com/bendlang/bend/releases/download/v2.0.39/bend-2.0.39-linux-arm64.tar.gz",
			sha256: "71b43e1bb9313dd14ac2b0553b854e41c39d65ecaa47040796ebff4a46f54a97",
		},
		"darwin-arm64": {
			url: "https://github.com/bendlang/bend/releases/download/v2.0.39/bend-2.0.39-darwin-arm64.tar.gz",
			sha256: "d4aaef68de545727429ce83b9e88ff3273bf068df599e3542e446755b5f3d83a",
		},
		"darwin-x64": {
			url: "https://github.com/bendlang/bend/releases/download/v2.0.39/bend-2.0.39-darwin-x64.tar.gz",
			sha256: "a512cfd1d29ec24c640126a6a640e597b4ea1abe0aefbda7cc57efd85ab56e22",
		},
	},
} as const;

export type VerificationVerdict = "passed" | "failed" | "inconclusive";

export interface VerificationConfig {
	schemaVersion: 1;
	enabled: boolean;
	backend: "bend";
	laws: string;
	proof: string;
	timeoutMs: number;
}

export interface VerificationRecord {
	schemaVersion: 1;
	instanceId: string;
	revision: string;
	verdict: VerificationVerdict;
	command: string[];
	candidate: CommandResult;
	lawsDigest: string;
	proofDigest: string;
	toolDigest: string;
	createdAt: string;
}

export interface VerificationTool {
	version: string;
	executable: string;
	digest: string;
}

export interface VerificationStatus {
	config: VerificationConfig | null;
	configPath: string;
	directory: string;
	tool: VerificationTool | null;
	record: VerificationRecord | null;
}

export class VerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerificationError";
	}
}

const CommandResultSchema = Type.Object(
	{
		exitCode: Type.Number(),
		stdout: Type.String(),
		stderr: Type.String(),
		timedOut: Type.Boolean(),
		aborted: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

const ConfigSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		enabled: Type.Boolean(),
		backend: Type.Optional(Type.Literal("bend")),
		laws: Type.Optional(Type.String({ pattern: FILE_NAME })),
		proof: Type.Optional(Type.String({ pattern: FILE_NAME })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const RecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		instanceId: Type.String({ minLength: 1 }),
		revision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
		verdict: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("inconclusive")]),
		command: Type.Array(Type.String()),
		candidate: CommandResultSchema,
		lawsDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		proofDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		toolDigest: Type.String({ minLength: 1 }),
		createdAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const ReadySchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		version: Type.String(),
		archiveSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		executableSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		installedAt: Type.String(),
	},
	{ additionalProperties: false },
);

const validateConfig = Compile(ConfigSchema);
const validateRecord = Compile(RecordSchema);
const validateReady = Compile(ReadySchema);

export function verificationPaths(instanceRoot: string) {
	const root = resolve(instanceRoot);
	return {
		config: join(root, VERIFICATION_CONFIG),
		directory: join(root, VERIFICATION_DIR),
		records: join(root, "state", RECORD_DIR),
		tools: join(root, "state", TOOLS_DIR),
		bend: join(root, "state", TOOLS_DIR, "bend", BEND_PIN.version),
		suggestions: join(root, VERIFICATION_DIR, "suggestions"),
	};
}

export function parseVerificationConfig(raw: unknown): VerificationConfig {
	if (!validateConfig.Check(raw)) {
		const detail = validateConfig.Errors(raw).map((error) => `${error.instancePath || "/"}: ${error.message}`);
		throw new VerificationError(`Verification config is invalid: ${detail.join("; ")}`);
	}
	return {
		schemaVersion: 1,
		enabled: raw.enabled,
		backend: "bend",
		laws: raw.laws ?? DEFAULT_LAWS,
		proof: raw.proof ?? DEFAULT_PROOF,
		timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
}

/** Absent config means the layer is off. A malformed config fails closed instead of being ignored. */
export async function readVerificationConfig(instanceRoot: string): Promise<VerificationConfig | null> {
	const { config } = verificationPaths(instanceRoot);
	let text: string;
	try {
		text = await readFile(config, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	}
	try {
		return parseVerificationConfig(JSON.parse(text));
	} catch (error) {
		throw new VerificationError(`Invalid ${config}: ${(error as Error).message}`);
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return false;
		throw error;
	}
}

async function fileDigest(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

/**
 * Enable or disable the layer. Enabling requires both user-authored files: this command
 * writes configuration only, never laws or proofs.
 */
export async function setVerificationEnabled(
	instanceRoot: string,
	options: { approved: boolean; enabled: boolean },
): Promise<VerificationConfig> {
	if (options.approved !== true) throw new VerificationError("Changing verification requires explicit approval");
	const paths = verificationPaths(instanceRoot);
	const existing = (await readVerificationConfig(instanceRoot)) ?? {
		schemaVersion: 1 as const,
		enabled: false,
		backend: "bend" as const,
		laws: DEFAULT_LAWS,
		proof: DEFAULT_PROOF,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
	if (existing.enabled === options.enabled) return existing;
	if (options.enabled) {
		for (const name of [existing.laws, existing.proof]) {
			if (!(await isFile(join(paths.directory, name)))) {
				throw new VerificationError(`Write ${join(paths.directory, name)} before enabling verification`);
			}
		}
	}
	await writeJsonAtomic(paths.config, { ...existing, enabled: options.enabled });
	return { ...existing, enabled: options.enabled };
}

export function assetForPlatform(platform: string, arch: string) {
	const key = `${platform}-${arch}` as keyof typeof BEND_PIN.assets;
	const asset = BEND_PIN.assets[key];
	if (!asset) throw new VerificationError(`Bend ${BEND_PIN.version} has no pinned build for ${key}`);
	return { key, ...asset };
}

export function verifyPinnedArchive(bytes: Buffer, expected: string): string {
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== expected)
		throw new VerificationError(`Bend archive checksum mismatch: expected ${expected}, got ${actual}`);
	return actual;
}

/** The pinned Bend tree, or null when it has not been installed and verified. */
export async function installedBend(instanceRoot: string): Promise<VerificationTool | null> {
	const paths = verificationPaths(instanceRoot);
	const executable = join(paths.bend, "bend", "bin", "bend");
	if (!(await isFile(executable))) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(join(paths.bend, "ready.json"), "utf8"));
	} catch {
		return null;
	}
	if (!validateReady.Check(raw) || raw.version !== BEND_PIN.version) return null;
	const sha256 = await fileDigest(executable);
	if (sha256 !== raw.executableSha256) return null;
	return { version: raw.version, executable, digest: `bend@${raw.version}:sha256:${sha256}` };
}

/**
 * Download, checksum, and extract the pinned Bend release. Requires network approval because
 * it fetches from GitHub. The whole release tree is kept: the binary loads `bend2/` beside it.
 */
export async function installBend(
	instanceRoot: string,
	options: { approved: boolean; network: boolean; fetchImpl?: typeof fetch },
): Promise<VerificationTool> {
	if (options.approved !== true) throw new VerificationError("Installing Bend requires explicit approval");
	if (options.network !== true) throw new VerificationError("Installing Bend requires network approval");
	const existing = await installedBend(instanceRoot);
	if (existing) return existing;
	const asset = assetForPlatform(process.platform, process.arch);
	const response = await (options.fetchImpl ?? fetch)(asset.url);
	if (!response.ok) throw new VerificationError(`Bend download failed: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	verifyPinnedArchive(bytes, asset.sha256);
	const paths = verificationPaths(instanceRoot);
	await mkdir(paths.bend, { recursive: true, mode: 0o700 });
	const archive = join(paths.bend, "bend.tar.gz");
	await writeFile(archive, bytes, { mode: 0o600 });
	try {
		await execFileAsync("tar", ["-xzf", archive, "-C", paths.bend], { timeout: 300_000 });
	} finally {
		await rm(archive, { force: true });
	}
	const executable = join(paths.bend, "bend", "bin", "bend");
	if (!(await isFile(executable))) throw new VerificationError("Bend archive did not contain bend/bin/bend");
	await writeJsonAtomic(join(paths.bend, "ready.json"), {
		schemaVersion: 1,
		version: BEND_PIN.version,
		archiveSha256: asset.sha256,
		executableSha256: await fileDigest(executable),
		installedAt: new Date().toISOString(),
	});
	const installed = await installedBend(instanceRoot);
	if (!installed) throw new VerificationError("Bend installation could not be verified");
	return installed;
}

export function verificationRecordPath(instanceRoot: string, revision: string): string {
	if (!/^[0-9a-f]{40}$/.test(revision)) throw new VerificationError(`Invalid revision ${JSON.stringify(revision)}`);
	return join(verificationPaths(instanceRoot).records, `${revision}.json`);
}

export async function readVerificationRecord(
	instanceRoot: string,
	revision: string,
): Promise<VerificationRecord | null> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(verificationRecordPath(instanceRoot, revision), "utf8"));
	} catch {
		return null;
	}
	if (!validateRecord.Check(raw)) return null;
	return {
		schemaVersion: 1,
		instanceId: raw.instanceId,
		revision: raw.revision,
		verdict: raw.verdict,
		command: [...raw.command],
		candidate: raw.candidate as CommandResult,
		lawsDigest: raw.lawsDigest,
		proofDigest: raw.proofDigest,
		toolDigest: raw.toolDigest,
		createdAt: raw.createdAt,
	};
}

/** Persist a result for one exact revision. Exposed so callers and tests share one writer. */
export async function recordVerificationResult(instanceRoot: string, record: VerificationRecord): Promise<void> {
	await writeJsonAtomic(verificationRecordPath(instanceRoot, record.revision), record);
}

export interface VerificationRun {
	record: VerificationRecord;
	result: CommandResult;
}

/**
 * Check the user-owned law files in the sandbox, then record the verdict for `revision`.
 * The check binds the revision, the law and proof contents, and the pinned tool, so editing
 * any of them invalidates the record instead of silently reusing it.
 */
export async function runVerification(
	instanceRoot: string,
	options: { instanceId: string; revision: string; signal?: AbortSignal },
): Promise<VerificationRun> {
	const config = await readVerificationConfig(instanceRoot);
	if (!config) throw new VerificationError("Verification is not configured");
	if (!config.enabled) throw new VerificationError("Verification is disabled");
	const tool = await installedBend(instanceRoot);
	if (!tool) throw new VerificationError("Install the pinned Bend release before running verification");
	const paths = verificationPaths(instanceRoot);
	const laws = join(paths.directory, config.laws);
	const proof = join(paths.directory, config.proof);
	for (const file of [laws, proof]) {
		if (!(await isFile(file))) throw new VerificationError(`${file} is missing`);
	}
	await mkdir(paths.records, { recursive: true, mode: 0o700 });
	const workspace = await mkdtemp(join(paths.records, "work-"));
	let result: CommandResult;
	try {
		await copyFile(laws, join(workspace, config.laws));
		await copyFile(proof, join(workspace, config.proof));
		result = await sandboxCommand({
			command: tool.executable,
			args: [config.proof],
			policy: { workspace, writable: [workspace], readOnly: [join(paths.bend, "bend")], network: false },
			timeoutMs: config.timeoutMs,
			signal: options.signal,
		});
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	const verdict: VerificationVerdict =
		result.aborted || result.timedOut
			? "inconclusive"
			: result.exitCode === 0 && result.stdout.includes("ALL PROOFS CHECK")
				? "passed"
				: "failed";
	const record: VerificationRecord = {
		schemaVersion: 1,
		instanceId: options.instanceId,
		revision: options.revision,
		verdict,
		command: [tool.executable, config.proof],
		candidate: result,
		lawsDigest: await fileDigest(laws),
		proofDigest: await fileDigest(proof),
		toolDigest: tool.digest,
		createdAt: new Date().toISOString(),
	};
	await recordVerificationResult(instanceRoot, record);
	return { record, result };
}

/**
 * Activation gate. Returns the reasons a revision may not be activated, or an empty list when
 * verification is off. Called by the store so no caller can bypass it.
 */
export async function verificationActivationProblems(
	instanceRoot: string,
	details: { instanceId: string; revision: string },
): Promise<string[]> {
	const config = await readVerificationConfig(instanceRoot);
	if (!config?.enabled) return [];
	const record = await readVerificationRecord(instanceRoot, details.revision);
	if (!record) {
		return [
			`verification is enabled but ${details.revision} has no recorded check; run "pi instance verify run --revision ${details.revision}"`,
		];
	}
	const problems: string[] = [];
	if (record.instanceId !== details.instanceId) problems.push("verification was recorded for another instance");
	if (record.revision !== details.revision) problems.push("verification was recorded for another revision");
	if (record.verdict !== "passed") problems.push(`the last verification verdict is ${record.verdict}`);
	const paths = verificationPaths(instanceRoot);
	const tool = await installedBend(instanceRoot);
	if (!tool) problems.push("the pinned Bend release is not installed");
	else if (record.toolDigest !== tool.digest) problems.push("the Bend tool changed since the recorded check");
	for (const [file, recorded, label] of [
		[join(paths.directory, config.laws), record.lawsDigest, "laws"],
		[join(paths.directory, config.proof), record.proofDigest, "proof"],
	] as const) {
		if (!(await isFile(file))) problems.push(`${label} file is missing`);
		else if ((await fileDigest(file)) !== recorded) problems.push(`${label} changed since the recorded check`);
	}
	if (problems.length) problems.push('run "pi instance verify run" again after reviewing the changes');
	return problems;
}

export async function verificationStatus(instanceRoot: string, revision: string): Promise<VerificationStatus> {
	const config = await readVerificationConfig(instanceRoot);
	return {
		config,
		configPath: verificationPaths(instanceRoot).config,
		directory: verificationPaths(instanceRoot).directory,
		tool: await installedBend(instanceRoot),
		record: config?.enabled ? await readVerificationRecord(instanceRoot, revision) : null,
	};
}
