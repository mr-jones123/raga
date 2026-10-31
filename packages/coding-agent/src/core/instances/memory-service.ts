import { createConnection } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
	InstanceMemory,
	type MemoryEntry,
	type MemoryInput,
	type MemoryOrigin,
	type MemoryQuery,
	type MemoryReference,
	type MemoryRetrieval,
	type MemorySnapshot,
} from "./memory.ts";

/** Whether an acknowledged archive record also reached the selected search backend. */
export type MemoryIngestion =
	| { backend: "local"; status: "archived" }
	| { backend: "hindsight"; status: "retained"; documentId: string }
	| { backend: "hindsight"; status: "failed"; documentId: string; error: string };

export interface MemoryObservation {
	entry: MemoryEntry;
	ingestion: MemoryIngestion;
}

/** The memory a session reads and writes. Every implementation selects from one archive with one ranking. */
export interface MemoryService {
	readonly kind: "local" | "hindsight" | "proxy";
	readonly readOnly: boolean;
	search(query: MemoryQuery, signal?: AbortSignal): Promise<MemoryRetrieval>;
	get(id: string, version?: number, signal?: AbortSignal): Promise<MemoryEntry>;
	observe(input: MemoryInput, signal?: AbortSignal): Promise<MemoryObservation>;
}

/** A service that owns its archive on this host, as opposed to a proxy to another host's service. */
export interface ArchiveMemoryService extends MemoryService {
	readonly kind: "local" | "hindsight";
	/** The exact record store. Writes made directly to it reach the search backend only through {@link index}. */
	readonly archive: InstanceMemory;
	/**
	 * Makes archive entries searchable; local search needs nothing beyond the archive. Hindsight keeps one
	 * document per record, which each indexed version replaces.
	 */
	index(entries: MemoryEntry[], signal?: AbortSignal): Promise<MemoryIngestion[]>;
	snapshot(): Promise<MemorySnapshot>;
	/** {@link InstanceMemory.restore}, then indexes the snapshot's current active versions. */
	restore(snapshot: MemorySnapshot, signal?: AbortSignal): Promise<{ published: MemoryReference[] }>;
}

/** A client of a service another host owns; see {@link createProxyMemoryService}. */
export interface ProxyMemoryService extends MemoryService {
	readonly kind: "proxy";
}

export interface HindsightOptions {
	/** Base URL of the Hindsight API, without credentials, query, or fragment. With `apiKey`, HTTPS unless loopback. */
	url: string;
	/** Memory bank of this archive. A bank shared with another archive returns foreign sources, which fail searches. */
	bankId: string;
	apiKey?: string;
	/** Per HTTP request. Default: 120000. */
	timeoutMs?: number;
}

export type MemoryServiceOptions =
	| { backend: "local"; instanceRoot: string }
	| { backend: "hindsight"; instanceRoot: string; hindsight: HindsightOptions };

const DOCUMENT_ID = /^raga-memory:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const BANK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RECALL_QUERY_BYTES = 400;
const RECALL_MAX_TOKENS = 4096;
const RETAIN_BATCH = 100;
const PROXY_REQUEST_BYTES = 1024 * 1024;
const PROXY_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 120_000;
const ENVIRONMENT_BACKENDS = {
	hindsight: ["RAGA_HINDSIGHT_URL", "RAGA_HINDSIGHT_BANK", "RAGA_HINDSIGHT_API_KEY"],
	proxy: ["RAGA_MEMORY_PROXY_SOCKET"],
} as const;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function localService(archive: InstanceMemory): ArchiveMemoryService {
	return {
		kind: "local",
		readOnly: false,
		archive,
		search: (query) => archive.retrieve(query),
		get: (id, version) => archive.get(id, version),
		async observe(input) {
			return { entry: await archive.observe(input), ingestion: { backend: "local", status: "archived" } };
		},
		async index(entries) {
			return entries.map((): MemoryIngestion => ({ backend: "local", status: "archived" }));
		},
		snapshot: () => archive.snapshot(),
		restore: (snapshot) => archive.restore(snapshot),
	};
}

