# Verification operator runbook

Practical local procedures. Commands below exist in this repository. On Windows Git Bash, `corepack` may not be on `PATH`; use `corepack.cmd` in place of `corepack`.

## Prerequisites

- Node.js **>= 24** (`package.json` `engines.node`)
- pnpm **10.34.5** via Corepack (`packageManager`)
- Docker, for the verification parser image (`services/parser`)
- Local Postgres / Supabase (`POSTGRES_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`)
- Do not load the Knowledge Services `.env` file for local proofs. Export only the vars a profile needs. Never print grants, PEMs, or tokens.

## Build and verify

```bash
corepack pnpm install
corepack pnpm verify
```

`verify` is `corepack pnpm typecheck && corepack pnpm test && corepack pnpm build` (each step is Turbo). Equivalent:

```bash
corepack pnpm exec turbo run typecheck test build
```

Serial (avoids host contention):

```bash
corepack pnpm exec turbo run typecheck test build --concurrency=1
```

The testkit file `packages/testkit/src/broad-evaluation-corpus.test.ts` has a p95-latency hard gate that is a known **wall-clock flake under parallel load**. It is unrelated to verification. It passes in isolation:

```bash
corepack pnpm --filter @aiengineer/knowledge-testkit exec vitest run src/broad-evaluation-corpus.test.ts
```

See `docs/workspaces/verification-module/swarm-plan-20260906/SW-00-FULL-VERIFY-REGRESSION.md`.

Package-only verification algorithms:

```bash
corepack pnpm --filter @aiengineer/knowledge-verification typecheck
corepack pnpm --filter @aiengineer/knowledge-verification test
corepack pnpm --filter @aiengineer/knowledge-verification build
```

## CLI invocation

Bin name: `ks` (`apps/cli/package.json`; `ks --help` lists the commands).

In-repo from source (passes args after `--` to `tsx src/index.ts`):

```bash
corepack pnpm --filter @aiengineer/knowledge-cli dev -- <group> <command…> ...
```

After `build`:

```bash
corepack pnpm --filter @aiengineer/knowledge-cli exec node dist/index.js <group> <command…> ...
```

Generic HTTP commands need `KNOWLEDGE_API_URL` or `--base-url`, and `KNOWLEDGE_API_TOKEN`. `--context` must be JSON that parses as `OperationContextSchema` (full envelope: `tenantId`, `operationId`, `attemptId`, `correlationId`, `actor`, `capabilityVersion`, `idempotencyKey`, `reason`, `contractVersion`). The API ignores caller-supplied actor/operation identity and builds a trusted context from the bearer and ownership grants.

Examples below use `knowledge` as the bin; substitute the in-repo form above.

## Start API, worker, MCP

```bash
corepack pnpm dev:api
corepack pnpm dev:worker
corepack pnpm dev:mcp
```

These are `tsx watch src/index.ts` for `@aiengineer/knowledge-api`, `@aiengineer/knowledge-worker`, and `@aiengineer/knowledge-mcp`. They read `process.env` only (no `--env-file`).

- API default `HOST=127.0.0.1`, `PORT=4100`
- MCP default `PORT` fallback **4101**
- Worker loop: `WORKER_TENANT_ID`, `WORKER_ID`, `WORKER_POLL_MS`, `WORKER_LEASE_MS`, `KNOWLEDGE_PERSISTENCE_MODE`

