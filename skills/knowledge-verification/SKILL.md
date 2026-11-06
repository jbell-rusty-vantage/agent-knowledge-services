---
name: knowledge-verification
description: >-
  Runs admitted Knowledge Verification operations through the ks CLI and the
  verify_* platform MCP tools. Use when verifying an extraction, running a
  structured extraction, parsing a registered artifact, capturing a benchmark
  source, running or comparing an extraction benchmark, replaying a verification
  run, or reconciling a provider attempt.
license: Proprietary
metadata:
  version: "1.5.0"
  contract: "verification.v1"
---

# Knowledge verification

Admitted verification of extractions, structured extraction, artifact parsing, benchmarks, replays and provider reconciliation. Surfaces are the `ks` CLI and bounded MCP tools. Contract: `verification.v1`. Skills contain operational instructions, not verifier algorithms.

Read [assertion and media decisions](capabilities.md) to distinguish library selectors from
admitted capture surfaces and mechanical results from semantic support.

## Retired in SV-17

Claims, citation, report and metric verification, audit-bundle inspection, adjudication, run/case
reads, drift revalidation and the executor's recovery and report surfaces were retired in SV-17;
claims, runs and seals go through ks.knowledge_operation.v2 (K01) on the knowledge_verification component, with exact-use admission.

## When to use

- A registered artifact handle and capture set must be extraction-verified, parsed, replayed or benchmarked.
- The user names verify extraction, structured extraction, artifact parse, extraction benchmark, replay verification run, provider reconciliation, the knowledge verification CLI, or the `verify_*` MCP tools.

## Which verification surface

Two CLIs exist. Pick by where you are running:

| You are… | Use | Skill |
|---|---|---|
| A research agent capturing sources and locating exact quotes, typically inside a sandbox with `VERIFY_EXECUTOR_URL` set | `knowledge-verify` (verification executor: capture, locate, register, artifact) | the separately installed `knowledge-verify` skill |
| An operator or orchestration agent calling the admitted platform API with tenant/mission ownership context (`ks verify …`, `verify_*` MCP) | `ks` CLI / MCP | this skill |

Do not mix them in one run: the executor writes its own capture and artifact store; the platform API writes to Postgres via operations. If `knowledge-verify --help` works and `KNOWLEDGE_API_URL` is unset, you are on the executor surface.

## When not to use

- Retrieval, evaluation, publication, or vector-store work (other skills).
- Live provider SDK calls, raw SQL, secret reads, or unsigned local grading presented as admitted verification.
- Inventing locators from display excerpts.

## Non-negotiable rules

- Never treat display excerpts as selectors.
- Never retry with the producer deployment.
- Never call provider SDKs directly for admitted verification.
- Never fabricate artifact IDs, receipts, or human labels.
- `completed` + `review_required` is a held result, not a failure.
- Exit `0` admitted, `1` completed quality failure, `2` infrastructure/config/auth.
- Deterministic failures cannot be overridden by semantic judges.
- MCP/CLI cannot grant capabilities.
- A structural seal is custody, not admission and not publication.
- Resubmitting unchanged bytes is a duplicate, not a repair.

## Bounded batches and accounting

Submit work in coherent batches with an explicit ceiling so one failure cohort stays diagnosable
and a partial result stays useful. Keep each batch to one capture family or one question slice; do
not merge unrelated extractions to reduce round trips.

Charge every submission, poll and replay to the caller's remaining budget and
report usage with the result. Unknown usage is unknown, never zero. Read results as compact handles:
write the JSON to a file with `--out` and cite `operationId`, `receiptId`, `runId` and digests rather
than pasting whole receipts into the conversation.

## Preflight

Env: `KNOWLEDGE_API_URL` (or CLI `--base-url`), `KNOWLEDGE_API_TOKEN`. MCP also needs `POSTGRES_URL` and bearer identities from `KNOWLEDGE_API_IDENTITIES` (server-side; do not print secrets).

CLI `--context` is full `OperationContextSchema` (`packages/contracts/src/identity.ts`): required `tenantId`, `operationId`, `attemptId`, `correlationId`, `actor`, `capabilityVersion`, `idempotencyKey` (8–255), `reason`, `contractVersion` (`v1`). Schema-optional: `projectId`, `missionId`, `workItemId`, `causationId`, `externalExecution`.

MCP mutation `context` is slimmer: `tenantId`, `correlationId`, `idempotencyKey`, plus schema-optional hints `attemptId`, `workItemId`, `missionId`, `causationId`, `externalExecution`. MCP reads need only `tenantId` and `correlationId`.

Against an API configured with `VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON` (the production path), CLI `--context` / MCP `context` must carry `attemptId` + `missionId` + `workItemId` that match an ownership grant (tenant, bearer actor, mission) and existing `orchestration.attempt` / `work_item` / `mission` rows with the grant's `agentDeploymentId`. The client sends those IDs as `x-verification-attempt-id`, `x-verification-work-item-id`, `x-verification-mission-id`. Otherwise **403** `"Verification operation ownership denied"`. In legacy static mode (`VERIFICATION_SERVICE_ATTEMPT_ID` without grants), `attemptId` must equal that server value.

`--input` is the public request body (`verificationContractVersion` always `"verification.v1"`). Artifact inputs are `{artifactId, digest}` where `digest` is `sha256:` + 64 hex.

Accepted mutation stdout is `AcceptedOperationSchema` (`operationId`, `state:"queued"`, `contractVersion`, `statusUrl`, `eventStreamUrl`, `cancellationUrl`, `retryUrl`, `reconcileUrl`) — no artifact IDs. Obtain artifact handles from the family terminal read after the operation succeeds. Capture terminal is HTTP `GET /v1/verification/captures/:operationId` only — no CLI/MCP capture-show tool. Do not invent handles.

