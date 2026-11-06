# Native agent retrieval, ingestion and GraphRAG

Revision: 2026-10-10. Accepted consumer boundaries, with implementation choices gated by [Q01–Q03](CLARIFICATIONS.md). The newer v2 assembly is the owner's selected review candidate, not an accepted schema.

## Problem and scope

Shared retrieval outcomes must not erase backend semantics or add a language that agents do not need. Biotech agents currently use native Neo4j skills, or Biotech's schema workspace with its read and ingestion operations. AI Engineer agents retain their PostgreSQL workspace/read/ingest tools. The planned client-facing Deep Agent must preserve the same domain-native routing; no agent uses the Neo4j GraphQL API in this release. Web/Expo entity clients use that API; AI Engineer entity clients use a custom PostgreSQL-backed API. User-state APIs remain separate from graph querying.

Share capture, preparation, immutable evidence, authorization context, budgets, result status, verification and evaluation where the semantics match. Keep database-native query compilation, graph traversal, indexing, temporal visibility, version authority and writes native. A common result envelope must not force UUIDs, PostgreSQL knowledge sequence numbers or SpaceVersion onto Biotech.

## Current code and proposed schema are different evidence

Biotech has `ReadIntent`/snapshot operations, identity resolution, `CypherRequest` read/explain execution, and ingestion intent → plan → apply → receipt. The schema workspace is progressive disclosure over a pinned contract, not a requirement to start a sandbox for every read. The native Cypher route is already present; its historical “baseline” name is not an architectural prohibition on selecting it for future ordinary agent reads.

The v2 summary explicitly says candidate/unaccepted. It reports successful syntax/EXPLAIN work but no applicable unmodified candidate ingestion plans; compatibility shims are not an implemented production migration. Its planner, mapping and temporal coverage need qualification before re-pinning. Its proposed Chunk uses `(snapshot, textVersionHash, chunkerVersion, chunkIndex)` identity. `CHUNK_OF` links SourceSnapshot, `COVERS_LOCATOR` represents span overlap, and `MENTIONS` links entities with method/version provenance. Neither overlap nor an entity mention proves a claim. Embeddings are proposed as deployment/index data outside GraphQL SDL fields. This is a useful review candidate, not settled storage authority.

Candidate OD-44 explicitly leaves embedding model/dimensions unresolved; 1536 is a placeholder. FU-07 records that v2 has no completed operations DDL file. These existing decisions must be resolved through Q03 and the native schema owner, not overwritten by a new platform default.

## Consumer routing

| Consumer | AI Engineer | Biotech |
| --- | --- | --- |
| Web and Expo entity views | Custom authorized HTTP API over native PostgreSQL queries; typed application client | Neo4j GraphQL product schema and typed operation client, direct or BFF-mediated according to Q04 |
| Client-facing Deep Agent | Admitted domain skills/MCP/CLI and native knowledge operations | Admitted Neo4j skills or schema workspace/native read and ingestion tools; no GraphQL |
| External domain agent | App-specific skills and granted native operations | Same native choices under separately provisioned authority; no GraphQL requirement |
| Canonical knowledge writes | Native PostgreSQL plan/admission/execution | Native Neo4j plan/admission/apply/receipt; no generated GraphQL mutations |

Same actor authorization and evidence meaning do not mean identical query protocols. Direct Neo4j skills may use explicitly provisioned principals in the owner's environment; skills contain guidance, never credentials. This does not automatically authorize arbitrary writes to canonical knowledge. Q02 records the supported direct-skill scope and how writes enter domain admission.

## Read artifacts: recommendation to resolve at Q02

Preserve named operations for familiar resolve/card/trace tasks. For unfamiliar graph reads, evaluate **parameterized Cypher in a thin versioned artifact** against the existing typed read intent on identical questions. Prefer the least translation that still provides safe execution and attributable evidence. Do not expand a compulsory query DSL before this comparison. A native Cypher route can reuse schema discovery, validation and receipts without translating into GraphQL.

The accepted artifact contract must declare:

- Exact contract/schema/query digest; statement bytes or named operation plus typed parameters; target database through a trusted binding; caller scope outside model-selected credentials.
- Read-only operation class, permitted procedures, variable-length traversal rules and hard row/byte/time limits. Parameterization addresses values, not arbitrary label/property/path semantics.
- Stable result ordering where comparison or pagination requires it; defined output columns/types and integer/temporal/spatial serialization; cursor semantics and explicit truncation.
- Source/entity/assertion/locator references when available, request intent and purpose, execution start/end, selected route, cache eligibility and a result receipt.
- Error distinctions: invalid schema, forbidden effects, ambiguous identity, unsupported contract, timeout, truncated result, missing evidence and empty authorized result.
- Read-only database authority and tested executor restrictions. A keyword guard or driver READ routing alone is not a complete guarantee that arbitrary Cypher cannot perform side effects. Procedure policy and runtime authority must agree.
- `EXPLAIN` establishes supported planning, not query correctness, complete coverage or bounded run cost. Run `PROFILE` only in the admitted isolated benchmark environment because it executes the query.

