---
type: Playbook
title: Schema, bounded reads, and deterministic ingestion
description: Knowledge-read operation execution, unavailable retrieval operations, pinned schema navigation, reproducible reads, and admitted deterministic ingestion.
tags: [knowledge, schema, read, ingestion, receipts]
owner: ai-engineer-knowledge-services
aliases: [database snapshot, named query, ingestion receipt, knowledge head, knowledge-read operation, retrieval unavailable, knowledge.read_intent, read intent, receipt targets]
questions:
  - How do I read tenant knowledge before writing an ingestion intent?
  - What should I do when an ingestion response is lost?
  - Does a read snapshot prove that a canonical write committed?
  - Which read intent is recorded as an operation, and where?
implementation_status: partial
decision_status: reference
validation_status: source-and-test-inspected
sources:
  - resource: ../packages/knowledge-db/src/schema-workspace/workspace.ts
    title: Workspace loader
  - resource: ../packages/knowledge-db/src/db-read/read-executor.ts
    title: Read executor
  - resource: ../packages/knowledge-db/src/ingestion/executor.ts
    title: Ingestion executor
  - resource: ../packages/knowledge-operation-protocol/src/read-intent.ts
    title: K01 knowledge.read_intent contract
  - resource: ../packages/bindings/aiengineer-postgres/src/read-intent-port.ts
    title: AI Engineer read-intent port
---

# Use this playbook

Use this sequence for schema facts, tenant-scoped knowledge, or a canonical
change. It is not permission to query or write. Start with the accepted
[preparation design](../docs/architecture/0002-deterministic-preparation.md).

# 1. Navigate the pinned schema first

Start with `schema_search`, then `schema_get` for the domain page before a
relation or function page. Search normalizes terms and ranks exact aliases,
names, terminology, partial aliases, then token overlap; it is a navigator,
not a database query. See
[`search.ts`](../packages/knowledge-db/src/schema-workspace/search.ts) and its tests in
[`schema-workspace.test.ts`](../packages/knowledge-db/src/schema-workspace/schema-workspace.test.ts).

Read the relevant rule and vocabulary files before composing an intent.
`schema_materialize` can use the db-contract CLI, a prebuilt bundle, or an
in-process filter; it records the chosen strategy and omitted items. See
[`materialize.ts`](../packages/knowledge-db/src/schema-workspace/materialize.ts).
## Contract pins

The workspace manifest provides `migrationHead` and, when available, a
workspace fingerprint. `ReadExecutor.validateIntent` rejects an intent whose
declared pin disagrees with the loaded workspace. Before a database read, the
executor compares the workspace migration head with the database migration
head and fails closed on mismatch by default. See
[`workspace.ts`](../packages/knowledge-db/src/schema-workspace/workspace.ts) and
[`head.ts`](../packages/knowledge-db/src/schema-workspace/head.ts).

**Do not** copy a migration head from a different checkout or bypass a mismatch
for normal work. `allowStale` is documented in code as experiments only and is
recorded in the resulting snapshot.
# 2. Make a bounded, reproducible read

Create a `knowledge-read-intent.v1` with tenant context and named-query
operations. The catalog owns SQL, parameters, result shape, role ceiling, cost
class, and defaults. An operation can refer to a prior result with
`$<opId>...`; unresolved references skip it rather than silently substituting
a value. The contract is defined in
[`read-intent.ts`](../packages/knowledge-db/src/db-read/read-intent.ts).

The executor validates duplicate operation IDs, catalog membership, parameter
schemas, role escalation, and limits before it touches the database. It then
uses a repeatable-read transaction, caps rows with one extra row to detect
truncation, and returns a per-operation digest. Read the implementation in
[`read-executor.ts`](../packages/knowledge-db/src/db-read/read-executor.ts) and the
database proof in
[`read-executor.integration.test.ts`](../packages/knowledge-db/src/db-read/read-executor.integration.test.ts).

| Need | Use | Result to retain |
| --- | --- | --- |
| Catalog-backed tenant facts | Named-query read intent | `snapshotDigest`, `atKnowledgeSeq`, per-operation status/digest |
| A permitted diagnostic read | `db_sql_readonly` | Rows, cap/truncation flag, knowledge head, content digest |
| Query-cost inspection | `db_explain` | Plan under the same read-only guard |
| A durable input to ingestion | Read intent with `persist: true` | Snapshot artifact ID and intent artifact lineage |

