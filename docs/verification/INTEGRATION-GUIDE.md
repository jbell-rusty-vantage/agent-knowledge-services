# Verification integration guide

For Mission Control, Eve, Cursor Cloud agents, dashboards, and other services. Call HTTP, CLI, or MCP. Do not import `@aiengineer/knowledge-verification`. Do not call provider SDKs from agents.

**SV-17.** Claims verification, run sealing, report registration/assessment and exact-use admission go through [Knowledge Operation Protocol v2](#knowledge-operation-protocol-v2) on the `knowledge_verification` component (2.4.0). The `verification.v1` envelope below now covers only capture, parse, structured extraction, extraction verification, extraction replay and benchmarks. The claims, report, metric, adjudication, audit-bundle, semantic, run/case read, drift and recovery operations, their routes, MCP tools, CLI commands and client methods were removed; retired configuration is refused at startup (`VERIFICATION_RETIRED_CONFIGURATION:<NAME>`).

## Operation envelope

The durable HTTP envelope is **not** a caller-supplied `OperationContext` body. The API authenticates the bearer, reads `x-tenant-id`, and builds a trusted `OperationContext` from ownership grants plus optional hints.

### `OperationContextSchema` (CLI `--context`, generic operations)

Required: `tenantId`, `operationId`, `attemptId`, `correlationId`, `actor`, `capabilityVersion`, `idempotencyKey`, `reason`, `contractVersion`. Schema-optional: `projectId`, `workItemId`, `missionId`, `causationId`, `externalExecution`.

CLI generic commands parse this full schema even though verification HTTP mutations send only tenant, correlation, idempotency, and hints as headers (`x-verification-attempt-id`, `x-verification-work-item-id`, `x-verification-mission-id`, `x-causation-id`, `x-external-*`).

### `VerificationOperationContextHintsSchema` (HTTP hint headers)

Schema-optional: `attemptId`, `workItemId`, `missionId`, `causationId`, `externalExecution`.

Against an API configured with `VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON` (the production path), CLI `--context` / MCP `context` / these hint headers must carry `attemptId` + `missionId` + `workItemId` that match an ownership grant (tenant, bearer actor, mission) and existing `orchestration.attempt` / `work_item` / `mission` rows with the grant's `agentDeploymentId`. Otherwise **403** `"Verification operation ownership denied"`. In legacy static mode (`VERIFICATION_SERVICE_ATTEMPT_ID` without grants), `attemptId` must equal that server value.

`externalExecution`: `runtime` (`eve` | `vercel_workflow` | `mission_control` | `other`), `runId`, optional `rootRunId`, `sessionId`, `turnId`, `toolCallId`.

Typed client context (`VerificationClientContext`): `tenantId`, `correlationId`, `idempotencyKey`, plus the same hint fields. On the production ownership path those three IDs are required even though the schema marks them optional.

## Headers

| Header | Role |
| --- | --- |
| `Authorization: Bearer <token>` | Identity from `KNOWLEDGE_API_IDENTITIES` (or deployed resolver) |
| `x-tenant-id` | Tenant UUID (required except profile capture) |
| `x-correlation-id` | Correlation string; API may assign one if absent |
| `Idempotency-Key` | Mutations only; trim length 8–255 |
| `x-verification-attempt-id` | Hint `attemptId` |
| `x-verification-work-item-id` | Hint `workItemId` |
| `x-verification-mission-id` | Hint `missionId` |
| `x-causation-id` | Hint `causationId` |
| `x-external-runtime` | `externalExecution.runtime` |
| `x-external-run-id` | `externalExecution.runId` |
| `x-external-root-run-id` | optional |
| `x-external-session-id` | optional |
| `x-external-turn-id` | optional |
| `x-external-tool-call-id` | optional |

Profile capture (`POST /v1/verification/benchmark-capture-profiles/:profileName/captures`) sends Bearer + `x-correlation-id` + `Idempotency-Key` only. No caller ownership headers.

## 202 receipt and polling

Mutations return **202** `AcceptedOperationSchema`:

Receipt `statusUrl` / `eventStreamUrl` / `cancellationUrl` / `retryUrl` / `reconcileUrl` are built as `/v1/operations/{id}` (and `:cancel` / `:retry` / `:reconcile`). Example:

```json
{
  "operationId": "00000000-0000-4000-8000-000000000009",
  "state": "queued",
  "contractVersion": "v1",
  "statusUrl": "https://knowledge.example/v1/operations/00000000-0000-4000-8000-000000000009",
  "eventStreamUrl": "https://knowledge.example/v1/operations/00000000-0000-4000-8000-000000000009/events",
  "cancellationUrl": "https://knowledge.example/v1/operations/00000000-0000-4000-8000-000000000009:cancel",
  "retryUrl": "https://knowledge.example/v1/operations/00000000-0000-4000-8000-000000000009:retry",
  "reconcileUrl": "https://knowledge.example/v1/operations/00000000-0000-4000-8000-000000000009:reconcile"
}
```

1. Poll `GET /v1/verification/operations/{id}` (`knowledge.read`) — or the receipt `statusUrl` `GET /v1/operations/{id}` — until a terminal state: `succeeded`, `needs_review`, `failed`, `cancelled`, `quarantined`. Prefer the verification-aware route. CLI: `ks verify status --input '{"operationId":"<uuid>"}'` (`getVerificationOperation`). MCP: `verify_status` `{context:{tenantId,correlationId},operationId}` (spec §19 `knowledge_get_operation`). `ks knowledge operation status` calls generic `GET /v1/operations/{id}`.
2. Then GET the family terminal resource (`/v1/verification/captures/{id}`, `/extractions/{id}`, `/benchmarks/{id}`, `/benchmarks/comparisons/{id}`, …).

KS operation `state` values: `queued` | `running` | `needs_review` | `quarantined` | `succeeded` | `failed` | `cancelled`.

## Typed client (`@aiengineer/knowledge-client`)

Verification methods used by `CliKnowledgeClient` / MCP:

| Method | Kind |
| --- | --- |
| `captureVerificationSource` | mut |
| `captureVerificationSourceWithProfile` | mut (no tenant header) |
| `parseArtifact` | mut |
| `extractStructuredData` | mut |
| `verifyExtraction` | mut |
| `runBenchmark` | mut |
| `compareBenchmarkRuns` | mut |
| `replayVerificationRun` | mut |
| `applyProviderReconciliation` | mut |
| `getVerificationOperation` | read |
| `getVerificationCaptureResult` | read |
| `getStructuredExtraction` | read |
| `getBenchmarkRun` / `getBenchmarkRunManifest` | read |
| `getBenchmarkComparison` | read |
| `getProviderReconciliation` | read |
| `retryOperation` / `reconcileOperation` | control |

`KnowledgeClientError` wraps problem details when `response.ok` is false.

## Failure taxonomy

| Layer | Meaning |
| --- | --- |
| Execution `succeeded` | Worker finished. Inspect terminal resource for policy/quality. |
| Execution `needs_review` | Held for review. CLI `--wait` exit **1**. Escalate to review; do not retry or override. |
| MC `completed` + `review_required` | Successful execution with a held result. Not an infrastructure failure. |
| `CAPABILITY_NOT_ADMITTED` **503** | Flag/JSON/service missing. Do not treat as a quality fail. |
| Quality fail | Terminal `valid === false`, comparison `engineeringGateOutcome === "fail"`, policy `fail`. CLI `--wait` exit **1**. |
| Infrastructure | Timeout, `failed` / `cancelled` / `quarantined`, missing receipt, unhandled `--wait` kind (`VERIFICATION_WAIT_UNSUPPORTED_KIND`), transport error. CLI exit **2**. |
| `FORBIDDEN` **403** | Ownership, projection grant, or reviewer identity denied. |
| `INVALID_CONTRACT` **400** | Missing/short `Idempotency-Key` or schema mismatch. |

Provider errors, harness failures, quality failures, and policy rejection are distinct (`OperationFailureSummary.category`, `qualityFailure`).

## Request examples

Shapes checked against Zod in `packages/contracts/src/verification/requests.ts`. Only fields that exist are shown.

### Registered capture (`CaptureSourceRequestSchema`)

```json
{
  "verificationContractVersion": "verification.v1",
  "source": {
    "mode": "register",
    "sourceKind": "web_page",
    "sourceId": "capture-1",
    "contentArtifact": {
      "artifactId": "00000000-0000-4000-8000-000000000011",
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  },
  "requestedProjectionKinds": ["html_dom"]
}
```

`mode: "acquire"` uses `sourceKind` + credential-free `sourceUri` instead of `sourceId`/`contentArtifact`. Zod allows 1–4 unique values from `native_text`, `canonical_json`, `html_dom`, `pdf_text`, `geometry`, `ocr_geometry`, `table_grid`, `transcript`. The application admits only two shapes: `sourceKind:"web_page"` with exactly `["html_dom"]`, or `mode:"acquire"` + `sourceKind:"pdf"` with exactly `["pdf_text","geometry"]`. Other combinations → `VERIFICATION_CAPTURE_MODE_NOT_ADMITTED`.

### Verify extraction (`VerifyExtractionRequestSchema`)

```json
{
  "verificationContractVersion": "verification.v1",
  "captureIds": ["capture-1"],
  "extractionSchema": {
    "artifactId": "00000000-0000-4000-8000-000000000012",
    "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "extractionOutput": {
    "artifactId": "00000000-0000-4000-8000-000000000014",
    "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  }
}
```

`captureIds`: unique, length 1–100. Digests are `sha256:` + 64 hex. Claims verification is no longer a `verification.v1` request; submit `verify.claims` or `report.register` over K01.

### Replay (`ReplayRunRequestSchema`)

```json
{
  "verificationContractVersion": "verification.v1",
  "runId": "00000000-0000-4000-8000-000000000013",
  "replayMode": "deterministic_only"
}
```

`replayMode` is `deterministic_only` or `recorded_provider_outputs`. HTTP path `runId` must equal the body. Replay covers extraction runs only.

## Integration lanes

### Mission Control

Capability dispatch adapter: `../ai-engineer-mission-control/apps/api/src/verification-temporal.ts` and `verificationWorkflow`. Launch uses `REJECT_DUPLICATE`. The future parent mission/node workflow replaces harness-seeded orchestration rows. Do not copy verification algorithms into MC.

Keep execution state separate from admission disposition. Dashboard configuration: `../ai-engineer-mission-control/docs/VERIFICATION-CPH-RECEIPTS.md`. The internal drift revalidation queue (`/v1/system/verification-drift-*`, scope `verification.drift.consume`) was retired in SV-17 with its AIDB outbox; Mission Control's KNOWLEDGE_* settings for K01 are in `platform/mission-control/docs/MISSION_CONTROL_LOCAL_API.md`.

Propagate `missionId`, `workItemId`, `attemptId`, and `externalExecution` (`runtime: "mission_control"`) as hint headers.

### Eve signed runtime bridge (retired)

The Eve runtime attestation for `verifyClaims` / `verifyReport` was retired in SV-17 with those use cases. `VERIFICATION_EVE_RUNTIME_ATTESTATION_KEYS_JSON` is refused at startup, and an ownership grant carrying `eveRuntimeAuthority` is rejected. Eve submits through K01 with a K07 issuer credential like any other origin.

### Cursor Cloud

CLI or HTTP only. Propagate mission / work-item / attempt IDs as hints. Never call provider SDKs from the agent. Never copy KS algorithms into the cloud skill. Skills should invoke `knowledge` or the typed client against the live API.

### Dashboard

Reads and controls go through supported MC/KS HTTP only. No direct database mutation. No generic verification promotion/suspension durable command yet.

### Biotech graph binding (K06, Sprint V)

Package `@aiengineer/knowledge-binding-biotech-graph` (`packages/bindings/biotech-graph`). Status: engineering proof on disposable stores only; nothing is deployed.

- Operational records (task, run, report, observations, seal, decisions, operations) live in the `knowledge_verification` component installed in the Biotech application PostgreSQL (installation `biotech`, binding `biotech-graph`). The graph is never a run store. Report bodies and ledgers use the component `artifact_custody`.
- `BiotechGraphAdmission.admitExactUse` runs one PostgreSQL transaction: `admit_exact_use`, then (only when admitted) `bind_effect`, the inline `biotech-knowledge-admission.v1` payload row, and `enqueue_dispatch` with marker scheme `ks-intent-marker.v1`. It returns receipt state `pending_dispatch`. A held or rejected decision writes nothing.
- Native payload bytes are the RFC 8785 (JCS) bytes of the `biotech-knowledge-intent.v2` object. The bound effect digest is K01 `boundEffectDigest` over those bytes and the originating origin. The `report.publish` proposal must carry the frozen revision's ids and digests.
- Delivery: `BiotechGraphDelivery.deliver` push-triggers `POST /kg/admission/dispatch/consume` on the BKS executor, then reconciles from the component row and the principal-scoped v3 `marker` read. A receipt is `applied` only after a verified acknowledgment. There is no native cancellation: `stopDispatch` revokes pending dispatches and reconciliation follows.
- Official reads: v3 `report` with `use.officialUse: true`. The binding recomputes the result digest and serves a report only when its eligibility item is eligible and the graph Report carries the frozen kind and body, ledger and structured-body digests.
- Environment variable names: `KS_BIOTECH_EXECUTOR_URL`, `KS_BIOTECH_EXECUTOR_TOKEN` (BKS token class `service`, role `writer`, grant `admission.dispatch`, the component tenant), `KS_BIOTECH_EXECUTOR_READ_TOKEN` (optional reader), `KS_BIOTECH_EXECUTOR_TIMEOUT_MS`.

## Knowledge Operation Protocol v2

The verification executor (`apps/verification-executor`, `knowledge-verify serve`, default `127.0.0.1:4310`) exposes `ks.knowledge_operation.v2` (K01, package `@aiengineer/knowledge-operation-protocol`) over HTTP and MCP, authenticated by K07 issuer credentials. Status: engineering proof (Sprint V SV-16) on disposable stores only; nothing is deployed. Code: the service, K07 validation, the backend port and its `BackendRegistry` live in `packages/host/src/knowledge-operation/` (subpath `@aiengineer/knowledge-host/knowledge-operation`); each binding package exports its backend as `BACKEND` (`@aiengineer/knowledge-binding-aiengineer-postgres`, `@aiengineer/knowledge-binding-biotech-graph`; the in-memory one is the host's `IN_MEMORY_BACKEND`), and the executor composes the registry in `apps/verification-executor/src/serve.ts` (`KNOWLEDGE_BACKENDS`). `KS_KNOWLEDGE_BINDINGS_JSON` names registry ids; an unregistered id refuses at startup (`UNKNOWN_BINDING`). The executor keeps the HTTP and MCP adapters in `apps/verification-executor/src/knowledge-operation/`.

### Routes

Bodies are exactly the K01 JSON Schemas (`packages/knowledge-operation-protocol/schemas/`).

| Route | Body | Answer |
| --- | --- | --- |
| `POST /knowledge-operation/v2/invoke` | `operation-envelope.v2` | `operation-receipt.v2` (200) for `report.register` and `knowledge.apply`; `knowledge-plan-preview.v1` (200) for `knowledge.plan_preview`; `operation-handle.v2` (202) for `report.assess`, `report.derive`, `knowledge.read`, `verify.claims` and the trusted assessment operations `report.observe`, `report.seal`, `report.decide`, `report.review`, `decision.resolve` |
| `GET /knowledge-operation/v2/operations/{operationId}` | — | `operation-status.v2`. While not terminal, `retryAfterMs` is bounded to 100..300000 and mirrored as `Retry-After` |
| `POST /knowledge-operation/v2/operations/{operationId}/cancel` | `{"cancelRequestId"}` | `operation-status.v2`. Idempotent: the first cancel request id is kept, and a terminal operation is unchanged |
| `GET /knowledge-operation/v2/receipts/{effectKey}` | — | `receipt-lookup.v2`: `found`, `not_found` (never proof that nothing was applied) or `unresolved` |
| `GET /knowledge-operation/v2/describe` | — | `binding-descriptor.v2`: operations, report kinds, guarantees, signing issuer, pinned component (`knowledge-verification-<version>` and its release digest), qualification receipts |
| `GET /knowledge-operation/v2/artifacts/{artifactId}?digest=sha256:...` | — | Exact custody bytes re-verified against the digest (report body, ledger, package manifest). This is an executor extension: K01 v2 has no bytes route. It needs a `knowledge.read` grant |

The handle scope (tenant, application, binding) is always the credential's. MCP tools on `/mcp` call the same service in process: `knowledge_operation_invoke`, `knowledge_operation_get`, `knowledge_operation_cancel`, `knowledge_receipt_get`, `knowledge_describe`. Their credential travels in the `X-Knowledge-Operation-Credential` header, never in tool arguments. Over stdio there is no credential, so every tool refuses.

### Operations

| Operation | Behaviour |
| --- | --- |
| `report.register` | Native contract `research-report/v2`, inline `{task, fragments, assertions, supportSets, report:{reportId, revision, kind, structuredBody, timeCoverage, supersedes}}`. Binds the effect (component `bind_effect`), answers an existing receipt first, answers an applied registration's receipt first, then validates the whole registration (records, structured body, report kind, rendering, the producer ledger and the revision record, an existing superseded revision) and preflights every record id and digest against the store before the first write, so a refusal writes no record; then it registers the evidence (write-once, idempotent for identical bytes), opens a run and registers the report against its pinned K08 kind. It is not one transaction: an infrastructure failure mid-write can leave write-once records; a retry with the same content heals (identical records are re-used), but those orphans block registering other content under the same ids (rename them). A record id another registration holds with other bytes refuses `EFFECT_CONFLICT` with `details.reason = record_id_conflict` (`record`, `id`); the same bytes under another id refuse `record_digest_exists` (never `INTERNAL`). The K01 receipt is persisted with the component `effect_receipt` row. The producer cannot submit judge, auditor or reviewer observations |
| `report.assess` | `ReportAssessmentService.start`; the in-process runner executes the independent census and aggregation. It refuses `INDEPENDENCE_UNPROVEN` when no auditor is configured |
| `knowledge.read` | Native contract `selected-report-read/v2` (published `selected-report-read.v2`): `{report: Ref<report>, exact: true, purpose, selection}` where `selection` is `{mode: "revision"}` or `{mode: "members", assertions: Ref<assertion>[], evidence: Ref<fragment>[]}` (sorted by id). It freezes exactly the selection as a `research-report-package.v2` manifest (published schema): a revision read re-verifies and carries body and ledger plus every assertion and evidence record; a members read carries only the selected records, each under its exact handle (record canonical digest = handle digest). The purpose is recorded, not a use decision. Refusals carry `details.reason`: undeclared purpose or malformed selection `INVALID_ENVELOPE`, a foreign handle `SCOPE_DENIED`, an unknown member `NOT_FOUND`, an unknown revision or edited member `EXACT_REVISION_UNAVAILABLE`; the retired `research-report-package/v1` refuses `SCHEMA_UNSUPPORTED` |
| `knowledge.apply` | AI Engineer: the native exact-use ingestion transaction (SV-08; `knowledge-ingestion-intent/v1` with `exactUse`) when the AI Engineer knowledge database is configured, otherwise `SCHEMA_UNSUPPORTED`. Biotech: exact-use admission plus outbox enqueue in one PostgreSQL transaction (`biotech-knowledge-apply/v1` = `{intent, exactUse}`); the receipt outcome is `pending_dispatch` until the BKS acknowledgment verifies. `effect.boundEffectDigest` is the plan-level digest the use decision binds; `semanticPayloadDigest` is diagnostic. The K01 receipt is persisted in component `protocol_receipt`, so `receipt.get` answers `found` |
| `knowledge.plan_preview` | AI Engineer only (listed next to `knowledge.apply` when its port previews). Read-only: the same envelope as `knowledge.apply` (same binding, tenant, `knowledge-ingestion-intent/v1` inline intent with `exactUse.effectKey` and `exactUse.originatingOrigin`; `effect` may be the apply's binding, whose `boundEffectDigest` is ignored, or null), sent with `operation: "knowledge.plan_preview"` and a non-effect credential granting it. The intent's decision fields (`useDecisionId`, `boundEffectDigest`, `processedEpoch`, `normalizedValuesDigest`) may be absent and are ignored. Answers `knowledge-plan-preview.v1` `{planId, semanticPayloadDigest, boundEffectDigest, normalizedValuesDigest, processedEpoch, migrationHead}`: what `knowledge.apply`'s own planning computes for the same request in the same database state (`processedEpoch` is the authoritative revocation epoch; `normalizedValuesDigest` is the digest the intent presents, else the digest of `{}`). It binds, journals and admits nothing. Refusals are those of `knowledge.apply` before admission |
| `verify.claims` | Retired with the executor's file-store verifier chain in SV-17; it answers `SCHEMA_UNSUPPORTED`. Register the run's evidence with `report.register` and assess it with `report.assess` on the component |
| `report.observe` | Sprint OC WI-03. Native contract `report-observation/v1` (published `report-observation.v1`): `{report, observations: VerificationObservation[], census}`. The caller's evaluator role is the credential's `evaluation` grant (`judge`, `second_family_judge` or `auditor`); a payload naming another role or vendor refuses `ORIGIN_MISMATCH` (`evaluator_identity_conflict`), and the producer's own subject or operation refuses `INDEPENDENCE_UNPROVEN` (`evaluator_is_producer`). Only an auditor submits `census` (its independent discovery pass; the coordinator reconciles it into one census observation). A sealed run takes none (`EFFECT_CONFLICT`, `run_sealed`) |
| `report.seal` | `report-seal/v1`: `{report, build}`. Seals the run's verification snapshot with the executor's K07 seal key; the result names the exact `verification_run` and `run_manifest`. A repeated seal answers the same run. No seal key: `CAPABILITY_UNAVAILABLE` (`seal_key_unconfigured`). A key the installation's `knowledge_verification.seal_signing_key` registry does not pin `active`: `CAPABILITY_UNAVAILABLE` (`seal_key_unregistered` / `seal_key_inactive`, `details.keyId`); register its public half with `knowledge-db seal-key` (the root installers' `seal-key` step). These `seal_key_*` reasons are a provisioning gap, not a transient fault: although the code class is retryable, callers must not auto-retry `report.seal`; hold for the operator and retry once the key is pinned |
| `report.decide` | `report-use/v1`: `{report, subject, use, audience, purpose, boundEffectDigest, targetSchema, normalizedValues, policy, rubric, expiresAt}`. An exact use decision of the sealed revision (or one assertion) under the K08 use classes and judgment policies; `purpose` (`official`, `review_repair`) is recorded and never changes the disposition. An unsealed run refuses `EXACT_REVISION_UNAVAILABLE` (`run_not_sealed`). A governed judgment is admitted only with `review_required` and carries `judgment_not_entailed:<id>` |
| `report.review` | `report-review/v1`: `{decision, outcome, boundEffectDigest, qualifiersDigest, rationale}`. The reviewer is the credential subject under a `human_reviewer` grant; a live reviewer grant covering the use, audience and report kind is required (`SCOPE_DENIED`, `reviewer_not_qualified`; provision one with `knowledge-verify grant-reviewer`, idempotent per reviewer and exact scope); digests other than the decision's refuse `STALE_DECISION` (`review_binding_mismatch`); a superseded decision refuses `STALE_DECISION` (`decision_superseded`), except the same reviewer's replay, which answers its successor. The successor decision is persisted with a signed `decision_snapshot` |
| `decision.resolve` | `decision-resolve/v1`: `{decision}`. Follows the successor chain to the current decision and checks its current exact-use eligibility read-only (component `check_use_eligibility`); answers `use-decision-resolution.v1` with `admissibility`, `reviewPending` and the judgment-covered ids. Durable: a fresh executor resolves the same successor |
| `report.derive` | Native contract `research-report-derive/v1`, `{report, mapping}`. The research-core deterministic compiler over the exact revision and the support of the run's authoritative observations: supported fields compile through the declared mapping, unresolved entity or time mappings hold items. A terminal handle (`succeeded`, `partial` or `held`) names the proposals document |

The biotech binding (`biotech-graph`, K06 package `@aiengineer/knowledge-binding-biotech-graph`) is served when its `databaseUrlEnv` names the Biotech component database; without it the binding is registered and answers `SCHEMA_UNSUPPORTED`. Both PostgreSQL backends require component `knowledge_verification` 2.4.0 or later (migration 0007). `knowledge.apply` enforces the K08 use-class registry (`catalog/research/use-classes.json`, executor setting `KNOWLEDGE_USE_CLASSES_FILE`): an official or consequential use without `exactUse` refuses `REVIEW_REQUIRED`. The use comes from the envelope `use`/`audience` or the intent `declaredUse`; there is no default (a missing or conflicting use refuses `SCHEMA_UNSUPPORTED`). A Biotech apply must carry its normalized-values digest.

### Authentication (K07)

The bearer is a compact JWS whose payload is `credential-claims.v2`.

- **Header.** Exactly `{alg, kid, typ}`, with `alg` `EdDSA` (Ed25519) or `ES256` and `typ` `ks-knowledge-operation+jwt`. Any other member fails closed.
- **Keys.** Keys are pinned by `kid` from the issuer JWKS, with a bounded cache. A key with `retire_at` (epoch seconds) verifies until that time, then refuses. An unknown kid triggers at most one rate-limited reload, then fails closed.
- **Claims.** The schema is strict: lifetime at most 300 s, 30 s skew, pinned `iss`, exact `aud`, and single use: an in-process cache plus the durable component table `credential_use` (2.3.0), so a replayed `jti` or a reused dispatch id refuses even after an executor restart (`details.reason` `replay` or `dispatch_reused`).
- **Installation and envelope.** The credential must match this installation (application to binding, installation id, optional tenant allowlist), the operation grant, the envelope tenant, application, binding and dispatch id, and the effect key and bound digest for effectful calls.
- **Declared use.** Effectful envelopes may carry `use` and `audience` (both or neither; non-effectful operations carry none). `knowledge.apply` classifies the effect by the envelope's use, else the intent's `declaredUse`; with a use-class policy and neither, it refuses `SCHEMA_UNSUPPORTED` (no default); different declarations refuse `SCHEMA_UNSUPPORTED`; an official or consequential use without `exactUse` refuses `REVIEW_REQUIRED`. For `report.register` the envelope's use must be the task's.
- **Evaluator grant.** `evaluation` (`credential-evaluation.v1`, optional) is the host's attestation of a separate evaluator invocation: `{role, credentialRef, provider, family}`. `report.observe` needs an observer role and `report.review` a `human_reviewer`; an evaluator credential grants only `report.observe`, `report.review`, `decision.resolve`, `knowledge.read` and `operation.get`, never an effect or recovery.
- **Origin.** K01 `admitDispatch` applies. The caller must be the originating origin, or a new attempt presenting an `effect`-scoped recovery claim for that exact key and digest. A `read_only` recovery (a `recovery` origin) permits only `receipt.get` and `operation.get`, scoped to the effect it names.
- **Legacy bearer.** The static `VERIFY_EXECUTOR_TOKEN` bearer still guards the old routes and never authorizes these.

Environment variable names (values are never logged):

| Name | Purpose |
| --- | --- |
| `KS_KNOWLEDGE_ISSUER` | Pinned issuer |
| `KS_KNOWLEDGE_AUDIENCE` | This executor's audience |
| `KS_KNOWLEDGE_JWKS_FILE` or `KS_KNOWLEDGE_JWKS_URL` | Issuer JWKS (https, or http on loopback) |
| `KS_KNOWLEDGE_BINDINGS_JSON` | `[{application, binding, installationId, databaseUrlEnv?, tenants?}]`. `databaseUrlEnv` is `KS_AIENG_DB_COMPONENT_DSN` or `KS_BIOTECH_DB_COMPONENT_DSN` (the plane of the binding's application); the database config module reads it |
| `KS_KNOWLEDGE_SEAL_KEY_ID`, `KS_KNOWLEDGE_SEAL_KEY_FILE`, `KS_KNOWLEDGE_SEAL_ISSUER` | Optional run-seal key. Its public half must be pinned under the same id and issuer: `knowledge-db seal-key --admin-dsn-env <NAME> --key-id <id> --key-file <pem> [--issuer <name>] [--retire <old id,...>]` (idempotent; a conflicting key for the id refuses `SEAL_KEY_CONFLICT`; prints only the public key's SHA-256) |
| `KS_KNOWLEDGE_AUDITOR_SCRIPT_FILE` | Scripted census auditor (disposable proofs only) |
| `KS_KNOWLEDGE_REPORT_KINDS_DIR`, `KS_KNOWLEDGE_QUALIFICATION_FILE` | Report-kind catalogue and advertised qualification receipts |
| `KS_KNOWLEDGE_SOURCE_AUTHORITY_DIR` | K08 source authority rules; the sibling `use-classes.json` and `judgment-policies.json` decide official uses, required review and governed judgments (default `catalog/research/source-authority`) |

Key files: the issuer signs with one private Ed25519 JWK JSON file (`{"kty":"OKP","crv":"Ed25519","x","d","kid","alg":"EdDSA"}`). The executor reads the public JWKS `{"keys":[...]}`. Mission Control's `load_signing_key` and `publish_jwks` use the same format; `apps/verification-executor/src/knowledge-operation/tests/test-support.ts` writes disposable pairs.

### Error codes

Every refusal is `protocol-error.v2`; the HTTP status is mirrored from the code. A domain hold or rejection keeps `domainOutcome: true`.

| Code | HTTP |
| --- | --- |
| `SCOPE_DENIED` (every credential refusal, with `details.reason`) | 401 |
| `ORIGIN_MISMATCH` | 403 |
| `EFFECT_CONFLICT`, `EXACT_REVISION_UNAVAILABLE`, `REVIEW_REQUIRED`, `STALE_DECISION`, `UNRESOLVED_EFFECT`, `INDEPENDENCE_UNPROVEN`, `CANCELLED` | 409 |
| `SCHEMA_UNSUPPORTED` | 422 |
| `BUDGET_EXHAUSTED` | 429 |
| `UNSUPPORTED_MEDIA` | 415 |
| `INVALID_ENVELOPE` | 400 |
| `NOT_FOUND` | 404 |
| `CAPABILITY_UNAVAILABLE` (routes not configured, or a required capability not advertised and qualified) | 503 |
| `INTERNAL` | 500 |

### Limitations

- `report.register` spans several coordinator transactions. A crash after the effect is bound but before its receipt is recorded leaves an orphan open run. The retry is refused `EFFECT_CONFLICT`, because K02 records are write-once per id; a new registration uses new record ids.
- The `knowledge.apply` protocol receipt is written right after the native transaction commits, not inside it. A crash in between leaves the native receipt only (`receipt.get` answers `unresolved`), and the next dispatch records the protocol receipt from the native duplicate.
- A Biotech `pending_dispatch` receipt is not updated when BKS acknowledges; reconcile delivery with the binding's `BiotechGraphDelivery`.
- `dispatchSequence` counts the dispatches this process observed.
- One observation batch per evaluator role per run (WI-03 N2): a role's first observations stand (a failing or unsupported verdict is sticky for that revision; only a reviewer decision moves the outcome); a later observation from the same role under any request id refuses `EFFECT_CONFLICT` (`evaluator_role_observed`), a replay of the same observation ids passes through.
- W1 limit (OVE-169) of the per-role cap: a role batch recorded only in part (for example a transport failure mid-request) cannot be completed by a rerun with new observation ids, which refuses `evaluator_role_observed`; Mission Control treats that as observed and the run seals with the partial batch, so the likely outcome is a hold or an unmet obligation rather than a pass, and only a reviewer decision moves it. A same-run census replay under a new census id is refused the same way, which is harmless: the first census stands. W1 must observe this path on its first real judge failure.
- A revocation after promotion does not demote Mission Control's accepted head (no demotion is implemented); demotion or a consumer-side re-check of current eligibility before official use is an explicit W1 prerequisite (OVE-169).
- Rollback is one-way: Mission Control with WI-03 requires `auditorKind` in `binding-descriptor.v2`, and an older Mission Control's strict model rejects a descriptor that carries it. Roll KS and MC forward together; do not pair a new KS with an old MC.
- Deploy order (WI-03): the assertion `judgment` field, the `evaluation` credential claim and `auditorKind` are strict-schema additions, so upgrade the Knowledge Services executor before any producer or Mission Control release that sends them; an older executor refuses them as unknown fields.
- The executor refuses `KS_KNOWLEDGE_AUDITOR_SCRIPT_FILE` unless `KS_KNOWLEDGE_DISPOSABLE=1`, and refuses to start without the K08 use-class registry (`KS_KNOWLEDGE_USE_CLASSES_REQUIRED`).
- A crash between a trusted assessment write (observation, decision or adjudication) and its operation row: the retry with the same request id recomputes and finishes the same operation (an operation left open after `start` is driven to `succeeded`; concurrent callers converge). A replayed observation id with the same bytes is the same record, a reviewer's replay answers its successor, a repeated seal answers the same run, and a decision is read through by its deterministic id. A replayed census after a crash is not deduplicated (one census observation per discovery pass).

## See also

- [SURFACE-REFERENCE.md](SURFACE-REFERENCE.md) — routes, CLI, MCP, worker
- [OPERATOR-RUNBOOK.md](OPERATOR-RUNBOOK.md) — local profiles and CLI flows
- [README.md](README.md) — acceptance state