Do not seal telemetry into semantic identity. Current native read snapshots include elapsed timings in their digest; N01 must decide compatible separation into request identity, canonical result identity and execution receipt. Old receipts remain interpretable and unchanged. Query-text determinism is not result determinism on a changing graph. Retaining returned bytes enables historical replay; re-running later is a new observation. A bookmark provides causal consistency and is not a historical graph snapshot. State/time filters provide only the history actually modeled by the schema.

## Write artifacts and agent output semantics

Read flexibility must not remove the write boundary. Domain skills teach an agent to emit one schema-versioned ingestion intent with exact referenced entities/proposals, evidence locators and permitted operations. The executor resolves ambiguous identity, validates allowed predicates/qualifiers, validates verification admission, plans against explicit graph preconditions and injected time, then applies a sealed ordered plan atomically with its intent marker.

The supported sequence is:

1. Discover a minimal schema slice and existing entities/evidence. Reuse a cached schema slice when its pin matches; no forced full sandbox.
2. Emit a versioned proposal using the selected native ingestion vocabulary. Report unresolved identities and missing evidence instead of guessing canonical facts.
3. Validate and plan without canonical writes. Inspect the exact planned effect and expected graph state, not only an LLM explanation.
4. Obtain required verification/admission for the exact effect and intended use. Evidence presence alone cannot authorize it.
5. Apply the pinned plan under current authority and graph preconditions. Replay the same intent **and original plan** to recover its receipt; changed plan bytes conflict rather than silently reusing a receipt. Stale state requires explicit replan/admission.
6. Recover a lost response via marker/receipt lookup. Verify readback and distinguish transaction success, admitted knowledge and publication.

Deterministic planning requires the same intent, schema/rules, graph observations and injected clock. Concurrent state can invalidate a plan. Retry safety comes from authority checks, transaction semantics and idempotency markers, not from deterministic text alone. A future raw-Cypher write artifact would have to preserve these same obligations; it is not selected by this amendment. Standalone verification and mission correlation retain ADRs 0007–0012.

Current `inputSnapshot` is digest-bound in the intent but is not loaded/validated by the planner/apply source inspected here. Explicit copied preconditions do enforcement. The touched-node set is not a complete dependency closure over relationships, negative results or concurrent new edges. N02 must resolve this contract gap for the accepted semantics, including stale-read and lost-response cases, before documenting stronger snapshot guarantees.

N03 updates the native planner and worked skills for one approved v2 ingestion case, including identity ambiguity, changed source, duplicate delivery and stale precondition. Broader domain migrations must be split into separately reviewed slices, not treated as implied by one successful case.

## Representation, retrieval scope and physical indexes

Q03 must decide three axes independently:

| Axis | Decisions | Invariant |
| --- | --- | --- |
| Representation | Source/document classes, snapshots, extracted text versions, chunks, entity and locator links | Stable lineage to retained bytes; chunk text is a representation, not an authoritative claim |
| Retrieval scope/version | Corpus membership, tenant/ACL, publication/admission eligibility, replacement, current/historical view | Every served result can identify eligible source versions; correction and revocation affect current use |
| Physical indexing | Chunk/entity/document embedding targets; Neo4j or external store; model, dimensions, similarity and index names | Incompatible embedding models are never silently mixed; index readiness and data coverage are explicit |

Recommendation for review: retain immutable captures and text representations, derive chunks deterministically, keep locator-span links and entity-link method versions, then add versioned embedding/index manifests. A manifest can be an operational record; it need not be a new graph node type. Entity summary vectors and document chunk vectors answer different questions and may coexist if their retrieval profiles explain the difference. GraphQL `@vector` and current entity search indexes do not establish this corpus model or an agent retrieval pipeline.

## Ingestion and re-index lifecycle

An approved corpus ingestion slice must take one allowed source through capture → representation → chunk identity → locator/entity-link derivation → embedding/index write if selected → coverage check → serving eligibility. Each stage records digests, versions, retained source refs and errors. Schema decisions are made upstream; pinned/generated schema and workspaces are not hand-edited.

Required states include pending, materialized, index-pending, indexed, eligible, superseded/withdrawn and failed, with an owner-selected mapping into native contracts. Graph write success is not vector index readiness. For an external vector store, graph/index writes are not atomic: use durable intent/outbox and reconciliation, with eligibility only after exact acknowledgment. For Neo4j indexes, distinguish committed vector properties, online index state and complete corpus coverage. Do not claim distributed atomicity or instant full indexing.

