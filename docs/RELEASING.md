# How to version and release raga

Raga uses [semantic-release](https://github.com/semantic-release/semantic-release) in GitHub Actions. Releases use `raga-vX.Y.Z` tags, continuing the existing version line. Pi's `vX.Y.Z` tags, package versions, and `packages/*/CHANGELOG.md` files remain upstream-owned.

## Automatic releases

Push conventional commits to `main`. After both CI jobs pass, the release job:

1. Finds the latest reachable `raga-v*` release tag and analyzes subsequent commits.
2. Chooses the next version and generates release notes.
3. Updates the root `CHANGELOG.md` and commits only that file as `chore(release): raga vX.Y.Z [skip ci]`.
4. Pushes the release commit and the `raga-vX.Y.Z` tag.
5. Creates a GitHub Release with the generated notes.
6. Builds and packs the tagged release, then publishes `raga-cli` to npm with provenance through npm trusted publishing. Already-published versions are skipped; pushes that create no release skip npm publication.

Configuration lives in `release.config.mjs`; the job lives in `.github/workflows/ci.yml`. The job runs only for pushes to the raga repository's `main` branch, never for pull requests. It uses the built-in `GITHUB_TOKEN` with `contents: write` for GitHub and `id-token: write` for npm trusted publishing; no npm token is needed. If branch or tag rules prevent the bot from pushing, repository administrators must explicitly allow the release bot under those rules. Do not disable protections globally.

The local `post-commit` release hook has been removed. Local commits no longer create release commits or tags. Run `npx husky` once per clone to enable the remaining commit validation hooks.

## Commit messages and version bumps

| Commit | Bump |
|---|---|
| `fix: repair authentication` | Patch |
| `perf: reduce startup time` | Patch |
| `feat: add a command` | Minor |
| `feat!: change the command API` | Major |
| Any commit with a `BREAKING CHANGE: ...` footer | Major |
| `docs`, `chore`, `refactor`, `test`, `build`, `ci`, `style` without breaking changes | No release |

The largest bump across the unreleased commits wins. Breaking changes bump the major version even below 1.0. These are semantic-release's standard rules, replacing the former patch-on-every-commit behavior. Use a breaking-change footer to explain migration steps.

Land raga work by rebase or squash, with a conventional final commit message. Upstream pi merges remain merge commits. Unlike the old script, semantic-release analyzes all commits since the last release, including newly merged upstream commits; those can contribute to the bump and notes.

Write commit messages for readers of the changelog. Never edit generated changelogs by hand. The existing changelog history is retained; new sections use semantic-release's format.

## Inspect and troubleshoot

- Tags: <https://github.com/mr-jones123/raga/tags>
- Releases: <https://github.com/mr-jones123/raga/releases>
- CI and release logs: <https://github.com/mr-jones123/raga/actions/workflows/ci.yml>

A docs/chore-only push passing CI without a new release is expected. A failed check prevents release. If publishing fails after a tag has been pushed, inspect the release logs and repository state before retrying; do not delete published tags to force a retry.

For an authenticated preview from a clean checkout of `main`:

```sh
npx --no-install semantic-release --dry-run
```

A dry run does not write the changelog, create commits or tags, or publish a release, but still verifies remote access and requires GitHub authentication. Do not run a real release locally; let CI own publishing.

To read the version locally:

```sh
git fetch origin --tags
node scripts/raga-release.mjs version
```

Between releases the output looks like `0.8.0+3.g1a2b3c4`. Both older annotated tags and semantic-release's lightweight tags are supported. The script also retains `lint-msg` for the commit-message hook; it no longer creates releases.

## Publish to npm

Raga is published as `raga-cli`, which installs the `raga` command. It bundles `packages/coding-agent` and raga's copies of the pi packages. Publishing does not change upstream workspace versions. Users install with `npm install -g raga-cli` and update with `raga update`; see [UPDATING.md](UPDATING.md).

### One-time npm trusted publisher setup

On npmjs.com, open **raga-cli → Settings → Trusted Publisher**, choose **GitHub Actions**, and enter:

| Field | Value |
|---|---|
| Organization or user | `mr-jones123` |
| Repository | `raga` |
| Workflow filename | `ci.yml` (not `.github/workflows/ci.yml`) |
| Environment name | Leave empty; the release job does not declare an environment |

You must have permission to manage the npm package. If it has never been published, publish its first version manually before configuring the trusted publisher. The package and GitHub repository must be public for provenance.

The release job uses a GitHub-hosted Ubuntu runner and Node 24, which supplies npm with trusted publishing support. npm requires at least npm 11.5.1 and Node 22.14.0 for this authentication method. `scripts/raga-publish.mjs` verifies the npm version before building and publishing. Do not configure `NPM_TOKEN` or `NODE_AUTH_TOKEN` for this job; GitHub's short-lived OIDC identity supplies authentication.

Save this configuration before the first publishing run. npm does not validate the settings when you save them; a filename or repository mismatch will fail at publication. See [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

### Publication and recovery

After semantic-release completes, `scripts/raga-publish.mjs` requires an exact `raga-vX.Y.Z` tag at `HEAD`. It checks whether that version is already on npm, runs `scripts/raga-pack.mjs`, and publishes the resulting tarball with `--access public --provenance --ignore-scripts`. Registry failures other than a missing version fail the job rather than being treated as permission to publish.

If npm publication fails after GitHub release creation, the GitHub release remains published. Fix the trusted publisher configuration first. Do not delete the tag, reuse an npm version, or assume semantic-release will recreate an existing release on a retry. To recover, publish the existing tagged version manually from a clean checkout using an npm account authorized to publish:

1. Fetch the new release tag and check it out in a clean checkout. Use the tag, not an unreleased commit. Install dependencies with `npm ci --ignore-scripts`.
2. Build and pack:

   ```sh
   node scripts/raga-pack.mjs
   ```

   This runs `npm run build`, stages the package in `packages/coding-agent/dist/raga-cli/`, and writes `packages/coding-agent/dist/raga-cli-X.Y.Z.tgz`. Use `--skip-build` to reuse a build, or `--allow-unreleased` only for a local installation test.
3. Publish the tarball:

   ```sh
   npm login
   npm publish packages/coding-agent/dist/raga-cli-X.Y.Z.tgz --access public --ignore-scripts
   ```

A published npm version cannot be reused.

## Merge upstream pi

Merge upstream with a merge commit; do not rebase onto upstream:

```sh
git fetch upstream --tags
git merge upstream/main
```

Keep the `upstream` remote pointed at pi, not raga. Upstream `v*` tags do not match the release tag format and cannot reset raga's version.
