# Unit 5 specification: executor fold, `ks` CLI, local profile and MCP stdio

Status: proposed execution specification, prepared at the end of Unit 4 on 2026-09-28. Begin only from the locally integrated Unit 4 main. Parent: [FINAL-LAYOUT.md](./FINAL-LAYOUT.md), unit 5 (§3, §4.1, §4.4) and [review](./FINAL-REVIEW.md) R1, R3, R4, R5. Previous unit: [UNIT-4-APPLICATION-ORDER-AND-CATALOG.md](./UNIT-4-APPLICATION-ORDER-AND-CATALOG.md). Progress: [workspace/PROGRESS.md](./workspace/PROGRESS.md).

Delivery is divided into slices (5A–5H, one branch per slice) in [UNIT-5-SLICES.md](./UNIT-5-SLICES.md); start each session there.

Eve adaptation is **superseded** by [DeepAgents readiness](./DEEPAGENTS-READINESS.md), decision 2026-09-29. The filename stays for stable links; historical item 6 is not executable scope. KS slices 5C–5D3 and 5F are unchanged.

## Scope and entry gate

Use the one-branch-per-slice names in [UNIT-5-SLICES.md](./UNIT-5-SLICES.md), from integrated local main; next is `refactor/ks-unit-5d1-db-group` (5A–5C are delivered). Unlike Units 1–4 this unit changes surfaces deliberately: the executor binaries (`knowledge-verify`, the executor's `knowledge`) and the CLI's `knowledge` binary are replaced by one `ks`; the DeepAgents consumer smoke validates the folded contract. Eve skill sync and Eve sandbox packaging are no longer Unit 5 acceptance items. No forwarding adapters, dual-running services or legacy aliases (R3, R4). Authority outcomes, custody, receipts and persisted identity strings do not change.

Before editing, rerun the registered-replay test (`packages/application/src/verification/benchmark/verification-benchmark-registered-replay.test.ts`) and record an explicit decision on the missing historical judge receipt. No new failure, substitute receipt or weakened assertion.

Out of scope: skill renames and the eight-skill layout (Unit 6; Unit 5 packages the skills that exist), `scripts/` → `proofs/` (Unit 7), worker activity extraction, the error-code set in `contracts` unless a fold needs it, and the pre–Mission Control experiment runner.

## Inputs from Unit 4

- **Catalog.** `packages/application/src/operations/catalog.ts` lists every executor operation with admission `executor`: 42 registry operations (`schema_*`, `db_*`, `ingest_*`, `artifact_get`, `source_*`, `checkpoint_*`, `content_*`, `report_*`, `recovery_*`) and 16 `verify_*` tools, each excluded from ks api/mcp/cli with the reason "Unit 5 folds…". Folding an operation means changing its row to `admitted`/`gated` with real bindings (the parity test then requires them to be registered) or recording an explicit removal. Ingestion keeps its transaction and receipt semantics; it gains no durable operation kind. Declared kinds stay fail-closed.
- **Binaries today:** `apps/cli` `knowledge` (remote, `KnowledgeClient`), executor `knowledge-verify` (`index.ts`: local store, remote via `VERIFY_EXECUTOR_URL`, `serve`, `mcp-stdio`) and executor `knowledge` (`knowledge.ts`: the registry CLI), and `apps/jev` `jev`. Executor exports `root-host/v1`, `scoped-host/v1`, `evidence-reader/v1`; `pack:sandbox` builds `dist/sandbox/knowledge-verify-<version>.tgz` with the `knowledge-verify` skill.
- **Executor environment:** `VERIFY_STORE_DIR`, `VERIFY_EXECUTOR_URL`, `VERIFY_EXECUTOR_TOKEN`, `VERIFY_HOST`/`VERIFY_PORT`, `VERIFY_TENANT_ID`, `VERIFY_PRINCIPAL_SALT`, `VERIFY_JUDGE_MODEL`, `VERIFY_CROSS_FAMILY_JUDGE_MODEL`, producer/verifier deployment and attempt ids, `VERIFY_GIT_SHA`, `VERIFY_RECOVERY_REQUIRED`.
- **Naming pass:** `packages/sources`, `packages/client`, `services/parser` (npm names unchanged).

## Work items

0. **R1 prerequisite (separate, behavior-preserving commit).** `knowledge-db` still depends on `persistence`, which depends on `application`. Specify narrow transaction and content-admission interfaces owned by `knowledge-db`, implement them in persistence, inject them through host, and remove the production `knowledge-db → persistence` dependency before any `application → knowledge-db` import. Preserve transaction scope, bounded roles, custody and atomic receipts. Do not move the pool into core or make application import host. *Delivered in slice 5A (production edge removed; the test-only edge is carried to 5D1 — see [UNIT-5-SLICES.md](./UNIT-5-SLICES.md)).*
1. **Local profile in host.** Implement `createHost({ profile: "local" })` over the executor's file store (today's `VERIFY_STORE_DIR` mode) with an explicit capability matrix (R5): offline operations (register, capture-file, read/search/locate, claims/extraction/report mechanics, policy, seal, status) need no network, database or credentials; online capture and semantic judging run only with explicit provider configuration and otherwise fail `CAPABILITY_NOT_ADMITTED`; database-backed registry operations are server-profile only. No silent fallback after a remote authorization or network error. Construction is lazy; `close()` keeps Unit 2's lifecycle rules. *Delivered in slice 5B (the executor supplies the file-backed services through a typed seam until 5D3 — see [UNIT-5-SLICES.md](./UNIT-5-SLICES.md)).*
2. **Executor use cases into application and host.** Move the registry and `verify_*` pipeline into application use cases by tool group (`db/` for schema/db/ingest, `knowledge/` for source/checkpoint/content/report, `verification/` for recovery and the intent pipeline) with the §4.2 handler shape; host composes them for the server and local profiles. Move root/scoped host composition into host; replace the three executor export subpaths with the published consumer contracts from host or the client (decide per consumer, no aliases).
3. **Transports.** API absorbs the executor's HTTP routes (`/artifacts`, `/captures`, `/media-types`, `/runs/:runId`) under the existing auth and problem mapping. MCP registers the folded tool groups; decide and record final names per R3 (`verify_*` unchanged by default). Add MCP stdio on the local profile in `apps/mcp`; a remote agent keeps the HTTP MCP endpoint.
4. **`ks` CLI.** One binary in `apps/cli`: `ks knowledge|verify|db|jev …`. Remote mode uses `KnowledgeClient` (replacing `VERIFY_EXECUTOR_URL`/token with the API URL and bearer); offline commands lazily load the local host; `--help` and remote commands never construct host (R5). Exit codes `0`/`1` gate failed/`2` usage-auth-network-executor. `pack:sandbox` becomes a CLI build target producing a `ks` tarball with its required skills; test the installed tarball outside the monorepo without database secrets or workspace resolution. *Delivered in slice 5C for the platform commands and the local-profile intent pipeline (`ks jev` waits for 5F; the db, knowledge and verification folds bind their remaining `ks` names in 5D1–5D3) — see [UNIT-5-SLICES.md](./UNIT-5-SLICES.md).*
5. **Jev transport consolidation** (Unit 2 decision). One Jev service instance per SQLite database; HTTP and MCP in the owner process share it; other processes use the client. Define the owner start command, reject dual ownership, preserve recovery/cancellation/retry and authentication; `ks jev …` replaces the `jev` CLI surface. Keep `apps/jev` until equivalent surfaces and lifecycle proofs pass; the six Jev MCP tools and the registered skill stay available.
6. **Eve adaptation — superseded history, not work or acceptance** (replaced by DR1–DR5; former scope follows):
   - `tools/team/t14-platform-host.mjs`: compose MCP with in-process knowledge services instead of the removed `createApiClient`; load `packages/client` and `packages/core` instead of `client-typescript` and `runtime`.
   - `tools/team/t14-launcher.mjs`: the runtime package list still names pre-Unit-1 packages (`client-typescript`, `db-read`, `domain`, `embeddings`, `ingestion`, `runtime`, `schema-workspace`) and resolves `@aiengineer/knowledge-embeddings` from the worker; point them at `client`, `knowledge-db`, `core`, `retrieval` and the new `ks`/host entrypoints.
   - `tools/team/t14-ks-host.mjs`: `packages/runtime` → `packages/core`; executor package directory → `ks`.
   - `tools/experiment-runner/run.mjs` and `lib/tarball.mjs`: executor entry and `dist/sandbox/TARBALL` → the `ks` build and tarball.
   - `tools/skill-pack-sync/sync.mjs` and `agents/verified-research/agent/lib/skill-packs.generated.ts`: executor skill home (`apps/verification-executor/skills/knowledge-verify`) → its new home.
   - `agents/verified-research/agent/lib/profiles.ts`, `instructions/surface.ts`, `connections/verification.ts` and the sandbox image: executables `knowledge-verify`/`knowledge` and `VERIFY_EXECUTOR_URL` → `ks` and its remote configuration.
   - Stage/child input and result manifests needed by the stage-graph experiment, if Eve owns them.
