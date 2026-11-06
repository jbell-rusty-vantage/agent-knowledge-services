---
name: knowledge-ingest
description: >-
  Use when verified facts must be written into the shared knowledge database: compose a
  knowledge-ingestion intent (entities, aliases, identifiers, relationships, two-clock facts,
  events, evidence support, staged candidates, reports) from a sealed verification run and a
  knowledge-db snapshot, dry-run it, apply it through the deterministic executor, inspect the
  receipt, recover from stale-head or validation failures, and verify by re-reading. You never
  write to the database yourself; the executor does, as executor_service.
allowed-tools:
  - Bash(knowledge ingest *)
  - Bash(knowledge db *)
  - Bash(knowledge artifact *)
---

# knowledge-ingest — author intents, let the executor write

`knowledge ingest` forwards to the knowledge executor (`KNOWLEDGE_EXECUTOR_URL`). The executor
plans your intent (schema, vocabularies, rules, evidence, subjects, current head), then applies
the admitted proposals in one transaction as the only identity allowed to write canonical facts
(`temporal.begin_batch` → `assert_*` → `commit_batch`). Every apply produces an immutable receipt
whether it succeeds or fails. Failures are instructions.

## Preconditions (all three, or do not start)

- a **sealed** verification run whose claims you will cite (`{ runId, claimId }`); a seal is custody, not admission;
- a **snapshot** (`06-snapshot.json`) with `snapshotDigest` and `knowledgeHead.knowledgeSeq`;
- you have read the rules page (`knowledge schema get rules/README.md`) for the entity kinds you touch.

## The proposal rule (overrides every shortcut)

1. **Cite or stage.** Every fact/relationship/event proposal cites ≥ 1 `{ runId, claimId }` from a sealed run.
   Anything you cannot cite becomes `candidate.stage` with a `reason`, or is left out.
2. **Declare time twice.** Every fact has a `worldInterval` (`from` required) and a `temporalBasis`
   (`explicit` with an `extent` quoting the date; `observation_bounded` when the source only proves "true when captured").
   Knowledge time is handled by the executor.
3. **Reference the snapshot you read.** `inputSnapshot` and `expectedKnowledgeHead` come from `06-snapshot.json`. Do not hand-edit them.
4. **One `intentId` per logical change set.** Re-submitting the *same file* is safe and returns the same receipt (`duplicateOf`), even when two submissions run at the same time.
   Changing proposals under the same `intentId` is a new intent; prefer a `-v2` suffix.
5. **Use vocabulary codes exactly** (`streamKind`, `relationshipKind`, `eventKind`, `unit`, `aliasKind`, identifier `scheme`).
   `VOCABULARY_VIOLATION` names the field and the allowed values.
6. **Never include SQL, roles, or receipt ids** in an intent.

## Sequence

### Report packages and content links were retired

Report registration, assessment and package reads, and content-link close-out, were retired in SV-17; claims, runs and seals go through ks.knowledge_operation.v2 (K01) on the knowledge_verification component.

### Preserved source receipts are inputs, not evidence

Preserve provider work instead of hiding it. `knowledge source discover <request.json>` dispatches a configured provider under durable accounting; `knowledge source import <receipt.json>` accounts for an attempt you executed elsewhere from already preserved bytes; `knowledge source select <request.json>` records which leads you selected, omitted or treated as duplicates, with reasons. Read one back with `knowledge source attempt <attemptId>`, and recover an interrupted dispatch with `knowledge source reconcile <attemptId>` — that never calls the provider again.

Imported metadata is self-reported and stays self-reported: a preserved search receipt is an untrusted discovery artifact. It can justify a `candidate.stage` reason or explain a coverage gap. It can never be the evidence behind `fact.assert_state`, and a failed or blocked attempt stays in the record rather than disappearing.

### Research staging creates identities

During research, stage what you cannot yet support: `candidate.stage` with a reason, plus `entity.create` / `entity.alias` / `entity.identifier` so later work has stable identities. Identity operations are not fact admission, and a staged candidate is not knowledge.

### Correct a stale fact in its existing slot

A correction supersedes the current segment of the existing series; it never opens a parallel series beside the stale one. Re-read the subject first (`entity.card`, `facts.history_for_stream`) and reuse the existing `scopeKey`: for prices the `price.scope_key_is_unit` rule reuses the key already in use for that unit (older data uses `input_tokens`), rewriting a conflicting `scopeKey` you supply with `reason: existing_series_reused`. Give the correction its own `worldInterval` and `temporalBasis`; adjacent intervals and controls must stay queryable at their old knowledge heads. Two live segments for one semantic slot is a defect, not a correction.

