import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

export function digest(value) {
	return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
}

export function readJsonl(path) {
	const text = readFileSync(path, "utf8");
	if (text && !text.endsWith("\n")) throw new Error(`Incomplete JSONL record in ${path}`);
	return text.split("\n").filter(Boolean).map((line, index) => {
		try { return JSON.parse(line); }
		catch (error) { throw new Error(`Invalid JSONL at ${path}:${index + 1}`, { cause: error }); }
	});
}

export function createArtifacts(outputRoot, configuration) {
	mkdirSync(outputRoot, { recursive: true });
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
	const directory = resolve(outputRoot, runId);
	mkdirSync(directory);
	const files = new Map(["config", "events", "results"].map((name) => [name, openSync(join(directory, `${name}.jsonl`), "ax", 0o600)]));
	let sequence = 0;
	let closed = false;
	const trials = new Set();
	const append = (file, value) => {
		if (closed) throw new Error("Artifact journal is closed");
		const row = { ...value, schemaVersion: 1, runId, sequence: ++sequence, recordedAt: new Date().toISOString() };
		const buffer = Buffer.from(`${JSON.stringify(row)}\n`);
		let offset = 0;
		while (offset < buffer.length) offset += writeSync(files.get(file), buffer, offset, buffer.length - offset);
		fsyncSync(files.get(file));
		return row;
	};
	append("config", { type: "configuration", ...configuration });
	return {
		runId,
		directory,
		event(type, fields = {}) { return append("events", { ...fields, type }); },
		result(record) {
			if (!record.trialId || trials.has(record.trialId)) throw new Error(`Duplicate or missing trial ID: ${record.trialId}`);
			if (!["passed", "failed", "error", "timeout", "cancelled", "checkpoint"].includes(record.status)) throw new Error(`Invalid result status: ${record.status}`);
			const row = append("results", { ...record, type: "trial_result" });
			trials.add(record.trialId);
			return row;
		},
		close() {
			if (closed) return;
			closed = true;
			for (const fd of files.values()) closeSync(fd);
		},
	};
}
