import type { ExtensionFactory } from "../extensions/types.ts";
import { InstanceMemory } from "./memory.ts";
import type { HarnessPin } from "./types.ts";

export function createMemoryExtension(pin: HarnessPin): ExtensionFactory {
	return (api) => {
		const memory = new InstanceMemory(pin.instanceRoot);
		api.on("before_agent_start", async (event) => {
			if (event.messageType !== "user" || !event.prompt.trim()) return;
			const result = await memory.retrieve({
				query: event.prompt,
				scope: pin.projectRoot,
				harnessRevision: pin.revision,
				maxChars: 4000,
				limit: 5,
			});
			api.appendEntry("raga-memory-retrieval", { trigger: "task", ...result });
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
