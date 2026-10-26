# How to version and release raga

Raga has its own version line, separate from upstream pi. The current version is the newest annotated `raga-vX.Y.Z` tag behind `HEAD`. No file stores the version. `scripts/raga-release.mjs` reads the commits since that tag and writes the root `CHANGELOG.md` from their headers. Pi's `packages/*/CHANGELOG.md` files, the package versions, and the `vX.Y.Z` tags stay upstream's.

## Set up a clone

Run these steps once per clone.

1. Add pi as the remote `upstream`, so that the release script can tell upstream commits from raga commits. The `upstream` remote must point at pi, never at raga.

	```sh
	git remote add upstream https://github.com/badlogic/pi-mono.git
	```

	If you cloned pi itself, rename its remote instead with `git remote rename origin upstream`. To use another remote name, set `RAGA_UPSTREAM_REMOTE`.

2. Fetch pi's branches and tags. The script needs pi's `v*` tags to recognize upstream commits, and it needs raga's `raga-v*` tags for the version.

	```sh
	git fetch upstream --tags
	git fetch --tags
	```

3. Activate the git hooks. `commit-msg` checks every commit header, and `post-commit` cuts the release.

	```sh
	npx husky
	```

The fork point already has the tag `raga-v0.0.0`. In a new fork, create it with `node scripts/raga-release.mjs init --base <fork-point-commit>`.

## Write commits that become the changelog

Each commit header is one changelog entry. Write the header for a reader of the changelog.

| Header | Changelog section |
|---|---|
| `feat(kernel): keep Python variables across turns` | Added |
| `fix(repl): stop the kernel when the session ends` | Fixed |
| `perf: ...` or `revert: ...` | Changed |
| `feat(tools)!: ...` with a `BREAKING CHANGE: <migration note>` footer | Breaking Changes |
| `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style` | Not listed |

Land raga work by rebase or squash. A merge commit from a raga branch makes the release fail, because the script reads only the first-parent history.

## Every change bumps the version

The `post-commit` hook releases after every commit. The header picks the bump: `feat` raises the minor version, a breaking change raises the major version once past 1.0, and everything else, including `docs` and `chore`, raises the patch version. The hook writes the changelog entry, commits it as `chore(release): raga vX.Y.Z` with hooks skipped, and tags that commit. The generated commit does not release again.

So one change produces two commits: your change, then its release. Tags stay local until you push them. Set `RAGA_NO_AUTO_RELEASE=1` for a commit that should not release, such as an amended checkpoint. The release commit only writes `CHANGELOG.md`, so skipping its hooks does not skip checks on the change itself.

## Manual release or recovery

Run `release --dry-run` to see the plan, or `release` / `release <bump>` to recover an interrupted release or to cut one by hand. The steps below describe that path.

1. Check the commits since the last release.

	```sh
	node scripts/raga-release.mjs check
	```

	The command prints `ok` or lists every problem.

2. Preview the release.

	```sh
	node scripts/raga-release.mjs release --dry-run
	```

	The output shows the next version, the new `CHANGELOG.md` section, and the git commands the release runs.

3. Release.

	```sh
	node scripts/raga-release.mjs release
	```

	The script picks the version from the commits. To set it yourself, pass `patch`, `minor`, `major`, or an exact `X.Y.Z`. The script writes `CHANGELOG.md`, commits it as `chore(release): raga vX.Y.Z`, and creates the annotated tag `raga-vX.Y.Z`. The tag message is the release notes, so `git show raga-vX.Y.Z` prints them.

4. Push the commit and the tag. The script prints the command and never pushes.

	```sh
	git push <raga-remote> HEAD raga-vX.Y.Z
	```

Below 1.0, a breaking change or a `feat` raises the minor version, and anything else raises the patch version. From 1.0, a breaking change raises the major version and a `feat` raises the minor version.

If a release stops partway, run the same command again. The script reads the repository state and finishes the release. If the release already exists, the script does nothing.

To print the current version, run `node scripts/raga-release.mjs version`. Between releases the output looks like `0.1.0+3.g1a2b3c4`, which means three commits after `raga-v0.1.0`.

## Merge upstream pi

Merge upstream with a merge commit. Do not rebase onto upstream.

```sh
git fetch upstream --tags
git merge upstream/main
```

The release lists the merge as one line under **Upstream**, such as `Merged pi v1.5.0 (143 commits)`. Upstream's own commits are not listed. If `check` reports the merge as a stray merge, the `upstream` remote or pi's `v*` tags are missing. Restore them and run `check` again.
