/**
 * Process-local lifecycle events for RLM cells. The kernel has no emitter and the TUI
 * cannot see child sessions, so this bus is the one place root and child cells report to.
 * Listeners must not affect execution: a throwing listener is ignored.
 */

export type RlmCellStatus = "ok" | "error" | "aborted";

export interface RlmCellStartEvent {
	type: "start";
	cellId: string;
	sessionId: string;
	depth: number;
	code: string;
	startedAt: number;
}

export interface RlmCellEndEvent {
	type: "end";
	cellId: string;
	sessionId: string;
	depth: number;
	status: RlmCellStatus;
	durationMs: number;
}

export type RlmCellEvent = RlmCellStartEvent | RlmCellEndEvent;

type Listener = (event: RlmCellEvent) => void;

const listeners = new Set<Listener>();

export function subscribeRlmCellEvents(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function emitRlmCellEvent(event: RlmCellEvent): void {
	for (const listener of [...listeners]) {
		try {
			listener(event);
		} catch {
			// A dashboard fault must never fail a cell.
		}
	}
}

/** The first non-empty code line, trimmed for a dashboard row. */
export function cellCodePreview(code: string, limit = 96): string {
	const line = code.split("\n").find((value) => value.trim().length > 0) ?? "";
	const trimmed = line.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}
