# Research reports v1

Implemented against DB Contract **0.4.0**, migration head `20260913020000`. The canonical [table contract](../../../aiengineer/ai-engineer-db-contract/docs/knowledge-model/REPORTS.md) owns the schema. [Cloud smoke evidence](report-package-smoke.json) records upload/readback, exact span replay, both authoring modes and tenant isolation in a dedicated synthetic test tenant. This does not attest general pre-Mission-Control readiness or production deployment of the executor process.

## Create and retrieve

The verification executor catalog exposes the same operation through CLI, HTTP and MCP:

```sh
knowledge report register report.json --tenant <tenant-uuid>
knowledge report get <report-version-uuid> --tenant <tenant-uuid>
knowledge artifact get <artifact-uuid> --tenant <tenant-uuid>
```

MCP names: `report_register`, `report_get`. HTTP uses `POST /knowledge/report_register` with `{ "tenantId": "...", "report": { ... } }`, and `POST /knowledge/report_get` with `{ "tenantId": "...", "reportVersionId": "..." }`. Existing executor authentication/configuration applies.

`ReportStructureSchema` and `ReportService` are exported by `@aiengineer/knowledge-ingestion`. The schema is in `packages/ingestion/src/reports/structure.ts`. It requires report/revision UUIDs, a positive version, title/slug/type/purpose, scope and cutoff, producer identity/version, sections and research questions. Optional producer attempt references must resolve to an actual tenant-owned attempt. It accepts `authoringMode: incremental | post_research` with the same lifecycle and no mandatory mission identity.

Each section has a stable key, heading, kind, explanatory blocks, optional question/conclusion/context, and exact section-revision dependencies. Blocks accept Markdown: prose, tables, code and captions. Each declared assertion has a stable key, a UTF-16 `[start,end)` range within its block, kind, qualifiers, derivation and run-qualified claim references. KS derives final offsets after rendering headings; it does not normalize Unicode or rephrase claims. Claim references include an evidence-manifest artifact ID and digest, a claim digest, role and optional canonical claim ID. The evidence manifest must already be registered and available for this tenant.

Questions record coverage independently from assertion support. Partial/unanswered/conflicting/out-of-scope answers retain explanations, required flags and evidence still needed. Answered/partial/conflicting questions point to actual sections. Synthetic examples do not constitute factual knowledge.

For remote custody configure the existing `KNOWLEDGE_ARTIFACT_STORAGE=supabase` settings and server credentials. Reports use the fixed private `research-reports` bucket; other ingestion ledger artifacts retain their configured bucket. Artifact reads dispatch by registered bucket. Local mode persists report bytes locally and returns `storage_pending`, not a remote durability claim.

## Registration, verification and ingestion

Registration stores structured JSON, generated Markdown and a manifest; verifies uploaded bytes by readback; checks input references; writes the database projections; and seals when artifacts are available. The result returns `registration: sealed | storage_pending` and `admission: not_evaluated`. Retrying identical revision bytes is idempotent. A reused revision ID with different bytes rejects. After actual storage reconciliation, retry can seal a previously pending registration. A revision's content is never edited in place.

The package can be authored while facts are being ingested, or afterward from input artifacts. Add an optional binding to an ordinary ingestion proposal:

```json
{
  "reportBinding": {
    "reportVersionId": "93000000-0000-7000-8000-000000000102",
    "assertionKey": "release-date"
  }
}
```

The binding is provenance, not admission evidence. Existing evidence, policy, temporal and identity requirements still apply. The executor attaches the resulting proposal/receipt/canonical references in the same transaction. Report reads include sections, assertions, claim bindings, question coverage, dependencies, ingestion links and artifact metadata.

`report_get` also returns append-only `report_assessment` links recorded after sealing. Each binds a result artifact to the exact report digest and, when available, its canonical verification run. KS must evaluate authoritative verifier/policy results before promotion; the report service itself returns `admission: not_evaluated` even when assessment links exist.

The existing legacy `report.publish` proposal remains a separate compatibility path. It does not silently convert old reports to v1 or imply that a v1 registration has passed report verification. The pre-MC plan must finish authoritative evidence admission, independent omitted-assertion detection, final-report semantic verification, selected publication and invalidation. Registered content is not automatically eligible for official retrieval, articles or courses.

## Validation

- Unit and isolated PostgreSQL tests: `packages/ingestion/src/reports/*.test.ts`; set `REPORT_TEST_DATABASE_URL` to an explicitly named local `disposable_*` database for integration tests.
- Database behavioral tests: DB Contract `supabase/tests/research_report_packages.sql` (rollback-only).
- Identified cloud custody proof: `scripts/prove-report-packages.mjs --project-ref=wkythqbofmckbuoothhn`, using environment-supplied credentials and a trusted server certificate. The script retains two immutable synthetic revisions in a dedicated test tenant and does not admit graph facts.
