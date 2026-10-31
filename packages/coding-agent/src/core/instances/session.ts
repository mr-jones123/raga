import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { discoverExtensionsInDir } from "../extensions/loader.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "../resource-loader.ts";
import type { SessionManager } from "../session-manager.ts";
import { SettingsManager } from "../settings-manager.ts";
import { createMemoryExtension } from "./memory-extension.ts";
import type { MemoryService } from "./memory-service.ts";
import { createRefinementExtension } from "./model-refinement.ts";
import { overlaps, SandboxPolicyError } from "./sandbox.ts";
import { openInstance } from "./store.ts";
import type { HarnessPin, SandboxPolicy } from "./types.ts";

export const INSTANCE_SESSION_ENTRY = "raga-instance-pin";

export function findInstanceRoot(cwd: string): string | undefined {
	let directory = resolve(cwd);
	while (true) {
		if (basename(directory) === ".raga") return undefined;
		const root = join(directory, ".raga");
		if (existsSync(join(root, "instance.json"))) return root;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export async function resolveInstancePin(
	cwd: string,
	requested: HarnessPin | string | undefined,
	sessionManager?: SessionManager,
): Promise<HarnessPin | undefined> {
	const recorded = sessionManager
		?.getBranch()
		.findLast((entry) => entry.type === "custom" && entry.customType === INSTANCE_SESSION_ENTRY);
	if (recorded?.type === "custom") {
		const data: unknown = recorded.data;
		if (
			typeof data !== "object" ||
			data === null ||
			!("instanceRoot" in data) ||
			typeof data.instanceRoot !== "string" ||
			!("revision" in data) ||
			typeof data.revision !== "string"
		)
			throw new Error("The session has invalid instance revision metadata");
		const requestedRoot = typeof requested === "string" ? requested : requested?.instanceRoot;
		if (requestedRoot && resolve(requestedRoot) !== resolve(data.instanceRoot)) {
			throw new Error("A session cannot resume in a different instance");
		}
		if (typeof requested === "object" && requested.revision !== data.revision) {
			throw new Error("A session cannot switch harness revisions while resuming");
		}
		return openInstance(data.instanceRoot, data.revision);
	}
	if (typeof requested === "object") return requested;
	if (requested) return openInstance(requested);
	if (process.env.RAGA_INSTANCE_ROOT)
		return openInstance(process.env.RAGA_INSTANCE_ROOT, process.env.RAGA_INSTANCE_REVISION);
	const root = findInstanceRoot(cwd);
	return root ? openInstance(root) : undefined;
}

export function instanceSettings(pin: HarnessPin): SettingsManager {
	const path = join(pin.resourceRoot, "settings.json");
	const contents = existsSync(path) ? readFileSync(path, "utf8") : "{}";
	return SettingsManager.inMemory(JSON.parse(contents));
}

export async function instanceResources(
	pin: HarnessPin,
	settingsManager: SettingsManager,
	extensionFactories: DefaultResourceLoaderOptions["extensionFactories"] | undefined,
	memory: MemoryService | undefined,
	modelRuntime?: ModelRuntime,
): Promise<ResourceLoader> {
	const instructions = join(pin.resourceRoot, "AGENTS.md");
	const loader = new DefaultResourceLoader({
		cwd: pin.resourceRoot,
		agentDir: pin.resourceRoot,
		settingsManager,
		extensionFactories: [
			createRefinementExtension(pin, modelRuntime),
			...(memory ? [createMemoryExtension(pin, memory)] : []),
			...(extensionFactories ?? []),
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalExtensionPaths: discoverExtensionsInDir(join(pin.resourceRoot, "extensions")),
		additionalSkillPaths: existsSync(join(pin.resourceRoot, "skills")) ? [join(pin.resourceRoot, "skills")] : [],
		additionalPromptTemplatePaths: existsSync(join(pin.resourceRoot, "prompts"))
			? [join(pin.resourceRoot, "prompts")]
			: [],
		additionalThemePaths: existsSync(join(pin.resourceRoot, "themes")) ? [join(pin.resourceRoot, "themes")] : [],
		noContextFiles: true,
		agentsFilesOverride: () => ({
			agentsFiles: existsSync(instructions)
				? [{ path: instructions, content: readFileSync(instructions, "utf8") }]
				: [],
		}),
	});
	await loader.reload();
	return {
		getExtensions: () => loader.getExtensions(),
		getSkills: () => loader.getSkills(),
		getPrompts: () => loader.getPrompts(),
		getThemes: () => loader.getThemes(),
		getAgentsFiles: () => loader.getAgentsFiles(),
		getSystemPrompt: () => loader.getSystemPrompt(),
		getSystemPromptSource: () => loader.getSystemPromptSource(),
		getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
		getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
		extendResources: () => {
			throw new Error("Instance resources are pinned. Propose a new harness revision.");
		},
		reload: (options) => loader.reload(options),
	};
}

export function recordInstancePin(pin: HarnessPin, sessionManager: SessionManager): void {
	if (
		sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === INSTANCE_SESSION_ENTRY)
	)
		return;
	sessionManager.appendCustomEntry(INSTANCE_SESSION_ENTRY, {
		instanceId: pin.instanceId,
		instanceRoot: pin.instanceRoot,
		revision: pin.revision,
		projectRoot: pin.projectRoot,
	});
}

/**
 * Host dependency roots every instance sandbox mounts read-only, such as a project interpreter outside the
 * system runtime. Only the host environment names them, never a harness revision, so a revision cannot widen
 * its own sandbox. A root overlapping the project or the instance would expose another actor's checkout or state.
 */
function dependencyRoots(pin: HarnessPin): string[] {
	const value = process.env.RAGA_SANDBOX_READ_ONLY?.trim();
	if (!value) return [];
	const protectedRoots = [realpathSync(pin.projectRoot), realpathSync(pin.instanceRoot)];
	return value.split(delimiter).map((path) => {
		let real: string | undefined;
		try {
			real = realpathSync(path);
		} catch {}
		if (real !== path) {
			throw new SandboxPolicyError(
				`RAGA_SANDBOX_READ_ONLY entry must be an existing canonical absolute path: ${path}`,
			);
		}
		const overlap = protectedRoots.find((root) => overlaps(path, root));
		if (overlap) throw new SandboxPolicyError(`RAGA_SANDBOX_READ_ONLY entry ${path} overlaps ${overlap}`);
		return path;
	});
}

export function instanceSandbox(
	pin: HarnessPin,
	cwd: string,
	sessionManager: SessionManager,
	workspaceRoot = cwd,
): SandboxPolicy {
	const snapshots = join(pin.stateRoot, "kernels", sessionManager.getSessionId());
	// Each session (root, child, fork) owns its cache, so tool caches persist across commands
	// without sharing writable state between actors or making a read-only workspace writable.
	const cache = join(snapshots, "cache");
	mkdirSync(cache, { recursive: true, mode: 0o700 });
	return {
		workspace: realpathSync(workspaceRoot),
		cwd: realpathSync(cwd),
		readOnly: [realpathSync(pin.resourceRoot), ...dependencyRoots(pin)],
		writable: [realpathSync(snapshots)],
		network: false,
		env: { XDG_CACHE_HOME: realpathSync(cache) },
	};
}
