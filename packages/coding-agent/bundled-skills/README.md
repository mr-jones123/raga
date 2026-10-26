# Portable default skills

New instances copy this pack into their first accepted revision. Each session reads its pinned copy. Updating package assets does not rewrite an existing instance.

The pack contains 56 portable pstack skills, four companion skills, the native create-skill and raga-runtime adapters, and the managed no-mistakes skill. It excludes make-bot-ui and editor-only services. The original public no-mistakes skill stays unchanged under skills/no-mistakes/upstream.

Read [the native runtime](skills/raga-runtime/SKILL.md) for the Python API. Read [the workflow guide](docs/guide/README.md) for skill selection. Workers return supervisor-owned workspace changes rather than Git commits. Skill changes go through candidate_read, candidate_write, and candidate_commit. Promotion remains a trusted operator operation.

## Sources and regeneration

bundle.json records source commits, source-file hashes, adapted-file hashes, licenses, and runtime dependencies. Regenerate from cursor/plugins at eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10, no-mistakes at 4822244e763fd4c3d7f48be6433f92df10bb5b33, and the published commander 14.0.0 package tree. From the repository root, run node scripts/raga-sync-skills.mjs with those three source directories as positional arguments. The generator compares every imported asset with the checked-in source hashes and refuses missing, added, or modified source files. A deliberate upstream update must review the source hashes and license changes as well as the adaptation.

Pstack's MIT notice is in [licenses/pstack](licenses/pstack). Companion notices are in [licenses/cursor-team-kit](licenses/cursor-team-kit). No-mistakes and Commander have their own [no-mistakes](licenses/no-mistakes) and [Commander](licenses/commander) notices.

## Optional capabilities and authorization

Run capability_report() in the native Python session to inspect Node, Git, terminal support, Java, GitHub, the local Playwright browser, Mermaid, and the pinned TLC jar. Missing optional tools report prerequisites without installing dependencies. Runtime versions and pinned assets are in dependencies.json.

No-mistakes v1.84.0 requires separate operator approvals for provisioning, network-enabled repository enablement, validation, gate responses, and lifecycle changes. The model API permits inspect, status, and restricted run after explicit enablement. It cannot supply approval or respond to a gate. Push, PR, CI, and automatic yes mode require separate operator grants. A stopped daemon requires explicit start before another run.

The backend keeps HOME and NM_HOME below instance state, disables telemetry and update checks, and avoids OS service installation. It does not copy credentials or inherit ambient credentials. A runnable pipeline adapter must receive credentials through an explicitly approved wrapper or explicit trusted environment values. Version, JSON events, and durable sessions are probed before enablement.

## Integration checks

From packages/coding-agent, run the focused Vitest files test/instances-bundle.test.ts and test/instances-no-mistakes.test.ts after integration. The separate test/instances-no-mistakes-smoke.test.ts is opt-in with RAGA_NM_SMOKE=1, RAGA_NM_AGENT_EXECUTABLE, and RAGA_NM_AGENT_VERSION. Its optional JSON RAGA_NM_AGENT_ARGS and RAGA_NM_AGENT_ENV are explicit adapter inputs. The smoke creates a disposable Git remote, uses the actual pinned backend, and asserts that the feature branch is not published. It can use network and paid model calls. Do not enable it without authorization.