Shared non-verification deps for durable surfaces: `POSTGRES_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `KNOWLEDGE_API_IDENTITIES`, `KNOWLEDGE_API_URL`. Optional `CANONICAL_LOCAL_ONLY=1` for loopback Postgres.

Parser image (required when any verification worker block is on):

```bash
docker build -t aiengineer-verification-parser:v1 services/parser
docker image inspect --format '{{.Id}}' aiengineer-verification-parser:v1
```

Set `VERIFICATION_PARSER_IMAGE_DIGEST` to that immutable `sha256:`+64hex id, not the mutable tag. `VERIFICATION_PARSER_COMMAND` defaults to `docker`.

## Ownership grants

`VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON` is the production path . Full shape, uniqueness rule, and rollout order: [DEPLOYMENT.md](DEPLOYMENT.md#ownership-grants).

Array of **1–256** grants `{tenantId, actor, missionId, agentDeploymentId, capabilityVersion, externalExecution?}` (a grant carrying the retired `eveRuntimeAuthority` is rejected). Unique on `tenantId:actor.kind:actor.id:missionId`. `externalExecution` and `eveRuntimeAuthority` are mutually exclusive.

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

Seed `orchestration.mission` / `work_item` / `attempt` rows for the caller's `agentDeploymentId` **before** starting the API. Mutations must send `attemptId` + `missionId` + `workItemId` that match a grant and those rows; otherwise **403** `"Verification operation ownership denied"`.

## Configuration profiles

Flags default to `0` (off). Empty JSON leaves the kind unregistered. Grouped vars below are the exact names from inventory §7.

### (a) Read-only inspection

Reads flags + public keys. API only; worker not required.


| Var                                                        | Notes                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON`               | grant array; see [Ownership grants](#ownership-grants) |
| `VERIFICATION_CAPTURE_READS_ENABLED`                       | `1` for capture GET                                    |
| `VERIFICATION_BENCHMARK_READ_PUBLIC_KEYS_JSON`             | JSON keys                                              |
| `VERIFICATION_BENCHMARK_COMPARISON_READ_PUBLIC_KEYS_JSON`  | JSON keys                                              |
| `VERIFICATION_STRUCTURED_EXTRACTION_READ_PUBLIC_KEYS_JSON` | JSON keys                                              |


Plus `POSTGRES_URL`, `SUPABASE_`*, `KNOWLEDGE_API_IDENTITIES`.

Smoke: `GET /health` is always `{ "status": "ok" }`. A capability-off probe is any enabled-flag GET, e.g. `GET /v1/verification/captures/:operationId` returns **503** `CAPABILITY_NOT_ADMITTED` when `VERIFICATION_CAPTURE_READS_ENABLED` is not `1`.

### (b) Capture / parse / extraction verification

Catalog + parser image + ownership grants.


| Var                                                          | Process     | Notes                                                  |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------ |
| `VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON`                 | api         | grant array; see [Ownership grants](#ownership-grants) |
| `VERIFICATION_SERVICE_CATALOG_JSON`                          | api, worker | JSON catalog                                           |
| `VERIFICATION_PARSER_IMAGE_DIGEST`                           | api, worker | `sha256:`+64hex                                        |
| `VERIFICATION_PARSER_COMMAND`                                | worker      | default `docker`                                       |
| `VERIFICATION_STORAGE_BUCKET`                                | api, worker | default `ai-engineer-cloud-bucket`                     |
| `VERIFICATION_CAPTURE_ACQUIRE_ENABLED`                       | api, worker | `0`/`1`                                                |
| `VERIFICATION_SOURCE_ACQUISITION_GRANTS_JSON`                | worker      | required if acquire=`1`                                |
| `VERIFICATION_CAPTURE_READS_ENABLED`                         | api         | `1` to read terminals                                  |
| `VERIFICATION_PARSE_ARTIFACT_ENABLED`                        | api, worker | `0`/`1`                                                |
| `VERIFICATION_STRUCTURED_EXTRACTION_CONFIG_JSON`             | api, worker | JSON                                                   |
| `VERIFICATION_STRUCTURED_EXTRACTION_SIGNING_KEY_ID`          | worker      | required if config set                                 |
| `VERIFICATION_STRUCTURED_EXTRACTION_SIGNING_PRIVATE_KEY_PEM` | worker      | PEM                                                    |
| `VERIFICATION_STRUCTURED_EXTRACTION_READ_PUBLIC_KEYS_JSON`   | api         | JSON keys                                              |
| `AI_GATEWAY_API_KEY` or `INTERFAZE_API_KEY`                  | worker      | extraction host                                        |


### (c) Benchmark

Configs and signing keys. The claims/report, semantic, sealing, adjudication and audit-inspection profiles were retired in SV-17; their settings are refused at startup (`VERIFICATION_RETIRED_CONFIGURATION:<NAME>`).


| Var                                                         | Process     | Notes                                                  |
| ----------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| `VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON`                | api         | grant array; see [Ownership grants](#ownership-grants) |
| `VERIFICATION_BENCHMARK_CONFIG_JSON`                        | api, worker | JSON                                                   |
| `VERIFICATION_BENCHMARK_SIGNING_KEY_ID`                     | worker      | required if config                                     |
| `VERIFICATION_BENCHMARK_SIGNING_PRIVATE_KEY_PEM`            | worker      | PEM                                                    |
| `VERIFICATION_BENCHMARK_COMPARISON_CONFIG_JSON`             | api, worker | JSON                                                   |
| `VERIFICATION_BENCHMARK_COMPARISON_SIGNING_KEY_ID`          | worker      | required if config                                     |
| `VERIFICATION_BENCHMARK_COMPARISON_SIGNING_PRIVATE_KEY_PEM` | worker      | PEM                                                    |
| `VERIFICATION_BENCHMARK_READ_PUBLIC_KEYS_JSON`              | api         | JSON keys                                              |
| `VERIFICATION_BENCHMARK_COMPARISON_READ_PUBLIC_KEYS_JSON`   | api         | JSON keys                                              |
| `VERIFICATION_BENCHMARK_CAPTURE_PROFILES_JSON`              | api         | JSON                                                   |


Full matrix: [DEPLOYMENT.md](DEPLOYMENT.md).

## Attestation export and inspect

Local only. Does not call the API.

```bash
ks verify attestation export --audit-bundle <path> --trusted-public-keys <path> --trusted-binding <path> --output <path>
ks verify attestation inspect --audit-bundle <path> --trusted-public-keys <path> --trusted-binding <path> --attestation <path>
```

Export signs with `KNOWLEDGE_VERIFICATION_ATTESTATION_SIGNING_KEY_PEM`. Inspect: exit 0 verified, 1 not verified, 2 error.

## Replay

```bash
ks verify bundle replay --input '<ReplayRunRequestSchema JSON>' --context '<OperationContextSchema JSON>'
```

`ReplayRunRequestSchema`: `verificationContractVersion`, `runId`, `replayMode` (`deterministic_only` | `recorded_provider_outputs`). Path `runId` must match the body. `--wait` handles `verification_replay` (uses `result.valid`).

## Provider reconciliation

```bash
ks verify reconciliation apply --input '{"operationId":"<uuid>","providerAttemptId":"<uuid>","artifact":<VerificationArtifactHandle>}' --context '<context>'
ks verify reconciliation show --input '{"operationId":"<uuid>","providerAttemptId":"<uuid>"}' --context '<context>'
```

Apply never authorizes redispatch. Reconciliation exists for extraction attempts only (the claims/report hosts were retired in SV-17).

## Recovery

- Historical local DB wipe: `docs/workspaces/verification-module/LOCAL-RESET-RECOVERY.md`. Do not run `db:reset` against a shared populated project. Incremental migrate; disposable reset is `../../aiengineer/ai-engineer-db-contract/scripts/reset-disposable-local.mjs`.
- Retry / reconcile (generic operation control):

```bash
ks knowledge operation retry --input '{"operationId":"<uuid>"}' --context '<full OperationContext>'
ks knowledge operation reconcile --input '{"operationId":"<uuid>"}' --context '<full OperationContext>'
```

Manual retry is restricted to deterministic replay/extraction infrastructure failures. It does not retry provider-capable, unknown, policy, or quality outcomes.

## Hygiene

- Never load KS `.env` for local proofs.
- Never print grants, PEMs, or tokens.
- Sealed artifacts, audit bundles, and registered object-store bytes are immutable. Changing a judgment changes `manifestDigest`.
- Do not invent human labels. The diagnostics review pack candidates stay blank until authenticated humans annotate them.
- Claims verification, run sealing and review now go through `ks.knowledge_operation.v2` on the verification component; see the [integration guide](INTEGRATION-GUIDE.md#knowledge-operation-protocol-v2).