function hindsightService(archive: InstanceMemory, options: HindsightOptions): ArchiveMemoryService {
	let endpoint: URL;
	try {
		endpoint = new URL(options.url);
	} catch {
		throw new Error("Hindsight requires an absolute HTTP(S) URL");
	}
	if (
		!["http:", "https:"].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new Error("Hindsight URL must use HTTP(S) without credentials, query, or fragment");
	}
	if (typeof options.bankId !== "string" || !BANK_ID.test(options.bankId))
		throw new Error("Invalid Hindsight bank ID");
	if (options.apiKey !== undefined && (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)))
		throw new Error("Invalid Hindsight API key");
	const loopback =
		endpoint.hostname === "localhost" ||
		endpoint.hostname === "[::1]" ||
		/^127\.\d+\.\d+\.\d+$/.test(endpoint.hostname);
	if (options.apiKey !== undefined && endpoint.protocol !== "https:" && !loopback)
		throw new Error("Hindsight sends an API key only over HTTPS or to a loopback host");
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
		throw new Error("Invalid Hindsight timeoutMs");
	const bank = `${endpoint.href.replace(/\/$/, "")}/v1/default/banks/${options.bankId}`;
	const headers = {
		"Content-Type": "application/json",
		...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
	};

	async function request(
		operation: string,
		method: "PUT" | "POST",
		url: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const deadline = AbortSignal.timeout(timeoutMs);
		let status: number | undefined;
		try {
			const response = await fetch(url, {
				method,
				headers,
				body: JSON.stringify(body),
				redirect: "error",
				signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
			});
			status = response.status;
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error();
			}
			return (await response.json()) as unknown;
		} catch {
			const cause = deadline.aborted
				? "timeout"
				: signal?.aborted
					? "aborted"
					: status === undefined
						? "transport"
						: status >= 200 && status < 300
							? "malformed response"
							: `HTTP ${status}`;
			throw new Error(`Hindsight ${operation} failed (${cause})`);
		}
	}

	// Callers share one creation, which no caller's signal cancels; each signal bounds only its own wait.
	let bankReady: Promise<void> | undefined;
	const ensureBank = (signal?: AbortSignal): Promise<void> => {
		if (!bankReady) {
			const creating = request("bank", "PUT", bank, {}).then((response) => {
				if ((response as { bank_id?: unknown } | null)?.bank_id !== options.bankId)
					throw new Error("Hindsight returned an unexpected bank identity");
			});
			creating.catch(() => {
				if (bankReady === creating) bankReady = undefined;
			});
			bankReady = creating;
		}
		if (!signal) return bankReady;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const abort = () => reject(new Error("Hindsight bank failed (aborted)"));
		if (signal.aborted) abort();
		signal.addEventListener("abort", abort, { once: true });
		bankReady.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		return promise;
	};

	async function index(entries: MemoryEntry[], signal?: AbortSignal): Promise<MemoryIngestion[]> {
		const ingestion: MemoryIngestion[] = [];
		for (let start = 0; start < entries.length; start += RETAIN_BATCH) {
			const batch = entries.slice(start, start + RETAIN_BATCH);
			const items = batch.map((entry) => ({
				content: entry.text,
				context: `Raga ${entry.kind}, ${entry.trust}, ${entry.epistemicStatus}`,
				document_id: `raga-memory:${entry.id}`,
				update_mode: "replace",
				timestamp: entry.createdAt,
				metadata: { raga_memory_id: entry.id, raga_memory_version: String(entry.version) },
			}));
			try {
				await ensureBank(signal);
				const response = (await request("retain", "POST", `${bank}/memories`, { items, async: false }, signal)) as {
					success?: unknown;
					async?: unknown;
					bank_id?: unknown;
					items_count?: unknown;
				} | null;
				if (
					response?.success !== true ||
					response.async !== false ||
					response.bank_id !== options.bankId ||
					response.items_count !== items.length
				) {
					throw new Error("Hindsight did not confirm synchronous retention");
				}
				for (const item of items)
					ingestion.push({ backend: "hindsight", status: "retained", documentId: item.document_id });
			} catch (error) {
				for (const item of items) {
					ingestion.push({
						backend: "hindsight",
						status: "failed",
						documentId: item.document_id,
						error: errorMessage(error),
					});
				}
			}
		}
		return ingestion;
	}

	async function recall(query: string, signal?: AbortSignal): Promise<string[]> {
		let bounded = "";
		let bytes = 0;
		for (const character of query.trim()) {
			bytes += Buffer.byteLength(character);
			if (bytes > RECALL_QUERY_BYTES) break;
			bounded += character;
		}
		if (!bounded) return [];
		await ensureBank(signal);
		const response = (await request(
			"recall",
			"POST",
			`${bank}/memories/recall`,
			{
				query: bounded,
				types: ["world", "experience"],
				budget: "mid",
				max_tokens: RECALL_MAX_TOKENS,
				include: { entities: null, chunks: null, source_facts: null },
			},
			signal,
		)) as { results?: unknown } | null;
		if (!Array.isArray(response?.results)) throw new Error("Hindsight returned malformed recall results");
		return response.results.map((fact: unknown) => {
			const documentId =
				typeof fact === "object" && fact !== null && "document_id" in fact ? fact.document_id : undefined;
			const match = typeof documentId === "string" ? DOCUMENT_ID.exec(documentId) : null;
			if (!match) throw new Error("Hindsight returned a fact from a foreign source document");
			return match[1];
		});
	}

	return {
		kind: "hindsight",
		readOnly: false,
		archive,
		async search(query, signal) {
			if (typeof query?.query !== "string") throw new Error("Memory query must be a string");
			return archive.retrieve(query, { kind: "hindsight", ids: await recall(query.query, signal) });
		},
		get: (id, version) => archive.get(id, version),
		async observe(input, signal) {
			const entry = await archive.observe(input);
			const [ingestion] = await index([entry], signal);
			return { entry, ingestion };
		},
		index,
		snapshot: () => archive.snapshot(),
		async restore(snapshot, signal) {
			const restored = await archive.restore(snapshot);
			const current: MemoryEntry[] = [];
			for (const [first] of snapshot.histories) {
				const entry = await archive.get(first.id);
				if (entry.status === "active") current.push(entry);
			}
			const failed = (await index(current, signal)).find((ingestion) => ingestion.status === "failed");
			if (failed?.status === "failed") throw new Error(`Restored archive could not be indexed: ${failed.error}`);
			return restored;
		},
	};
}

