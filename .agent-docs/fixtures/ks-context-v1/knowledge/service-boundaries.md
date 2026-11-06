---
type: Service Boundary
title: Knowledge service boundaries
description: Ownership and safe entry points for schema navigation, bounded reads, ingestion, and retrieval.
tags: [knowledge, boundaries, schema, ingestion, retrieval]
owner: ai-engineer-knowledge-services
sources:
  - resource: ../packages/knowledge-db/src/schema-workspace/workspace.ts
    title: Workspace loader
  - resource: ../packages/knowledge-db/src/db-read/read-executor.ts
    title: Read executor
  - resource: ../packages/knowledge-db/src/ingestion/executor.ts
    title: Ingestion executor
  - resource: ../packages/host/src/verification/host-runtime.ts
    title: Shared verification host
  - resource: ../apps/api/src/index.ts
    title: API runtime composition
  - resource: ../apps/mcp/src/index.ts
    title: MCP runtime composition
---

# Purpose

Use this page when deciding which Knowledge Services surface owns a change or
an operation. It keeps callers from treating a transport, a read snapshot, or
a retrieval result as a second authority for canonical knowledge.

The service owns knowledge preparation, retrieval, evidence, verification, and
policy admission. The shared database schema, migrations, Supabase configuration,
and generated database types remain in the pinned
[`ai-engineer-db-contract`](../packages/knowledge-db/package.json) dependency;
this repository consumes that contract and does not create a rival schema
authority. The accepted lifecycle design is
[`0002-deterministic-preparation.md`](../docs/architecture/0002-deterministic-preparation.md).

# Choose the owner

| Need | Read first | Owner and result |
| --- | --- | --- |
| Change a service use case shared by transports | [`application`](../packages/application/src/index.ts) | Shared use-case composition; keep algorithms out of transport handlers. |
| Change the main service HTTP, CLI, or MCP surface | [API runtime](../apps/api/src/index.ts), [CLI commands](../apps/cli/src/commands.ts), [MCP runtime](../apps/mcp/src/index.ts) | Transport adaptation to published contracts and shared application behavior. |
| Compose verification ownership and admission for API or MCP | [`createVerificationHostRuntime`](../packages/host/src/verification/host-runtime.ts) | Shared host; transports are not a second algorithm authority. |
| Find schema meaning, a relation, vocabulary, rule, or named query | [`schema-workspace`](../packages/knowledge-db/src/schema-workspace/index.ts) | Loads and searches the pinned workspace; it does not query tenant data. |
| Read tenant knowledge reproducibly | [`ReadExecutor`](../packages/knowledge-db/src/db-read/read-executor.ts) | Executes catalog queries in a read-only transaction and returns a digestible snapshot. |
| Inspect a permitted query plan or bounded ad hoc read | [`sql-guard.ts`](../packages/knowledge-db/src/db-read/sql-guard.ts) | Guards one read statement and uses the bounded `pipeline_agent` role. |
| Plan or commit verified knowledge proposals | [`IngestionExecutor`](../packages/knowledge-db/src/ingestion/executor.ts) | Produces a deterministic plan or applies through `temporal.*` as `executor_service`. |
| Expose schema/read/ingest functions to an operator or agent | [`knowledge/operations.ts`](../apps/verification-executor/src/knowledge/operations.ts) | Defines one operation catalog for CLI, HTTP, and MCP. |
| Retrieve already prepared, authorized records | [`retrieve`](../packages/retrieval/src/search/retrieve.ts) | Builds an evidence packet under retrieval policy; it does not write canonical knowledge. |

Cross-repository consumers use the published HTTP/client, CLI, or MCP contract;
they must not import these internal algorithm packages.

# Boundary rules

1. A workspace is a **contract view**, not the database. Its loader reads a
   manifest, search index, optional catalog, terminology, and rules lazily;
   `assertHeadMatches` fails closed when the database migration head differs,
   unless an explicit experiment-only `allowStale` setting is used. See
   [`workspace.ts`](../packages/knowledge-db/src/schema-workspace/workspace.ts) and
   [`head.ts`](../packages/knowledge-db/src/schema-workspace/head.ts).
2. A named query is the normal read boundary. The catalog fixes query text,
   parameter schema, role ceiling, cost class, and row/timeout limits. Callers
   may ask for a lower role, never a higher one. See
   [`read-intent.ts`](../packages/knowledge-db/src/db-read/read-intent.ts).
3. A read snapshot observes one repeatable-read view and records its contract,
   selected knowledge sequence, operation digests, and head. It is evidence for
   a later plan, not proof that a write committed.
4. An ingestion intent is a proposal, never direct SQL. The executor plans it
   against the workspace, supplied snapshot, evidence oracle, vocabulary, and
   current head before it can call canonical temporal helpers.
5. A receipt is the authority for an uncertain ingestion outcome. Repeating
   the exact intent is idempotent; changing its contents under the same
   identity is a conflict. The integration test covers committed-response loss
   and concurrent duplicate submission in
   [`executor.integration.test.ts`](../packages/knowledge-db/src/ingestion/tests/executor.integration.test.ts).

# Transport route

