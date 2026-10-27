# Pilot implementation decisions

## Attribution

The cross-task experience library and the comparison against adaptation without
that library are informed by Ruiyao Xu et al.,
[Harness²: Recursive Agent Harnessing for an Open World](https://arxiv.org/abs/2610.14224),
arXiv:2610.14224v1. See Section 2.3 for persistence, Section 3.1 for the shuffled
stream protocol, and Section 4, Table 3, for the library ablation.

The paired transfer split, the three named conditions, and the restriction to
prose lesson memory are our pilot decisions. We do not claim to reproduce
Harness² or to have reused its implementation. See the
[methodological source and differences](README.md#methodological-source).

## Experiment shape

The experiment record contains a frozen task pin, pair, task position, condition,
repetition, budget, retained-state key, and provenance. Conditions are a fixed
registry. Learning state is separate from project workspaces and conversations.
This follows Model the Domain and makes reset behavior explicit.

Two designs were considered. A task pipeline made reference, consolidation, and
final solving explicit. A fully event-driven state reducer would make arbitrary
resume easier, but added machinery that this one-pass pilot does not need.
The implementation uses the pipeline and the existing append-only journals.
It does not support resuming a partial matrix.

The checkpoint separated read-only catalog inspection and design exploration
from one owner's coupled changes to the runner and Docker adapters. Native
supervised child launch failed in this session. Implementation proceeded in the
main session, with a separate one-shot source audit and local tests. The design
perspectives were not model-diverse.

## Verification gates

The benchmark checklist requires actual model requests, correct outputs, error
counts, and independent scoring. Preflight resolves the exact model without
inference. Smoke executes real requests and the independent verifier. Smoke
outcomes are never evidence of better task performance.

A reused adapter removed a bind source when its broker trial closed, before
Docker copied out the patch. The broker now settles pending requests when a
trial closes, but retains its directory until containers are destroyed and the
broker is disposed. The local broker regression check proves this lifetime
without contacting a model provider.

The protocol checks cover model pins, exact task matrices, related-task order,
condition resets, transfer-state isolation, lesson bounds, provenance, and
accounting across stages. The broker check also verifies that an unaccounted
failed request consumes its reservation and cannot evade the spending cap.

Source and installed dependencies are copied into a per-run snapshot. Provider
credentials stay outside it. Grader results never choose learning artifacts.

## Limits

Adaptation is prose lesson memory, not arbitrary executable harness evolution.
The sample uses repository matching, not a claim that patches are independent
or that paired tasks require the same skill. Structural lesson checks do not
prove semantic correctness or absence of memorized solutions. A small single
order cannot establish statistical significance. Source images may exhaust
available disk before all tasks finish. Interrupted runs remain incomplete.
