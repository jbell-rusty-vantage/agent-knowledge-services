# Verification deployment

Processes, environment, rollout, and rollback for the verification module. Runtime baseline: [docs/architecture/0001-runtime-and-deployment.md](../architecture/0001-runtime-and-deployment.md). AWS worker/Docling stack: [infra/aws/README.md](../../infra/aws/README.md). Image context exclusions: [`.dockerignore`](../../.dockerignore). Do not duplicate those documents here.

## Processes

| Process | Package | Role | Typical host |
| --- | --- | --- | --- |
| api | `@aiengineer/knowledge-api` | Fastify HTTP; admission, 202 receipts, terminal reads | Vercel Fluid Compute or Node container. Default `PORT=4100` |
| worker | `@aiengineer/knowledge-worker` | Durable verification activities | Always-on container (AWS ECS/Fargate in the infra template) |
| mcp | `@aiengineer/knowledge-mcp` | Streamable HTTP MCP facade; every tool calls application in process (no HTTP to the API) | Vercel or Node. Default `PORT` fallback **4101** |
| parser (optional) | `services/parser` | Sandboxed native PDF/HTML parse | Local/remote Docker image pinned by digest |

`services/docling` is a separate conversion boundary, not the verification parser.

Mission Control / Temporal (`../ai-engineer-mission-control`) dispatches KS capabilities. The Temporal namespace is operator-provisioned. Credentials stay in server/activity configuration; source bytes and bearer tokens do not belong in workflow history.

## Environment variable matrix

Host configuration (`@aiengineer/knowledge-host/config`, formerly `packages/config`) has no `VERIFICATION_*` keys. The CLI does not read `VERIFICATION_*`. API, MCP and worker read `process.env` (or an injected `Environment`). Since Unit 3 the MCP role composes the same verification read, reconciliation, decision and capture-profile services as the API, so an MCP deployment needs the same `VERIFICATION_*` read configuration, Supabase Storage credentials and (for `knowledge_retrieve_search`) gateway credentials for those tools; the same configuration failure codes apply at MCP startup. `KNOWLEDGE_API_URL` remains required: it roots accepted-operation poll links, and MCP never calls it.

### Shared / ownership

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON` | api, worker* | req for most capabilities | JSON grant array (see [Ownership grants](#ownership-grants)) | bind actor→tenant/mission/attempt |
| `VERIFICATION_SERVICE_ATTEMPT_ID` | api | opt (legacy static context) | UUID | static attempt when no ownership resolver |
| `VERIFICATION_SERVICE_WORK_ITEM_ID` | api | opt | UUID | static work-item hint |
| `VERIFICATION_SERVICE_MISSION_ID` | api | opt | UUID | static mission hint |
| `VERIFICATION_SERVICE_CAUSATION_ID` | api | opt | string | static causation |
| `VERIFICATION_SERVICE_EXTERNAL_RUNTIME` | api | pair with run id | string | external execution |
| `VERIFICATION_SERVICE_EXTERNAL_RUN_ID` | api | pair | string | |
| `VERIFICATION_SERVICE_EXTERNAL_ROOT_RUN_ID` | api | opt | string | |
| `VERIFICATION_SERVICE_EXTERNAL_SESSION_ID` | api | opt | string | |
| `VERIFICATION_SERVICE_EXTERNAL_TURN_ID` | api | opt | string | |
| `VERIFICATION_SERVICE_EXTERNAL_TOOL_CALL_ID` | api | opt | string | |
| `VERIFICATION_SERVICE_CAPABILITY_VERSION` | api | opt | string | default `verification-service.v1` |
| `VERIFICATION_EVE_RUNTIME_ATTESTATION_KEYS_JSON` | api | opt | JSON keys | Eve attestation on ownership resolver |

\*Worker authorizes by `WORKER_TENANT_ID`, not by composing ownership grants itself.

### Capture / catalog / parse

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_SERVICE_CATALOG_JSON` | api, worker | req for capture/parse | JSON catalog | source/profile grants |
| `VERIFICATION_CAPTURE_ACQUIRE_ENABLED` | api, worker | opt | flag `0`/`1` | live source acquire |
| `VERIFICATION_SOURCE_ACQUISITION_GRANTS_JSON` | worker | req if acquire=`1` | JSON array | transport grants |
| `VERIFICATION_PARSE_ARTIFACT_ENABLED` | api, worker | opt | flag `0`/`1` | parse admission |
| `VERIFICATION_CAPTURE_READS_ENABLED` | api | opt | flag `0`/`1` | capture GET |

