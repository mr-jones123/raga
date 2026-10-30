import {
	type Component,
	sliceByColumn,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import {
	getLanguageFromPath,
	highlightCode,
	type Theme,
	type ThemeColor,
} from "../../modes/interactive/theme/theme.ts";
import { groupDiffFiles } from "./categories.ts";
import type { GitDiffClient, GitDiffCommit, GitDiffFile, GitDiffSource } from "./git.ts";

// Never pass repository-controlled terminal sequences through to the renderer.
function safe(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (char) =>
		char === "\t" ? "    " : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

type Screen = "categories" | "files" | "viewer" | "commits";
const COMMIT_PAGE = 100;
/** Lines moved per arrow key or wheel notch in the viewer. */
const SCROLL_STEP = 3;

/** Read-only, bounded dashboard. Custom layout keeps categories and files visible beside the viewport. */
export class DiffDashboard implements Component {
	private client: GitDiffClient;
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private done: () => void;
	private source: GitDiffSource;
	private screen: Screen = "categories";
	private groups: ReturnType<typeof groupDiffFiles> = [];
	private category = 0;
	private selectedFile = 0;
	private commits: GitDiffCommit[] = [];
	private selectedCommit = 0;
	private commitSkip = 0;
	private moreCommits = false;
	private fromCommits = false;
	private fullSource = false;
	private text: string[] = [];
	private top = 0;
	private left = 0;
	private maxLeft = 0;
	private zoomed = false;
	private rootPath = "";
	private error = "";
	private loading = false;
	private generation = 0;
	private closed = false;

	constructor(
		client: GitDiffClient,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: () => void,
		source: GitDiffSource = { kind: "working" },
	) {
		this.client = client;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.source = source;
	}

	public async start(): Promise<void> {
		await this.loadFiles(true);
	}

	invalidate(): void {
		this.highlighted = undefined;
		// Styling is calculated during render, never stored in repository state.
	}

	private changed(): void {
		if (!this.closed) this.tui.requestRender();
	}

	private async request(work: () => Promise<() => void>): Promise<void> {
		if (this.closed) return;
		const generation = ++this.generation;
		this.loading = true;
		this.error = "";
		this.changed();
		try {
			const apply = await work();
			if (this.closed || generation !== this.generation) return;
			apply();
		} catch (error) {
			if (this.closed || generation !== this.generation) return;
			this.error = safe(error instanceof Error ? error.message : String(error));
		} finally {
			if (!this.closed && generation === this.generation) {
				this.loading = false;
				this.changed();
			}
		}
	}

	private async loadFiles(resolveRoot = false): Promise<void> {
		const source = this.source;
		await this.request(async () => {
			const root = resolveRoot || !this.rootPath ? await this.client.root() : this.rootPath;
			const files = await this.client.files(source);
			return () => {
				this.rootPath = root;
				this.groups = groupDiffFiles(files);
				this.category = 0;
				this.selectedFile = 0;
			};
		});
	}

	private async loadCommits(skip: number): Promise<void> {
		this.screen = "commits";
		await this.request(async () => {
			const commits = await this.client.commits(COMMIT_PAGE, skip);
			return () => {
				this.commits = commits;
				this.commitSkip = skip;
				this.selectedCommit = 0;
				this.moreCommits = commits.length === COMMIT_PAGE;
			};
		});
	}

	private files(): GitDiffFile[] {
		return this.groups[this.category]?.files ?? [];
	}

	private async loadText(): Promise<void> {
		const file = this.files()[this.selectedFile];
		if (!file) return;
		this.screen = "viewer";
		this.top = 0;
		this.left = 0;
		this.text = [];
		this.maxLeft = 0;
		const source = this.source;
		const fullSource = this.fullSource;
		await this.request(async () => {
			const text = fullSource ? await this.client.file(file, source) : await this.client.diff(file, source);
			return () => {
				this.text = text ? text.split("\n").map(safe) : [];
				this.highlighted = undefined;
				this.maxLeft = this.text.reduce((max, line) => Math.max(max, visibleWidth(line) - 1), 0);
			};
		});
	}

	/** The dashboard is a full-terminal overlay, covering the editor and application footer. */
	private height(): number {
		return Math.max(1, this.tui.terminal.rows);
	}

	private bodyHeight(): number {
		return Math.max(1, this.height() - (this.screen === "viewer" && this.zoomed ? 2 : 6));
	}

	private scrollTo(top: number): void {
		this.top = Math.max(0, Math.min(Math.max(0, this.text.length - this.bodyHeight()), top));
	}

	private moveSelection(delta: number, jump?: "start" | "end"): void {
		const count =
			this.screen === "categories"
				? this.groups.length
				: this.screen === "files"
					? this.files().length
					: this.commits.length + Number(this.moreCommits) + Number(this.commitSkip > 0);
		const current =
			this.screen === "categories"
				? this.category
				: this.screen === "files"
					? this.selectedFile
					: this.selectedCommit;
		const next = Math.max(
			0,
			Math.min(count - 1, jump === "start" ? 0 : jump === "end" ? count - 1 : current + delta),
		);
		if (this.screen === "categories") {
			if (next !== this.category) this.selectedFile = 0;
			this.category = next;
		} else if (this.screen === "files") this.selectedFile = next;
		else this.selectedCommit = next;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || event.type !== "wheel" || !event.wheelDelta) return undefined;
		if (this.screen === "viewer") {
			if (event.shift) this.left = Math.max(0, Math.min(this.maxLeft, this.left + event.wheelDelta * 8));
			else this.scrollTo(this.top + event.wheelDelta * SCROLL_STEP);
		} else {
			this.moveSelection(event.wheelDelta);
		}
		this.changed();
		return { handled: true };
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			++this.generation;
			this.loading = false;
			this.error = "";
			if (this.screen === "viewer") this.screen = "files";
			else if (this.screen === "files") this.screen = "categories";
			else if (this.screen === "categories" && this.fromCommits) {
				this.fromCommits = false;
				this.screen = "commits";
			} else {
				this.closed = true;
				this.done();
				return;
			}
		} else if (kb.matches(data, "app.diff.working") || kb.matches(data, "app.diff.staged")) {
			this.source = { kind: kb.matches(data, "app.diff.staged") ? "staged" : "working" };
			this.screen = "categories";
			this.fromCommits = false;
			this.groups = [];
			void this.loadFiles();
		} else if (kb.matches(data, "app.diff.commits")) {
			void this.loadCommits(0);
		} else if (kb.matches(data, "app.diff.refresh")) {
			if (this.screen === "commits") void this.loadCommits(this.commitSkip);
			else if (this.screen === "viewer") void this.loadText();
			else void this.loadFiles();
		} else if (kb.matches(data, "app.diff.nextCategory") || kb.matches(data, "app.diff.previousCategory")) {
			if (this.screen === "commits" || !this.groups.length) return;
			this.category =
				(this.category + (kb.matches(data, "app.diff.nextCategory") ? 1 : this.groups.length - 1)) %
				this.groups.length;
			this.selectedFile = 0;
			if (this.screen === "viewer") void this.loadText();
		} else if (kb.matches(data, "app.diff.zoom")) {
			if (this.screen !== "viewer") return;
			this.zoomed = !this.zoomed;
			this.scrollTo(this.top);
		} else if (kb.matches(data, "app.diff.file")) {
			if (this.screen !== "viewer" && this.screen !== "files") return;
			this.fullSource = !this.fullSource;
			void this.loadText();
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (this.loading) return;
			if (this.screen === "categories" && this.groups.length) this.screen = "files";
			else if (this.screen === "files") {
				this.fullSource = false;
				void this.loadText();
			} else if (this.screen === "commits") {
				if (this.selectedCommit === this.commits.length && this.moreCommits)
					void this.loadCommits(this.commitSkip + COMMIT_PAGE);
				else if (this.selectedCommit === this.commits.length + Number(this.moreCommits) && this.commitSkip > 0)
					void this.loadCommits(Math.max(0, this.commitSkip - COMMIT_PAGE));
				else {
					const commit = this.commits[this.selectedCommit];
					if (!commit) return;
					this.source = { kind: "commit", commit: commit.hash };
					this.fromCommits = true;
					this.screen = "categories";
					this.groups = [];
					void this.loadFiles();
				}
			}
		} else {
			const page = this.bodyHeight();
			const step = this.screen === "viewer" ? SCROLL_STEP : 1;
			const delta = kb.matches(data, "tui.select.up")
				? -step
				: kb.matches(data, "tui.select.down")
					? step
					: kb.matches(data, "tui.select.pageUp")
						? -page
						: kb.matches(data, "tui.select.pageDown")
							? page
							: 0;
			const start = kb.matches(data, "app.diff.start");
			const end = kb.matches(data, "app.diff.end");
			if (this.screen === "viewer") {
				this.scrollTo(start ? 0 : end ? this.text.length : this.top + delta);
				if (kb.matches(data, "app.diff.left")) this.left = Math.max(0, this.left - 8);
				if (kb.matches(data, "app.diff.right")) this.left = Math.min(this.maxLeft, this.left + 8);
			} else {
				this.moveSelection(delta, start ? "start" : end ? "end" : undefined);
			}
		}
		this.changed();
	}

	private highlighted: string[] | undefined;

	private sourceLines(): string[] {
		if (this.highlighted) return this.highlighted;
		const file = this.files()[this.selectedFile];
		const language = file ? getLanguageFromPath(file.path) : undefined;
		// Highlighting is a convenience; very large files stay plain to keep the dashboard responsive.
		const size = this.text.reduce((sum, line) => sum + line.length + 1, 0);
		let lines = this.text;
		if (language && size <= 200_000) {
			try {
				const result = highlightCode(this.text.join("\n"), language);
				if (result.length === this.text.length) lines = result;
			} catch {
				// Fall back to plain source.
			}
		}
		this.highlighted = lines;
		return lines;
	}

	private pad(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, "");
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	}

	private categoryColor(name: string): ThemeColor {
		const colors: Record<string, ThemeColor> = {
			Tests: "success",
			"GitHub workflows": "mdLink",
			Modules: "accent",
			Documentation: "mdHeading",
			Dependencies: "warning",
			Configuration: "syntaxType",
		};
		return colors[name] ?? "muted";
	}

	private statusBadge(file: GitDiffFile): string {
		const code = file.untracked ? "?" : (file.status[0] ?? "?");
		const color: ThemeColor =
			code === "A" || code === "?"
				? "success"
				: code === "D"
					? "error"
					: code === "R" || code === "C"
						? "mdLink"
						: code === "M"
							? "warning"
							: "muted";
		return this.theme.style(` ${code} `, { fg: color, bold: true });
	}

	private pathLabel(file: GitDiffFile, selected: boolean, compact = false): string {
		const t = this.theme;
		const split = (path: string) => {
			const index = path.lastIndexOf("/");
			return index < 0 ? ["", path] : [path.slice(0, index + 1), path.slice(index + 1)];
		};
		const [dir, base] = split(safe(file.path));
		let label = `${t.fg("dim", dir)}${t.style(base, { fg: selected ? "accent" : "text", bold: true })}`;
		if (file.oldPath) label = `${t.fg("dim", safe(file.oldPath))} ${t.fg("mdLink", "→")} ${label}`;
		if (file.untracked && !compact) label += t.fg("muted", " untracked");
		return label;
	}

	private row(content: string, selected: boolean, width: number): string {
		const t = this.theme;
		const line = `${selected ? t.fg("accent", "▌") : " "} ${content}`;
		return selected ? t.bg("selectedBg", this.pad(line, width)) : truncateToWidth(line, width, "");
	}

	private diffLine(line: string, slice: string, width: number): string {
		const t = this.theme;
		if (line.startsWith("+++") || line.startsWith("---"))
			return t.style(this.pad(slice, width), { fg: "mdHeading", bold: true });
		if (line.startsWith("+")) return t.style(this.pad(slice, width), { fg: "toolDiffAdded", bg: "toolSuccessBg" });
		if (line.startsWith("-")) return t.style(this.pad(slice, width), { fg: "toolDiffRemoved", bg: "toolErrorBg" });
		if (line.startsWith("@@")) {
			const end = slice.indexOf("@@", 2);
			return end < 0
				? t.fg("syntaxKeyword", slice)
				: `${t.style(slice.slice(0, end + 2), { fg: "syntaxKeyword", bold: true })}${t.fg("syntaxFunction", slice.slice(end + 2))}`;
		}
		if (/^(?:diff --git|index |new file|deleted file|similarity|rename |old mode|new mode)/.test(line))
			return t.fg("dim", slice);
		if (line.startsWith("\\")) return t.fg("warning", slice);
		if (/^Binary files? /.test(line)) return t.fg("warning", slice);
		return t.fg("toolDiffContext", slice);
	}

	private viewerBody(width: number, bodyHeight: number): string[] {
		const t = this.theme;
		const sidebar = !this.zoomed && width >= 90 ? Math.min(34, Math.floor(width / 3)) : 0;
		const content = Math.max(0, width - (sidebar ? sidebar + 1 : 0));
		const files = this.files();
		const firstFile = Math.max(
			0,
			Math.min(this.selectedFile - Math.floor(bodyHeight / 2), files.length - bodyHeight),
		);
		const gutter = this.fullSource ? String(this.text.length).length : 0;
		const source = this.fullSource ? this.sourceLines() : undefined;
		const lines: string[] = [];
		for (let index = 0; index < bodyHeight; index++) {
			const number = this.top + index;
			const raw = this.text[number];
			let view = "";
			if (raw !== undefined) {
				if (this.fullSource && source) {
					const prefix = `${t.fg("dim", String(number + 1).padStart(gutter))} ${t.fg("borderMuted", "│")} `;
					view = prefix + sliceByColumn(source[number] ?? raw, this.left, Math.max(0, content - gutter - 3));
				} else {
					view = this.diffLine(raw, sliceByColumn(raw, this.left, content), content);
				}
			} else if (index === 0) {
				view = t.fg("muted", "No content (empty, deleted, or binary file).");
			}
			view = truncateToWidth(view, content, "");
			if (!sidebar) {
				lines.push(view);
				continue;
			}
			const entry = files[firstFile + index];
			const selected = firstFile + index === this.selectedFile;
			const label = entry
				? this.row(`${this.statusBadge(entry)} ${this.pathLabel(entry, selected, true)}`, selected, sidebar)
				: "";
			lines.push(`${this.pad(label, sidebar)}${t.fg("borderMuted", "│")}${view}`);
		}
		return lines;
	}

	private listBody(width: number, bodyHeight: number): string[] {
		const t = this.theme;
		let rows: string[] = [];
		let selected = 0;
		if (this.screen === "commits") {
			const hashWidth = Math.max(7, ...this.commits.slice(0, 1).map((entry) => entry.shortHash.length));
			rows = this.commits.map(
				(entry) =>
					`${t.style(safe(entry.shortHash).padEnd(hashWidth), { fg: "warning", bold: true })} ${t.fg("text", safe(entry.subject))} ${t.fg("syntaxFunction", safe(entry.author))} ${t.fg("dim", safe(entry.date.slice(0, 10)))}`,
			);
			if (this.moreCommits) rows.push(t.fg("mdLink", "Older commits →"));
			if (this.commitSkip > 0) rows.push(t.fg("mdLink", "← Newer commits"));
			selected = this.selectedCommit;
		} else if (this.screen === "categories") {
			const total = this.groups.reduce((sum, group) => sum + group.files.length, 0) || 1;
			rows = this.groups.map((group) => {
				const color = this.categoryColor(group.name);
				const bar = "█".repeat(Math.max(1, Math.round((group.files.length / total) * 20)));
				return `${t.fg(color, "●")} ${t.style(safe(group.name).padEnd(18), { fg: color, bold: true })} ${t.fg("muted", String(group.files.length).padStart(4))}  ${t.fg(color, bar)}`;
			});
			selected = this.category;
		} else {
			rows = this.files().map(
				(entry, index) => `${this.statusBadge(entry)} ${this.pathLabel(entry, index === this.selectedFile)}`,
			);
			selected = this.selectedFile;
		}
		if (!rows.length) return [t.fg("muted", this.screen === "commits" ? "  No commits." : "  No changed files. ✓")];
		const first = Math.max(0, Math.min(selected - Math.floor(bodyHeight / 2), rows.length - bodyHeight));
		return rows
			.slice(first, first + bodyHeight)
			.map((row, index) => this.row(row, first + index === selected, width));
	}

	render(width: number): string[] {
		width = Math.max(0, width);
		if (width === 0) return Array.from({ length: this.height() }, () => "");
		const t = this.theme;
		const height = this.height();
		const source = this.source;
		const commit = source.kind === "commit" ? this.commits.find((entry) => entry.hash === source.commit) : undefined;
		const badge =
			this.screen === "commits"
				? t.style(" HISTORY ", { fg: "mdLink", bg: "selectedBg", bold: true })
				: source.kind === "working"
					? t.style(" WORKING TREE ", { fg: "success", bg: "selectedBg", bold: true })
					: source.kind === "staged"
						? t.style(" STAGED ", { fg: "warning", bg: "selectedBg", bold: true })
						: `${t.style(` ${source.commit.slice(0, 9)} `, { fg: "warning", bg: "selectedBg", bold: true })} ${t.fg("text", safe(commit?.subject ?? ""))}`;
		const header = `${t.style(" ◆ diff ", { fg: "accent", bold: true })}${badge} ${t.fg("dim", safe(this.rootPath))}`;

		const file = this.files()[this.selectedFile];
		const totalFiles = this.groups.reduce((sum, group) => sum + group.files.length, 0);
		let metadata: string;
		if (this.screen === "commits") {
			metadata = `${t.fg("muted", "Commits")} ${t.fg("text", `${this.commitSkip + 1}–${this.commitSkip + this.commits.length}`)} ${t.fg("dim", "· pick one to review")}`;
		} else if (this.screen === "viewer" && file) {
			const mode = this.fullSource
				? t.style(" FILE ", { fg: "mdLink", bold: true })
				: t.style(" DIFF ", { fg: "accent", bold: true });
			metadata = `${this.statusBadge(file)} ${this.pathLabel(file, true)} ${mode}${t.fg("dim", `ln ${this.top + 1}/${this.text.length}  col ${this.left + 1}`)}`;
		} else {
			metadata = `${t.style(String(totalFiles), { fg: "text", bold: true })} ${t.fg("muted", "changed files")}`;
		}

		const tabs = this.groups
			.map((group, index) => {
				const color = this.categoryColor(group.name);
				const label = ` ${safe(group.name)} ${group.files.length} `;
				return index === this.category && this.screen !== "commits"
					? t.style(label, { fg: color, bg: "selectedBg", bold: true })
					: `${t.fg(color, ` ${safe(group.name)}`)} ${t.fg("dim", `${group.files.length} `)}`;
			})
			.join(t.fg("borderMuted", "│"));

		const zoomed = this.screen === "viewer" && this.zoomed;
		const rule = t.fg("borderMuted", "─".repeat(width));
		const lines = zoomed ? [metadata] : [header, metadata, tabs, rule];
		const bodyHeight = this.bodyHeight();
		let body: string[];
		if (this.error) body = [t.style(`  ✗ ${this.error}`, { fg: "error", bold: true })];
		else if (this.loading) body = [t.fg("muted", "  ⠿ Loading…")];
		else if (this.screen === "viewer") body = this.viewerBody(width, bodyHeight);
		else body = this.listBody(width, bodyHeight);
		lines.push(...body.slice(0, bodyHeight));
		while (lines.length < height - (zoomed ? 1 : 2)) lines.push("");

		const key = (action: Keybinding) =>
			t.style(safe(this.keybindings.getKeys(action)[0] ?? "unbound"), { fg: "accent", bold: true });
		const item = (keys: string, label: string) => `${keys} ${t.fg("muted", label)}`;
		const sep = t.fg("borderMuted", " · ");
		const nav = `${key("tui.select.up")}${t.fg("dim", "/")}${key("tui.select.down")}`;
		const context =
			this.screen === "viewer"
				? [
						item(key("app.diff.zoom"), this.zoomed ? "exit fullscreen" : "fullscreen"),
						item(key("app.diff.file"), this.fullSource ? "show diff" : "show file"),
						item(nav, "scroll"),
						item(`${key("tui.select.pageUp")}${t.fg("dim", "/")}${key("tui.select.pageDown")}`, "page"),
						item(`${key("app.diff.left")}${t.fg("dim", "/")}${key("app.diff.right")}`, "pan"),
						item(key("app.diff.nextCategory"), "category"),
					]
				: this.screen === "commits"
					? [
							item(nav, "move"),
							item(key("tui.select.confirm"), "review"),
							item(`${key("app.diff.start")}${t.fg("dim", "/")}${key("app.diff.end")}`, "first/last"),
						]
					: [
							item(nav, "move"),
							item(key("tui.select.confirm"), "open"),
							item(key("app.diff.nextCategory"), "category"),
							...(this.screen === "files" ? [item(key("app.diff.file"), "file")] : []),
						];
		if (zoomed) lines.push(context.join(sep));
		else
			lines.push(
				[
					item(key("tui.select.cancel"), "back"),
					item(key("app.diff.working"), "working"),
					item(key("app.diff.staged"), "staged"),
					item(key("app.diff.commits"), "commits"),
					item(key("app.diff.refresh"), "refresh"),
				].join(sep),
				context.join(sep),
			);
		// Pad every row so the full-screen overlay hides the transcript beneath it.
		return lines.slice(0, height).map((line) => this.pad(line, width));
	}
}