Re-embedding creates a new compatible generation; switch current retrieval eligibility only after coverage/quality checks. Retain or invalidate old generations according to replay/retention policy. Corrections and deletion traverse source → representation → chunk → embedding → evidence/result dependencies. An old result can remain an immutable historical receipt while current serving is denied. Deleting source bytes may make replay unavailable; report that condition rather than fabricate evidence.

## GraphRAG is backend-specific

| Concern | AI Engineer PostgreSQL | Biotech Neo4j |
| --- | --- | --- |
| Existing retrieval machinery | Versioned spaces/publication and knowledge contracts; native relational/lexical/vector channels | Bounded graph reads and entity-vector options; new evidence/corpus retrieval still needs decisions |
| Joins and graph context | Approved SQL views/relations and actually supported graph adapters | Native typed traversals, labels, direction, path length, fanout and assertion/evidence edges |
| Identity/time | Preserve UUID and native version/knowledge-view semantics | Preserve `hu:` UIDs and modeled state/valid-time semantics; do not invent PostgreSQL K heads |
| Candidate ranking | Existing channel/reranker contracts and versioned coverage | Entity resolution, lexical/chunk/entity vector candidates, then explicitly bounded graph context if selected |
| Evidence | Captured representations/selectors and current admission | SourceSnapshot/SourceLocator and qualified assertions; `MENTIONS`, adjacency and similarity remain discovery signals |
| Index publication | Existing space/index publication authority | Q03 chooses generation/eligibility ownership and physical index behavior |

N05 should prove one selected scientific question class end to end through the native agent surface: entity/lexical/vector candidates as approved, bounded graph expansion, evidence resolution, optional reranking, and an evidence packet with unsupported facets and provenance. A vector result is not scientific support. Preserve population, organism/material, dose, endpoint, study context, temporal qualifiers and contradictions. Never combine Cypher path scores, vector cosine and source quality as though they were a calibrated common probability.

Compare approved lexical-only, vector-only, graph-only and hybrid variants where available; an unavailable route is unsupported, not a zero score. Measure entity resolution, relevant evidence recall, citation correctness, qualifier preservation, contradictory evidence, token/tool/provider cost, p50/p95 latency and truncation. Q03 freezes representative questions and labeled evidence before optimization. No single backend benchmark certifies the other.

## API retrieval and agent retrieval remain distinct

R01 includes the custom AI Engineer entity API and its typed application contract. R02/N05 cover native Biotech agent questions and evidence retrieval. G01–G08 cover Biotech GraphQL entity clients. P02 may compose saved user research with GraphQL entity results, but an agent question follows the native path. The product UI may call a separately authorized answer service for synthesis; the answer service is not a hidden GraphQL agent adapter.

Readiness is split: direct supported entity reads can be qualified before a new corpus/vector pipeline; hybrid Fast/Explore claims require Q03 and their native implementation. Source/schema inventories and existing bounded routes remain usable according to their current contract while v2 work is blocked. No blanket outage or replacement of working tools follows from this plan.

## Acceptance and provenance

Required slices: N01 native read artifacts; N02 snapshot/precondition and retry conformance; N03 approved v2 ingestion case; N04 captured-source/index lifecycle; N05 evidence-preserving graph retrieval. Q01–Q03 are mandatory decision gates. Existing R02/R03/X01/V07 and domain assembly briefs are amended, with native blockers rather than a competing implementation plan.

Source inspection: Biotech `packages/contracts/src/read.ts`, `cypher.ts`, `ingest.ts`; `packages/kg-ops/src/read.ts`, `cypher.ts`, `plan.ts`, `apply.ts`, `operations.ts`; native query/ingestion/baseline skills; `schema/program/final/00-SUMMARY.md`, `decision-report.md` and assembled v2 SDL. AI Engineer comparison: shared KS retrieval contracts/executor, `knowledge-db` read and ingestion, and existing retrieval/publication documentation. No live graph data, embeddings or complete application fixtures were changed or generated for this planning amendment.

## Linked implementation issues

- [N01: Execute and retain a native agent read under the selected artifact contract](issues/26-n01.md)
- [N02: Make native ingestion snapshot preconditions and lost-response replay truthful](issues/27-n02.md)
- [N03: Migrate and ingest one approved v2 entity assertion and evidence case](issues/46-n03.md)
- [N04: Ingest one approved source into a versioned searchable corpus](issues/47-n04.md)
- [N05: Retrieve scientific evidence through the selected native graph profile](issues/48-n05.md)
