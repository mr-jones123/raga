import { stripVTControlCharacters } from "node:util";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { GitDiffClient, GitDiffCommit, GitDiffFile, GitDiffSource } from "../src/extensions/diff/git.ts";
import { DiffDashboard } from "../src/extensions/diff/ui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const enter = "\r";
const esc = "\x1b";
const end = "\x1b[F";
const home = "\x1b[H";
const files: GitDiffFile[] = [
	{ path: "test/a.test.ts", status: "M" },
	{ path: ".github/workflows/ci.yml", status: "A" },
	{ path: "src/main.ts", oldPath: "src/old.ts", status: "R" },
];
const commit: GitDiffCommit = {
	hash: "a".repeat(40),
	shortHash: "aaaaaaa",
	subject: "Change widget",
	author: "Author",
	date: "2026-01-01",
};
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

function fixture(bindings = new KeybindingsManager()) {
	const client = {
		root: vi.fn(async () => "/repo"),
		files: vi.fn(async (_source: GitDiffSource) => files),
		commits: vi.fn(async (_limit: number, _skip: number) => [commit]),
		diff: vi.fn(async (_file: GitDiffFile, _source: GitDiffSource) => "@@ -1 +1 @@\n-old\n+new"),
		file: vi.fn(async (_file: GitDiffFile, _source: GitDiffSource) => "full source"),
	};
	const tui = { terminal: { rows: 18 }, requestRender: vi.fn() };
	const done = vi.fn();
	const ui = new DiffDashboard(client as unknown as GitDiffClient, tui as unknown as TUI, theme, bindings, done);
	const text = (width = 120) => ui.render(width).map(stripVTControlCharacters).join("\n");
	return { client, tui, done, ui, text };
}

beforeEach(() => initTheme("dark"));

