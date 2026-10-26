---
name: setup-pstack
description: Configure real native model selectors for the bundled engineering workflows through a candidate harness revision.
---

Read [the native Python adapter](../raga-runtime/SKILL.md) before executing this workflow. Authoring targets candidate revisions. Children use run_child, not an external agent service.

# Configure native model roles

Read [the native runtime](../raga-runtime/SKILL.md). Inspect the currently configured model registry through the host's model selection interface. Use exact provider/model selectors, not editor slugs or worker aliases. Preserve operator credentials outside the candidate.

Use `await instance.candidate_read(id, 'agents/model-roles.json')` and `await instance.candidate_write(id, 'agents/model-roles.json', content)` to edit the proposal. The supervisor checks candidate paths and preserves the accepted revision.

Read agents/model-roles.json from the pinned resource root. Null inherits the session model. Choose code, judgment, and verification roles from available models. Record when roles use one family so reviews do not claim diversity. Never silently replace a rejected selector.

Use the candidate authoring workflow to propose the model-role JSON. The supervisor validates selectors against its registry. Commit the candidate and request explicit promotion. This does not change a running session's pinned configuration.
