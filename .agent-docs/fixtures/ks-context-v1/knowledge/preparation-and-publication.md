---
type: Architecture Concept
title: Knowledge preparation and publication
description: How admitted source material becomes traceable, policy-gated knowledge and a versioned retrieval publication.
tags: [knowledge, preparation, provenance, publication]
owner: ai-engineer-knowledge-services
sources:
  - id: preparation-repository
    resource: ../packages/persistence/src/preparation.ts
    title: Preparation persistence repository
  - id: ingestion-executor
    resource: ../packages/knowledge-db/src/ingestion/executor.ts
    title: Knowledge ingestion executor
  - id: publication-coordinator
    resource: ../packages/retrieval/src/vector-backends/publication/coordinator.ts
    title: Exploratory publication coordinator
  - id: selected-candidate-evaluation
    resource: ../packages/persistence/src/publication-evaluation.ts
    title: Selected candidate evaluation and publication guards
---

# Knowledge preparation and publication

Preparation turns an admitted source into material that can be inspected, cited, and—only after separate gates—made available to retrieval. It is the path from source custody to a useful knowledge representation; it is not a permission to make a claim true or expose it to users.

This concept covers the local service working copy. It does not establish that a schema pin, object store, worker, or vector publication is deployed.

## Purpose

The service needs a repeatable answer to three practical questions:

1. Which exact source bytes and conversion produced this representation?
2. Why is a proposed record, link, summary, or projection allowed to exist?
3. Which evaluated version may retrieval read, and how can it be replaced safely?

The answer is a chain of immutable identities, bounded procedures, and receipts. A successful conversion, embedding, or test is useful evidence about processing; it is not a publication decision.

## Core flow

```text
source identity and captured bytes
  → admitted representation and structural nodes
  → chunks and projections
  ├→ optional evidence-backed canonical ingestion
  └→ evaluated vector-space version → atomic active-publication pointer
```

Preparation persists a capture with the artifact digest, media type, storage address, acquisition details, source identity, and tenant. A representation and its chunks retain their parent capture and procedure lineage. The Postgres adapter checks the same immutable identity on replay and rejects conflicting metadata rather than silently updating it. See [`packages/persistence/src/preparation.ts`](../packages/persistence/src/preparation.ts) and its preparation tests in [`packages/persistence/src/preparation.test.ts`](../packages/persistence/src/preparation.test.ts).

The business result is traceability: an operator can connect a retrieved passage or a new knowledge record back to captured bytes and the procedure that produced it. It also makes a refresh explicit: new bytes or a changed procedure make a new representation/version, not an in-place rewrite of history.

## Optional canonical knowledge integration

The ingestion planner is a deterministic decision stage. It reads an intent, a bounded snapshot, the current knowledge head, vocabulary, subject-resolution facts, and an authenticated evidence oracle; it returns admitted, held, rejected, or no-op proposals. Apply occurs only after planning and uses the expected head, a transactional batch, idempotency identity, immutable intent/plan/receipt artifacts, and receipt reconciliation. The execution boundary is [`packages/knowledge-db/src/ingestion/executor.ts`](../packages/knowledge-db/src/ingestion/executor.ts); proposal semantics and planned outcomes are tested in [`packages/knowledge-db/src/ingestion/tests/plan.test.ts`](../packages/knowledge-db/src/ingestion/tests/plan.test.ts).

A materialized record needs an eligible, authoritative claim whose verdict is `directly_supported` and whose subject binding agrees with the resolved subject. A later proposal must preserve the authorized statement, qualifiers, and encoded effect; it cannot reinterpret a claim by writing similar prose. Report publication additionally requires a complete report binding, while the legacy report route is deliberately rejected. These rules are in [`packages/knowledge-db/src/ingestion/evidence-admission.ts`](../packages/knowledge-db/src/ingestion/evidence-admission.ts) and its tests in [`packages/knowledge-db/src/ingestion/tests/evidence-admission.test.ts`](../packages/knowledge-db/src/ingestion/tests/evidence-admission.test.ts).

Content links make source-to-knowledge connections explicit. The current contract supports document-to-entity, chunk-to-entity, chunk-to-claim, chunk-to-relationship, summary materialization, summary-source, and projection-target links. An intent pins its contract head, workspace fingerprint, policy digest, snapshot artifact, and knowledge sequence; stale application fails. Dependency order and exact evidence/capture bindings are schema-validated in [`packages/contracts/src/content-links.ts`](../packages/contracts/src/content-links.ts).

### Example: a qualified implementation fact

An agent captures a vendor document, converts it, and selects a chunk saying a capability is available “in preview.” A verification run directly supports the claim and retains the exact locator and selected bytes. The planner may materialize a record and link the chunk only if the proposal retains that qualification and matches the claim’s canonical subject. It may not turn the statement into “generally available,” even if a summary sounds more convenient.

## Publication is a separate gate

Publication exposes a particular vector-space version for a tenant and store space. The exploratory coordinator checks expected item count, dimensions and precision, source/representation/chunk/projection/vector/embedding/index/policy/evaluation manifests, index readiness, authorization, evaluation, and a sample search. It advances the active pointer atomically only after those checks pass. The implementation is [`packages/retrieval/src/vector-backends/publication/coordinator.ts`](../packages/retrieval/src/vector-backends/publication/coordinator.ts), with the inspection checks in [`verification.ts`](../packages/retrieval/src/vector-backends/publication/verification.ts) and coverage in [`coordinator.test.ts`](../packages/retrieval/src/vector-backends/publication/coordinator.test.ts) and [`verification.test.ts`](../packages/retrieval/src/vector-backends/publication/verification.test.ts).

