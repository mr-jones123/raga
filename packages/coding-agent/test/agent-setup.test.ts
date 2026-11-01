import { stripVTControlCharacters } from "node:util";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRoleDefinition, AgentRoleValue } from "../src/core/agent-roles.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type AgentSetupActions,
	AgentSetupEditor,
	type AgentSetupOptions,
	type AgentSetupState,
	validateAgentSetup,
} from "../src/modes/interactive/agents/setup.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const HOME = "\x1b[H";
const END = "\x1b[F";
const SAVE = "\x13";

const CATALOG: AgentRoleDefinition[] = [
	{ name: "code", panel: false, defaultSeats: 1, description: "Default for worker children" },
	{ name: "judgment", panel: false, defaultSeats: 1, description: "Judgment-heavy children" },
	{ name: "arena runners", panel: true, defaultSeats: 2, description: "/arena: one candidate per seat" },
];
const AVAILABLE = ["anthropic/claude-opus-4-5", "openai/gpt-5", "google/gemini-3-pro"];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture(overrides: Partial<AgentSetupOptions> = {}, rows = 30) {
	const tui = { terminal: { rows }, requestRender: vi.fn() };
	const picks: { current: AgentRoleValue; title: string; resolve: (value: AgentRoleValue | undefined) => void }[] = [];
	let discard = deferred<boolean>();
	const actions = {
		pickModel: vi.fn((current: AgentRoleValue, title: string) => {
			const pick = deferred<AgentRoleValue | undefined>();
			picks.push({ current, title, resolve: pick.resolve });
			return pick.promise;
		}),
		save: vi.fn<(state: AgentSetupState) => void>(),
		cancel: vi.fn(),
		confirmDiscard: vi.fn(() => discard.promise),
	} satisfies AgentSetupActions;
	const options: AgentSetupOptions = {
		catalog: CATALOG,
		initial: { roles: {} },
		available: AVAILABLE,
		instance: false,
		...overrides,
	};
	const editor = new AgentSetupEditor(tui as unknown as TUI, theme, new KeybindingsManager(), options, actions);
	const lines = (width = 120) => editor.render(width).map(stripVTControlCharacters);
	const text = (width = 120) => lines(width).join("\n");
	const selectedLine = (width = 120) => lines(width).find((line) => line.startsWith("▶")) ?? "";
	const press = (...keys: string[]) => {
		for (const key of keys) editor.handleInput(key);
	};
	const resetDiscard = () => {
		discard = deferred<boolean>();
		return discard;
	};
	const answerDiscard = (value: boolean) => discard.resolve(value);
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	return { editor, tui, actions, picks, lines, text, selectedLine, press, flush, answerDiscard, resetDiscard };
}

beforeEach(() => {
	initTheme("dark");
});

describe("agent setup editor", () => {
	it("renders the header, note, budget row, roles, and panel seats", () => {
		const f = fixture({
			initial: {
				budget: "large",
				roles: {
					code: "anthropic/claude-opus-4-5",
					"arena runners": ["openai/gpt-5", null, "google/gemini-3-pro"],
				},
			},
			parentModel: "anthropic/claude-sonnet-4-5",
		});
		const lines = f.lines();
		expect(lines[0]).toContain("Agent roles · 3 models available · budget large");
		expect(lines[1]).toContain(
			"New subagents launched by role use these models. Null roles inherit the parent's model.",
		);
		expect(lines[2]).toMatch(/^▶ Budget\s+large — high reasoning/);
		const line = (start: string) => lines.find((entry) => entry.slice(2).startsWith(start)) ?? "";
		expect(line("code ")).toMatch(/code\s+claude-opus-4-5 anthropic\s+Default for worker children/);
		expect(line("judgment ")).toMatch(/judgment\s+inherit \(parent: claude-sonnet-4-5\)\s+Judgment-heavy children/);
		expect(line("arena runners · 3 seats")).toContain("/arena: one candidate per seat");
		expect(line("arena runners · 3 seats")).not.toContain("not model-diverse");
		expect(line("  seat 1")).toMatch(/seat 1\s+gpt-5 openai/);
		expect(line("  seat 2")).toMatch(/seat 2\s+inherit \(parent: claude-sonnet-4-5\)/);
		expect(line("  seat 3")).toMatch(/seat 3\s+gemini-3-pro google/);
		expect(lines.at(-1)).toContain("enter pick model · i inherit · a/d add/remove seat · ctrl+s save · esc cancel");
		expect(lines.at(-1)).not.toContain("unsaved changes");
	});

	it("fills missing roles with inherit and default seats, and shows the instance note", () => {
		const f = fixture({ instance: true });
		const text = f.text();
		expect(text).toContain("This session is an instance: its children use the pinned agents/model-roles.json.");
		expect(text).toMatch(/Budget\s+default — children use the parent's thinking level/);
		expect(text).toContain("budget default");
		expect(text).toMatch(/arena runners · 2 seats\s+not model-diverse/);
		expect(text).toMatch(/seat 1\s+inherit/);
		expect(text).toMatch(/seat 2\s+inherit/);
		expect(text).not.toContain("seat 3");
		expect(text).not.toContain("(parent:");
	});

	it("marks unavailable selectors and same-provider panels", () => {
		const f = fixture({
			initial: { roles: { code: "gone/model-x", "arena runners": ["openai/gpt-5", null] } },
			parentModel: "openai/gpt-5-mini",
		});
		const text = f.text();
		expect(text).toMatch(/code\s+⚠ gone\/model-x not available/);
		expect(text).toMatch(/arena runners · 2 seats\s+not model-diverse/);
	});

	it("cycles the budget on confirm", () => {
		const f = fixture();
		const seen: string[] = [];
		for (let index = 0; index < 5; index++) {
			f.press(ENTER);
			seen.push(f.lines()[0]);
		}
		expect(seen.map((line) => line.match(/budget (\S+)/)?.[1])).toEqual([
			"unlimited",
			"large",
			"medium",
			"small",
			"default",
		]);
		f.press(ENTER);
		expect(f.selectedLine()).toContain("unlimited — xhigh reasoning");
		expect(f.lines().at(-1)).toContain("• unsaved changes");
	});

	it("picks a model, applies the result, ignores input while pending, and keeps the value on cancel", async () => {
		const f = fixture({ initial: { roles: { code: "openai/gpt-5" } } });
		f.press(DOWN, ENTER);
		expect(f.actions.pickModel).toHaveBeenCalledWith("openai/gpt-5", "code");
		f.press(DOWN, ENTER, "i");
		expect(f.actions.pickModel).toHaveBeenCalledTimes(1);
		expect(f.lines().at(-1)).toContain("Waiting for a choice");
		f.picks[0].resolve("google/gemini-3-pro");
		await f.flush();
		expect(f.selectedLine()).toMatch(/code\s+gemini-3-pro google/);
		expect(f.tui.requestRender).toHaveBeenCalled();

		f.press(ENTER);
		f.picks[1].resolve(undefined);
		await f.flush();
		expect(f.selectedLine()).toMatch(/code\s+gemini-3-pro google/);

		f.press(ENTER);
		f.picks[2].resolve(null);
		await f.flush();
		expect(f.selectedLine()).toMatch(/code\s+inherit/);
	});

	it("picks a seat from its row, and seat 1 from the panel header", async () => {
		const f = fixture();
		f.press(END, ENTER);
		expect(f.picks[0]).toMatchObject({ current: null, title: "arena runners seat 2" });
		f.picks[0].resolve("openai/gpt-5");
		await f.flush();
		f.press(UP, UP, ENTER);
		expect(f.picks[1].title).toBe("arena runners seat 1");
		f.picks[1].resolve("anthropic/claude-opus-4-5");
		await f.flush();
		const text = f.text();
		expect(text).toMatch(/seat 1\s+claude-opus-4-5 anthropic/);
		expect(text).toMatch(/seat 2\s+gpt-5 openai/);
		expect(text).not.toContain("not model-diverse");
	});

	it("sets single roles and seats to inherit, but not the panel header", () => {
		const f = fixture({
			initial: { roles: { code: "openai/gpt-5", "arena runners": ["openai/gpt-5", "openai/gpt-5"] } },
		});
		f.press(DOWN, "i");
		expect(f.selectedLine()).toMatch(/code\s+inherit/);
		f.press(END, "i");
		expect(f.selectedLine()).toMatch(/seat 2\s+inherit/);
		f.press(UP, UP, "i");
		expect(f.text()).toMatch(/seat 1\s+gpt-5 openai/);
	});

	it("adds seats up to 8 and removes seats down to 1", () => {
		const f = fixture({ initial: { roles: { "arena runners": ["openai/gpt-5", "google/gemini-3-pro"] } } });
		f.press(END, UP, UP, "a");
		expect(f.selectedLine()).toMatch(/seat 3\s+inherit/);
		for (let index = 0; index < 10; index++) f.press("a");
		expect(f.text()).toContain("arena runners · 8 seats");
		expect(f.text()).toContain("maximum of 8 seats");
		f.press(HOME, DOWN, "a", "d");
		expect(f.text()).toContain("arena runners · 8 seats");

		f.press(END, UP, UP, UP, UP, UP, UP, UP);
		expect(f.selectedLine()).toMatch(/seat 1\s+gpt-5/);
		f.press("d");
		expect(f.selectedLine()).toMatch(/seat 1\s+gemini-3-pro/);
		for (let index = 0; index < 10; index++) f.press("d");
		expect(f.text()).toContain("arena runners · 1 seat ");
		expect(f.text()).toContain("needs at least one seat");
		expect(f.text()).not.toContain("seat 2");
	});

	it("blocks save on unavailable selectors and selects the first problem", () => {
		const f = fixture({
			initial: {
				roles: {
					judgment: "gone/a",
					"arena runners": ["openai/gpt-5", "gone/b", "gone/c", "gone/d"],
				},
			},
		});
		f.press(SAVE);
		expect(f.actions.save).not.toHaveBeenCalled();
		expect(f.selectedLine()).toMatch(/judgment\s+⚠ gone\/a not available/);
		const error = f.lines(400).at(-2) ?? "";
		expect(error).toContain(
			"judgment: gone/a not available — pick another or inherit; arena runners seat 2: gone/b not available — pick another or inherit; arena runners seat 3: gone/c not available",
		);
		expect(error).toContain("(+1 more)");
		f.press("i", SAVE);
		expect(f.selectedLine()).toMatch(/seat 2\s+⚠ gone\/b/);
		f.press(DOWN);
		expect(f.lines(400).at(-2)).not.toContain("Cannot save");
	});

	it("saves every catalog role with panels as arrays", () => {
		const f = fixture({
			initial: { budget: "small", roles: { code: "openai/gpt-5", stale: "openai/gpt-5" } },
		});
		f.press(DOWN, DOWN, "i", SAVE);
		expect(f.actions.save).toHaveBeenCalledWith({
			budget: "small",
			roles: { code: "openai/gpt-5", judgment: null, "arena runners": [null, null] },
		});
		f.press(HOME, ENTER, SAVE);
		expect(f.actions.save.mock.calls[1][0]).toEqual({
			roles: { code: "openai/gpt-5", judgment: null, "arena runners": [null, null] },
		});
	});

	it("cancels immediately when clean and asks before discarding changes", async () => {
		const clean = fixture();
		clean.press(ESC);
		expect(clean.actions.confirmDiscard).not.toHaveBeenCalled();
		expect(clean.actions.cancel).toHaveBeenCalledTimes(1);

		const f = fixture();
		f.press(ENTER, ESC);
		expect(f.actions.confirmDiscard).toHaveBeenCalledTimes(1);
		f.press(ESC);
		expect(f.actions.confirmDiscard).toHaveBeenCalledTimes(1);
		f.answerDiscard(false);
		await f.flush();
		expect(f.actions.cancel).not.toHaveBeenCalled();
		f.resetDiscard();
		f.press(ESC);
		f.answerDiscard(true);
		await f.flush();
		expect(f.actions.cancel).toHaveBeenCalledTimes(1);
	});

	it("treats changes reverted to the initial state as clean", () => {
		const f = fixture();
		f.press(ENTER, ENTER, ENTER, ENTER, ENTER);
		expect(f.lines().at(-1)).not.toContain("unsaved changes");
		f.press(ESC);
		expect(f.actions.confirmDiscard).not.toHaveBeenCalled();
		expect(f.actions.cancel).toHaveBeenCalled();
	});

	it("renders exactly rows by width at every size and scrolls to the selection", () => {
		const roles = Object.fromEntries(
			CATALOG.map((role) => [role.name, role.panel ? AVAILABLE : "gone/very-long-model"]),
		);
		for (const rows of [0, 1, 2, 3, 4, 5, 6, 8, 30]) {
			for (const width of [0, 1, 5, 20, 40, 80, 200]) {
				const f = fixture({ initial: { roles }, parentModel: "anthropic/claude-opus-4-5" }, rows);
				f.press(END);
				const rendered = f.editor.render(width);
				expect(rendered).toHaveLength(rows);
				for (const line of rendered) expect(visibleWidth(line)).toBe(width);
				f.press(SAVE);
				for (const line of f.editor.render(width)) expect(visibleWidth(line)).toBe(width);
			}
		}
		const small = fixture({}, 6);
		small.press(END);
		expect(small.selectedLine()).toContain("seat 2");
		small.press(HOME);
		expect(small.selectedLine()).toContain("Budget");
	});

	it("shows a save error in place of the hints when too short for the details line", () => {
		const f = fixture({ initial: { roles: { code: "gone/x" } } }, 3);
		f.press(SAVE);
		expect(f.lines(300).at(-1)).toContain("code: gone/x not available");
	});

	it("sanitizes role names, descriptions, and selectors", () => {
		const hostile = "evil\x1b[31m\u202e\nname";
		const f = fixture({
			catalog: [{ name: hostile, panel: false, defaultSeats: 1, description: "desc\x07\u2066" }],
			initial: { roles: { [hostile]: "bad\x1b]0;title\x07/mo\u2028del" } },
			available: ["bad\x1b]0;title\x07/mo\u2028del"],
			parentModel: "p/\x9bmodel",
		});
		f.press(DOWN);
		// The theme's own SGR codes are the only escapes left.
		for (const line of f.editor.render(200))
			expect(line.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(
				/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
			);
		const text = f.text(200);
		expect(text).toContain("evil\\u001b[31m\\u202e name");
		expect(text).toContain("desc\\u0007\\u2066");
		expect(text).toContain("mo\\u2028del bad\\u001b]0;title\\u0007");
		f.press(ENTER);
		expect(f.picks[0].title).toBe("evil\\u001b[31m\\u202e name");
	});
});

describe("validateAgentSetup", () => {
	it("returns unavailable selectors with 1-based seats, ignoring inherit", () => {
		expect(
			validateAgentSetup(
				{
					roles: {
						a: "x/1",
						b: null,
						c: "inherit",
						d: [null, "y/2", "x/1", " y/3 "],
					},
				},
				["x/1"],
			),
		).toEqual([
			{ role: "d", seat: 2, selector: "y/2" },
			{ role: "d", seat: 4, selector: "y/3" },
		]);
		expect(validateAgentSetup({ roles: { a: "z/9" } }, [])).toEqual([{ role: "a", selector: "z/9" }]);
	});
});
