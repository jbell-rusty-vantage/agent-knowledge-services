# Knowledge Services current architecture

Status: reference. Source-backed snapshot at cleanup slice 5P, integrated in `3528642`; subsequent changes require reinspection. This is neither a deployment attestation nor a replacement for accepted ADRs.

## What exists

Knowledge Services owns preparation, evidence retrieval, evaluation, verification and policy admission. Shared schema/migration authority stays in `ai-engineer-db-contract`; cross-repository callers use HTTP/client, CLI or MCP rather than internal algorithm imports.

| Concern | Current implementation | Entry |
| --- | --- | --- |
| Composition | Server API/MCP/worker roles and a local verification profile with owned lifecycle. | [createHost](../../packages/host/src/create-host.ts) |
| Shared behavior and availability | Application use cases, admission, reads and an operation catalog that distinguishes executable, gated, declared and executor-only capabilities. | [Catalog](../../packages/application/src/operations/catalog.ts) |
| Platform transports | API route modules; typed MCP tool registration; `ks` command bindings. API and MCP invoke application in process. | [API](../../apps/api/src/index.ts), [MCP](../../apps/mcp/src/index.ts), [CLI](../../apps/cli/src/ks-commands.ts) |
| Local verification | File-backed capture and artifact tools through host, using an executor-owned transitional seam (a non-authoritative capture cache since SV-17). Remote CLI never falls back to this profile. | [Capability matrix](../../packages/host/src/local/capabilities.ts) |
| Database/schema and custody tools | Schema exploration, bounded reads, deterministic ingestion, source discovery and checkpoint groups remain on executor surfaces pending folds; the report, content-link and recovery groups were retired in SV-17. | [Executor registry](../../apps/verification-executor/src/knowledge/operations.ts) |
| Jev | Dedicated service/CLI, SQLite queue and child workers. | [Jev architecture](modules/jev.md) |
| Conversion | Preparation owns routing; Docling and isolated PDF/HTML parser have distinct process boundaries. | [Capture/conversion concept](../../knowledge/capture-conversion-and-custody.md) |

The merged package folders are `core`, `sources`, `preparation`, `retrieval`, `knowledge-db`, `application`, `host`, `contracts`, `client`, `persistence`, `policy`, `evaluation`, `verification`, `testkit` and `jev`. Historical package names such as `conversion`, `chunking`, `embeddings`, `schema-workspace` and `db-read` now identify submodules, not independent workspace packages. `packages/sources` retains npm name `@aiengineer/knowledge-acquisition`; folder and package name are not interchangeable.

## SV-17 verification cutover (2026-10-25)

The `knowledge_verification` component (2.5.0, migrations 0001..0008; 0008 `effect_dispatch_journal`; bindings require at least 2.5.0) is the only authority for verification runs, claims and seals, reached through `ks.knowledge_operation.v2` on the [executor](../../packages/host/src/knowledge-operation/service.ts). The legacy `verification.v1` claims, report, metric, adjudication, audit-bundle, semantic, run/case read, drift and recovery surfaces were removed from contracts, application, persistence, host, worker, API, MCP, CLI, client and executor; the executor's file-store verifier chain and intent files went with them. The vendored contract is `@aiengineer/database-contract` 0.6.0 (tracked `vendor/aiengineer-database-contract-0.6.0.tgz`, head `20261031010000`: receipt targets, origin digest and Mission Control coordinates, `mission_run_effects`); contract 0.5.0 (head `20261025010000`) withdrew the tables behind those surfaces. The pin does not attest a live database's head: the Sprint OC W0 remote disposable was installed at `20261025010200` and has not received `20261031010000`. K01 also serves `knowledge.read_intent`, a recorded read (see [schema, reads and ingestion](../../knowledge/schema-read-and-ingestion.md#two-read-contracts-with-similar-names)). Ingestion admits cited runs only through `exactUse` ([oracle](../../packages/knowledge-db/src/ingestion/exact-use-oracle.ts)) and enforces the K08 use-class registry. Retired configuration is refused at startup. The retained `verification.v1` operations are listed in the [verification guide](../verification/README.md#operation-kinds-and-use-cases).

## What 5P changed

The application owns the [operation catalog](../../packages/application/src/operations/catalog.ts). Platform MCP names follow `knowledge_*` and `verify_*`; old dotted and `knowledge_verify_*` names have no compatibility aliases. Transport handlers were structured without claiming the later executor fold had happened. Representative checks are [catalog parity](../../apps/mcp/src/tests/operation-catalog.test.ts), [API/MCP parity](../../apps/mcp/src/tests/api-mcp-parity.test.ts), [API golden errors](../../apps/api/src/tests/golden-errors.test.ts), and [MCP golden errors](../../apps/mcp/src/tests/golden-errors.test.ts).

Q0's Biome formatting, lint ratchet and dependency-cruiser boundary baseline are already configured in [quality tooling](../../tools/quality/README.md). A baseline records tolerated existing debt; it does not certify a clean architecture.

## Accepted target and unfinished work

The [accepted layout](../operations/package-cleanup/FINAL-LAYOUT.md) remains the target. [Unit 5 slices](../operations/package-cleanup/UNIT-5-SLICES.md) separately define executor database/knowledge/verification folds (5D1–5D3), Jev consolidation (5F), and executor retirement (5H). The current `jev` binary and executor package must be preserved until their replacement gates pass.

Ten root skills plus the executor skill are shipped (the verification recovery skill was retired in SV-17). Eight canonical skills and DeepAgents parser conformance are [Unit 6 direction](../operations/package-cleanup/UNIT-6-SKILLS-DIRECTION.md), not delivered behavior. [DR1-DR5](../operations/package-cleanup/DEEPAGENTS-READINESS.md) and the [seven-stage fixture](../operations/package-cleanup/REAL-FIXTURE-STAGE-GRAPH.md) separate readiness from provisional experiments and full quality acceptance. Their research-agent runner path is historical: `research_ingestion_systems_agent` is retired and absent. No replacement consumer is established by those documents; use the [current neighbor map](../../README.md#neighbor-systems) and qualify an explicit consumer before running a fixture. Historical Eve integration wording does not override that boundary.

## Evidence limits

This snapshot inspected implementation and test anchors; it did not run live providers, change the database or deploy services. The cleanup [continuation](../operations/package-cleanup/NEXT-PACKAGE-CLEANUP.md) records a missing historical judge-failure receipt and its exact baseline exception. Do not translate successful scoped checks into an unqualified full-suite or production-readiness claim. For an actual incident, use the owning [verification runbook](../verification/OPERATOR-RUNBOOK.md).
