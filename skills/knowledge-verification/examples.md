# Knowledge verification examples

Placeholder UUIDs are RFC-layout (`…-4000-8000-…`). Digests are `sha256:` + 64 lowercase hex. Replace every ID and digest with values from admitted operations. Do not submit these placeholders.

Public mutation bodies live in `packages/contracts/src/verification/requests.ts`. CLI `--context` is `OperationContextSchema` in `packages/contracts/src/identity.ts`. MCP mutation `context` is the slim envelope in [mcp-reference.md](mcp-reference.md).

## 1. OperationContext (CLI `--context`)

```json
{
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "operationId": "00000000-0000-4000-8000-000000000002",
  "attemptId": "00000000-0000-4000-8000-000000000003",
  "correlationId": "agent-verification-example-001",
  "actor": {
    "kind": "service",
    "id": "00000000-0000-4000-8000-000000000004",
    "serviceIdentity": "knowledge_api"
  },
  "capabilityVersion": "verification-service.v1",
  "idempotencyKey": "idem-verify-extract-example-001",
  "reason": "admitted-extraction-verification",
  "contractVersion": "v1",
  "missionId": "00000000-0000-4000-8000-000000000005",
  "workItemId": "00000000-0000-4000-8000-000000000006"
}
```

The `actor` in `--context` is validated locally by the CLI `OperationContextSchema`. The API binds the bearer's own actor; a mismatched `--context.actor` does not impersonate another identity.

Against an API configured with `VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON` (the production path), `--context` / MCP `context` must include `attemptId` + `missionId` + `workItemId` that match an ownership grant (tenant, bearer actor, mission) and existing `orchestration.attempt` / `work_item` / `mission` rows with the grant's `agentDeploymentId`. The client sends those IDs as `x-verification-attempt-id`, `x-verification-work-item-id`, `x-verification-mission-id`. Otherwise **403** `"Verification operation ownership denied"`. In legacy static mode, `attemptId` must equal `VERIFICATION_SERVICE_ATTEMPT_ID`.

## 2. captureSource (registered mode)

`CaptureSourceRequestSchema`

```json
{
  "verificationContractVersion": "verification.v1",
  "source": {
    "mode": "register",
    "sourceKind": "web_page",
    "sourceId": "00000000-0000-4000-8000-000000000011",
    "contentArtifact": {
      "artifactId": "00000000-0000-4000-8000-000000000012",
      "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000001"
    }
  },
  "requestedProjectionKinds": ["html_dom"]
}
```

Admitted capture shapes (application; Zod is wider): `sourceKind:"web_page"` requires exactly `["html_dom"]`; only `mode:"acquire"` + `sourceKind:"pdf"` may use `["pdf_text","geometry"]`. Other combinations → `VERIFICATION_CAPTURE_MODE_NOT_ADMITTED`.

Acquire mode (not used above) is `{mode:"acquire", sourceKind, sourceUri}` with a credential-free `http:`/`https:` URL.

## 3. verifyExtraction

`VerifyExtractionRequestSchema`. `captureIds` must contain exactly one `captureId` (`VERIFICATION_EXTRACTION_SINGLE_CAPTURE_REQUIRED`).

```json
{
  "verificationContractVersion": "verification.v1",
  "captureIds": ["00000000-0000-4000-8000-000000000021"],
  "extractionSchema": {
    "artifactId": "00000000-0000-4000-8000-000000000041",
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000005"
  },
  "extractionOutput": {
    "artifactId": "00000000-0000-4000-8000-000000000042",
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000006"
  }
}
```

## 4. replayRun

`ReplayRunRequestSchema`

```json
{
  "verificationContractVersion": "verification.v1",
  "runId": "00000000-0000-4000-8000-000000000051",
  "replayMode": "deterministic_only"
}
```

## CLI session (illustrative)

Handles below are examples of shape, not live IDs. `--wait` is admitted for extraction verification; the completion object is not the authoritative result.

```text
export KNOWLEDGE_API_URL="http://127.0.0.1:4100"
export KNOWLEDGE_API_TOKEN="<token>"

node apps/cli/dist/index.js verify extract \
  --context '{"tenantId":"00000000-0000-4000-8000-000000000001","operationId":"00000000-0000-4000-8000-000000000002","attemptId":"00000000-0000-4000-8000-000000000003","correlationId":"agent-verification-example-001","actor":{"kind":"service","id":"00000000-0000-4000-8000-000000000004","serviceIdentity":"knowledge_api"},"capabilityVersion":"verification-service.v1","idempotencyKey":"idem-verify-extract-example-001","reason":"admitted-extraction-verification","contractVersion":"v1","missionId":"00000000-0000-4000-8000-000000000005","workItemId":"00000000-0000-4000-8000-000000000006"}' \
  --input '{"verificationContractVersion":"verification.v1","captureIds":["00000000-0000-4000-8000-000000000021"],"extractionSchema":{"artifactId":"00000000-0000-4000-8000-000000000041","digest":"sha256:0000000000000000000000000000000000000000000000000000000000000005"},"extractionOutput":{"artifactId":"00000000-0000-4000-8000-000000000042","digest":"sha256:0000000000000000000000000000000000000000000000000000000000000006"}}'
```

Accepted stdout matches `AcceptedOperationSchema` (`packages/contracts/src/integration.ts`):

```json
{
  "operationId": "00000000-0000-4000-8000-000000000081",
  "state": "queued",
  "contractVersion": "v1",
  "statusUrl": "http://127.0.0.1:4100/v1/operations/00000000-0000-4000-8000-000000000081",
  "eventStreamUrl": "http://127.0.0.1:4100/v1/operations/00000000-0000-4000-8000-000000000081/events",
  "cancellationUrl": "http://127.0.0.1:4100/v1/operations/00000000-0000-4000-8000-000000000081:cancel",
  "retryUrl": "http://127.0.0.1:4100/v1/operations/00000000-0000-4000-8000-000000000081:retry",
  "reconcileUrl": "http://127.0.0.1:4100/v1/operations/00000000-0000-4000-8000-000000000081:reconcile"
}
```

Artifact handles come from the family terminal read after the operation succeeds, not from this acceptance payload.

```text
node apps/cli/dist/index.js verify status \
  --context '<same OperationContext>' \
  --input '{"operationId":"00000000-0000-4000-8000-000000000081"}'
```

`--wait` completion is not this `AcceptedOperation` payload and is not the authoritative result. Shape: `{operationId,state,qualityPassed?,receiptId?,exitCode,benchmark?,comparison?}`. Read the operation's receipt (or MCP `verify_status`, then the receipt) for the signed terminal result.