export function createMemoryService(options: MemoryServiceOptions): ArchiveMemoryService {
	const archive = new InstanceMemory(options.instanceRoot);
	switch (options.backend) {
		case "local":
			return localService(archive);
		case "hindsight":
			return hindsightService(archive, options.hindsight);
		default:
			throw new Error("Unknown memory backend");
	}
}

/** Searches and reads through `service`; observations are rejected. */
export function readOnlyMemoryService(service: MemoryService): MemoryService {
	if (service.readOnly) return service;
	return {
		kind: service.kind,
		readOnly: true,
		search: (query, signal) => service.search(query, signal),
		get: (id, version, signal) => service.get(id, version, signal),
		observe: () => Promise.reject(new Error("Memory is read-only in this session")),
	};
}

function proxyCall(socketPath: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
	const frame = `${JSON.stringify({ v: 2, type: "memory", method, params })}\n`;
	if (Buffer.byteLength(frame) > PROXY_REQUEST_BYTES)
		return Promise.reject(new Error("Memory proxy request exceeds 1 MiB"));
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const socket = createConnection(socketPath);
	const chunks: Buffer[] = [];
	let bytes = 0;
	let settled = false;
	const finish = (error: Error | undefined, value?: unknown) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		socket.destroy();
		if (error) reject(error);
		else resolve(value);
	};
	const timer = setTimeout(() => finish(new Error("Memory proxy timed out")), PROXY_TIMEOUT_MS);
	const abort = () => finish(new Error("Memory proxy request aborted"));
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });
	socket.once("connect", () => socket.write(frame));
	socket.on("error", (error) => finish(new Error(`Memory proxy unavailable: ${error.message}`)));
	socket.on("close", () => finish(new Error("Memory proxy closed without a response")));
	socket.on("data", (chunk: Buffer) => {
		const newline = chunk.indexOf(10);
		const piece = newline < 0 ? chunk : chunk.subarray(0, newline);
		bytes += piece.length;
		if (bytes > PROXY_RESPONSE_BYTES) return finish(new Error("Memory proxy response exceeds 4 MiB"));
		chunks.push(piece);
		if (newline < 0) return;
		let response: { type?: unknown; result?: unknown; error?: unknown };
		try {
			response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof response;
		} catch {
			return finish(new Error("Memory proxy returned malformed JSON"));
		}
		if (response?.type === "memory_result" && "result" in response) finish(undefined, response.result);
		else if (response?.type === "memory_error" && typeof response.error === "string")
			finish(new Error(response.error));
		else finish(new Error("Memory proxy returned an invalid response"));
	});
	return promise;
}