7. **Remove the executor app** once every catalog row has left `executor` admission and the DeepAgents smoke against ks (DR2 exit) passes on the new surfaces. Repeat the smoke after removal.

## Carried items

- Host `verification/api/*-runtime.ts` still combine construction with ownership gates (`createVerificationOperationReadAuthorizer`, reconciliation grant matching). Extract them into application ports only with their tests, if the fold touches them; failure codes unchanged.
- One error-code set in `contracts` (FINAL-LAYOUT §4.2) mapped once for API and MCP; do not change statuses or titles.
- `scripts/run-verification-security-regressions.mjs` names test files that moved before Unit 4 in five packages; fix with Unit 7's proof reorganization.
- tsup/tsc builds do not clean `dist`: stale compiled files survive moves (the old acquisition `dist/*.test.js` hazard; stale flat `.d.ts` in `packages/application/dist`). Preserve and remove before acceptance runs.

## Bounded sequence

1. Entry evidence: replay decision; export, test-identity and catalog inventories (extend `unit4-inventory.mjs`); historical consumer inventory may be consulted read-only.
2. R1 inversion; validate and commit.
3. Local profile and capability matrix with tests; validate and commit.
4. Fold executor use cases by tool group, one group per commit (db, knowledge, verification), updating catalog rows as they become platform bindings.
5. API routes, MCP groups and stdio, then `ks` CLI and packaging; installed-tarball smoke.
6. Jev consolidation with lifecycle proofs.
7. DeepAgents smoke against ks after 5C–5D3 and 5F; then executor removal and repeat smoke.
8. Documentation, ledger, Unit 6 specification, local KS integration. Readiness changes integrate separately in their owner repository.