### Bounded batches, receipts and accounting

Keep one `intentId` to a coherent change set that you can diagnose as a unit: the pre-Mission-Control baseline is at most 16 evidence-bearing proposals per submitted batch. A partially admitted batch (`outcome: partial`) must still name every held and rejected proposal.

Every apply has a receipt whether it succeeded or not, and the receipt — not the response you happened to receive — is authoritative. After a lost response, re-`apply` the same file: an identical intent returns `duplicateOf` with the original `receiptId` and an unchanged head. Never mint a new `intentId` to escape an uncertain outcome. Fetch a receipt later with `knowledge ingest receipt <receiptId>` and read its artifacts with `knowledge artifact get <artifactId>`.

Write every large response to a file (`--out`) and carry handles — `receiptId`, `snapshotDigest`, `knowledgeSeq`, `artifactId` — instead of pasting whole documents. Charge planning, applying, reading back and recovery to the caller's budget, and report usage; unknown usage is unknown, never zero.

| # | stage | command | quality gate (exit 0) | file |
|---|---|---|---|---|
| 1 | compose | write `80-ingestion-intent.json` (`knowledge-ingestion-intent.v1`) from `07-gaps.md` + sealed run + `06-snapshot.json` | file parses | `80-ingestion-intent.json` |
| 2 | plan (dry run) | `knowledge ingest plan 80-ingestion-intent.json --out 81-plan.json` | `plannedOutcome ≠ rejected`; every `review_required`/`held` is one you accept; read `rewrites` and `ruleChecks` | `81-plan.json` |
| 3 | apply | `knowledge ingest apply 80-ingestion-intent.json --out 82-receipt.json` | `outcome ∈ applied \| partial \| noop`; `knowledgeBatch.knowledgeSeq` present when applied/partial | `82-receipt.json` |
| 4 | duplicate check (when asked) | `knowledge ingest apply 80-ingestion-intent.json --out 82b-receipt.json` | `duplicateOf` = first `receiptId`; `head.after` unchanged | `82b-receipt.json` |
| 5 | read back | `knowledge db read-intent 05-read-intent.json --out 83-verify-snapshot.json`; run `verify.suggestedReadIntent` from the receipt | head advanced by your batch; created ids visible | `83-verify-snapshot.json` |
| 6 | summary | `knowledge ingest receipt <receiptId>` if you need it again | — | `90-ingest-summary.md` |

### 1. Compose

```json
{ "schemaVersion": "knowledge-ingestion-intent.v1", "intentId": "<topic>-<asof>",
  "context": { "tenantId": "<from db head>", "correlationId": "<run id>", "actor": { "kind": "agent", "id": "<you>" } },
  "inputSnapshot": { "snapshotId": "<06>", "snapshotDigest": "<06>", "knowledgeSeq": <06> },
  "expectedKnowledgeHead": <06.knowledgeHead.knowledgeSeq>, "onStale": "rebase_if_disjoint", "asOf": "<date>",
  "evidence": { "verificationRuns": [ { "runId": "<sealed run>" } ] },
  "subjects": [
    { "ref": "openai", "mode": "resolved", "entityId": "<from snapshot>", "kind": "organization" },
    { "ref": "offering", "mode": "new", "kind": "model_offering", "displayName": "…", "aliases": [], "identifiers": [],
      "typedPayload": { "model_version_id": "$subject:<ref>", "provider_entity_id": "<uuid>", "offering_key": "api" }, "onMatch": "review" } ],
  "proposals": [
    { "proposalId": "p-01", "kind": "fact.assert_state", "subjectRef": "offering", "streamKind": "model_offering_price",
      "worldInterval": { "from": "2026-08-20T00:00:00Z", "to": null, "bounds": "[)" }, "amount": 2.5, "currency": "USD", "unit": "per_1m_input_tokens",
      "temporalBasis": "explicit", "extent": { "sourceText": "August 20, 2026", "precision": "day", "earliest": "2026-08-20", "latest": "2026-08-20" },
      "belief": "accepted", "evidence": [ { "runId": "<run>", "claimId": "<claim>", "role": "primary" } ] } ] }
```

Choosing the proposal kind:

| you want to say | kind | notes |
|---|---|---|
| "X exists and is a <kind>" | subject `mode: new` (the executor synthesizes `entity.create`) | `typedPayload` keys must be columns of `corpus.<kind>`; `onMatch: review` unless you are sure it is new |
| "X is also called Y" / "X has id Y in scheme S" | `entity.alias` / `entity.identifier` | idempotent |
| "A <rel> B [since/until]" | `relationship.assert` | `worldInterval` required for temporal kinds |
| "X's <stream> is/was V [from D]" | `fact.assert_state` | prices: rule `price.scope_key_is_unit` reuses the key of the subject's existing series for that unit (older data uses `input_tokens`), else defaults `scopeKey` to the unit; a `scopeKey` you give that names another key is rewritten (`reason: existing_series_reused`) |
| "On D, X <event>" | `event.assert` | `occurredDuring` + `precision` |
| "This quote also supports that fact" | `support.admit` | needs `locatorId` and a materialized claim |
| "Record these claims as evidence rows" | `claim.materialize` (+ `evidence.claims[]` text) | needs `context.attemptId` or an `exactUse` originating origin (recorded as `producer_origin_digest`); otherwise `held: attempt_or_origin_required` |
| "Observe metric M = v" | `metric.observe` | needs `metricDefinitionVersionId` |
| "I found X but cannot resolve/place it" | `candidate.stage` | no evidence needed; give `reason` |
| "Publish this report" | `report.publish` with `markdown` | stored as artifact `knowledge_report_markdown` + `research.report_version` |

### 2. Plan

`plan` writes nothing. Per proposal: `outcome` (`admitted`, `no_op_duplicate`, `review_required`, `held`, `rejected`),
`rewrites` (rules the executor applied), `actions` (the helper calls it will make). `head.rebased: true` means your
snapshot was stale but no touched slot changed, so the executor will use the current head. `errors[]` non-empty ⇒ exit 1 and `apply` refuses.
A price correction lands in the existing series: a rewrite with `reason: existing_series_reused` means the executor will
supersede the current segment under that `scope_key` instead of opening a parallel series beside the stale one.

### 3. Apply and recover

| code | what happened | do |
|---|---|---|
| `REBASE_REQUIRED` | head advanced and a proposal touches a changed slot (`details.whatChanged`, `touchedBy`), or `onStale: fail` | re-run the read intent, compare, adjust or drop touched proposals, update `inputSnapshot`/`expectedKnowledgeHead`, resubmit as `…-v2` |
| `VOCABULARY_VIOLATION` / `RULE_VIOLATION` | a code, unit, status, or currency is not allowed; `details.allowed` lists values | fix the field; if none fits, `candidate.stage` |
| `EVIDENCE_NOT_ELIGIBLE` | run not sealed or claim not in the run | cite a run sealed through ks.knowledge_operation.v2 (K01) on the verification component, then resubmit |
| `SUBJECT_MERGED` / `SUBJECT_UNKNOWN` / `SUBJECT_MATCH_EXISTS` | entity merged, missing, or already exists | use `details.mergedInto` / the match; re-snapshot |
| `REVIEW_REQUIRED_ONLY` | nothing admissible | report it; do not force |
| `BATCH_OPEN` / `DB_UNAVAILABLE` | transient | the executor already retried; wait and `apply` again (idempotent) |
| `DUPLICATE_PENDING` | the same intent was submitted in parallel and the winning submission had no receipt within 30 s (`details.intentId`) | wait, then `apply` again: it returns the winner's receipt as `duplicateOf` |

A rejected apply still has a receipt (`outcome: rejected`, `failure.code`); record its `receiptId`.

### 5–6. Verify and summarize

`90-ingest-summary.md`: intentId(s), idempotencyKey, receiptId(s) with outcomes, head before → after, per-proposal outcomes and
created ids, duplicate check result, what `entity.what_changed` reported, rejected attempts and why, files written.

## Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | success — includes `duplicateOf`, `partial`, `noop`, and rebased applies | read `outcome` and `proposals[].outcome` |
| 1 | quality gate failed (`INTENT_SCHEMA_INVALID`, `EVIDENCE_NOT_ELIGIBLE`, `VOCABULARY_VIOLATION`, `RULE_VIOLATION`, `REBASE_REQUIRED`, `SUBJECT_*`, `REVIEW_REQUIRED_ONLY`, `DUPLICATE_PENDING`, plan rejected) | fix per the table and re-run from `plan` |
| 2 | usage / network / executor (`WORKSPACE_STALE`, `HEAD_MISMATCH`, `DB_UNAVAILABLE`, `ROLE_DENIED`) | stop and report |

## MCP equivalents

`ingest_plan`, `ingest_apply`, `ingest_receipt`, `artifact_get`, `source_discover`, `source_import`, `source_attempt`, `source_reconcile`, `source_select` on the executor's `/mcp`. Each tool takes the same input object as its CLI command.
