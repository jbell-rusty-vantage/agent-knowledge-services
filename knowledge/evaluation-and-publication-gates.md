---
type: Architecture Concept
title: Evaluation and publication gates
description: Separate frozen retrieval evaluation, human quality evidence, and authorized publication-pointer changes.
tags: [evaluation, publication, retrieval, fixtures, quality, rollback]
aliases: [gold dataset, heldout evaluation, release gates, vector activation]
questions:
  - Does a passing retrieval benchmark authorize publication?
  - How do real fixtures differ from synthetic tests?
  - What does rollback change in a vector publication?
owner: ai-engineer-knowledge-services
implementation_status: implemented-with-separate-acceptance-gates
decision_status: reference
validation_status: source-and-test-inspected
sources:
  - resource: ../packages/evaluation/src/index.ts
    title: Frozen datasets and evaluation cases
  - resource: ../packages/retrieval/src/vector-backends/publication/coordinator.ts
    title: Publication and rollback coordination
  - resource: ../packages/persistence/src/publication-evaluation.ts
    title: Candidate evaluation guards
---

# Evaluation informs publication; it does not grant authority

There are three separate outcomes: a test proves a bounded implementation property, an evaluation estimates quality on identified cases, and an authorized publication operation changes what retrieval can read. Preserve that distinction when reporting success.

The [evaluation contract and implementation](../packages/evaluation/src/index.ts) model frozen cases with relevance judgments, expected filters, abstention, forbidden results, expected facts/locators, provenance and partitions. `dev`, `calibration` and `heldout` serve different purposes. The `fixtureKind` distinguishes real-bundle-grounded cases, synthetic gaps, reviewed negatives and adversarial cases. A generated candidate does not become independent human gold merely because it has a plausible expected answer.

## Choose evidence for the question

| Question | Appropriate evidence | Limit |
| --- | --- | --- |
| Are ordering, filtering, bounds and failure cases correct? | Deterministic unit tests with explicit counterexamples. | Fakes do not prove provider behavior. |
| Do captured documents produce the expected supported records and locators? | Frozen real-document fixtures with independent expectations. | A small corpus does not prove broad product quality. |
| Does an adapter still obey its provider contract? | Explicitly configured live conformance test. | One successful call does not establish calibration. |
| Should a candidate publication replace the active version? | Bound evaluation, policy, authorization, manifest and index checks. | A benchmark score alone grants no pointer-change authority. |

[Evaluation tests](../packages/evaluation/src/index.test.ts), [verification statistics tests](../packages/evaluation/src/verification-statistics.test.ts), and [human-review tests](../packages/evaluation/src/verification-human-review.test.ts) are starting points for the corresponding implementation contracts. Use reviewed negatives to test when retrieval should abstain, not only whether it finds a desirable result.

## Publish an immutable version

The [publication coordinator](../packages/retrieval/src/vector-backends/publication/coordinator.ts) inspects a proposed version and gathers verification findings before committing a publication. The [persistence evaluation adapter](../packages/persistence/src/publication-evaluation.ts) binds selected-candidate evidence to publication guards. Accepted [ADR 0003](../docs/architecture/0003-embedding-retrieval-evaluation.md) requires source-to-evaluation manifests, counts, dimensions, precision, index readiness, authorization, evaluation and a sample query before changing the active pointer.

Rollback changes the pointer while preserving immutable versions and audit history. It does not erase failed evaluation or mutate prior packet citations. A publication submission is not proof that activation completed; inspect the owning operation and publication receipt.

The [MCP catalog](../apps/mcp/src/catalog.ts) explicitly excludes publication approval and publication. A retrieval/evaluation skill cannot manufacture that authority. Keep write-side publication procedures separate from read-only retrieval grants.

## Engineering proof versus fixture acceptance

The proposed [seven-stage fixture](../docs/operations/package-cleanup/REAL-FIXTURE-STAGE-GRAPH.md) is a consumer integration plan, not a completed benchmark. [DeepAgents readiness](../docs/operations/package-cleanup/DEEPAGENTS-READINESS.md) belongs to the research-agent repository. Unit tests, installed CLI smoke, provisional engineering runs, human-reviewed gold and full release acceptance must be reported separately. No live provider run or publication is attested by this page.
