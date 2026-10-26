### Worktree cleanup

1. Read the current instance's supervisor-owned workspace and session records. Run git worktree list --porcelain in the bound application repository. Match each path and base commit to its owner. Unknown ownership means keep it.
2. Inspect dirty files, unpushed commits, accepted revisions, active jobs, and process liveness. A stopped chat or a merged branch alone is not proof that a descendant workspace is unused.
3. Ask the supervisor to remove only its own stopped child workspace through the managed lifecycle. Never run git worktree remove --force or delete a user's unknown directory.
4. Report what was removed and what remains, with owner and reason. Destructive removal of user data needs explicit operator approval.
