import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { GitDiffClient, type GitDiffSource } from "./git.ts";
import { DiffDashboard } from "./ui.ts";

export default function diffExtension(pi: ExtensionAPI): void {
	let open = false;
	pi.registerCommand("diff", {
		description: "Review categorized working-tree, staged, and commit diffs in a read-only dashboard",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/diff requires interactive mode.", "warning");
				return;
			}
			if (open) return;
			open = true;
			try {
				const client = new GitDiffClient(ctx.cwd);
				await client.root();
				const ref = args.trim();
				let source: GitDiffSource = { kind: "working" };
				if (ref === "--staged") source = { kind: "staged" };
				else if (ref && ref !== "--working") source = { kind: "commit", commit: await client.resolveCommit(ref) };
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => {
						const view = new DiffDashboard(client, tui, theme, keybindings, done, source);
						void view.start().catch((error: unknown) => {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
							done();
						});
						return view;
					},
					{
						// Cover the whole terminal, including the editor and application footer.
						overlay: true,
						overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 },
					},
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				open = false;
			}
		},
	});
}
