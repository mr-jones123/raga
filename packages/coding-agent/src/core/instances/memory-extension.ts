import type { ExtensionFactory } from "../extensions/types.ts";
import type { MemoryRetrieval } from "./memory.ts";
import type { MemoryService } from "./memory-service.ts";
import type { HarnessPin } from "./types.ts";

export function createMemoryExtension(pin: HarnessPin, memory: MemoryService): ExtensionFactory {
	return (api) => {
		api.on("before_agent_start", async (event) => {
			if (event.messageType !== "user" || !event.prompt.trim()) return;
			const query = { text: event.prompt, trigger: "task", includeUnverified: false, maxChars: 4000, limit: 5 };
			let result: MemoryRetrieval;
			try {
				result = await memory.search({
					query: query.text,
					scope: pin.projectRoot,
					harnessRevision: pin.revision,
					maxChars: query.maxChars,
					limit: query.limit,
				});
			} catch (error) {
				// The extension runner reports the rethrown error; the session keeps the failed retrieval too.
				api.appendEntry("raga-memory-retrieval", {
					trigger: "task",
					query,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
			api.appendEntry("raga-memory-retrieval", { trigger: "task", query, ...result });
			if (!result.text) return;
			return {
				message: {
					customType: "raga-memory-context",
					content: result.text,
					display: false,
				},
			};
		});
	};
}
