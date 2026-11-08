import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatContextBar } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSession(options: {
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usingSubscription?: boolean;
	percent?: number | null;
	cwd?: string;
	routedModel?: { model: { id: string }; thinkingLevel?: string };
}): AgentSession & { contextCalls: number; entries: unknown[] } {
	const entries: unknown[] = [];
	const session = {
		contextCalls: 0,
		entries,
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getCwd: () => options.cwd ?? "/home/user/projects/raga",
		},
		getContextUsage() {
			session.contextCalls++;
			return { contextWindow: 200_000, percent: options.percent === undefined ? 34 : options.percent };
		},
		routedModel: options.routedModel,
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};
	return session as unknown as AgentSession & { contextCalls: number; entries: unknown[] };
}

function createFooterData(
	branch: string | null = "main",
	statuses = new Map<string, string>(),
): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => branch,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

describe("FooterComponent", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders folder, branch, context bar, billing, and model on one line", () => {
		const session = createSession({ reasoning: true, thinkingLevel: "high", usingSubscription: true });
		const lines = new FooterComponent(session, createFooterData()).render(80).map(stripAnsi);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^ raga · main · ■■■□□□□□ 34% +sub · test-model · high $/);
		expect(visibleWidth(lines[0])).toBe(80);
	});

	it("shows api for API-key auth and marks Kimi Coding as a subscription", () => {
		expect(stripAnsi(new FooterComponent(createSession({}), createFooterData()).render(80)[0])).toContain("api ·");
		const kimi = createSession({ provider: "kimi-coding" });
		expect(stripAnsi(new FooterComponent(kimi, createFooterData()).render(80)[0])).toContain("sub ·");
	});

	it("omits the branch outside a git repository", () => {
		const line = stripAnsi(new FooterComponent(createSession({}), createFooterData(null)).render(80)[0]);
		expect(line.startsWith(" raga · ■■■")).toBe(true);
	});

	it("shows the physical model a virtual model routed to", () => {
		const session = createSession({
			modelId: "auto",
			reasoning: true,
			thinkingLevel: "high",
			routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
		});
		const line = stripAnsi(new FooterComponent(session, createFooterData()).render(120)[0]);
		expect(line).toContain("auto · high → gpt-5.6-luna · medium");
	});

	it("keeps lines within width for wide model names and narrow terminals", () => {
		const session = createSession({ modelId: "模".repeat(30), reasoning: true, thinkingLevel: "high" });
		const footer = new FooterComponent(
			session,
			createFooterData("feature/".repeat(10), new Map([["a", "x".repeat(200)]])),
		);
		for (const width of [10, 30, 60, 93]) {
			for (const line of footer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("puts extension statuses on a second line", () => {
		const footer = new FooterComponent(
			createSession({}),
			createFooterData(
				"main",
				new Map([
					["b", "two"],
					["a", "one"],
				]),
			),
		);
		expect(stripAnsi(footer.render(80)[1])).toBe(" one two");
	});

	it("caches context usage until an entry is appended", () => {
		const session = createSession({});
		const footer = new FooterComponent(session, createFooterData());
		footer.render(80);
		footer.render(80);
		expect(session.contextCalls).toBe(1);
		session.entries.push({});
		footer.render(80);
		expect(session.contextCalls).toBe(2);
	});
});

describe("formatContextBar", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("fills one cell per eighth and clamps out-of-range values", () => {
		expect(stripAnsi(formatContextBar(0))).toBe("□□□□□□□□ 0%");
		expect(stripAnsi(formatContextBar(50))).toBe("■■■■□□□□ 50%");
		expect(stripAnsi(formatContextBar(140))).toBe("■■■■■■■■ 100%");
		expect(stripAnsi(formatContextBar(null))).toBe("□□□□□□□□ ?");
	});
});