/**
 * Forwards to a service owned by the host behind `socketPath`, one JSON line request and response per connection.
 * The host binds scope, archive, backend, credentials, write access, applicability context, and provenance; the
 * wire carries none of them.
 */
export function createProxyMemoryService(socketPath: string): ProxyMemoryService {
	if (typeof socketPath !== "string" || !socketPath.startsWith("/"))
		throw new Error("Memory proxy socket must be absolute");
	return {
		kind: "proxy",
		readOnly: false,
		search: async (query, signal) => (await proxyCall(socketPath, "search", query, signal)) as MemoryRetrieval,
		get: async (id, version, signal) =>
			(await proxyCall(socketPath, "get", version === undefined ? { id } : { id, version }, signal)) as MemoryEntry,
		observe: async (input, signal) =>
			(await proxyCall(socketPath, "observe", { input }, signal)) as MemoryObservation,
	};
}

/**
 * The selected service for an instance: `RAGA_MEMORY_BACKEND` is `local` (default), `hindsight` (with
 * `RAGA_HINDSIGHT_URL`, `RAGA_HINDSIGHT_BANK`, and optional `RAGA_HINDSIGHT_API_KEY`), or `proxy` (with
 * `RAGA_MEMORY_PROXY_SOCKET`). Empty settings count as unset; settings of an unselected backend are an error
 * rather than ignored.
 */
export function selectMemoryService(
	instanceRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): ArchiveMemoryService | ProxyMemoryService {
	const setting = (name: string) => env[name]?.trim() || undefined;
	const backend = setting("RAGA_MEMORY_BACKEND") ?? "local";
	for (const [kind, names] of Object.entries(ENVIRONMENT_BACKENDS)) {
		const stray = names.find((name) => setting(name) !== undefined);
		if (kind !== backend && stray) throw new Error(`${stray} is set, but RAGA_MEMORY_BACKEND is ${backend}`);
	}
	switch (backend) {
		case "local":
			return createMemoryService({ backend: "local", instanceRoot });
		case "hindsight": {
			const url = setting("RAGA_HINDSIGHT_URL");
			const bankId = setting("RAGA_HINDSIGHT_BANK");
			if (!url || !bankId) throw new Error("Hindsight memory requires RAGA_HINDSIGHT_URL and RAGA_HINDSIGHT_BANK");
			return createMemoryService({
				backend: "hindsight",
				instanceRoot,
				hindsight: { url, bankId, apiKey: setting("RAGA_HINDSIGHT_API_KEY") },
			});
		}
		case "proxy": {
			const socket = setting("RAGA_MEMORY_PROXY_SOCKET");
			if (!socket) throw new Error("Proxy memory requires RAGA_MEMORY_PROXY_SOCKET");
			return createProxyMemoryService(socket);
		}
		default:
			throw new Error(`Unknown RAGA_MEMORY_BACKEND ${JSON.stringify(backend)}`);
	}
}

/**
 * What a host serving {@link createProxyMemoryService} grants one client. Every field is the host's; none is read
 * from the wire.
 */
export interface MemoryProxyBinding {
	service: MemoryService;
	/** The only scope the client may search, read, or record. */
	scope: string;
	/** Rejects every observation, whatever `service` permits. */
	readOnly: boolean;
	/**
	 * The applicability context the host attests. Searches use it in place of the client's task type, harness
	 * revision, and tool versions. An observation may hard-bind only to these values, or omit them to stay portable.
	 */
	context?: Pick<MemoryQuery, "taskType" | "harnessRevision" | "toolVersions">;
	/** Provenance recorded on every observation in place of any origin the client sends. */
	origin?: MemoryOrigin;
	/** Host attestations appended to every observation's evidence, such as its trial and stage. */
	evidence?: string[];
}

/** Evidence prefixes only a proxy host attests, beyond the prefixes of its own binding evidence. */
const HOST_EVIDENCE_PREFIXES = ["benchmark-trial:", "origin-harness-revision:"];

/**
 * What a proxy client learns of a failed host operation. Filesystem and parse errors name host archive paths
 * and stored bytes, so they reach the client only as a stable message; `cause` keeps them for the host.
 */
function clientError(method: string, error: unknown): Error {
	if (error instanceof Error && !("code" in error) && !(error instanceof SyntaxError)) return error;
	return new Error(`Memory ${method} failed`, { cause: error });
}

