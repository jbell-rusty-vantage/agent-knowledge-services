# ADR 0015: Preserve native retrieval semantics and gate embedding design

Status: accepted invariants; read representation and Biotech corpus/index implementation require Q01–Q03 decisions.

## Decision

Share evidence/result envelopes, budgets and evaluation methods. Keep PostgreSQL and Neo4j query planning, indexing, version authority, temporal semantics and transactions native. Do not force Biotech through PostgreSQL SpaceVersion, UUID, publication-head or graph-view contracts.

A read intent may be a parameterized Cypher artifact, a named operation or an existing typed read intent. New abstraction is justified by measured task outcomes and maintainability. Deterministic artifact compilation does not imply stable results against a changing graph; bookmarks are causal positions, not historical snapshots. Keep query identity, canonical result identity and execution telemetry separate.

Canonical writes preserve schema-pinned intent, injected clock, graph preconditions, evidence/admission witness, ordered plan, idempotency marker and atomic domain transaction. A bare Cypher write is not an equivalent replacement merely because its text is deterministic.

Document/chunk/entity structure defines representation and provenance. Retrieval partitions define scope and release/version policy. Physical vector indexes define model/dimensions/similarity/filters. These are independent design axes. v2's proposed Chunk links and current entity-vector indexes do not settle the new retrieval model. No embedding field, index or space is automatically adopted.

## Consequences and gates

[Q01–Q03](../specs/belllabs-knowledge-platform/CLARIFICATIONS.md) choose a staged schema and supported native contracts. [Native retrieval and ingestion](../specs/belllabs-knowledge-platform/NATIVE-RETRIEVAL-INGESTION.md) specifies artifacts, lifecycle and paired evaluation. Existing verification integrity and final fixture gates remain in force. A shared adapter must return unsupported semantics explicitly rather than fabricate backend equivalence.