### Metric

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_METRIC_ENABLED` | api | opt | flag `0`/`1` | admit `verification_metric` |
| `VERIFICATION_METRIC_PROFILE_GRANTS_JSON` | worker | req for metric activity | JSON array | metric profiles |

### Claims / report / seal identity

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_CLAIMS_ENABLED` | api | opt | flag `0`/`1` | claims/report submit |
| `VERIFICATION_CLAIMS_PROJECTION_GRANTS_JSON` | api, worker | req if claims/audit/adj | JSON array | projection grants |
| `VERIFICATION_SEAL_POLICY_GRANTS_JSON` | api, worker | req if claims/seal | JSON array | seal policy artifacts |
| `VERIFICATION_CLAIMS_REPORT_READ_PUBLIC_KEYS_JSON` | api | opt | JSON keys | claims/report reads |
| `VERIFICATION_CODE_GIT_SHA` | api, worker | req if claims/seal | string | seal identity |
| `VERIFICATION_CODE_DIRTY` | api, worker | req if seal | `0`/`1` | dirty tree flag |
| `VERIFICATION_RUNTIME_PLATFORM` | api, worker | req if seal | string | seal identity |
| `VERIFICATION_RUNTIME_DEPLOYMENT_ID` | api, worker | req if seal | string | seal identity |
| `VERIFICATION_SEMANTIC_RUNTIME_JSON` | worker | opt | JSON | claims semantic stage |
| `VERIFICATION_SEMANTIC_PROFILE_GRANTS_JSON` | api, worker | opt | JSON | judge profiles |

### Audit inspection

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_AUDIT_INSPECTION_ENABLED` | api, worker | opt | flag `0`/`1` | inspect submit + worker |
| `VERIFICATION_AUDIT_INSPECTION_GRANTS_JSON` | api, worker | req if enabled | JSON | exact audit grants |
| `VERIFICATION_AUDIT_INSPECTION_PUBLIC_KEYS_JSON` | worker | req if inspect enabled | JSON keys | inspect verify |
| `VERIFICATION_AUDIT_INSPECTION_READS_ENABLED` | api | opt | flag `0`/`1` | inspect GET |
| `VERIFICATION_AUDIT_INSPECTION_TIMEOUT_MS` | worker | opt | positive int | default 30000 |
| `VERIFICATION_AUDIT_SIGNING_KEY_ID` | worker | opt pair | string | audit signer |
| `VERIFICATION_AUDIT_SIGNING_PRIVATE_KEY_PEM` | worker | opt pair | PEM | audit signer |

### Adjudication

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_ADJUDICATION_GRANTS_JSON` | api, worker | all-or-nothing trio | JSON | adjudication |
| `VERIFICATION_ADJUDICATION_REVIEW_REQUIREMENTS_JSON` | api, worker | trio | JSON | reviewer quorum/roles |
| `VERIFICATION_ADJUDICATION_PUBLIC_KEYS_JSON` | api, worker | trio | JSON keys | packet keys |
| `VERIFICATION_ADJUDICATION_TIMEOUT_MS` | api, worker | opt | int | default 30000 |
| `VERIFICATION_ADJUDICATION_DECISIONS_ENABLED` | api, worker | opt | flag `0`/`1` | decision record/read |
| `VERIFICATION_ADJUDICATION_SYNTHETIC_REVIEWER_GRANTS_JSON` | api, worker | opt if enabled | JSON array | synthetic reviewers |