Canonical ingestion is not a prerequisite for every vector publication. The publication request accepts a promotion decision and evaluation-gate identifiers, while candidate evidence is optional and checked only when supplied. A publication therefore protects the inspected version it activates; it does not imply a canonical-record materialization happened first.

Each successor publication records the prior active publication as its predecessor; the first activation has none. Rollback switches the active pointer to a prior retained version and records a reason-bearing event; it does not delete the newer version. Reconciliation can later report count, index, authorization, evaluation, or manifest drift. This preserves an audit trail and makes recovery reversible.

Promotion-selection code is present in the working tree at [`packages/application/src/knowledge/promotion-selection/promotion-selection.ts`](../packages/application/src/knowledge/promotion-selection/promotion-selection.ts) and [`apps/verification-executor/src/knowledge/promotion-selection.ts`](../apps/verification-executor/src/knowledge/promotion-selection.ts). Its repository state is not, by itself, evidence that any external promotion authority or deployment is live.

### Selected candidate publication

The selected-candidate route in [`packages/persistence/src/publication-evaluation.ts`](../packages/persistence/src/publication-evaluation.ts) requires a separately authenticated evaluation executor and preserves proposer, reviewer, evaluator, and publisher separation. Indexing returns `publishable: false`. Evaluation records exact and ANN answers, an actual HNSW index-scan plan, and immutable vector-ID/digest pairs. Staging and pointer switches compare those pairs with current physical vectors and recheck dependency eligibility. A vector mutation or permutation after evaluation requires new evaluation; an unchanged set of digest values alone is insufficient.

Selected-publication rollback must supply the entire frozen query set, with the original query IDs and embedding digests and the target store space. Empty, subset, duplicate, or changed-query baselines cannot establish equivalence. The durable worker checks this requirement before admitting the rollback plan, and the persistence verifier checks it again when comparing answers. Query-set rejection is covered by [`publication-evaluation.test.ts`](../packages/persistence/src/publication-evaluation.test.ts) and worker admission tests. Actual activation, revocation, vector drift, and rollback are exercised by [`promotion-publication.integration.test.ts`](../apps/verification-executor/src/knowledge/promotion-publication.integration.test.ts) on isolated services; they do not establish deployment status.

## Boundaries

- **Preparation owns** captures, representations, chunks, projections, source-to-knowledge linkage, and the evidence needed to explain those effects.
- **Ingestion owns** deterministic planning and guarded application of an ingestion intent; it does not make retrieval reads succeed.
- **Policy and verification own** evidence eligibility and admission. A semantic assessment cannot override a deterministic failure.
- **Vector publication owns** version inspection and the active pointer. A vector search result cannot self-promote its own version.
- **The shared database contract owns** migrations and generated database types. This repository consumes the pinned contract; it is not a second schema authority.

## What callers should retain

An integration should keep the intent identifier and digest, contract pin, snapshot artifact, expected and resulting knowledge sequence, receipt identifier, affected canonical references, publication identifier, and vector-space version. Those identifiers let a later reader distinguish a repeat of the same effect from a new proposal.

Do not use a display title, source URL, or chunk text as an idempotency substitute. Those values can be reused or normalized, while the bounded intent and receipt encode the authorized effect.

## Relationship to retrieval

Publication is the handoff to retrieval, not the conclusion of a research task. Retrieval must bind its read to an authorized publication/version and resolve its own evidence closure. A preparation receipt proves a guarded write; it does not prove that a future query is relevant or sufficiently supported.

## Failure modes and operator meaning

| Signal | Meaning | Safe next action |
| --- | --- | --- |
| `ARTIFACT_METADATA_CONFLICT` | An artifact identity already exists with different immutable metadata. | Stop; reconcile the capture and storage identity. |
| `WORKSPACE_STALE` or `REBASE_REQUIRED` | The pinned workspace/migration or knowledge head no longer matches. | Re-read the bounded snapshot and rebuild the plan. |
| `EVIDENCE_NOT_ELIGIBLE` / `AUTHORITATIVE_CLAIM_REQUIRED` | The proposed effect lacks admissible evidence. | Repair verification or narrow the proposal; do not bypass admission. |
| `PUBLICATION_VERIFICATION_FAILED` | The version failed a count, manifest, readiness, authorization, evaluation, or sample-search check. | Keep the current pointer and correct the candidate version. |
| Reconciliation finding | An active publication no longer matches its expected state. | Investigate custody and evaluation; use a reasoned pointer rollback when warranted. |

## Limits and open implementation facts

The bounded read executor explicitly returns `RETRIEVAL_UNAVAILABLE` for a `retrieval` operation instead of executing it; see [`packages/knowledge-db/src/db-read/read-executor.ts`](../packages/knowledge-db/src/db-read/read-executor.ts). That read-intent limitation is separate from the API retrieval executor and from guarded ingestion application. The retrieval-side packet and replay boundary is described by the neighboring [retrieval and evidence concept](./retrieval-and-evidence.md).

The evidence rules and publication tests demonstrate selected local behavior. They do not prove tenant data exists, storage objects are reachable, credentials are configured, or a published pointer has been activated in a deployed environment.

An unchanged receipt proves a replayed effect is the same operation, not that its source remains current; recapture and re-evaluation remain explicit work.
