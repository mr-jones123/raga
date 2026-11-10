## [0.16.0](https://github.com/mr-jones123/raga/compare/raga-v0.15.1...raga-v0.16.0) (2026-11-10)

### Features

* **coding-agent:** add wiki skill for Obsidian vaults through the Obsidian CLI ([76add0a](https://github.com/mr-jones123/raga/commit/76add0a01dc850c8f45893cc08e76e0be9fb01c3))
* **coding-agent:** run no-mistakes without an instance and show a live stepper ([9faa314](https://github.com/mr-jones123/raga/commit/9faa3143837b96aa49adb39812fdeba8554fee19))

## [0.15.1](https://github.com/mr-jones123/raga/compare/raga-v0.15.0...raga-v0.15.1) (2026-11-09)

### Bug Fixes

* **release:** ship the pi-tui native helpers in raga-cli ([2d46c45](https://github.com/mr-jones123/raga/commit/2d46c452c3b0635ebb6697716eff090e3b468ba8))

## [0.15.0](https://github.com/mr-jones123/raga/compare/raga-v0.14.0...raga-v0.15.0) (2026-11-09)

### Features

* **coding-agent:** add /review with isolated verifiers confined by Seatbelt or bubblewrap ([b364dcc](https://github.com/mr-jones123/raga/commit/b364dcc2f8a69a34d40bf533297d740f2ff400f6))
* **coding-agent:** bundle a quiz skill that explains commits and tests the user before shipping ([71c6aa3](https://github.com/mr-jones123/raga/commit/71c6aa364390dc8f83b090fa61edad0b9cb12b8e))

### Bug Fixes

* **ai:** allow prompt cache keys for compatible proxies ([#9442](https://github.com/mr-jones123/raga/issues/9442)) ([35c9724](https://github.com/mr-jones123/raga/commit/35c9724db5c87e887a4bfa89f753ae77c9267b4b))
* **ai:** send session-id instead of session_id on OpenAI Responses ([#11793](https://github.com/mr-jones123/raga/issues/11793)) ([63dce08](https://github.com/mr-jones123/raga/commit/63dce08842c285d95ca863f9d47df67383c4e319)), closes [#4967](https://github.com/mr-jones123/raga/issues/4967) [#11639](https://github.com/mr-jones123/raga/issues/11639)
* **coding-agent:** harden isolated rlm_query children and the Seatbelt profile ([738e1ca](https://github.com/mr-jones123/raga/commit/738e1cacd200c9898d2d4e3d8d03c30bdbecc1f7))
* **tui:** prevent cursor marker leaks ([#9441](https://github.com/mr-jones123/raga/issues/9441)) ([a82d23a](https://github.com/mr-jones123/raga/commit/a82d23a20fdcbc8d2246941563801453730e32be)), closes [#9257](https://github.com/mr-jones123/raga/issues/9257) [#9332](https://github.com/mr-jones123/raga/issues/9332)

## [0.14.0](https://github.com/mr-jones123/raga/compare/raga-v0.13.0...raga-v0.14.0) (2026-11-08)

### Features

* **coding-agent:** add /btw for side questions ([5df1ec5](https://github.com/mr-jones123/raga/commit/5df1ec57403a66f82e1ac3a69a7b8c0930395d99))
* **coding-agent:** boxed indigo editor and one-line footer ([65c2c7c](https://github.com/mr-jones123/raga/commit/65c2c7c41b0e04c1cd860701230857bc28f092b3))

## [0.13.0](https://github.com/mr-jones123/raga/compare/raga-v0.12.1...raga-v0.13.0) (2026-11-07)

### Features

* **coding-agent:** compact python cells with an inline running wheel ([f09ffbc](https://github.com/mr-jones123/raga/commit/f09ffbc9b4ae33cd2ddf5a7289fd45d96f92b5b0))
* **coding-agent:** show subagents as a tree chart in /agents-tui ([dcd2abe](https://github.com/mr-jones123/raga/commit/dcd2abe0403d42055273eecfc1c6e5506e76b608))

## [0.12.1](https://github.com/mr-jones123/raga/compare/raga-v0.12.0...raga-v0.12.1) (2026-11-07)

### Bug Fixes

* **deps:** update undici and minimatch for security advisories ([1cdc576](https://github.com/mr-jones123/raga/commit/1cdc576a3b63e53bfc031d50ecceca2864e5c0b5))

## [0.12.0](https://github.com/mr-jones123/raga/compare/raga-v0.11.0...raga-v0.12.0) (2026-11-03)

### Features

* **coding-agent:** add tenmo to watch, start, and delete sessions across folders ([4589a68](https://github.com/mr-jones123/raga/commit/4589a68c5a42e049e39f40a87707928ce4f90ce8))
* **coding-agent:** hide superseded OpenAI and Anthropic models ([ef2cb8b](https://github.com/mr-jones123/raga/commit/ef2cb8b10bef8c3a71e9fd677b7fc208a7a6f8f8))

### Bug Fixes

* **peak:** pin TLC to stable v1.7.4 and fix statechart checks on macOS ([9148f37](https://github.com/mr-jones123/raga/commit/9148f377bb31d3d89ffebeb6ba7a82358e22083a))

## [0.11.0](https://github.com/mr-jones123/raga/compare/raga-v0.10.1...raga-v0.11.0) (2026-11-02)

### Features

* **ai:** send Claude Code's billing attestation on Anthropic OAuth requests ([1ae8c83](https://github.com/mr-jones123/raga/commit/1ae8c8372b69c044ace500c3181657d129554cb7))

## [0.10.1](https://github.com/mr-jones123/raga/compare/raga-v0.10.0...raga-v0.10.1) (2026-11-01)

### Bug Fixes

* install raga with its own installer instead of pi's ([e7816db](https://github.com/mr-jones123/raga/commit/e7816db595936716a08febd2a5a9ac7d91fcfca2))

## [0.10.0](https://github.com/mr-jones123/raga/compare/raga-v0.9.0...raga-v0.10.0) (2026-11-01)

### Features

* assign models to subagent roles with /agent-setup ([937ae97](https://github.com/mr-jones123/raga/commit/937ae97887bae82215579de3966d23886d8e8d15))
* open subagents as named sessions from /agents in the TUI or Rex panes ([8cba5d3](https://github.com/mr-jones123/raga/commit/8cba5d360d3f9c9ee0d5fd76652ae53c41f04b21))

### Bug Fixes

* **artifacts:** keep headless Chrome away from the macOS login keychain ([2c65a35](https://github.com/mr-jones123/raga/commit/2c65a3562a0354cbb20618aac4ddedf919ff08c0))
* keep Raga updates and user-facing guidance on Raga ([8ff9209](https://github.com/mr-jones123/raga/commit/8ff9209ed94681e1c254a496515dd561e7b58590))
* pick role models in a full-screen list inside /agent-setup ([df1e642](https://github.com/mr-jones123/raga/commit/df1e64234b170472d18c286140d472717699d916))
* return partial child work when the turn budget is exhausted ([0383bc1](https://github.com/mr-jones123/raga/commit/0383bc1485b8b039d0d5b9628b8ecc12d680a426))

## [0.9.0](https://github.com/mr-jones123/raga/compare/raga-v0.8.0...raga-v0.9.0) (2026-10-31)

### Features

* add archive compaction strategy that drops context without a summarization call ([3b682ee](https://github.com/mr-jones123/raga/commit/3b682ee878320ce897f136b8661f3b0178c9df1d))
* add bend and raga-artifacts skills and run peak in ordinary sessions ([4fb5df2](https://github.com/mr-jones123/raga/commit/4fb5df2d32583b6d03f77d5e62c37a219978fcc7))
* add managed local models and CI releases ([53a7325](https://github.com/mr-jones123/raga/commit/53a73254eeceba1298c98823c275fff8331bb0b8))
* store instance memory in SQLite with selectable memory backends ([6c4997b](https://github.com/mr-jones123/raga/commit/6c4997be478c430c27ad378fa4d87bafc12f2444))
* **tui:** add /diff dashboard for categorized git review ([03cb062](https://github.com/mr-jones123/raga/commit/03cb062df23b6591d33902f7d1bb815976dc4049))

### Bug Fixes

* publish CLI updates to npm through trusted publishing ([f236785](https://github.com/mr-jones123/raga/commit/f2367854e11a26576324116194ec299403cc2e6a))
* **schemas:** regenerate keybindings schema for /diff bindings ([6ce96c7](https://github.com/mr-jones123/raga/commit/6ce96c73b6a742857be37e4bb79a83edb566106e))

# Changelog

Generated by scripts/raga-release.mjs from conventional commits. Do not edit by hand.

## [0.8.0] - 2026-10-27

### Breaking Changes

- ship raga as the raga-cli npm package with its own ~/.raga/agent directory. raga keeps its own settings in ~/.raga/agent and no longer reads ~/.pi/agent; run /login again and reinstall packages, or set RAGA_CODING_AGENT_DIR=~/.pi/agent. (c42e6f0)

### Added

- **tui**: add /idle to show the turning raga wheel fullscreen (5c80c25)

### Fixed

- **ai**: keep long cache retention off for OpenCode DeepSeek V4.1 Flash (b25f3f6)

## [0.7.1] - 2026-10-27

### Fixed

- **rlm**: leave kernel memory unlimited on macOS (f8637df)

## [0.7.0] - 2026-10-26

### Breaking Changes

- **skills**: make peak the only installed skill (59f2d79)

## [0.6.1] - 2026-10-26

### Fixed

- **rlm**: harden the cell dashboard (d63483f)

## [0.6.0] - 2026-10-26

### Added

- **rlm**: show a spinning dashboard for running cells (99eab93)

## [0.5.0] - 2026-10-26

### Added

- **skills**: add peak-setup with an explicit role picker (28fb28a)

## [0.4.0] - 2026-10-26

### Added

- **skills**: rename poteto-mode to peak and ship all playbooks (953563a)

## [0.3.0] - 2026-10-26

### Added

- **skills**: ship pstack and no-mistakes to root sessions (5b2923b)

## [0.2.0] - 2026-10-26

### Added

- **rlm**: make raga always run in RLM mode (8e841d4)

## [0.1.3] - 2026-10-26

### Changed

- **startup**: add a bundled launcher and document both run paths (2d9ab9e)

## [0.1.2] - 2026-10-26

_No user-visible changes._

## [0.1.1] - 2026-10-26

### Fixed

- **release**: let docs-only changes cut a patch release (b743e2e)

## [0.1.0] - 2026-10-26

### Added

- **release**: generate raga changelog from conventional commits (51c9add)
- **rlm**: add the Python kernel and the TypeScript Kernel host (8fc6bae)
- **rlm**: add RLM mode with the python tool, sub-LLM calls, and context (9c35e9b)
- **rlm**: add rlm_query child sessions and kernel snapshots across resume and fork (fded120)
- **rlm**: limit and report kernel memory (d81278a)
- **instances**: add versioned adaptive instance system (aa0e264)
- **bench**: add reproducible DeepSWE comparison harness (0abdcbb)
- **instances**: add optional user-owned proof verification (16141d8)
- **raga**: add a dedicated CLI and interactive branding (06e2311)
- **raga**: describe raga's capabilities on startup (09a53ad)
- **version**: show raga's own version and release every change (b3b32f0)

### Fixed

- **rlm**: return the whole file from read() and guide chunked llm_batch work (2aa8be5)
- **raga**: close audit gaps in the formal flow (d86975d)
- **release**: ignore vendored packages in lockstep checks (640d878)
