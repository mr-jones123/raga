// Adapted from Prime Agent (MIT), github.com/PrimeIntellect-ai/prime-agent
/**
 * Wire types for the RLM kernel protocol (version 1). See docs/RLM.md "Wire protocol".
 *
 * The host writes `KernelRequest` objects to the kernel's stdin and reads `KernelEvent`
 * objects from its stdout, one JSON object per LF-terminated line.
 */

export const PROTOCOL_VERSION = 1;

export type HostReplyData = { status: "ok"; result: unknown } | { status: "error"; error: string };

export type KernelRequest =
	| { type: "execute"; id: string; code: string }
	| { type: "interrupt"; id?: string }
	| { type: "host_reply"; id: string; data: HostReplyData }
	| { type: "snapshot"; id: string; path: string; max_bytes?: number; max_variable_bytes?: number }
	| { type: "restore"; id: string; path: string }
	| { type: "list_names"; id: string }
	| { type: "set_context"; id: string; task: string; inputs: Record<string, string> }
	| { type: "shutdown"; id?: string };

export interface ReadyEvent {
	event: "ready";
	protocol: number;
	python: string;
}

export interface StreamEvent {
	event: "stdout" | "stderr";
	id: string | null;
	text: string;
}

export interface ResultEvent {
	event: "result";
	id: string;
	text: string;
}

export interface HostRequestEvent {
	event: "host_request";
	id: string;
	cell: string | null;
	data: { type: string; [key: string]: unknown };
}

export interface ErrorEvent {
	event: "error";
	id: string | null;
	ename: string;
	evalue: string;
	traceback: string[];
}

/** `done` carries request-specific fields; the typed ones are validated when present. */
export interface DoneEvent {
	event: "done";
	id: string;
	status: "ok" | "error";
	saved?: string[];
	skipped?: string[];
	bytes?: number;
	restored?: string[];
	failed?: string[];
	names?: string[];
	reason?: string;
}

export type KernelEvent = ReadyEvent | StreamEvent | ResultEvent | HostRequestEvent | ErrorEvent | DoneEvent;

export class KernelProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KernelProtocolError";
	}
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function fail(event: string, field: string): never {
	throw new KernelProtocolError(`Invalid "${event}" event: bad "${field}"`);
}

function str(obj: JsonObject, field: string): string {
	const value = obj[field];
	return typeof value === "string" ? value : fail(String(obj.event), field);
}

function strOrNull(obj: JsonObject, field: string): string | null {
	const value = obj[field];
	return value === null || typeof value === "string" ? value : fail(String(obj.event), field);
}

function optStrings(obj: JsonObject, field: string): string[] | undefined {
	const value = obj[field];
	if (value === undefined) return undefined;
	return isStringArray(value) ? value : fail("done", field);
}

/** Parse one event line. Throws `KernelProtocolError` for malformed JSON and unknown shapes. */
export function parseKernelEvent(line: string): KernelEvent {
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		throw new KernelProtocolError(`Kernel event is not JSON: ${line.slice(0, 200)}`);
	}
	if (!isObject(obj)) throw new KernelProtocolError(`Kernel event is not an object: ${line.slice(0, 200)}`);

	switch (obj.event) {
		case "ready": {
			const protocol = obj.protocol;
			if (typeof protocol !== "number") fail("ready", "protocol");
			return { event: "ready", protocol, python: str(obj, "python") };
		}
		case "stdout":
		case "stderr":
			return { event: obj.event, id: strOrNull(obj, "id"), text: str(obj, "text") };
		case "result":
			return { event: "result", id: str(obj, "id"), text: str(obj, "text") };
		case "host_request": {
			const data = obj.data;
			if (!isObject(data) || typeof data.type !== "string") fail("host_request", "data");
			return {
				event: "host_request",
				id: str(obj, "id"),
				cell: strOrNull(obj, "cell"),
				data: { ...data, type: data.type },
			};
		}
		case "error": {
			const traceback = obj.traceback;
			if (!isStringArray(traceback)) fail("error", "traceback");
			return {
				event: "error",
				id: strOrNull(obj, "id"),
				ename: str(obj, "ename"),
				evalue: str(obj, "evalue"),
				traceback,
			};
		}
		case "done": {
			const status = obj.status;
			if (status !== "ok" && status !== "error") fail("done", "status");
			const bytes = obj.bytes;
			if (bytes !== undefined && typeof bytes !== "number") fail("done", "bytes");
			const reason = obj.reason;
			if (reason !== undefined && typeof reason !== "string") fail("done", "reason");
			const done: DoneEvent = { event: "done", id: str(obj, "id"), status };
			const saved = optStrings(obj, "saved");
			const skipped = optStrings(obj, "skipped");
			const restored = optStrings(obj, "restored");
			const failed = optStrings(obj, "failed");
			const names = optStrings(obj, "names");
			if (saved) done.saved = saved;
			if (skipped) done.skipped = skipped;
			if (bytes !== undefined) done.bytes = bytes;
			if (restored) done.restored = restored;
			if (failed) done.failed = failed;
			if (names) done.names = names;
			if (reason !== undefined) done.reason = reason;
			return done;
		}
		default:
			throw new KernelProtocolError(`Unknown kernel event: ${JSON.stringify(obj.event)}`);
	}
}