```text
knowledge-db: schema-workspace → db-read → ingestion
                     contract    snapshot    receipt
                                              ↓
                                  verification-executor
                                     CLI / HTTP / MCP
```

The executor is a sandbox host distinct from `apps/api`. It creates its
knowledge services only when configuration supplies a database URL; see
[`context.ts`](../apps/verification-executor/src/knowledge/context.ts).
The catalog names operations once, so CLI, POST `/knowledge/<name>`, and MCP
share input schemas and gates. The CLI behaviour is covered by
[`cli.test.ts`](../apps/verification-executor/src/knowledge/cli.test.ts).

The main API and MCP servers compose the same services.
[`createApiRuntime`](../apps/api/src/index.ts) and
[`createMcpRuntime`](../apps/mcp/src/index.ts) call
[`createHost`](../packages/host/src/create-host.ts), whose `api` and `mcp`
roles both call
[`composeKnowledgeServices`](../packages/host/src/server/knowledge.ts) and
[`composeVerificationServices`](../packages/host/src/server/verification.ts)
(admission via
[`createVerificationHostRuntime`](../packages/host/src/verification/host-runtime.ts),
read, reconciliation and decision construction). Host owns construction and
release; the transports keep credential handling, listeners and protocol
mapping. MCP omits only transport-only pieces (callback replay and the
service-only drift queue).

Every MCP tool runs in process; MCP has no API client and issues no HTTP
request to the API
([fetch-trap test](../apps/mcp/src/tests/no-http-shims.test.ts)). Knowledge and
verification reads call the shared
[`createKnowledgeResourceReads`](../packages/application/src/knowledge/reads/knowledge-resource-reads.ts)
and
[`createVerificationResourceReads`](../packages/application/src/verification/reads/verification-resource-reads.ts);
`knowledge_retrieve_search` calls
[`submitCanonicalRetrievalRun`](../packages/application/src/knowledge/retrieval/canonical-retrieval-run.ts).
Verification mutations call application after
[`bindResolvedVerificationContext`](../packages/application/src/verification/operations/verification-context-binding.ts)
and the shared admission gates. `verify_status`,
`knowledge_embed_status` and `knowledge_promotion_status` use `operationService.get`;
`knowledge_retrieve_plan` is `RetrievalPlanSchema.parse`; pipeline catalog
writes use `operationService.submit`. The API route is the behavioral
reference: a [parity test](../apps/mcp/src/tests/api-mcp-parity.test.ts) runs
both transports over identical fixtures for every former shim row. This
follows accepted [ADR 0004](../docs/architecture/0004-transport-call-graph.md).

# Retrieval is a separate read path

Retrieval filters records by tenant, visibility, space, lifecycle, promotion,
and hard policy filters before ranking lexical, semantic, graph, rerank, and
diversity channels. It records omissions, degraded reranking, coverage, and an
abstention recommendation in an immutable packet. See
[`retrieve.ts`](../packages/retrieval/src/search/retrieve.ts) and
[`retrieve.test.ts`](../packages/retrieval/src/search/retrieve.test.ts).

Do not request retrieval through `knowledge-read-intent.v1` today: its
`retrieval` operation is deliberately skipped with `RETRIEVAL_UNAVAILABLE` in
[`ReadExecutor.runQueryOperation`](../packages/knowledge-db/src/db-read/read-executor.ts).
That is a present implementation limitation, even though retrieval is an
implemented package and a catalog entry may describe a retrieval-shaped query.

# Examples and counterexamples

| Situation | Correct route | Counterexample |
| --- | --- | --- |
| An agent needs allowed units before proposing a price fact. | Search the workspace, then read the scoped rule/vocabulary page. | Guessing a code from a fact stream. |
| A research task needs the current identity and its fact history. | Create a named-query read intent and retain its snapshot. | Running unrestricted SQL or citing an unpinned live read. |
| A response is lost after `ingest_apply`. | Submit the identical intent again and inspect its receipt. | Minting a new intent ID and risking another batch. |
| A caller wants a semantic answer from prepared records. | Use the published retrieval surface and preserve the evidence packet. | Treating a skipped db-read retrieval operation as empty search results. |

# Known gaps and decisions

- The bounded read executor skips retrieval operations rather than executing
  them. A future bridge must make
  its authorization, evidence-packet, and snapshot semantics explicit.
- The implemented deterministic ingestion intent/plan/apply path does not prove
  every broader ingestion ambition is complete or deployed.
- Ingestion persists canonical effects through temporal helpers and stores
  receipt/ledger records in its executor path. Those records are distinct from
  the service operation lifecycle; do not treat the absence of a
  `knowledge_service.operation` row as absence of an ingestion receipt.
- MCP answers `CAPABILITY_NOT_ADMITTED` when a read, reconciliation or
  decision capability is not composed; it never falls back to another
  transport. MCP deployments therefore need the same verification read,
  Storage and gateway configuration as the API for those tools to work.

For authentication, capability admission, and parser isolation, read the
owning [security guide](../docs/security.md) before changing a transport's trust
boundary. For normal worker leases and evidence-bound repair, use
[durable execution and recovery](durable-execution-and-recovery.md).