## Acceptance evidence

- Frozen install, forced typecheck/build, complete sequential test graph with every failure and skip listed; registered-replay decision recorded. Declared graph acyclic; no `knowledge-db → persistence` production edge; host imports no app.
- Catalog parity test: no row left in `executor` admission; every folded operation bound or explicitly removed; declared operations still fail closed; API/MCP parity and no-HTTP-shim tests pass.
- Local profile: offline commands pass with no network, database or credentials; online-only commands fail explicitly.
- `ks` installed from its tarball outside the workspace: `--help`, remote commands against a local API, offline example with receipts and zero provider calls.
- Jev: one owner per database, shared HTTP/MCP instance, `ks jev` and the six MCP tools, recovery/cancel/retry proofs.
- DeepAgents smoke against ks: required KS connectivity, a real config-composed parent/compiled child, service receipts, sandbox reachability and denied unauthorized mutations through published contracts (DR2). No Eve smoke, skill-pack-sync or Eve sandbox tarball gate. The installed `ks` tarball check above remains.

## Pre–Mission Control experiment dependency

Unit 5 supplies the folded KS contracts and the minimal [DR2 DeepAgents smoke against ks](./DEEPAGENTS-READINESS.md#dr2--ks-reachability). Stage tool subsets come from the operation-catalog groups. Unit 5 does not build or run the real stage graph; Unit 6 conformance and DR1–DR5 gate that later fixture.
