---
name: knowledge-db
description: >-
  Use when you must read the shared knowledge database: check what it already contains about a
  subject, run named catalog queries (entity resolution, cards, point-in-time facts, history,
  what_changed, vocabularies, receipts) and record a reproducible snapshot with a knowledge head
  and digest that an ingestion intent can cite. Also use to read back and diff after an
  ingestion. Never writes; use knowledge-ingest to change the database.
allowed-tools:
  - Bash(knowledge db *)
  - Bash(knowledge artifact *)
  - Bash(knowledge health)
---

# knowledge-db — reproducible reads (CLI surface)

`knowledge` forwards to the knowledge executor (`KNOWLEDGE_EXECUTOR_URL`), which runs every read
under a bounded database role (`app_reader` or `pipeline_agent`) in a read-only transaction and
returns one JSON document. You never hold a database credential.

## Preflight

```bash
knowledge health --out 04-health.json      # knowledge.headMatches must be true
knowledge db head                          # knowledgeHead.knowledgeSeq = the tenant clock; write it down
mkdir -p /workspace/run && cd /workspace/run
```

If `health` reports `headMatches: false`, or any command returns `WORKSPACE_STALE` / `HEAD_MISMATCH` (exit 2), stop and report.

## The snapshot rule (overrides ad-hoc querying)

1. **Every read you rely on is in a snapshot.** Exploration with `knowledge db sql` is fine, but
   facts you cite or build proposals on come from `knowledge db read-intent` (`05-read-intent.json` →
   `06-snapshot.json`). Its `snapshotDigest` and `knowledgeHead.knowledgeSeq` are what `knowledge ingest` requires.
2. **Knowledge head, not timestamps.** Freshness is `knowledgeSeq`.
3. **"Current" hides history.** `entity.card` shows facts valid now as known now. For "what was true on D" use
   `entity.at` with `at=D`; for "what did we learn between heads" use `entity.what_changed`; for a stream's history use `facts.history_for_stream`.
4. **Empty is a finding.** `entity.resolve` with every `score < 0.9`, or a card with no facts, means the database lacks it. Record it in `07-gaps.md`; do not invent.
5. **Catalog first, SQL last.** `knowledge schema manifest` lists every catalog entry with its params and role. `knowledge db sql` runs ONE `SELECT`/`WITH` as `pipeline_agent`, read-only, capped, and its rows are never evidence.

## Sequence

| # | stage | command | quality gate (exit 0) | file |
|---|---|---|---|---|
| 1 | health | `knowledge health` | `headMatches: true` | `04-health.json` |
| 2 | pick queries | `knowledge schema manifest` → `catalogEntries` | you can name each query + params | — |
| 3 | probe | `knowledge db sql "select …" --limit 20` (exploration only) | rows or an explicit empty | — |
| 4 | compose | write `05-read-intent.json` (`knowledge-read-intent.v1`) | file parses | `05-read-intent.json` |
| 5 | snapshot | `knowledge db read-intent 05-read-intent.json --persist --out 06-snapshot.json` | `snapshotDigest` present; no op `status: error`; check `skipped` ops | `06-snapshot.json` |
| 6 | gaps | list missing / stale / conflicting / unsupported facts, each naming the snapshot `opId` | every gap cites an opId | `07-gaps.md` |

### 4–5. Read intents

```json
{ "schemaVersion": "knowledge-read-intent.v1", "intentId": "openai-baseline",
  "context": { "tenantId": "<from db head>", "correlationId": "<run id>", "actor": { "kind": "agent", "id": "<you>" } },
  "operations": [
    { "opId": "resolve", "kind": "named_query", "query": "entity.resolve", "params": { "text": "OpenAI" } },
    { "opId": "card",    "kind": "named_query", "query": "entity.card",    "params": { "entity_id": "$resolve.rows[0].entity_id" } },
    { "opId": "at",      "kind": "named_query", "query": "entity.at",      "params": { "entity_id": "$resolve.rows[0].entity_id", "at": "2026-03-15T00:00:00Z" } },
    { "opId": "head",    "kind": "named_query", "query": "knowledge.head" } ] }
```

- Later operations reference earlier results: `$<opId>.rows[<n>].<column>` or `$<opId>.value.<path>`.
  An unresolved reference skips that operation (`status: skipped`, `reason: REF_UNRESOLVED`); it does not fail the snapshot.
- Parameters are validated against the catalog JSON Schema (`PARAMS_INVALID` lists the path); unknown queries are `QUERY_UNKNOWN`.
- Row caps: default 200, `limit` up to 2000; `status: truncated` means rows were cut.
- `--persist` stores intent and snapshot as `orchestration.artifact` rows (types `knowledge_read_intent`, `knowledge_read_snapshot`); `storage.artifactId` is what `knowledge artifact get <id>` returns.
- `headChanged: true` means a batch committed while you read; re-run before citing.

### 6. Gap notes

`07-gaps.md` has four sections — **Missing**, **Stale** (`valid_during` ended, old `k_from`, `observation_bounded` before the as-of date),
**Conflicting** (`belief: disputed`, sources disagree), **Unsupported** (no `primary_claim_id`). Each line: subject, stream/relationship kind,
current value, snapshot `opId`, what evidence would resolve it. This file is the research plan for `knowledge-verify`.

## Compact reads and receipt reconciliation

Large snapshots belong in files, not in the conversation: always pass `--out <file>` and carry the
handles — `snapshotDigest`, `knowledgeHead.knowledgeSeq`, `storage.artifactId`, per-op `contentDigest`
— forward. Read persisted bytes back with `knowledge artifact get <artifactId>` when you actually
need them. Charge reads to the caller's budget and report usage; unknown usage is unknown, not zero.

An uncertain write is settled by reading the authoritative receipt, never by re-reading rows and
guessing: `knowledge ingest receipt <receiptId>` returns the stored receipt, and a repeated apply of
the identical intent returns `duplicateOf` with an unchanged head. A read snapshot observes; it does
not prove that a batch committed.

## Corrections keep their existing slot

When you check whether a stale fact was corrected, look at the **existing** series rather than at a
new one. `facts.history_for_stream` shows the segments for one stream; a correction supersedes the
current segment under the same `scope_key`, so two live segments for one semantic slot is a defect
to report, not two competing facts to average. `entity.at` with `at=<date>` and `entity.what_changed`
between two heads tell you what was believed when, and the original evidence stays readable at the
old head.

## After an ingestion: read back

```bash
knowledge db read-intent 05-read-intent.json --out 83-verify-snapshot.json      # same intent, new head
```
Add an `entity.what_changed` op with `k_from` = head before, `k_to` = head after (the receipt's `verify.suggestedReadIntent` is ready-made).
`knowledgeHead.knowledgeSeq` must have advanced by exactly your committed batches; per-op `contentDigest` changes must be explained by the receipt's `proposals[].created` / `supersedes`.

## Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | success (possibly with `skipped`/`truncated` ops) | read the JSON |
| 1 | `QUERY_UNKNOWN`, `PARAMS_INVALID`, `LIMITS_EXCEEDED`, `ROLE_DENIED` (requested role above catalog role), `SQL_*` guard refusals, an op `status: error` | fix the intent or SQL |
| 2 | `WORKSPACE_STALE`, `HEAD_MISMATCH`, `DB_UNAVAILABLE`, network/auth | stop and report the code |

## MCP equivalents

`db_head`, `db_read_intent`, `db_sql_readonly`, `db_explain`, `artifact_get`, `schema_manifest` on the executor's `/mcp`. Each tool takes the same input object as its CLI command.
