---
name: create-skill
description: Author or revise a portable Agent Skills workflow in a candidate harness revision with explicit inputs and behavioral checks.
---

# Author a candidate skill

Define the trigger, input data, observable result, dependencies, side effects, approval boundaries, and failure behavior. Read nearby skills before choosing a shape. Use the native adapter at [raga-runtime](../raga-runtime/SKILL.md).

Request a candidate with `candidate = await instance.candidate_create()`. Read an existing resource with `await instance.candidate_read(candidate['id'], path)`. Write the proposed text with `await instance.candidate_write(candidate['id'], path, content)`. Never edit an accepted revision or a global skill installation. Use `skills/<name>/SKILL.md`, with lowercase hyphenated name and a description in YAML frontmatter. Keep references and helpers beside the skill. Resolve relative references from that directory.

Exercise success, input variation, failure, and ambiguous cases with real input. Executable Python helpers must pass fresh sandboxed interpreter probes without session globals. Record dependencies and external effects. A source-text assertion does not prove behavior. An unsupported capability reports its setup prerequisites.

Commit through `await instance.candidate_commit(candidate['id'], message)` and hand the candidate ID and evidence to the user. Promotion belongs to the trusted supervisor and explicit user approval. Host extension activation requires separate review. A skill cannot grant itself network or publication authority.