### Benchmark

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_BENCHMARK_CONFIG_JSON` | api, worker | opt | JSON | run benchmark |
| `VERIFICATION_BENCHMARK_SIGNING_KEY_ID` | worker | req if config | string | benchmark seal |
| `VERIFICATION_BENCHMARK_SIGNING_PRIVATE_KEY_PEM` | worker | req if config | PEM | |
| `VERIFICATION_BENCHMARK_COMPARISON_CONFIG_JSON` | api, worker | opt | JSON | compare |
| `VERIFICATION_BENCHMARK_COMPARISON_SIGNING_KEY_ID` | worker | req if config | string | |
| `VERIFICATION_BENCHMARK_COMPARISON_SIGNING_PRIVATE_KEY_PEM` | worker | req if config | PEM | |
| `VERIFICATION_BENCHMARK_CAPTURE_PROFILES_JSON` | api | opt | JSON | profile capture routing |
| `VERIFICATION_BENCHMARK_READ_PUBLIC_KEYS_JSON` | api | opt | JSON keys | benchmark GET |
| `VERIFICATION_BENCHMARK_COMPARISON_READ_PUBLIC_KEYS_JSON` | api | opt | JSON keys | comparison GET |

### Structured extraction / reconciliation

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_STRUCTURED_EXTRACTION_CONFIG_JSON` | api, worker | opt | JSON | extract live |
| `VERIFICATION_STRUCTURED_EXTRACTION_SIGNING_KEY_ID` | worker | req if config | string | |
| `VERIFICATION_STRUCTURED_EXTRACTION_SIGNING_PRIVATE_KEY_PEM` | worker | req if config | PEM | |
| `VERIFICATION_STRUCTURED_EXTRACTION_READ_PUBLIC_KEYS_JSON` | api | opt | JSON keys | extraction GET |
| `VERIFICATION_PROVIDER_RECONCILIATION_GRANTS_JSON` | api | opt | JSON | extraction recon |
| `VERIFICATION_SEMANTIC_PROVIDER_RECONCILIATION_GRANTS_JSON` | api | opt | JSON | claims/report recon |
| `VERIFICATION_PROVIDER_RECONCILIATION_PUBLIC_KEYS_JSON` | api | req if recon grants | JSON keys | both recon runtimes |

