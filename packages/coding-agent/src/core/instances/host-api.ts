import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HostHandler, HostRequest } from "../rlm/kernel.ts";
import type { SessionManager } from "../session-manager.ts";
import { InstanceMemory } from "./memory.ts";
import { getNoMistakesBackend } from "./no-mistakes.ts";
import { commitCandidate, createCandidate, getCandidate } from "./store.ts";
import type { ChildChange, ChildWorkspace, HarnessPin } from "./types.ts";
import {
	childChangePatch,
	collectChildChange,
	createChildWorkspace,
	integrateChildChange,
	listChildWorkspaces,
	snapshotChildWorkspace,
	snapshotProject,
} from "./workspaces.ts";

function text(data: HostRequest, key: string): string {
	const value = data[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a nonempty string`);
	return value;
}

function count(data: HostRequest, key: string, fallback: number, maximum: number): number {
	const value = data[key] ?? fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${key} must be an integer between 1 and ${maximum}`);
	}
	return value;
}

async function candidateFile(root: string, input: string): Promise<string> {
	if (isAbsolute(input) || input.includes("\0")) throw new Error("Candidate paths must be relative");
	const path = resolve(root, input);
	const rel = relative(root, path);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Candidate path escapes its checkout");
	const parts = rel.split(sep);
	if (rel !== "AGENTS.md" && !["skills", "lessons", "agents", "prompts"].includes(parts[0])) {
		throw new Error("The agent may edit only instructions, skills, lessons, prompts, and child specifications");
	}
	if (parts.some((part) => part.startsWith("."))) throw new Error("Hidden candidate paths are not editable");
	let current = root;
	for (const part of parts) {
		current = join(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error("Candidate symlinks are not editable");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	return path;
}

export function instanceHostHandlers(
	pin: HarnessPin,
	sessionManager: SessionManager,
	record: (type: string, data: unknown) => void,
	cwd = pin.projectRoot,
): Map<string, HostHandler> {
	const memory = new InstanceMemory(pin.instanceRoot);
	const owned = new Set<string>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "raga-candidate-owned") continue;
		const data: unknown = entry.data;
		if (typeof data === "object" && data !== null && "id" in data && typeof data.id === "string") owned.add(data.id);
	}
	const candidate = async (data: HostRequest) => {
		const id = text(data, "id");
		if (!owned.has(id)) throw new Error("This session does not own that candidate");
		return getCandidate(pin.instanceRoot, id);
	};
	const childChange = (id: string): { workspace: ChildWorkspace; change: ChildChange } => {
		const entry = sessionManager.getBranch().findLast((item) => {
			if (item.type !== "custom" || item.customType !== "raga-child-change") return false;
			const data = item.data as { workspace?: ChildWorkspace } | undefined;
			return data?.workspace?.id === id;
		});
		if (entry?.type !== "custom") throw new Error("This session does not own a collected change for that child");
		return entry.data as { workspace: ChildWorkspace; change: ChildChange };
	};
	return new Map<string, HostHandler>([
		[
			"instance.info",
			async () => ({
				instanceId: pin.instanceId,
				revision: pin.revision,
				projectRoot: pin.projectRoot,
				harnessPath: pin.resourceRoot,
			}),
		],
		[
			"instance.no_mistakes",
			async (data, context) => {
				const backend = await getNoMistakesBackend(pin.instanceRoot, pin.projectRoot);
				switch (text(data, "action")) {
					case "inspect":
						return backend.inspect();
					case "status":
						return backend.status();
					case "run": {
						if (!(await backend.inspect()).enabled)
							throw new Error("The user must explicitly enable no-mistakes for this instance first");
						const options = data.options;
						if (
							typeof options !== "object" ||
							options === null ||
							!("intent" in options) ||
							typeof options.intent !== "string"
						) {
							throw new Error("no-mistakes run requires the user's complete intent");
						}
						return backend.run({ intent: options.intent, approval: { network: true }, signal: context.signal });
					}
					default:
						throw new Error(
							"Provisioning, lifecycle changes, publication, and gate responses require the user CLI",
						);
				}
			},
		],
		[
			"instance.child_patch",
			async (data) => {
				const { workspace, change } = childChange(text(data, "workspace_id"));
				return { workspace, change, patch: await childChangePatch(workspace, change) };
			},
		],
		[
			"instance.integrate",
			async (data, context) => {
				const ids = data.workspace_ids;
				if (
					!Array.isArray(ids) ||
					ids.length === 0 ||
					ids.length > 16 ||
					!ids.every((id): id is string => typeof id === "string")
				) {
					throw new Error("workspace_ids must contain between one and sixteen child ids");
				}
				const args = data.args ?? [];
				if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string"))
					throw new Error("args must be strings");
				const command = text(data, "command");
				const timeoutMs = count(data, "timeout_ms", 120000, 3600000);
				const changes = ids.map(childChange);
				const workingDirectory = await realpath(cwd);
				const existing = (await listChildWorkspaces(pin.projectRoot)).find(
					(entry) => workingDirectory === entry.path || workingDirectory.startsWith(`${entry.path}${sep}`),
				);
				const snapshot = existing ? await snapshotChildWorkspace(existing) : await snapshotProject(pin.projectRoot);
				const directory = join(pin.stateRoot, "integrations");
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const workspace = await createChildWorkspace(snapshot, join(directory, randomUUID()));
				record("raga-integration-workspace", { workspace, children: ids });
				for (const { change } of changes) {
					const result = await integrateChildChange(
						workspace,
						change,
						{ command, args, timeoutMs },
						context.signal,
					);
					record("raga-integration-check", { workspaceId: workspace.id, change, result });
					if (!result.accepted) return { ...result, workspace };
				}
				const change = await collectChildChange(workspace);
				record("raga-child-change", { workspace, change });
				return { accepted: true, workspace, change, patch: await childChangePatch(workspace, change) };
			},
		],
		[
			"memory.search",
			async (data) => {
				const result = await memory.retrieve({
					query: text(data, "query"),
					scope: pin.projectRoot,
					harnessRevision: pin.revision,
					maxChars: count(data, "max_chars", 4000, 16000),
					limit: count(data, "limit", 5, 20),
					...(typeof data.task_type === "string" ? { taskType: data.task_type } : {}),
				});
				record("raga-memory-retrieval", result);
				return result;
			},
		],
		[
			"memory.get",
			async (data) => {
				const entry = await memory.get(text(data, "id"));
				if (entry.scope !== pin.projectRoot) throw new Error("Memory belongs to a different project scope");
				return entry;
			},
		],
		[
			"memory.observe",
			async (data) => {
				const evidence = data.evidence;
				if (!Array.isArray(evidence) || !evidence.every((item): item is string => typeof item === "string")) {
					throw new Error("evidence must be an array of strings");
				}
				const entry = await memory.observe({
					text: text(data, "text"),
					scope: pin.projectRoot,
					kind: "observation",
					evidence,
					harnessRevision: pin.revision,
					epistemicStatus: "hypothesis",
					trust: "unreviewed",
				});
				record("raga-memory-observation", { id: entry.id, version: entry.version });
				return entry;
			},
		],
		[
			"instance.candidate.create",
			async () => {
				const created = await createCandidate(pin.instanceRoot);
				owned.add(created.id);
				record("raga-candidate-owned", { id: created.id, baseRevision: created.baseRevision });
				return created;
			},
		],
		[
			"instance.candidate.read",
			async (data) => {
				const current = await candidate(data);
				const path = await candidateFile(await realpath(current.path), text(data, "path"));
				return readFile(path, "utf8");
			},
		],
		[
			"instance.candidate.write",
			async (data) => {
				const current = await candidate(data);
				if (typeof data.content !== "string" || Buffer.byteLength(data.content, "utf8") > 1024 * 1024) {
					throw new Error("content must be a string of at most 1 MiB");
				}
				const path = await candidateFile(await realpath(current.path), text(data, "path"));
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, data.content, { encoding: "utf8", mode: 0o600 });
				return { path: data.path, bytes: Buffer.byteLength(data.content, "utf8") };
			},
		],
		[
			"instance.candidate.commit",
			async (data) => {
				const current = await candidate(data);
				return commitCandidate(pin.instanceRoot, current.id, text(data, "message"));
			},
		],
	]);
}
