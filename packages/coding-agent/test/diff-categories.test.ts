import { describe, expect, it } from "vitest";
import { categoryForPath, groupDiffFiles } from "../src/extensions/diff/categories.ts";

describe("diff dashboard categories", () => {
	it.each([
		["packages/ai/test/models.test.ts", "Tests"],
		["src/model.spec.ts", "Tests"],
		["python/tests/test_model.py", "Tests"],
		["python/test_model.py", "Tests"],
		["src/__tests__/model.ts", "Tests"],
		["test/fixtures/README.md", "Tests"],
		[".github/workflows/ci.yml", "GitHub workflows"],
		["packages/ai/src/model.ts", "Modules"],
		["scripts/check.mjs", "Modules"],
		["python/raga_rlm/core.py", "Modules"],
		["docs/design.md", "Documentation"],
		["README.md", "Documentation"],
		["package-lock.json", "Dependencies"],
		["packages/ai/package.json", "Dependencies"],
		["pnpm-lock.yaml", "Dependencies"],
		["pyproject.toml", "Dependencies"],
		[".github/dependabot.yml", "Configuration"],
		[".husky/pre-commit", "Configuration"],
		["tsconfig.json", "Configuration"],
		["biome.json", "Configuration"],
		["assets/wheel.png", "Other"],
		["packages\\ai\\test\\model.test.ts", "Tests"],
	])("classifies %s as %s", (path, category) => {
		expect(categoryForPath(path)).toBe(category);
	});

	it("groups each file once in category order and sorts paths", () => {
		const files = ["src/z.ts", ".github/workflows/ci.yml", "src/a.ts", "test/unit.test.ts", "README.md"].map(
			(path) => ({ path, status: "M" }),
		);
		const groups = groupDiffFiles(files);
		expect(groups.map((group) => group.name)).toEqual(["Tests", "GitHub workflows", "Modules", "Documentation"]);
		expect(groups.find((group) => group.name === "Modules")?.files.map((file) => file.path)).toEqual([
			"src/a.ts",
			"src/z.ts",
		]);
		expect(groups.flatMap((group) => group.files)).toHaveLength(files.length);
		expect(groupDiffFiles([])).toEqual([]);
	});
});
