# Schema, retrieval and consumer decision gates

Revision: 2026-10-10 owner clarification. The architecture boundaries are authorized; the decisions below remain open. Earlier preapproval permits research, planning and publication. It does not supply answers to an unfinished ontology or embedding model.

## Confirmed by the owner

- Review the newer Biotech `schema/program/final` v2 assembly. Reviewing it does not accept, re-pin, migrate or deploy it.
- Target TypeScript web and React Native/Expo for the Biotech GraphQL client package.
- Biotech application entity reads use the Neo4j GraphQL library. AI Engineer application entity reads need a custom PostgreSQL-backed API.
- Agents currently use Neo4j skills directly or the proprietary schema workspace and read/ingestion operations. They do not use the Neo4j GraphQL API; the planned client-facing Deep Agent must preserve this routing too. Future agent-via-GraphQL experiments are outside this release.
- Preserve a deterministic executable intent artifact, without assuming reads need a new domain-specific language. Parameterized Cypher is a candidate representation already supported by the native service.
- Biotech's embedding targets, retrieval partitions and document/chunk/entity model remain decisions to review. Do not copy PostgreSQL vector-space storage into Neo4j by analogy.
- The complete application fixtures remain the final gate. Targeted contract tests, isolated integration and selected-query performance measurements are different checks.

## Interview register

Each gate produces a short owner-reviewed decision record, selected alternatives, explicit deferred scope, and amendments to its dependent issue acceptance criteria. Completing a research report alone cannot close an owner decision. Unanswered choices remain visible in Linear.

| Gate | Interview / decision needed | Evidence to bring | What it blocks |
| --- | --- | --- | --- |
| Q01 — v2 adoption boundary | Which v2 modules and first entity/evidence read are accepted for this release? Which owner decisions in the candidate summary remain unresolved? What legacy data must be preserved, mapped or quarantined? Accept a minimal staged subset or the whole candidate only explicitly. | Old pin, v2 manifest, current executable API and live graph compatibility inventory; existing candidate OD/R decisions, schema coverage and planner gaps. Separate graph semantics from public API exposure. | Re-pin/migration, v2-dependent native writes, final verification graph mapping and product entity schema. |
| Q02 — agent read and write semantics | For normal agent reads, prefer native parameterized Cypher, named/typed operations, or both selected by skill guidance? What work may directly configured Neo4j skills perform? Which results need retained artifacts? What is canonical write authority versus exploration in a disposable graph? | One identical question expressed in each existing read route; token/tool/latency/error comparison and failure examples; current Cypher guard, read contracts and plan/apply guarantees. | New read-artifact contract, DSL expansion/retirement, canonical host folds and revised domain query/ingest skills. |
| Q03 — corpus, embedding and GraphRAG model | Which document/source types and immutable representations are first? Embed chunks, entity summaries, documents, or multiple targets? Neo4j vectors, an external vector store, or both? What is the retrieval/publication version boundary? How do corrections, deletion and re-embedding affect historical replay? Which graph paths and scientific questions must retrieval answer? | v2 Chunk/SourceSnapshot/SourceLocator/MENTIONS proposal, existing entity vector indexes, PostgreSQL SpaceVersion/heads, model/dimension/cost inventory and example evidence packets. | New Biotech embedding writes/indexes, document/chunk ingestion, hybrid/graph retrieval and app semantic search activation. |
| Q04 — first client operations and access | TypeScript web + Expo is settled. Which first entity screens and relationship traversals? Direct user-token GraphQL or product BFF proxy? Which fields are public/member/private? Which operation registry, offline cache semantics and latency/cost targets? | One entity card plus related evidence operation, entitlement matrix, mobile paging/reconnect example and measured baseline. Propose a framework-neutral typed package; choose optional Apollo/urql/query-cache adapter only for an actual consumer. | Product GraphQL auth policy, supported operations, SDK consumer contract and production capacity target. |

Q01 must reference the candidate's existing owner decision identifiers rather than open a competing schema redesign. Q03 concerns representation, indexing and retrieval policy separately: a document–chunk–entity graph can coexist with versioned retrieval partitions. There is no requirement to introduce a node named `VectorSpace`.

## Work that can proceed now

G00: reconcile deployment, schema and performance evidence without a migration. Q01–Q04: prepare and conduct focused interviews. Existing F01/application bindings, D01/capability inventory, general verification algorithms and PostgreSQL-specific work retain their independent frontier. Library-source inspection, API operation inventory and isolated performance harness design do not require accepting v2.

## Readiness rules

Interview issues use `ready-for-human`. Issues whose own acceptance contract depends on unanswered choices use `needs-info` and native blockers. Fully specified downstream work can remain `ready-for-agent` while blocked; that label means specified, not executable now. After an answer, update the owner decision, spec, criteria, labels and native dependencies together. Do not auto-close interviews based on elapsed time, agent preferences, candidate filenames containing “final”, or preapproval of planning.

See [GraphQL and client delivery](GRAPHQL-CLIENT.md), [native retrieval and ingestion](NATIVE-RETRIEVAL-INGESTION.md), and [implementation plan](PLAN.md).

## Linked implementation issues

- [Q01: Interview and record the staged v2 schema adoption boundary](issues/20-q01.md)
- [Q02: Interview and select native agent read and write artifact semantics](issues/21-q02.md)
- [Q03: Interview and select the Biotech corpus embedding and GraphRAG contract](issues/22-q03.md)
- [Q04: Interview and freeze first web and Expo operations and access rules](issues/23-q04.md)