Raw SQL is limited to one guarded read statement and runs as `pipeline_agent`.
It is not a mutation route. `SELECT` syntax alone is insufficient proof of
safety: database read-only enforcement is also tested in
[`read-executor.integration.test.ts`](../packages/knowledge-db/src/db-read/read-executor.integration.test.ts).

## Knowledge-read operation execution and retrieval availability

- `ok` and `empty` are completed reads; `truncated` means the cap hid rows.
- `skipped` can mean `REF_UNRESOLVED`, unavailable artifact bytes, or another
  explicit non-result. It is not equivalent to an empty query result.
- `error` is a contained query failure with a code and message.
- Returned snapshots have `headChanged: false` on this path. If the head changes
  inside the transaction, the executor aborts with `SNAPSHOT_HEAD_CHANGED`;
  the caller must retry the read intent.

`retrieval` operations are currently skipped as `RETRIEVAL_UNAVAILABLE` in
[`read-executor.ts`](../packages/knowledge-db/src/db-read/read-executor.ts). Use the
separate retrieval service path; do not treat this status as a negative search
result.

## Two read contracts with similar names

Two different contracts carry the "knowledge read intent" name. Do not confuse them; neither replaces the other.

| | Bounded executor read (this section) | K01 `knowledge.read_intent` (OVE-204 slice 4) |
| --- | --- | --- |
| Identity | Schema version `knowledge-read-intent.v1` ([`db-read/read-intent.ts`](../packages/knowledge-db/src/db-read/read-intent.ts)) | K01 operation `knowledge.read_intent`, native contract `knowledge-read-intent/v1` (slash), request `knowledge-read-intent-request.v1`, result `knowledge-read-intent-result.v1` ([protocol `read-intent.ts`](../packages/knowledge-operation-protocol/src/read-intent.ts)) |
| Caller | Executor knowledge surfaces (MCP/executor registry) | Any K01 gateway caller holding a non-effect credential whose `operations` claim grants `knowledge.read_intent` (not an evaluator credential) |
| Queries | Every catalog named query, raw `db_sql_readonly`, `db_explain` | Eight allowlisted named queries (`knowledge.head`, `entity.resolve`, `entity.by_identifier`, `entity.card`, `entity.relationships`, `evidence.claims_for_entity`, `relationships.current_by_kind`, `vocab.relationship_kind`) plus schema search/get, at most 32 operations |
| Recording | Not recorded as an operation; persisted only as ledger artifacts when `persist: true` | Every served read is one `knowledge_verification.operation` row (verified origin digest, `run_id` and `subject` null, request `{operation, readIntent}`); a refused read records nothing |
| Guards | Workspace/database head check, role ceiling, limits | The same `ReadExecutor` underneath, plus the tenant guard (scope tenant must be `KS_DEFAULT_TENANT_ID`, else `SCOPE_DENIED`); row/value bodies past 256 KiB are withheld with their digest kept |
| Digests | Executor JCS digests | K01 `digestCanonical` over protocol JSON only |

The K01 path is the AI Engineer binding's read port
([`read-intent-port.ts`](../packages/bindings/aiengineer-postgres/src/read-intent-port.ts)), dispatched by the
[operation service](../packages/host/src/knowledge-operation/service.ts); without an injected port the operation answers
`SCHEMA_UNSUPPORTED`. The Biotech binding has no read-intent port yet. Proof: the protocol and port unit tests, the
executor's [`read-intent.integration.test.ts`](../apps/verification-executor/src/knowledge-operation/read-intent.integration.test.ts)
on a disposable AI Engineer database, and the backend conformance check `read_intent_recorded`. As of 2026-11-01 no
Mission Control mission has called it (integrated on the KS side only).

So the statement "ingestion does not write `knowledge_service.operation`; retrieval read ops are skipped" stays true for
the bounded executor, while K01 reads *are* recorded, in the component's `knowledge_verification.operation`.

# 3. Plan an ingestion intent

