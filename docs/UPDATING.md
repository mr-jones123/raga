# Install and update raga

## Install

Raga needs Node.js 22.19 or newer. Install the published CLI from npm:

```sh
npm install -g raga-cli
raga --version
```

RLM mode also needs `uv` to create its Python environment on first use.

## Update the CLI

Exit the current session, then run these commands in your terminal:

```sh
raga update
raga --version
```

`raga update` checks the npm registry for the latest published `raga-cli` version and updates the installed CLI with its detected package manager. It reports when you are already up to date. Start a new raga process to use the new version. This is a terminal command, not an interactive `/update` slash command.

Updating the CLI does not delete your settings, logins, sessions, or local model weights. Raga's user data lives separately under `~/.raga/agent` (or `RAGA_CODING_AGENT_DIR`). If a release migrates stored data, read its release notes and back up the data first.

If an older CLI cannot update itself, use the direct npm command:

```sh
npm install -g raga-cli@latest
raga --version
```

Use the same Node installation and package manager you used to install raga. If your installation is managed by a different package manager, update through that manager instead. Do not add `sudo` to work around an unexpected npm permission error; check the installation prefix and active Node environment first.

## Other update targets

| Command | What changes |
|---|---|
| `raga update` or `raga update --self` | The CLI only |
| `raga update --force` | Reinstall the latest published CLI even if already current |
| `raga update --extensions` | Installed extension packages only |
| `raga update <source>` | One installed extension package |
| `raga update --models` | Provider model catalogs, not local model weights |
| `raga update --all` | The CLI and installed extension packages |
| `raga update --help` | Options and exact usage |

## Source checkouts

An npm update does not update a Git checkout. For a source installation, first commit or otherwise protect your local changes, then update and rebuild the checkout:

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run build
./raga --version
```

`./raga-test.sh` runs directly from source instead of using the bundled build.

## Release availability

The CLI updater reads npm, not GitHub tags. After CI passes, the release workflow creates the GitHub release and then builds and publishes `raga-cli` through npm trusted publishing. A GitHub release can appear before npm publication finishes. If publishing fails, the new version will not be available to `raga update` until publication succeeds.

Compare `raga --version` with `npm view raga-cli version` and check the [CI logs](https://github.com/mr-jones123/raga/actions/workflows/ci.yml) when diagnosing a missing update. Maintainers configure publishing as described in [RELEASING.md](RELEASING.md).
