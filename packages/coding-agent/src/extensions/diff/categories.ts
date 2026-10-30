import type { GitDiffFile } from "./git.ts";

export const DIFF_CATEGORIES = [
	"Tests",
	"GitHub workflows",
	"Modules",
	"Documentation",
	"Dependencies",
	"Configuration",
	"Other",
] as const;

export function categoryForPath(path: string): (typeof DIFF_CATEGORIES)[number] {
	const normalized = path.replace(/\\/g, "/");
	if (
		/(?:^|\/)(?:tests?|__tests__|fixtures|__snapshots__)(?:\/|$)/i.test(normalized) ||
		/(?:\.(?:test|spec)\.[^/]+|_test\.[^/]+|(?:^|\/)test_[^/]+)$/.test(normalized)
	)
		return "Tests";
	if (normalized.startsWith(".github/workflows/")) return "GitHub workflows";
	if (
		/(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|(?:pnpm-lock|yarn)\.(?:yaml|lock)|bun\.lockb?|(?:requirements[^/]*\.txt)|pyproject\.toml|uv\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Gemfile(?:\.lock)?)$/.test(
			normalized,
		)
	)
		return "Dependencies";
	if (/(?:^|\/)(?:docs?|documentation)(?:\/|$)/i.test(normalized) || /\.(?:md|mdx|rst|adoc)$/i.test(normalized))
		return "Documentation";
	if (
		normalized.startsWith(".github/") ||
		normalized.startsWith(".husky/") ||
		/(?:^|\/)(?:biome\.jsonc?|Dockerfile(?:\.[^/]+)?|Makefile)$/.test(normalized) ||
		/(?:^|\/)(?:\.[^/]+|[^/]*(?:config|rc)(?:\.[^/]+)?)$/.test(normalized) ||
		/\.(?:ya?ml|toml|ini)$/i.test(normalized)
	)
		return "Configuration";
	if (
		/(?:^|\/)(?:src|lib|modules|packages|scripts|python)(?:\/|$)/.test(normalized) ||
		/\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cc|cpp|h|hpp|sh|rb|swift|kt|vue|svelte|css|scss|html)$/i.test(normalized)
	)
		return "Modules";
	return "Other";
}

export function groupDiffFiles(files: GitDiffFile[]): { name: string; files: GitDiffFile[] }[] {
	return DIFF_CATEGORIES.map((name) => ({
		name,
		files: files.filter((file) => categoryForPath(file.path) === name).sort((a, b) => a.path.localeCompare(b.path)),
	})).filter((group) => group.files.length > 0);
}