describe("DiffDashboard", () => {
	it("navigates categories, changed files, source tabs, and back stack", async () => {
		const { ui, text, client, done } = fixture();
		await ui.start();
		expect(text()).toContain("● Tests");
		expect(text()).toContain("GitHub workflows 1");
		ui.handleInput("\t");
		ui.handleInput(enter);
		expect(text()).toContain("ci.yml");
		ui.handleInput(esc);
		ui.handleInput("\t");
		ui.handleInput(enter);
		expect(text()).toContain("src/old.ts → src/main.ts");
		ui.handleInput("s");
		await flush();
		expect(client.files).toHaveBeenLastCalledWith({ kind: "staged" });
		expect(text()).toContain("STAGED");
		ui.handleInput("w");
		await flush();
		expect(text()).toContain("WORKING TREE");
		ui.handleInput(esc);
		expect(done).toHaveBeenCalledOnce();
	});

	it("opens patches and toggles full source without writing", async () => {
		const { ui, text, client } = fixture();
		await ui.start();
		ui.handleInput(enter);
		ui.handleInput(enter);
		await flush();
		expect(text()).toContain("+new");
		ui.handleInput("o");
		await flush();
		expect(text()).toContain(" FILE ");
		expect(text()).toContain("full source");
		expect(client.file).toHaveBeenCalledWith(files[0], { kind: "working" });
		ui.handleInput("o");
		await flush();
		expect(text()).toContain(" DIFF ");
		ui.handleInput(esc);
		expect(text()).toContain("o file");
	});

	it("paginates older commits and selects a commit's changes", async () => {
		const { ui, text, client } = fixture();
		client.commits.mockImplementation(async (_limit, skip) =>
			skip === 0
				? Array.from({ length: 100 }, () => commit)
				: [{ ...commit, hash: "b".repeat(40), subject: "Older change" }],
		);
		await ui.start();
		ui.handleInput("c");
		await flush();
		ui.handleInput(end);
		expect(text()).toContain("Older commits");
		ui.handleInput(enter);
		await flush();
		expect(client.commits).toHaveBeenLastCalledWith(100, 100);
		expect(text()).toContain("Older change");
		ui.handleInput(enter);
		await flush();
		expect(client.files).toHaveBeenLastCalledWith({ kind: "commit", commit: "b".repeat(40) });
		expect(text()).toContain("Older change");
		ui.handleInput(esc);
		expect(text()).toContain("HISTORY");
	});

	it("bounds vertical and horizontal scrolling and clips tiny terminals", async () => {
		const { ui, text, client, tui } = fixture();
		client.diff.mockResolvedValue(
			Array.from({ length: 80 }, (_, i) => `+line${i} ${"界".repeat(80)} tail`).join("\n"),
		);
		await ui.start();
		ui.handleInput(enter);
		ui.handleInput(enter);
		await flush();
		ui.handleInput("\x1b[6~");
		expect(text()).not.toContain("+line0 ");
		ui.handleInput(end);
		expect(text()).toContain("+line79");
		ui.handleInput(home);
		ui.handleInput("\x1b[C");
		expect(text()).toContain("col 9");
		for (const rows of [1, 2, 5, 18]) {
			tui.terminal.rows = rows;
			for (const width of [0, 1, 2, 5, 20, 90]) {
				const lines = ui.render(width);
				expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows));
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("discards stale source results and suppresses completion after close", async () => {
		const { ui, client, text, tui, done } = fixture();
		let resolve: (value: GitDiffFile[]) => void = () => {};
		client.files.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const start = ui.start();
		await flush();
		ui.handleInput("s");
		await flush();
		resolve([{ path: "stale", status: "M" }]);
		await start;
		expect(text()).not.toContain("stale");
		expect(text()).toContain("STAGED");
		client.files.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		ui.handleInput("r");
		ui.handleInput(esc);
		const renders = tui.requestRender.mock.calls.length;
		resolve(files);
		await flush();
		expect(done).toHaveBeenCalledOnce();
		expect(tui.requestRender).toHaveBeenCalledTimes(renders);
	});

	it("cancels a pending viewer without stale renders", async () => {
		const { ui, client, text, tui } = fixture();
		let resolve: (value: string) => void = () => {};
		client.diff.mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		await ui.start();
		ui.handleInput(enter);
		ui.handleInput(enter);
		ui.handleInput(esc);
		const renders = tui.requestRender.mock.calls.length;
		resolve("late patch");
		await flush();
		expect(text()).toContain("o file");
		expect(text()).not.toContain("late patch");
		expect(tui.requestRender).toHaveBeenCalledTimes(renders);
	});

	it("neutralizes control sequences in paths, metadata, patches, and errors", async () => {
		const { ui, client, text } = fixture();
		const attack = "\x1b]52;c;secret\x07\x1b[2J\r\u009b31m";
		client.files.mockResolvedValue([{ path: `src/${attack}.ts`, status: "M" }]);
		client.diff.mockResolvedValue(`+${attack}\n@@ header`);
		client.commits.mockResolvedValue([{ ...commit, subject: attack }]);
		await ui.start();
		ui.handleInput(enter);
		expect(text()).toContain("\\u001b");
		ui.handleInput(enter);
		await flush();
		expect(text()).toContain("\\u0007");
		expect(text()).not.toContain("\x1b");
		ui.handleInput("c");
		await flush();
		expect(text()).not.toContain("\x1b");
		client.commits.mockRejectedValue(new Error(attack));
		ui.handleInput("r");
		await flush();
		expect(text()).toContain("✗");
		expect(text()).not.toContain("\x1b");
	});

	it("changes category in the viewer and renders empty, binary, and failed previews", async () => {
		const { ui, client, text } = fixture();
		await ui.start();
		ui.handleInput(enter);
		ui.handleInput(enter);
		await flush();
		client.diff.mockResolvedValueOnce("Binary file (preview unavailable).");
		ui.handleInput("\t");
		await flush();
		expect(client.diff).toHaveBeenLastCalledWith(files[1], { kind: "working" });
		expect(text()).toContain("Binary file");
		client.diff.mockResolvedValueOnce("");
		ui.handleInput("r");
		await flush();
		expect(text()).toContain(" DIFF ");
		client.diff.mockRejectedValueOnce(new Error("Deleted file has no source"));
		ui.handleInput("r");
		await flush();
		expect(text()).toContain("Deleted file has no source");
		client.diff.mockResolvedValueOnce("+restored");
		ui.handleInput("r");
		await flush();
		const dark = ui.render(120);
		initTheme("light");
		ui.invalidate();
		expect(ui.render(120)).not.toEqual(dark);
		expect(text()).toContain("+restored");
	});

	it("uses configured bindings and recovers from Git errors", async () => {
		const { ui, client, text } = fixture(new KeybindingsManager({ "app.diff.staged": "x", "tui.select.down": "j" }));
		client.root.mockRejectedValueOnce(new Error("Not a repository"));
		await ui.start();
		expect(text()).toContain("Not a repository");
		ui.handleInput("s");
		expect(client.files).not.toHaveBeenCalled();
		ui.handleInput("x");
		await flush();
		expect(text()).toContain("STAGED");
		ui.handleInput("j");
		ui.handleInput(enter);
		expect(text()).toContain("ci.yml");
		ui.invalidate();
		expect(text()).toContain("ci.yml");
	});
	it("keeps navigation hints above application chrome at standard sizes", async () => {
		const { ui, tui, text } = fixture();
		await ui.start();
		for (const rows of [24, 32]) {
			tui.terminal.rows = rows;
			expect(ui.render(80)).toHaveLength(rows);
			expect(text(80)).toContain("escape back");
			expect(text(80)).toContain("enter open");
		}
	});

	it("scrolls large line sets without argument limits or losing the final line", async () => {
		const { ui, client, text } = fixture();
		client.diff.mockResolvedValue(Array.from({ length: 150000 }, (_, index) => `+line ${index}`).join("\n"));
		await ui.start();
		ui.handleInput(enter);
		ui.handleInput(enter);
		await flush();
		ui.handleInput(end);
		expect(text()).toContain("+line 149999");
		ui.handleInput("\x1b[C");
		expect(text()).toContain("col 9");
	});
	it("colors categories, status badges, selection, and diff lines from the active theme", async () => {
		const { ui } = fixture();
		await ui.start();
		const list = ui.render(120).join("\n");
		expect(list).toContain(theme.getBgAnsi("selectedBg"));
		expect(list).toContain(theme.getFgAnsi("success"));
		ui.handleInput(enter);
		ui.handleInput(enter);
		await flush();
		const patch = ui.render(120).join("\n");
		expect(patch).toContain(theme.getBgAnsi("toolSuccessBg"));
		expect(patch).toContain(theme.getBgAnsi("toolErrorBg"));
		expect(patch).toContain(theme.getFgAnsi("syntaxKeyword"));
	});
	it("scrolls three lines per arrow key and wheel notch, and toggles a fullscreen viewer", async () => {
		const { ui, client, text } = fixture();
		client.diff.mockResolvedValue(Array.from({ length: 100 }, (_, i) => `+row${i}`).join("\n"));
		await ui.start();
		ui.handleInput(enter);
		ui.handleInput(enter);
		await flush();
		ui.handleInput("\x1b[B");
		expect(text()).toContain("ln 4/100");
		ui.handleMouse({
			type: "wheel",
			button: "none",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 120,
			height: 18,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 2,
		});
		expect(text()).toContain("ln 10/100");
		expect(text()).toContain("● Tests".slice(2)); // tabs visible before fullscreen
		ui.handleInput("f");
		const full = ui.render(120);
		expect(full).toHaveLength(18);
		expect(full.join("\n")).not.toContain("WORKING TREE");
		expect(full.filter((line) => line.includes("+row"))).toHaveLength(16);
		ui.handleInput("f");
		expect(text()).toContain("WORKING TREE");
	});

	it("pads every row to the full width so the overlay hides the transcript and footer", async () => {
		const { ui } = fixture();
		await ui.start();
		for (const line of ui.render(70)) expect(visibleWidth(line)).toBe(70);
	});
});
