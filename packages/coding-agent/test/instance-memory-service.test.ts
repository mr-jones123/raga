import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instanceHostHandlers } from "../src/core/instances/host-api.ts";
import { InstanceMemory, type MemoryEntry, type MemoryRetrieval } from "../src/core/instances/memory.ts";
import {
	createMemoryService,
	createProxyMemoryService,
	handleMemoryProxyRequest,
	type MemoryObservation,
	type MemoryProxyBinding,
	type MemoryService,
	readOnlyMemoryService,
	selectMemoryService,
} from "../src/core/instances/memory-service.ts";
import type { HarnessPin } from "../src/core/instances/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

interface FakeHindsight {
	url: string;
	/** Content by document ID; retaining an existing document ID replaces it, as Hindsight's default upsert does. */
	documents: Map<string, string>;
	/** Every retained item as sent. */
	items: Array<Record<string, unknown>>;
	/** Document IDs the next recalls return, best first; by default every retained document. */
	recall?: string[];
	/** Holds bank creation until it settles. */
	bankGate?: Promise<void>;
	failRecall?: boolean;
	failRetain?: boolean;
	close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of request) text += chunk;
	return JSON.parse(text) as Record<string, unknown>;
}

async function startHindsight(): Promise<FakeHindsight> {
	const fake = { documents: new Map<string, string>(), items: [] as Array<Record<string, unknown>> } as FakeHindsight;
	const server: Server = createHttpServer(async (request, response) => {
		const match = /^\/v1\/default\/banks\/([^/]+)(\/memories(\/recall)?)?$/.exec(request.url ?? "");
		const payload = await body(request);
		const reply = (status: number, value: unknown) => {
			response.writeHead(status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (!match) return reply(404, {});
		const bank = match[1];
		if (!match[2]) {
			await fake.bankGate;
			return reply(200, { bank_id: bank });
		}
		if (!match[3]) {
			if (fake.failRetain) return reply(503, {});
			const items = payload.items as Array<{ document_id: string; content: string }>;
			for (const item of items) {
				fake.items.push(item);
				fake.documents.set(item.document_id, item.content);
			}
			return reply(200, { success: true, async: false, bank_id: bank, items_count: items.length });
		}
		if (fake.failRecall) return reply(500, {});
		const results = (fake.recall ?? [...fake.documents.keys()]).map((documentId) => ({
			id: randomUUID(),
			type: "experience",
			text: `EXTRACTED paraphrase of ${documentId}`,
			document_id: documentId,
		}));
		return reply(200, { results });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (typeof address !== "object" || !address) throw new Error("Fake Hindsight did not bind");
	fake.url = `http://127.0.0.1:${address.port}`;
	fake.close = async () => {
		server.closeAllConnections();
		await closeServer(server);
	};
	return fake;
}

async function serveProxy(path: string, binding: MemoryProxyBinding): Promise<SocketServer> {
	const server = createSocketServer((socket) => {
		let buffered = "";
		socket.on("data", async (chunk) => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			const frame = JSON.parse(buffered.slice(0, newline)) as { method: unknown; params: unknown };
			try {
				const result = await handleMemoryProxyRequest(binding, frame);
				socket.end(`${JSON.stringify({ type: "memory_result", result })}\n`);
			} catch (error) {
				socket.end(`${JSON.stringify({ type: "memory_error", error: (error as Error).message })}\n`);
			}
		});
	});
	server.listen(path);
	await once(server, "listening");
	return server;
}

async function closeServer(server: Server | SocketServer): Promise<void> {
	server.close();
	await once(server, "close");
}

describe("instance memory services", () => {
	let temporary: string;
	let pin: HarnessPin;
	let closers: Array<() => Promise<unknown>>;

	beforeEach(async () => {
		temporary = await mkdtemp(join(tmpdir(), "rm-"));
		pin = {
			instanceId: "instance-a",
			instanceRoot: join(temporary, "project", ".raga"),
			projectRoot: join(temporary, "project"),
			revision: "revision-a",
			resourceRoot: join(temporary, "harness"),
			stateRoot: join(temporary, "project", ".raga", "state"),
		};
		closers = [];
	});

	afterEach(async () => {
		for (const close of closers.reverse()) await close();
		await rm(temporary, { recursive: true, force: true });
	});

	function host(memory: MemoryService, revision = pin.revision) {
		const events: Array<{ type: string; data: unknown }> = [];
		const handlers = instanceHostHandlers(
			{ ...pin, revision },
			SessionManager.inMemory(pin.projectRoot),
			(type, data) => events.push({ type, data }),
			pin.projectRoot,
			memory,
		);
		const call = (type: string, data: Record<string, unknown> = {}) => {
			const handler = handlers.get(type);
			if (!handler) throw new Error(`No ${type} handler`);
			return handler({ type, ...data }, { cellId: null, signal: new AbortController().signal });
		};
		return {
			events,
			observe: (text: string, extra: Record<string, unknown> = {}) =>
				call("memory.observe", { text, evidence: ["cell-1"], ...extra }) as Promise<MemoryObservation>,
			search: (query: string, extra: Record<string, unknown> = {}) =>
				call("memory.search", { query, ...extra }) as Promise<MemoryRetrieval>,
			get: (id: string) => call("memory.get", { id }) as Promise<MemoryEntry>,
		};
	}

	it("returns unreviewed observations unchanged only through explicit experience search, across restart", async () => {
		const session = host(createMemoryService({ backend: "local", instanceRoot: pin.instanceRoot }));
		const { entry, ingestion } = await session.observe("Ledger exports need sorted currency keys.");
		expect(ingestion).toEqual({ backend: "local", status: "archived" });
		expect(entry).toMatchObject({
			trust: "unreviewed",
			epistemicStatus: "hypothesis",
			harnessRevision: "revision-a",
			origin: { harnessRevision: "revision-a" },
		});
		const reviewed = await session.search("ledger currency keys");
		expect(reviewed.selected).toEqual([]);
		expect(reviewed.excluded).toContainEqual({ id: entry.id, version: 1, reason: "unreviewed" });
		expect(session.events.at(-1)).toEqual({
			type: "raga-memory-retrieval",
			data: {
				...reviewed,
				trigger: "explicit",
				query: {
					text: "ledger currency keys",
					trigger: "explicit",
					includeUnverified: false,
					maxChars: 4000,
					limit: 5,
				},
			},
		});

		const restarted = host(createMemoryService({ backend: "local", instanceRoot: pin.instanceRoot }));
		const experience = await restarted.search("ledger currency keys", {
			include_unverified: true,
			max_chars: 3500,
			limit: 3,
		});
		expect(experience.selected).toEqual([entry]);
		expect(experience.text).toContain('"epistemicStatus":"hypothesis","trust":"unreviewed"');
		expect(experience.cost.ranking).toBe("lexical");
		expect(restarted.events.at(-1)).toMatchObject({
			type: "raga-memory-retrieval",
			data: {
				trigger: "explicit",
				query: {
					text: "ledger currency keys",
					trigger: "explicit",
					includeUnverified: true,
					maxChars: 3500,
					limit: 3,
				},
			},
		});
		expect(await restarted.get(entry.id)).toEqual(entry);
		expect(restarted.events.at(-1)).toEqual({
			type: "raga-memory-read",
			data: { id: entry.id, version: entry.version },
		});
	});

	it("records only successful in-scope reads at their current version", async () => {
		const service = createMemoryService({ backend: "local", instanceRoot: pin.instanceRoot });
		const session = host(service);
		const { entry } = await session.observe("Ledger keys sort before export.");
		const revised = await service.archive.revise(entry.id, {
			...entry,
			text: "Ledger keys sort by currency before export.",
			expectedVersion: entry.version,
		});
		expect(await session.get(entry.id)).toEqual(revised);
		expect(session.events.at(-1)).toEqual({
			type: "raga-memory-read",
			data: { id: entry.id, version: revised.version },
		});
		const foreign = await service.archive.observe({ ...entry, scope: "other-project" });
		const before = session.events.length;
		await expect(session.get(foreign.id)).rejects.toThrow("different project scope");
		await expect(session.get(randomUUID())).rejects.toThrow();
		expect(session.events).toHaveLength(before);
	});

	it("keeps existing revision bindings while portable observations reach later revisions", async () => {
		const service = createMemoryService({ backend: "local", instanceRoot: pin.instanceRoot });
		const legacy = await service.archive.observe({
			text: "Ledger legacy guidance bound to its revision.",
			scope: pin.projectRoot,
			kind: "observation",
			evidence: ["old-cell"],
			harnessRevision: "revision-old",
			epistemicStatus: "hypothesis",
			trust: "unreviewed",
		});
		const earlier = host(service, "revision-a");
		const bound = (await earlier.observe("Ledger bound observation.")).entry;
		const portable = (await earlier.observe("Ledger portable observation.", { portable: true })).entry;
		expect(portable.harnessRevision).toBeUndefined();
		expect(portable.origin?.harnessRevision).toBe("revision-a");

		const later = await host(service, "revision-b").search("ledger observation guidance", {
			include_unverified: true,
		});
		expect(later.selected.map((selected) => selected.id)).toEqual([portable.id]);
		expect(later.excluded).toContainEqual({ id: legacy.id, version: 1, reason: "revision-mismatch" });
		expect(later.excluded).toContainEqual({ id: bound.id, version: 1, reason: "revision-mismatch" });
		await expect(host(service).observe("Bad flag.", { portable: "yes" })).rejects.toThrow(
			"portable must be a boolean",
		);
	});

	it("restores exact histories idempotently and rejects conflicting or newer archives", async () => {
		const source = createMemoryService({ backend: "local", instanceRoot: pin.instanceRoot });
		const kept = (await host(source).observe("Ledger keys sort before export.")).entry;
		await source.archive.revise(kept.id, {
			text: "Ledger keys sort by currency before export.",
			scope: pin.projectRoot,
			kind: "observation",
			evidence: ["cell-2"],
			epistemicStatus: "hypothesis",
			trust: "unreviewed",
		});
		const retired = (await host(source).observe("Ledger totals were rounded.")).entry;
		await source.archive.retire(retired.id, "Disproved");
		const snapshot = await source.snapshot();

		const target = createMemoryService({ backend: "local", instanceRoot: join(temporary, "fresh", ".raga") });
		expect((await target.snapshot()).histories).toEqual([]);
		expect((await target.restore(snapshot)).published).toHaveLength(4);
		expect(await target.snapshot()).toEqual(snapshot);
		expect((await target.restore(snapshot)).published).toEqual([]);

		const altered = structuredClone(snapshot);
		const history = altered.histories.find((versions) => versions[0].id === kept.id);
		if (!history) throw new Error("Missing snapshot history");
		history[1].text = "Rewritten history.";
		await expect(target.restore(altered)).rejects.toThrow(`conflicts with stored ${kept.id}@2`);
		const older = structuredClone(snapshot);
		const olderHistory = older.histories.find((versions) => versions[0].id === kept.id);
		olderHistory?.pop();
		await expect(target.restore(older)).rejects.toThrow("older than the stored");

		const partial = createMemoryService({ backend: "local", instanceRoot: join(temporary, "partial", ".raga") });
		const repeated = { ...snapshot, histories: [...snapshot.histories, snapshot.histories[0]] };
		await expect(partial.restore(repeated)).rejects.toThrow("repeats");
		expect((await partial.snapshot()).histories).toEqual([]);
	});

	it("ranks archived records by Hindsight sources without replacing their text, across restart", async () => {
		const hindsight = await startHindsight();
		closers.push(() => hindsight.close());
		const options = { url: hindsight.url, bankId: "raga-test-bank" };
		const service = createMemoryService({ backend: "hindsight", instanceRoot: pin.instanceRoot, hindsight: options });
		const session = host(service);
		const first = await session.observe("Ledger exports need sorted currency keys.");
		const second = await session.observe("Currency rounding happens after ledger aggregation.");
		expect(first.ingestion).toEqual({
			backend: "hindsight",
			status: "retained",
			documentId: `raga-memory:${first.entry.id}`,
		});
		expect(hindsight.documents.get(`raga-memory:${first.entry.id}`)).toBe(first.entry.text);
		hindsight.recall = [`raga-memory:${second.entry.id}`, `raga-memory:${first.entry.id}`];

		for (const memory of [
			service,
			createMemoryService({ backend: "hindsight", instanceRoot: pin.instanceRoot, hindsight: options }),
		]) {
			const result = await host(memory).search("unrelated words", { include_unverified: true });
			expect(result.cost.ranking).toBe("hindsight");
			expect(result.selected).toEqual([second.entry, first.entry]);
			expect(result.text).not.toContain("EXTRACTED");
			expect(result.text).toContain(first.entry.text);
		}
		expect((await host(service).search("ledger currency")).selected).toEqual([]);

		const fresh = await startHindsight();
		closers.push(() => fresh.close());
		const restored = createMemoryService({
			backend: "hindsight",
			instanceRoot: join(temporary, "restored", ".raga"),
			hindsight: { url: fresh.url, bankId: "raga-restored-bank" },
		});
		await restored.restore(await service.snapshot());
		expect([...fresh.documents.keys()].sort()).toEqual(
			[`raga-memory:${first.entry.id}`, `raga-memory:${second.entry.id}`].sort(),
		);
		expect((await host(restored).search("ledger", { include_unverified: true })).selected).toHaveLength(2);
	});

	it("keeps one Hindsight document per record and hydrates its current archived version", async () => {
		const hindsight = await startHindsight();
		closers.push(() => hindsight.close());
		const options = { url: hindsight.url, bankId: "raga-test-bank" };
		const service = createMemoryService({ backend: "hindsight", instanceRoot: pin.instanceRoot, hindsight: options });
		const { entry: observed } = await host(service).observe("Ledger keys sort before export.");
		const snapshot = await service.snapshot();
		const revised = await service.archive.revise(observed.id, {
			text: "Ledger keys sort by currency before export.",
			scope: pin.projectRoot,
			kind: "observation",
			evidence: ["cell-2"],
			epistemicStatus: "hypothesis",
			trust: "unreviewed",
		});
		const documentId = `raga-memory:${observed.id}`;
		expect(await service.index([revised])).toEqual([{ backend: "hindsight", status: "retained", documentId }]);
		expect([...hindsight.documents]).toEqual([[documentId, revised.text]]);
		expect(hindsight.items.at(-1)).toMatchObject({
			document_id: documentId,
			update_mode: "replace",
			metadata: { raga_memory_id: observed.id, raga_memory_version: "2" },
		});
		expect(JSON.stringify(hindsight.items)).not.toContain(pin.projectRoot);
		const current = await host(service).search("ledger", { include_unverified: true });
		expect(current.selected).toEqual([revised]);
		expect(current.excluded).toContainEqual({ id: observed.id, version: 1, reason: "superseded" });

		const behindBank = createMemoryService({
			backend: "hindsight",
			instanceRoot: join(temporary, "behind", ".raga"),
			hindsight: options,
		});
		await behindBank.archive.restore(snapshot);
		expect((await host(behindBank).search("ledger", { include_unverified: true })).selected).toEqual([observed]);
		await behindBank.restore(snapshot);
		expect([...hindsight.documents]).toEqual([[documentId, observed.text]]);

		const retired = await service.archive.retire(observed.id, "Disproved");
		const afterRetirement = await host(service).search("ledger", { include_unverified: true });
		expect(afterRetirement.selected).toEqual([]);
		expect(afterRetirement.excluded).toContainEqual({ id: observed.id, version: retired.version, reason: "retired" });
	});

	it("fails Hindsight searches on foreign sources and outages without lexical fallback", async () => {
		const hindsight = await startHindsight();
		closers.push(() => hindsight.close());
		const service = createMemoryService({
			backend: "hindsight",
			instanceRoot: pin.instanceRoot,
			hindsight: { url: hindsight.url, bankId: "raga-test-bank" },
		});
		const session = host(service);
		const { entry } = await session.observe("Ledger exports need sorted currency keys.");

		hindsight.recall = ["another-system:ledger"];
		await expect(session.search("ledger", { include_unverified: true })).rejects.toThrow("foreign source");
		hindsight.recall = [`raga-memory:${randomUUID()}`];
		await expect(session.search("ledger", { include_unverified: true })).rejects.toThrow("unknown source record");
		hindsight.recall = [`raga-memory:${entry.id}@1`];
		await expect(session.search("ledger", { include_unverified: true })).rejects.toThrow("foreign source");
		hindsight.recall = undefined;
		hindsight.failRecall = true;
		await expect(session.search("ledger currency keys", { include_unverified: true })).rejects.toThrow(
			"Hindsight recall failed (HTTP 500)",
		);
		expect(session.events.at(-1)).toMatchObject({
			type: "raga-memory-retrieval",
			data: {
				trigger: "explicit",
				query: { text: "ledger currency keys", includeUnverified: true },
				error: expect.stringContaining("HTTP 500"),
			},
		});

		hindsight.failRetain = true;
		const unindexed = await session.observe("Ledger audits need a second reviewer.");
		expect(unindexed.ingestion).toMatchObject({
			backend: "hindsight",
			status: "failed",
			error: expect.stringContaining("HTTP 503"),
		});
		expect(await service.archive.get(unindexed.entry.id)).toEqual(unindexed.entry);
	});

	it("lets each caller's signal bound only its own wait for a shared Hindsight bank", async () => {
		const hindsight = await startHindsight();
		closers.push(() => hindsight.close());
		const options = { url: hindsight.url, bankId: "raga-test-bank" };
		const writer = createMemoryService({ backend: "hindsight", instanceRoot: pin.instanceRoot, hindsight: options });
		const { entry } = await host(writer).observe("Ledger exports need sorted currency keys.");
		const gate = Promise.withResolvers<void>();
		hindsight.bankGate = gate.promise;
		const service = createMemoryService({ backend: "hindsight", instanceRoot: pin.instanceRoot, hindsight: options });
		const query = {
			query: "ledger",
			scope: pin.projectRoot,
			harnessRevision: pin.revision,
			includeUnreviewed: true,
			includeHypotheses: true,
		};
		const cancelled = new AbortController();
		const abandoned = service.search(query, cancelled.signal);
		const waiting = service.search(query);
		cancelled.abort();
		await expect(abandoned).rejects.toThrow("Hindsight bank failed (aborted)");
		gate.resolve();
		expect((await waiting).selected).toEqual([entry]);
	});

	it("keeps read-only services from recording while they still search", async () => {
		const service = createMemoryService({ backend: "local", instanceRoot: pin.instanceRoot });
		await host(service).observe("Ledger exports need sorted currency keys.");
		const child = host(readOnlyMemoryService(service));
		await expect(child.observe("Child note.")).rejects.toThrow("read-only");
		expect((await child.search("ledger currency", { include_unverified: true })).selected).toHaveLength(1);
		expect(await service.archive.list()).toHaveLength(1);
	});

	it("serves a proxy client from a host-bound service and never falls back", async () => {
		const hostService = createMemoryService({ backend: "local", instanceRoot: join(temporary, "host", ".raga") });
		await hostService.archive.observe({
			text: "Other project ledger secret.",
			scope: "/other-project",
			kind: "observation",
			evidence: ["other"],
		});
		const [foreign] = await hostService.archive.list();
		const socketPath = join(temporary, "memory.sock");
		const binding: MemoryProxyBinding = {
			service: hostService,
			scope: pin.projectRoot,
			readOnly: false,
			context: { harnessRevision: "revision-a" },
			origin: { harnessRevision: "revision-a" },
			evidence: ["benchmark-trial:t-1"],
		};
		const server = await serveProxy(socketPath, binding);
		closers.push(() => closeServer(server));
		const client = host(createProxyMemoryService(socketPath));

		const observed = await client.observe("Ledger exports need sorted currency keys.", { portable: true });
		expect(observed.entry.evidence).toEqual(["cell-1", "benchmark-trial:t-1"]);
		expect(observed.entry.harnessRevision).toBeUndefined();
		expect(observed.entry.origin).toEqual({ harnessRevision: "revision-a" });
		expect(await hostService.archive.get(observed.entry.id)).toEqual(observed.entry);
		expect(await new InstanceMemory(pin.instanceRoot).list()).toEqual([]);
		expect((await client.search("ledger currency", { include_unverified: true })).selected).toEqual([observed.entry]);
		expect(client.events.at(-1)).toMatchObject({
			type: "raga-memory-retrieval",
			data: { trigger: "explicit", query: { text: "ledger currency", includeUnverified: true } },
		});
		expect(await client.get(observed.entry.id)).toEqual(observed.entry);
		expect(client.events.at(-1)).toEqual({
			type: "raga-memory-read",
			data: { id: observed.entry.id, version: observed.entry.version },
		});
		const beforeDeniedReads = client.events.length;
		for (const id of [foreign.id, randomUUID()]) {
			await expect(client.get(id)).rejects.toThrow(new RegExp(`^Memory entry not found: ${id}$`));
		}
		expect(client.events).toHaveLength(beforeDeniedReads);

		const bound = (await client.observe("Ledger bound note.")).entry;
		expect(bound.harnessRevision).toBe("revision-a");
		const later = host(createProxyMemoryService(socketPath), "revision-b");
		const laterSearch = await later.search("ledger bound note", { include_unverified: true });
		expect(laterSearch.selected.map((entry) => entry.id)).toContain(bound.id);
		await expect(later.observe("Ledger later bound note.")).rejects.toThrow(
			"Observation harnessRevision must match the host's or be omitted",
		);
		expect((await later.observe("Ledger later portable note.", { portable: true })).entry.origin).toEqual({
			harnessRevision: "revision-a",
		});
		for (const forged of ["benchmark-trial:t-2", "origin-harness-revision:revision-z"]) {
			await expect(client.observe("Forged attestation.", { evidence: [forged] })).rejects.toThrow(
				"reserved for host attestations",
			);
		}

		const query = { query: "ledger", scope: pin.projectRoot };
		await expect(
			handleMemoryProxyRequest(binding, { method: "search", params: { ...query, scope: "/other-project" } }),
		).rejects.toThrow("different project scope");
		await expect(
			handleMemoryProxyRequest(binding, { method: "search", params: { ...query, instanceRoot: "/" } }),
		).rejects.toThrow("unsupported field");
		const note = {
			text: "Trusted.",
			scope: pin.projectRoot,
			kind: "observation",
			evidence: ["x"],
			trust: "unreviewed",
			epistemicStatus: "hypothesis",
		};
		await expect(
			handleMemoryProxyRequest(binding, { method: "observe", params: { input: { ...note, trust: "curated" } } }),
		).rejects.toThrow("unreviewed hypothesis");
		await expect(handleMemoryProxyRequest(binding, { method: "snapshot", params: {} })).rejects.toThrow(
			"Unknown memory method",
		);
		const unstated = { service: hostService, scope: pin.projectRoot } as unknown as MemoryProxyBinding;
		await expect(handleMemoryProxyRequest(unstated, { method: "observe", params: { input: note } })).rejects.toThrow(
			"read-only",
		);

		const readOnlyPath = join(temporary, "read-only.sock");
		const readOnlyServer = await serveProxy(readOnlyPath, { ...binding, readOnly: true });
		closers.push(() => closeServer(readOnlyServer));
		await expect(host(createProxyMemoryService(readOnlyPath)).observe("Final-stage note.")).rejects.toThrow(
			"read-only",
		);
		expect(await hostService.archive.list()).toHaveLength(4);

		const missing = host(createProxyMemoryService(join(temporary, "missing.sock")));
		await expect(missing.search("ledger", { include_unverified: true })).rejects.toThrow("Memory proxy unavailable");
	});

	it("selects exactly one configured backend from the environment", () => {
		const root = pin.instanceRoot;
		expect(selectMemoryService(root, {}).kind).toBe("local");
		expect(
			selectMemoryService(root, { RAGA_MEMORY_BACKEND: "proxy", RAGA_MEMORY_PROXY_SOCKET: "/run/memory.sock" }).kind,
		).toBe("proxy");
		const hindsight = selectMemoryService(root, {
			RAGA_MEMORY_BACKEND: "hindsight",
			RAGA_HINDSIGHT_URL: "http://127.0.0.1:1",
			RAGA_HINDSIGHT_BANK: "bank",
		});
		expect(hindsight.kind).toBe("hindsight");
		expect(() => selectMemoryService(root, { RAGA_MEMORY_PROXY_SOCKET: "/run/memory.sock" })).toThrow(
			"RAGA_MEMORY_BACKEND is local",
		);
		expect(() => selectMemoryService(root, { RAGA_MEMORY_BACKEND: "proxy" })).toThrow("RAGA_MEMORY_PROXY_SOCKET");
		expect(() =>
			selectMemoryService(root, { RAGA_MEMORY_BACKEND: "hindsight", RAGA_HINDSIGHT_URL: "http://h" }),
		).toThrow("RAGA_HINDSIGHT_BANK");
		expect(() => selectMemoryService(root, { RAGA_MEMORY_BACKEND: "mem0" })).toThrow("Unknown RAGA_MEMORY_BACKEND");
		expect(
			selectMemoryService(root, {
				RAGA_MEMORY_BACKEND: " ",
				RAGA_HINDSIGHT_URL: "",
				RAGA_HINDSIGHT_API_KEY: "  ",
				RAGA_MEMORY_PROXY_SOCKET: "",
			}).kind,
		).toBe("local");
		const remote = { RAGA_MEMORY_BACKEND: "hindsight", RAGA_HINDSIGHT_BANK: "bank", RAGA_HINDSIGHT_API_KEY: "key" };
		expect(() => selectMemoryService(root, { ...remote, RAGA_HINDSIGHT_URL: "http://memory.example" })).toThrow(
			"only over HTTPS or to a loopback host",
		);
		for (const url of [
			"https://memory.example",
			"http://localhost:8888",
			"http://127.0.0.1:8888",
			"http://[::1]:8888",
		])
			expect(selectMemoryService(root, { ...remote, RAGA_HINDSIGHT_URL: url }).kind).toBe("hindsight");
	});
});
