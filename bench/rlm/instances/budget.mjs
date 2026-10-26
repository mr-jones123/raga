export class BudgetExceeded extends Error {}

export function meteredRuntime(runtime, limits) {
	const controller = new AbortController();
	const calls = [];
	const denials = [];
	let reservedUsd = 0;
	let reason = null;
	const started = Date.now();
	const stop = (message) => {
		reason ??= message;
		controller.abort(new BudgetExceeded(message));
	};
	const timer = setTimeout(() => stop("deadline"), limits.timeoutMs);
	const externalAbort = () => stop("aborted");
	process.once("SIGINT", externalAbort);
	let phaseEnd = limits.maxModelCalls;
	process.once("SIGTERM", externalAbort);
	let phase = "setup";
	const admission = (model, context, options) => {
		if (`${model.provider}/${model.id}` !== limits.model || model.api === "pi-virtual") throw new BudgetExceeded("Unbudgeted model routing is disabled");
		if (controller.signal.aborted) throw controller.signal.reason;
		if (calls.length >= limits.maxModelCalls) {
			stop("model-call-limit");
			throw controller.signal.reason;
		}
		if (calls.length >= phaseEnd) {
			denials.push({ phase, reason: "phase-call-limit", at: new Date().toISOString() });
			throw new BudgetExceeded("phase-call-limit");
		}
		const inputRate = Math.max(limits.inputRate ?? 0, model.cost?.input ?? 0, model.cost?.cacheRead ?? 0, model.cost?.cacheWrite ?? 0);
		const outputRate = Math.max(limits.outputRate ?? 0, model.cost?.output ?? 0);
		if (!(inputRate > 0) || !(outputRate > 0) || !(model.contextWindow > 0)) {
			throw new Error("Conservative pricing requires positive model rates/contextWindow or explicit rate overrides");
		}
		const maxTokens = Math.min(options?.maxTokens ?? limits.maxOutputTokens, limits.maxOutputTokens);
		// Reserve the full context window, not a character-based guess about tokenization.
		const reserve = (model.contextWindow * inputRate + maxTokens * outputRate) / 1_000_000;
		if (reservedUsd + reserve > limits.budgetUsd) {
			stop("dollar-reservation-limit");
			throw controller.signal.reason;
		}
		reservedUsd += reserve;
		const record = { index: calls.length + 1, phase, model: `${model.provider}/${model.id}`, sessionId: options?.sessionId ?? null, contextBytes: Buffer.byteLength(JSON.stringify(context)), maxTokens, inputRate, outputRate, pricedModel: (model.cost?.input ?? 0) > 0 && (model.cost?.output ?? 0) > 0, startedAt: new Date().toISOString(), reservedUsd: reserve, usage: null, dollars: null, estimatedDollars: null, status: "started" };
		calls.push(record);
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		return { record, options: { ...options, signal, maxTokens, maxRetries: 0 } };
	};
	const finish = (record, message) => {
		record.status = message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "aborted" : "completed";
		record.reportedUsage = message.usage ?? null;
		const tokenCount = message.usage ? ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (message.usage[key] ?? 0), 0) : 0;
		record.usage = record.status === "completed" || tokenCount > 0 ? message.usage ?? null : null;
		record.providerReportedDollars = Number.isFinite(message.usage?.cost?.total) ? message.usage.cost.total : null;
		record.dollars = record.pricedModel && record.usage ? record.providerReportedDollars : null;
		if (record.usage && ["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isFinite(record.usage[key]))) {
			record.estimatedDollars = ((record.usage.input + record.usage.cacheRead + record.usage.cacheWrite) * record.inputRate + record.usage.output * record.outputRate) / 1_000_000;
		}
		record.finishedAt = new Date().toISOString();
	};
	const proxy = new Proxy(runtime, {
		get(target, key) {
			if (["stream", "streamSimple", "complete", "completeSimple"].includes(key)) return (model, context, options) => {
				const admitted = admission(model, context, options);
				try {
					const streamMethod = key === "complete" ? "stream" : key === "completeSimple" ? "streamSimple" : key;
					const stream = target[streamMethod](model, context, admitted.options);
					const result = stream.result();
					const accounted = result.then((message) => { finish(admitted.record, message); return message; }, (error) => {
						admitted.record.status = "failed";
						admitted.record.error = String(error);
						throw error;
					});
					accounted.catch(() => {});
					return key.startsWith("complete") ? accounted : stream;
				} catch (error) {
					admitted.record.status = "failed";
					admitted.record.error = String(error);
					throw error;
				}
			};
			if (["classify", "generateImages", "streamDeferred", "fetchDeferred", "defer", "resolveModel"].includes(key)) return () => { throw new BudgetExceeded("Unmetered inference operation is disabled"); };
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		runtime: proxy, signal: controller.signal, calls, denials,
		setPhase(value, allowance = limits.maxModelCalls) { phase = value; phaseEnd = Math.min(limits.maxModelCalls, calls.length + allowance); },
		remaining() { return Math.max(0, limits.maxModelCalls - calls.length); },
		stop,
		summary() {
			return { modelCalls: calls.length, dollars: calls.every((call) => call.dollars !== null) ? calls.reduce((sum, call) => sum + call.dollars, 0) : null, knownDollars: calls.reduce((sum, call) => sum + (call.dollars ?? 0), 0), estimatedDollars: calls.every((call) => call.estimatedDollars !== null) ? calls.reduce((sum, call) => sum + call.estimatedDollars, 0) : null, unknownUsageCalls: calls.filter((call) => call.usage === null).length, unknownDollarCalls: calls.filter((call) => call.dollars === null).length, reservedUsd, reason, denials, wallMs: Date.now() - started };
		},
		close() { clearTimeout(timer); process.removeListener("SIGINT", externalAbort); process.removeListener("SIGTERM", externalAbort); },
	};
}

export function distribution(values) {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!sorted.length) return null;
	const middle = Math.floor(sorted.length / 2);
	return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, min: sorted[0], max: sorted.at(-1), n: sorted.length };
}