Admitted capture shapes (application; Zod is wider): `sourceKind:"web_page"` requires exactly `requestedProjectionKinds:["html_dom"]`; only `mode:"acquire"` + `sourceKind:"pdf"` may use `["pdf_text","geometry"]`. Other combinations → `VERIFICATION_CAPTURE_MODE_NOT_ADMITTED`.

Generic CLI: `ks verify <command…> --context '<json>' --input '<json>' [--base-url] [--timeout-ms] [--wait] [--human]`. Invocation details: [cli-reference.md](cli-reference.md). MCP tools: [mcp-reference.md](mcp-reference.md). Bodies: [examples.md](examples.md).

### Wait and poll

- `--wait` is verification_mutation only. It polls `getVerificationOperation`. Handled kinds (`WAITABLE_VERIFICATION_RECEIPTS`): `verification_capture`, `verification_extraction`, `verification_replay`, `verification_benchmark`, `verification_benchmark_compare`.
- `--wait` does **not** handle `verification_parse_artifact` or `verification_structured_extraction` (throws a message that starts with `VERIFICATION_WAIT_UNSUPPORTED_KIND:<kind>` → exit `2`).
- Prefer `ks verify status --input '{"operationId":"<uuid>"}'` (`getVerificationOperation`) over `operation status`. Then the family terminal read. `--wait` completion is a compact projection, not the authoritative result.
- MCP: `verify_status` (spec §19 `knowledge_get_operation`), then the family read tool.

`--wait` maps `needs_review` to exit `1`. Treat `needs_review` / `review_required` as held: do not retry or override.

## verify-extraction

**Applies when** a structured extraction output must be mechanically verified against registered captures and an extraction schema.

**Inputs.** `VerifyExtractionRequestSchema`: `verificationContractVersion`, `captureIds` (exactly one `captureId`), `extractionSchema`, `extractionOutput`. Extra capture IDs → `VERIFICATION_EXTRACTION_SINGLE_CAPTURE_REQUIRED`.

**CLI.** `ks verify extract --context '<OperationContext>' --input '<VerifyExtractionRequest>' --wait`

**MCP.** `verify_extract` `{context, request}`.

**Wait.** `--wait` is admitted (`verification_extraction`). Or `verify status`; there is no extract-result CLI or MCP read, so use the receipt / `getVerificationOperation`.

**Interpret.** `0` / `valid===true`: admitted. `1` / `valid===false` or `needs_review`: completed quality failure or held review. `2`: timeout, failed/cancelled/quarantined, missing receipt, auth/config.

**Escalate.** Held review stays held. Do not treat excerpts as selectors. Register only service-issued artifact handles.

## structured-extraction, artifact parse and provider reconciliation

**Structured extraction.** `ks verify extraction run --context '<OperationContext>' --input '<ExtractStructuredDataRequest>'` / MCP `verify_extraction_run`. No `--wait`: poll `verify status`, then `ks verify extraction show --input '{"operationId":"<uuid>"}'` / `verify_extraction_show`.

**Artifact parse.** `ks verify artifact parse --context '<OperationContext>' --input '<ParseArtifactRequest>'` / MCP `verify_artifact_parse`. No `--wait`: poll `verify status`.

**Provider reconciliation.** `ks verify reconciliation apply` / `verify_reconciliation_apply` with `operationId`, `providerAttemptId`, `artifact`; read with `ks verify reconciliation show` / `verify_reconciliation_show`.

## run-extraction-benchmark

**Applies when** a sealed offline benchmark must run (`executionMode` is only `offline_recorded`).

**Inputs.** `RunBenchmarkRequestSchema`: `verificationContractVersion`, `dataset`, `experimentDefinition`, `executionMode: "offline_recorded"`.

**CLI.** `ks verify benchmark run --context '<OperationContext>' --input '<RunBenchmarkRequest>' --wait`

**MCP.** `verify_benchmark_run` `{context, request}`.

**Wait.** `--wait` admitted (`verification_benchmark`): exit `0` on success receipt. Compare: `ks verify benchmark compare` / `verify_benchmark_compare`; `--wait` exit `1` if `engineeringGateOutcome==="fail"`. Reads: `benchmark show|manifest|comparison`. MCP: `verify_benchmark_show`, `verify_benchmark_manifest`, `verify_benchmark_comparison`. Capture a benchmark source with `ks verify benchmark capture` / `verify_benchmark_capture`.

**Interpret.** `0`: admitted run. `1`: comparison engineering gate fail. `2`: infrastructure.

**Escalate.** Incomplete recorded outputs or missing human gold → abstain; do not claim production quality.

## replay-verification-run

**Applies when** a prior run must be recomputed from registered artifacts.

**Inputs.** `ReplayRunRequestSchema`: `verificationContractVersion`, `runId`, `replayMode` `deterministic_only` | `recorded_provider_outputs`.

**CLI.** `ks verify bundle replay --context '<OperationContext>' --input '<ReplayRunRequest>' --wait`

**MCP.** `verify_bundle_replay` `{context, request}`.

**Wait.** `--wait` admitted (`verification_replay`).

**Interpret.** Replay must match sealed deterministic results. Divergence is a quality or integrity failure, not a license to change the original verdict.

**Escalate.** Integrity mismatch → stop and report; do not re-run with the producer deployment or live SDKs.

## References

- [cli-reference.md](cli-reference.md)
- [mcp-reference.md](mcp-reference.md)
- [examples.md](examples.md)
