# Configuration

Pi supports user-level and project configuration. User-level configuration lives in the agent directory, which defaults to `~/.pi/agent`. Project configuration lives in `.raga` under the working directory and loads after [project trust](security.md#understand-project-trust) is granted. The only exception is `sessionDir`, which Pi reads before resolving trust so it can locate sessions.

In interactive mode, use `/settings` to change common preferences. For other options, ask Pi to update the configuration or edit the relevant files directly. Run `/reload` after manually changing settings, keybindings, instructions, or resources.

## Agent directory

The agent directory is shown as `<agent-dir>` below. Set its location with the `PI_CODING_AGENT_DIR` environment variable or the SDK's [`agentDir`](sdk.md) option.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level [settings](settings.md), including preferences, defaults, resource paths, and Pi package declarations. |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md). |
| `<agent-dir>/mcp.json` | [MCP servers](mcp.md) available in every project. |
| `<agent-dir>/models.json` | [Compatible endpoints, models, and model overrides](models.md#configure-a-compatible-endpoint). |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. |
| `<agent-dir>/SYSTEM.md` | Replaces Pi’s default system prompt. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to Pi’s system prompt. |
| `<agent-dir>/extensions/` | User [extensions](extensions.md). |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md) exposed as slash commands. |
| `<agent-dir>/themes/` | User [theme](themes.md) files. |

## Project `.raga` directory

| Path | Responsibility |
|---|---|
| `.raga/settings.json` | Project-level [settings](settings.md), resource paths, and Pi package declarations. |
| `.raga/mcp.json` | Project [MCP servers](mcp.md). |
| `.raga/SYSTEM.md` | Replaces the system prompt for the project. |
| `.raga/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.raga/extensions/` | Project extensions. |
| `.raga/skills/` | Project skills and supporting files. |
| `.raga/prompts/` | Project prompt templates exposed as slash commands. |
| `.raga/themes/` | Project theme files. |

For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined.

### Migrate legacy project resources

Project `.pi` directories are no longer discovered. There is no automatic fallback or merge.
The explicit migration API is `migrateProjectConfig(projectRoot, { projectTrusted: true })` in `src/core/instances/migration.ts`.
Review the project before granting migration approval. Migration copies resource files without loading extensions and preserves `.pi`.
An existing `.raga` destination, including a symlink, fails before copying any files.
Invalid settings, symlinks, external resource paths, executable command overrides, and unresolved package references require manual review.
Resolve those references inside the legacy resource directories or configure them explicitly after migration.

Migration reports copied and skipped paths. It copies instructions, settings, extensions, skills, prompts, themes, child specifications, and lessons.
It excludes credentials, MCP configuration, models, sessions, state, caches, dependency installations, and unknown top-level files.
Credential-bearing settings fail migration rather than copy secrets. Files named `.env`, private keys, and authentication files are excluded within resources too.
MCP configuration requires separate review because it can contain credentials and executable commands.
Global `~/.pi/agent` authentication and `PI_` environment variables are unchanged.

## Context files

Context files are separate from project `.raga` configuration. Pi loads them from the agent directory, the working directory, and its parent directories. A context file applies whenever Pi runs in its directory or anywhere below it.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or other directories.

Context-file discovery does not require project trust.