function strictObject(value: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
	if (unsupported) throw new Error(`${name} has unsupported field ${JSON.stringify(unsupported)}`);
	return value as Record<string, unknown>;
}

const QUERY_FIELDS = [
	"query",
	"scope",
	"taskType",
	"harnessRevision",
	"toolVersions",
	"maxChars",
	"limit",
	"includeHypotheses",
	"includeUnreviewed",
] as const;
const INPUT_FIELDS = [
	"text",
	"scope",
	"kind",
	"evidence",
	"taskType",
	"applicability",
	"harnessRevision",
	"origin",
	"toolVersions",
	"epistemicStatus",
	"conflictsWith",
	"conflictKey",
	"sharing",
	"trust",
] as const;

/**
 * Answers one proxy request with the bound service. Requests name only a method and its parameters; scope,
 * write access, applicability context, provenance, and backend come from `binding`. Clients record only
 * unreviewed hypothesis observations, and a record outside the bound scope reads as absent.
 */
export async function handleMemoryProxyRequest(
	binding: MemoryProxyBinding,
	request: { method: unknown; params: unknown },
	signal?: AbortSignal,
): Promise<unknown> {
	const unbound = (scope: unknown) => {
		if (scope !== binding.scope) throw new Error("Memory belongs to a different project scope");
	};
	const context = binding.context;
	switch (request.method) {
		case "search": {
			const query = strictObject(request.params, QUERY_FIELDS, "Memory query") as unknown as MemoryQuery;
			unbound(query.scope);
			const bound = context
				? {
						...query,
						taskType: context.taskType,
						harnessRevision: context.harnessRevision,
						toolVersions: context.toolVersions,
					}
				: query;
			try {
				return await binding.service.search(bound, signal);
			} catch (error) {
				throw clientError("search", error);
			}
		}
		case "get": {
			const params = strictObject(request.params, ["id", "version"], "Memory get");
			if (typeof params.id !== "string") throw new Error("Memory get requires an id");
			if (params.version !== undefined && typeof params.version !== "number")
				throw new Error("Memory get version must be a number");
			const notFound = `Memory entry not found: ${params.id}${params.version === undefined ? "" : `@${params.version}`}`;
			let entry: MemoryEntry;
			try {
				entry = await binding.service.get(params.id, params.version, signal);
			} catch (error) {
				const missing = error instanceof Error && error.message.startsWith("Memory entry not found");
				throw missing ? new Error(notFound, { cause: error }) : clientError("get", error);
			}
			if (entry.scope !== binding.scope) throw new Error(notFound);
			return entry;
		}
		case "observe": {
			// Only an explicit `false` grants writes, so a JavaScript host that omits the field stays read-only.
			if (binding.readOnly !== false) throw new Error("Memory is read-only in this session");
			const params = strictObject(request.params, ["input"], "Memory observe");
			const input = strictObject(params.input, INPUT_FIELDS, "Memory input") as unknown as MemoryInput;
			unbound(input.scope);
			if (input.kind !== "observation" || input.trust !== "unreviewed" || input.epistemicStatus !== "hypothesis")
				throw new Error("Proxy clients record only unreviewed hypothesis observations");
			if (!Array.isArray(input.evidence)) throw new Error("evidence must be an array of strings");
			const reserved = [
				...HOST_EVIDENCE_PREFIXES,
				...(binding.evidence ?? []).map((item) => item.slice(0, item.indexOf(":") + 1) || item),
			];
			const forged = input.evidence.find(
				(item: unknown) => typeof item === "string" && reserved.some((prefix) => item.startsWith(prefix)),
			);
			if (forged !== undefined)
				throw new Error(`Evidence ${JSON.stringify(forged)} uses a prefix reserved for host attestations`);
			if (context) {
				for (const field of ["taskType", "harnessRevision", "toolVersions"] as const) {
					if (input[field] !== undefined && !isDeepStrictEqual(input[field], context[field]))
						throw new Error(`Observation ${field} must match the host's or be omitted`);
				}
			}
			try {
				return await binding.service.observe(
					{ ...input, origin: binding.origin, evidence: [...input.evidence, ...(binding.evidence ?? [])] },
					signal,
				);
			} catch (error) {
				throw clientError("observe", error);
			}
		}
		default:
			throw new Error(`Unknown memory method ${JSON.stringify(request.method)}`);
	}
}