Compose `knowledge-ingestion-intent.v1` from a sealed evidence run and the
snapshot you just retained. The intent supplies `inputSnapshot`, its digest and
knowledge sequence, `expectedKnowledgeHead`, subjects, and proposals. Planning
writes no canonical data. It validates the evidence, vocabulary, rules,
subjects, snapshot preflight, and current head, then reports proposal outcomes,
rewrites, actions, and planned order. See
[`intent.ts`](../packages/knowledge-db/src/ingestion/intent.ts) and
[`plan.ts`](../packages/knowledge-db/src/ingestion/plan.ts).

Example shape:

```json
{
  "schemaVersion": "knowledge-ingestion-intent.v1",
  "intentId": "company-status-2026-09",
  "inputSnapshot": { "artifactId": "<snapshot>", "snapshotDigest": "sha256:<digest>", "knowledgeSeq": 42 },
  "expectedKnowledgeHead": 42,
  "onStale": "rebase_if_disjoint",
  "subjects": [{ "ref": "company", "mode": "resolved", "entityId": "<uuid>", "kind": "organization" }],
  "proposals": [{ "proposalId": "status", "kind": "fact.assert_state", "subjectRef": "company" }]
}
```

The real proposal must include all fields required by its kind, including
eligible evidence and temporal information where applicable. A draft plan is
the place to see a vocabulary failure, required review, a no-op duplicate, or
a rule rewrite before a write is attempted.

# 4. Apply once, then use the receipt

`IngestionExecutor.apply` rechecks preflight and applies admitted work through
the temporal helpers in one executor-service transaction. It records an
immutable receipt and relational receipt data. The receipt carries outcomes,
affected references, head before/after, and storage references; it is the
authority after an uncertain response. Against AI Engineer database contract 0.6.0
(head `20261031010000`) it also writes one `orchestration.operation_receipt_target` row per native row created,
reused, superseded or staged (returned as `targets`), the `research.report_v2_*` projection of an exact-use apply
(`report`), and the origin digest and Mission Control coordinates on the intent and receipt; see
[`receipt-targets.ts`](../packages/knowledge-db/src/ingestion/receipt-targets.ts). See
[`apply.ts`](../packages/knowledge-db/src/ingestion/apply.ts),
[`executor.ts`](../packages/knowledge-db/src/ingestion/executor.ts), and
[`executor.integration.test.ts`](../packages/knowledge-db/src/ingestion/tests/executor.integration.test.ts).

| Situation | Correct action | Do not |
| --- | --- | --- |
| Apply response was lost | Submit the identical intent and read the returned receipt/`duplicateOf`. | Create a new intent ID. |
| Head advanced before apply | Re-read and re-plan; only use `rebase_if_disjoint` when the planner proves no touched slot changed. | Force a stale `fail` intent through. |
| Rule or vocabulary rejects a fact | Correct the proposal or stage it for review. | Replace the code with guessed SQL. |
| A price correction targets an existing unit | Preserve the existing series key and inspect rewrites/supersedes. | Open a parallel live series. |

Tests cover response loss, duplicate handling, stale-head rejection, disjoint
rebase, snapshot forgery rejection, and existing price-series reuse.

# 5. Verify with a new read

Fetch a receipt when necessary, then issue a new named-query snapshot at the
current head. Compare the receipt's created/superseded references with the new
snapshot; a previous snapshot cannot prove a batch committed. The persisted
read path stores the intent and snapshot as separate ledger artifacts with a
`derived_from` link in
[`ReadExecutor.persist`](../packages/knowledge-db/src/db-read/read-executor.ts).

# Current limitations

- Schema, bounded-read and ingestion operations are still served by the
  executor registry. The [application catalog](../packages/application/src/operations/catalog.ts)
  records these as executor-only; the accepted `ks db` fold is future work.
  Use [execution profiles](execution-profiles-and-transports.md) before
  selecting a binary or assuming MCP parity means every group is available.

- Persistence of a read intent/snapshot is opt-in (`persist: true`); an
  ordinary snapshot has no artifact handle to cite later.
- Artifact operations can be skipped when the ledger or retained bytes are
  unavailable. Treat that as an explicit gap.
- The read executor's retrieval operation remains unavailable, while the
  separate `packages/retrieval` implementation provides a different path.
- Linked integration tests document expected behavior; running them requires
  their configured disposable database. Their presence is not a claim that
  those tests or a deployment were exercised by authoring this concept.