### Reads / parser / storage

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_READS_ENABLED` | api | opt | flag `0`/`1` | run/case/evidence GET |
| `VERIFICATION_PARSER_IMAGE_DIGEST` | api, worker | req if claims/capture-reads/worker verify | `sha256:`+64hex | parser pin |
| `VERIFICATION_PARSER_COMMAND` | worker | opt | string | default `docker` |
| `VERIFICATION_STORAGE_BUCKET` | api, worker | opt | string | default `ai-engineer-cloud-bucket` |

### Drift (internal)

| Name | Process | Req/opt | Shape | Purpose |
| --- | --- | --- | --- | --- |
| `VERIFICATION_DRIFT_REVALIDATION_ENABLED` | api | opt | flag `0`/`1` default `0` | internal drift queue |
| `VERIFICATION_DRIFT_CONSUMER_SERVICE_IDENTITIES_JSON` | api | req if drift=`1` | JSON array | allowlist |
| `VERIFICATION_COMPONENT_DRIFT_MONITORS_JSON` | api | pair | JSON | component drift |
| `VERIFICATION_COMPONENT_DRIFT_PUBLIC_KEYS_JSON` | api | pair | JSON keys | |

### Non-`VERIFICATION_*` dependencies

| Name | Process | Purpose |
| --- | --- | --- |
| `KS_AIENG_DB_RUNTIME_DSN` | api, worker, mcp | canonical DB |
| `KS_AIENG_DB_URL`, `KS_AIENG_DB_SECRET_KEY` | api, worker | artifact store |
| `KNOWLEDGE_API_IDENTITIES` | api, mcp | bearer map |
| `KNOWLEDGE_API_URL` | api (public origin), mcp, cli | public origin / client |
| `KNOWLEDGE_API_TOKEN` | cli | client bearer |
| `AI_GATEWAY_API_KEY` | api (retrieval), worker (extraction/embeddings) | gateway |
| `INTERFAZE_API_KEY` | worker | Interfaze extraction host |
| `KNOWLEDGE_PERSISTENCE_MODE` | worker | `postgres` vs memory |
| `WORKER_TENANT_ID`, `WORKER_ID`, `WORKER_POLL_MS`, `WORKER_LEASE_MS` | worker | loop scope |
| `CANONICAL_LOCAL_ONLY` | api, worker, mcp | local Postgres |
| `VERCEL_OIDC_TOKEN` | api | alternate gateway auth |
| `KNOWLEDGE_CALLBACK_SIGNING_KEYS` | api | A2A callbacks (not verification-specific) |

Eve-host only (not read by KS api/worker): `EVE_VERIFICATION_GRANTS_JSON`, `EVE_VERIFICATION_SIGNING_PRIVATE_KEY_PEM`. See [INTEGRATION-GUIDE.md](INTEGRATION-GUIDE.md).

## Ownership grants

`VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON` is the production ownership path. It is required whenever `VERIFICATION_CLAIMS_ENABLED=1` (and for benchmark, comparison, structured extraction, metric, and audit-inspection flags). Production refuses a static `VERIFICATION_SERVICE_ATTEMPT_ID` without this array.

Shape (`apps/api/src/verification-ownership.ts`): a JSON array of **1–256** objects. Raw JSON larger than 262,144 bytes fails startup. Each grant:

| Field | Required | Notes |
| --- | --- | --- |
| `tenantId` | yes | UUID |
| `actor` | yes | `ActorSchema` (must match the bearer) |
| `missionId` | yes | UUID |
| `agentDeploymentId` | yes | 1–255 chars |
| `capabilityVersion` | yes | 1–255 chars |
| `externalExecution` | no | exact `ExternalExecutionContextSchema` bind |
| `eveRuntimeAuthority` | no | `{grantId, issuer, keyIds}` (1–16 unique key IDs) |

`externalExecution` and `eveRuntimeAuthority` are mutually exclusive. Grants must be unique on `tenantId:actor.kind:actor.id:missionId` (`DUPLICATE_VERIFICATION_OWNERSHIP_GRANT`).

Example (placeholders, not seeded rows):

```json
[
  {
    "tenantId": "00000000-0000-4000-8000-000000000001",
    "actor": {
      "kind": "service",
      "id": "00000000-0000-4000-8000-000000000004",
      "serviceIdentity": "knowledge_api"
    },
    "missionId": "00000000-0000-4000-8000-000000000005",
    "agentDeploymentId": "your-registered-deployment",
    "capabilityVersion": "verification-service.v1"
  }
]
```

The resolver also requires existing `orchestration.attempt` / `work_item` / `mission` rows for the hinted IDs, with `attempt.agent_deployment_id` equal to the grant's `agentDeploymentId`. Seed those rows before starting the API. Callers send `x-verification-attempt-id`, `x-verification-work-item-id`, `x-verification-mission-id`. Missing or unmatched hints → 403 `"Verification operation ownership denied"`.

## Secrets

PEM private keys and grants JSON come from a secret manager. Inject them into the **worker** (and API grant/public-key surfaces) at process start.

- **API** holds public keys and grant catalogs, never signing PEMs for benchmark/extraction/audit (those are worker-only).
- **API** may hold `VERIFICATION_EVE_RUNTIME_ATTESTATION_KEYS_JSON` public Ed25519 keys only.
- Do not place PEMs, grants, or tokens in Temporal history, MCP tool results, or logs.

## Database contract

Pinned: `@aiengineer/database-contract` → `file:vendor/aiengineer-database-contract-0.2.38.tgz` (`packages/persistence/package.json`).

Migrations are owned by `../../aiengineer/ai-engineer-db-contract`. Do not author KS-local migrations for shared schema.

Remote ledger (engineering handoff 2026-09-08): approved 49 remote migrations plus reviewed drift migration applied; remote migration ledger **209**; local canonical migrations **143**; installed contract **0.2.38**.

Tables touched by `packages/persistence` verification files include `knowledge_service.operation`, `operation_step`, `receipt`, `operation_event`, `lease`; plus `evidence.verification_*` and `orchestration.verification_*` / artifact lineage tables.

## Storage

`VERIFICATION_STORAGE_BUCKET` default `ai-engineer-cloud-bucket`. Object key: `{tenantId}/{digest[7:9]}/{digest[7:]}` (hex after `sha256:`). Every object-store artifact must be registered in the relational ledger.

## Parser image

Build from `services/parser`. Pin `VERIFICATION_PARSER_IMAGE_DIGEST` to `docker image inspect` id (`sha256:`+64 hex). Requests cannot choose the executable, image, URL, path, mount, environment, or command. See `services/parser/README.md`.

## Code identity (sealing)

When claims/seal are configured, set `VERIFICATION_CODE_GIT_SHA`, `VERIFICATION_CODE_DIRTY` (`0`/`1`), `VERIFICATION_RUNTIME_PLATFORM`, `VERIFICATION_RUNTIME_DEPLOYMENT_ID` on both api and worker to the deployed identity. Producer and verifier deployment identities must differ.

## Temporal / Mission Control

KS does not start Temporal. MC `verificationWorkflow` is the dispatch adapter. Launch uses `REJECT_DUPLICATE`. Namespace is operator-provisioned. Persistent drift scheduling is an operator deployment step (disposable Cloud proof exists; production must supply monitor handles, keys, service identities, and activate the schedule).

## CI

`.github/workflows/verify.yml` runs `pnpm verify` on `pull_request` and `push` to `main` (Node 24, pnpm 10.34.5, frozen lockfile).

## Rollout order

1. Apply `ai-engineer-db-contract` migrations (remote ledger first).
2. Seed orchestration mission / work-item / attempt rows for the caller's agent deployment (the ownership resolver joins these before any mutation is admitted).
3. Deploy **api** with ownership grants plus read-only flags/keys (`VERIFICATION_READS_ENABLED` and family public keys) so GETs return 503 until admitted, then 200 for sealed rows.
4. Enable **worker** capabilities incrementally (catalog → parse → claims/seal → extraction → benchmark → adjudication → audit). Each empty JSON/flag leaves the kind unregistered.
5. Point Mission Control dispatch at the live KS origin. Do not copy algorithms into MC or agents.
6. Enable dashboard supported reads/controls through MC/KS HTTP only.

## Rollback

Disable capability flags (`=0`) or empty the corresponding JSON. New submits return 503 `CAPABILITY_NOT_ADMITTED`. Sealed artifacts, receipts, and object-store bytes stay immutable. Do not delete sealed rows to “undo” a rollout.

## Health and smoke

| Check | Expected |
| --- | --- |
| `GET /health` (api or mcp) | `{ "status": "ok" }` always — not a capability probe |
| `GET /v1/verification/runs/:runId` with `VERIFICATION_READS_ENABLED` off | **503** `CAPABILITY_NOT_ADMITTED` (`"Verification reads unavailable"`) |
| Same with flag `1` and missing run | 404 `NOT_FOUND` |
| `GET /v1/verification/claims/:operationId` without read public keys | **503** `CAPABILITY_NOT_ADMITTED` |
| `GET /v1/verification/extractions/:operationId` without extraction read keys | **503** `CAPABILITY_NOT_ADMITTED` (`"Extraction reads unavailable"`) |
| `GET /v1/verification/audit-inspections/:operationId` with reads flag off | **503** `CAPABILITY_NOT_ADMITTED` (`"Audit inspection reads unavailable"`) |
| `GET /v1/verification/operations/:id` | 200 record or 404 — **does not** 503 for a missing verification capability (falls back to generic operation service) |
| Mutation without operation service / context resolver | **503** `CAPABILITY_NOT_ADMITTED` (`"Verification operation unavailable"`) |

Authenticated smoke: Bearer + `x-tenant-id`. Capability-off GET 503 is the intended probe that a flag is not admitted.
