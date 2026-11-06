# Unit 5 delivery slices

Status: proposed delivery plan, 2026-09-28. Scope and acceptance come from [UNIT-5-EXECUTOR-FOLD-CLI-AND-EVE.md](./UNIT-5-EXECUTOR-FOLD-CLI-AND-EVE.md); this page only divides that work into slices small enough for one agent or one small agent team per session. Progress: [workspace/PROGRESS.md](./workspace/PROGRESS.md).

## Why slices, and the adjusted branch rule

Unit 5 is larger than Units 1–4 combined and is the first unit that changes public surfaces and folds the executor. The developer prefers smaller slices because they produce higher-quality work. Adjustment to the one-branch-per-unit rule (developer preference, 2026-09-28; confirmed by the developer's 5A instruction): **one branch per slice**, named `refactor/ks-unit-5<letter>-<topic>`. Each slice is validated, reviewed, recorded in the ledger and merged locally before the next dependent slice starts. Eve slices 5E1/5E2 are superseded by [DeepAgents readiness](./DEEPAGENTS-READINESS.md); they are historical scope only and no longer gate cleanup.

Between slices, `main` may briefly hold both the executor and the folded platform surfaces. During the transition, the executor calls the same application use cases. That is not a forwarding adapter or a dual-running service: nothing preserves an old interface for compatibility, and slice 5H deletes the executor. No slice may add an alias, shim or legacy environment name.

## Slice map

| Slice | Repository | Topic | Depends on | Parallel with | Status |
| --- | --- | --- | --- | --- | --- |
| 5A | KS | Entry evidence and R1 `knowledge-db → persistence` inversion | Unit 4 main | — | merged locally 2026-09-28 |
| 5B | KS | Local host profile and capability matrix | 5A | — | merged locally 2026-09-28 |
| 5C | KS | `ks` CLI skeleton (remote), lazy offline dispatch and packaging | 5B | — | merged locally 2026-09-29 |
| Q0 | KS | Quality gates: formatter, lint ratchet, architecture boundary rules in `verify`/CI | 5C | — | merged locally 2026-09-29 (Biome, lint ratchet, boundary baseline; [record](./workspace/evidence/q0-validation.json)) |
| 5P | KS | Transport structure before the folds: catalog module, MCP tool table, API route modules, golden error tests, MCP naming decision | Q0 | — | merged locally 2026-10-01 ([validation](./workspace/evidence/unit5p-validation.json)) |
| 5D1 | KS | Fold the `db` group (schema, db, ingest, artifact) | 5P | — | queued |
| 5D2 | KS | Fold the `knowledge` group (source, checkpoint, content, report) | 5D1 | — | queued |
| 5D3 | KS | Fold the `verification` group (intent pipeline, `verify_*`, recovery), executor HTTP routes, MCP stdio | 5D2 | 5F | queued |
| 5F | KS | Jev transport consolidation (`ks jev`) | 5C | 5D3 | queued |
| 5E1 | Eve | Historical early path repair | — | — | superseded by [DR1–DR5](./DEEPAGENTS-READINESS.md) |
| 5E2 | Eve | Historical adaptation | — | — | superseded by [DR1–DR5](./DEEPAGENTS-READINESS.md) |
| 5H | KS | Remove the executor app; final acceptance; Unit 6 specification | 5C–5D3, 5F; DeepAgents smoke against ks (DR2 exit) | — | queued |

Q0 and 5P were added on 2026-09-29 (proposed; [app and skill quality plan](./APP-AND-SKILL-QUALITY.md)) so the folds add table entries to small modules instead of growing `apps/api/src/server.ts` (2,763 lines), `apps/mcp/src/index.ts` (1,250) and the CLI dispatch switch. Keep 5D1 → 5D2 → 5D3 sequential. They share hot files: the operation catalog (`packages/application/src/operations/catalog.ts`), the MCP registration, `apps/cli/src/commands.ts`, the application barrel and host composition. 5F touches Jev, CLI and MCP files; run it in parallel with 5D3 only when separate teams own disjoint files, and merge 5D3 first.

## Rules for every slice

- Read AGENTS.md, this page, the Unit 5 specification, the ledger's latest entry and the previous slice's ledger entry. Read FINAL-REVIEW R1, R3, R4 and R5 where the slice touches them.
- **Replay gate at entry.** Rerun `packages/application/src/verification/benchmark/verification-benchmark-registered-replay.test.ts` and record an explicit decision on the missing receipt (`SEALED_CHECKPOINT_MISSING:records/25-gl-repeatability-mutated-haiku_judge-failure.json`). No new failure, substitute receipt or weakened assertion.
- **Preserve:** behavior outside the slice's stated surface change, custody and receipts, authority outcomes, persisted identities, API/MCP parity (`api-mcp-parity.test.ts`), the no-HTTP-shim test, and Jev.
- **Catalog.** `packages/application/src/operations/catalog.ts` is the ledger of surfaces. A folded operation leaves `executor` admission only with real API/MCP/CLI bindings or a recorded exclusion reason. Declared kinds stay fail-closed. Ingestion keeps its receipt semantics.
- **Evidence.** Capture a before/after inventory with a copy of `workspace/evidence/unit4-inventory.mjs` renamed for the slice (`unit5a-inventory.mjs`, …). Record moved and renamed tests explicitly; allow no missing tests or changed outcomes.
- **Validation, sequentially** (PowerShell for `corepack`; the Git Bash corepack shim is broken):
  1. Frozen install; forced typecheck and build.
  2. Preserve and remove any stale `dist/*.test.js`.
  3. The full graph: `turbo run test --continue=always --concurrency=1 --force -- --maxWorkers=2`, listing every failure and skip.
  4. Examples and `node skills/check.mjs`.
  5. The slice's packaging smoke.
  6. `node .agent-docs/cli.mjs check --repo .` and `git diff --check`.

  Run one heavy command at a time: memory pressure has stopped a full run before.
- **Quality (from 5P onward).** New operations are table entries in the 5P route/tool/command modules; `server.ts`, MCP `index.ts` and CLI dispatch do not grow. Folded handlers keep the four-step shape — authorization and admission move into application use cases. Format, lint ratchet and boundary baseline (Q0; `pnpm format:check`, `pnpm lint`, `pnpm boundaries`, see `tools/quality/README.md`) may only improve. Apply the slice's additions in [APP-AND-SKILL-QUALITY.md §2](./APP-AND-SKILL-QUALITY.md#2-new-and-changed-work-by-slot).
- **Team shape.** Use one coordinator that owns the ledger, acceptance and the merge. Add at most one implementation worker per disjoint file set and one read-only reviewer. There is a single test-graph owner; no competing suites run.
- **Finish.** Record the slice in the ledger and `workspace/evidence/unit5<letter>-validation.json`, update navigation, merge locally with a merge commit and return to a clean `main`. Keep the stage-graph experiment milestone in the handoff. No push, deployment, paid provider call or shared-database mutation.

## Slices

### 5A — Entry evidence and the R1 inversion

- **Goal:** application can later depend on `knowledge-db` without a cycle.
- **Scope:**
  - Unit 5 entry evidence: the replay decision; export, test-identity and catalog inventories; Eve consumer re-inventory by exact file (read-only).
  - Narrow transaction and content-admission interfaces owned by `knowledge-db`, implemented in persistence and injected through host (and through the executor's current composition until 5D1).
  - Remove the production `knowledge-db → persistence` dependency.
- **Must not:** move the pool into core, make application import host, add a package to dodge an ownership decision, or change transaction scope, bounded roles or atomic receipts.
- **Exit:**
  - Manifest graph acyclic, with no `knowledge-db → persistence` production edge.
  - `knowledge-db` and executor suites keep their identities.
  - Adapters tested in persistence.
- **Delivered:** `packages/knowledge-db/src/ports.ts` (`KnowledgeSqlClient`, `KnowledgeTransactions`/`KnowledgeDatabase`, `KnowledgeTransactionScope`, `KnowledgeRole`, `ContentAdmission`); persistence's `TenantPostgres` and new `postgresContentAdmission` implement them; the executor composition injects them because host does not compose knowledge-db before 5D1. Persistence stays a knowledge-db **devDependency** for the database integration tests, their fixtures and the source-reader test. See the ledger's 5A entry.

### 5B — Local host profile

- **Goal:** `createHost({ profile: "local" })` over the executor's file store (today's `VERIFY_STORE_DIR`).
- **Scope:**
  - A capability matrix test covering server, local and remote CLI.
  - Offline operations need no network, database or credentials: register, capture-file, read/search/locate, claims/extraction/report mechanics, policy, seal, status.
  - Online capture and semantic judging run only with explicit provider configuration; otherwise `CAPABILITY_NOT_ADMITTED`.
  - Database-backed operations are server-only.
  - Lazy construction; idempotent `close()`; partial-start cleanup.
  - Update the catalog test so local-profile rows report their real state instead of `unavailable`.
- **Must not:** fall back silently after a remote auth or network error, or change transports yet.
- **Exit:**
  - The host test proves no network or database is touched at construction and offline operations work.
  - The Unit 2 lifecycle tests still pass.
- **Delivered:** `packages/host/src/local/` — `createHost({ profile: "local", storeDir, identity?, providers?, verification })` and the capability matrix (`localVerificationOperations`, `profileAvailability` over `server`, `local`, `remote-cli`; `HostCapabilityNotAdmittedError`, code `CAPABILITY_NOT_ADMITTED`). Provider configuration is an explicit option (`providers.capture`, optional Firecrawl key for document conversion; `providers.semantic`, AI gateway key); the local path never reads provider credentials from the environment. Host cannot import an app, so the executor supplies its file-backed intent pipeline through a typed **5D3 seam** (`executorLocalVerification` in `apps/verification-executor/src/local-services.ts`: a pure `captureMediaKind` and a lazy `create`); the executor has a type-only devDependency on host. The executor's own CLI, MCP and HTTP surfaces are unchanged. See the ledger's 5B entry.

### 5C — `ks` CLI skeleton and packaging

- **Goal:** one binary, `ks`, in `apps/cli`.
- **Scope:**
  - `ks knowledge|verify|db|jev …`, with today's platform commands mapped into the groups.
  - Remote mode through `KnowledgeClient` (API URL and bearer, replacing `VERIFY_EXECUTOR_URL`/token for folded commands); offline commands load the local host lazily.
  - `--help` and remote commands never construct host.
  - Exit codes `0`/`1` gate failed/`2` usage-auth-network-executor.
  - `pack:sandbox` becomes a CLI build target producing a `ks` tarball with required skills; the executor tarball stays until 5H.
  - Record final command names; remove the CLI's `knowledge` binary.
  - Carried from 5B: decide how `ks` obtains the local verification seam before 5D3 (it lives in the executor app; the CLI must not import another app's internals without a recorded decision), map CLI flags/environment onto `providers` and `identity` (no legacy `VERIFY_*` names), and replace `apps/cli/src/tests/remote-profile.test.ts`'s no-host-dependency check with one over the module graph `--help` and remote commands load.
- **Exit:**
  - The installed `ks` tarball, outside the workspace with no secrets, passes `--help`, a remote command against a local API, and an offline command.
  - Catalog CLI bindings updated to `ks` command names.
- **Delivered:** `apps/cli` builds one self-contained `ks` binary (the `knowledge` bin is gone). Command names live in `apps/cli/src/ks-commands.ts`: every platform command keeps its dispatcher entry and gains one name in the `knowledge`, `verify` or `db` group (the `verify` and `db` resources sit at their group root: `ks verify citations`, `ks db verify`); the intent pipeline is `ks verify capture|artifact|chain …` on the local profile; the offline utilities are `ks verify demo|benchmark diff|benchmark capture diagnostics-companies|attestation export|inspect`; `ks jev` is reserved for 5F. Each command has one profile, never a fallback. Recorded decisions: `ks` reaches the 5B seam only through the executor's transitional `./local-verification` export, imported by the lazily loaded `src/local/offline.ts`, and host's new `./local` entry (no server composition); 5D3 removes the export and the CLI's executor dependency. Local configuration: `--store`/`KNOWLEDGE_LOCAL_STORE_DIR` (default `.knowledge-store`), identity flags or `KNOWLEDGE_LOCAL_*`, providers only when named (`--providers`/`KNOWLEDGE_LOCAL_PROVIDERS`) with keys only from `KNOWLEDGE_LOCAL_FIRECRAWL_API_KEY`/`KNOWLEDGE_LOCAL_AI_GATEWAY_API_KEY`; no `VERIFY_*` name. `remote-profile.test.ts` checks the bundle metafile's static graph. `pack:sandbox` builds `apps/cli/dist/sandbox/ks-<version>.tgz` with the `platform-cli` skills and `zod`; catalog rows use `ks` names and the 16 intent-pipeline rows record `executor.ks`. See the ledger's 5C entry.

### 5D1 — Fold the `db` group

- **Goal:** `schema_*`, `db_*`, `ingest_*` and `artifact_get` become application use cases under `application/src/db/`, composed by host.
- **Scope:**
  - Bind them on API, MCP and `ks db …`, and set their catalog rows to real admission and bindings.
  - Ingestion keeps its transaction and receipt semantics, with no durable operation kind.
  - The executor's registry calls the same use cases until 5H.
  - Record the MCP names chosen per R3.
  - **First, remove the test-only `knowledge-db → persistence` edge** (carried from 5A). Turbo and pnpm order builds over devDependencies, so `application → knowledge-db` plus that edge closes `knowledge-db → persistence → application → knowledge-db`. Move the database-backed knowledge-db suites that need `TenantPostgres` (the seven `*.integration.test.ts` files, `test/ingestion` fixtures and `content-links/sources.test.ts`) to where host composes knowledge-db, or inject the transaction adapter through a test setup owned there; record every moved identity. Move the executor's `knowledge-db-ports.test.ts` conformance test with the composition into host.
- **Quality additions:** begin collapsing `CLI_COMMANDS` into `KS_COMMANDS` entries `{ profile, schema, summary, run }` with one shared argv parser; db-group errors use the contracts code set.
- **Exit:**
  - Every db-group catalog row leaves `executor`.
  - Bounded-read and ingestion tests keep their identities.
  - API/MCP parity rows added for the new reads.

### 5D2 — Fold the `knowledge` group

- **Goal:** `source_*` (discover, import, attempt, reconcile, select, prepare-captured), `checkpoint_*`, `content_*` and `report_*` become application use cases under `knowledge/` and `verification/` as appropriate.
- **Scope:**
  - Root and scoped host composition moves from the executor into host.
  - Bind on API, MCP and `ks knowledge …`, and update catalog rows.
  - Preserve provider accounting, custody and checkpoint semantics.
- **Quality additions:** break the executor ↔ worker relative `src/` imports first (activity registry, `CanonicalDurableKnowledgeWorker` and promotion-selection ports move to application/host); name an owner for every `root-host-*` module; move test-only fixtures (`selected-candidate-fixture.ts`, `report-dependency-fixture.ts`, `recovery-test-fixtures.ts`) to host test support with their suites, replacing sibling-repository paths with explicit configuration.
- **Exit:**
  - Those catalog rows leave `executor`.
  - No package or app imports another app's `src/`.
  - Custody, recovery and checkpoint suites keep their identities.

### 5D3 — Fold the `verification` group, executor HTTP routes and MCP stdio

- **Goal:** the intent pipeline (`verify_*`: capture, capture-file, media types, read/search/locate, register, claims, extraction, judge, policy, seal, check-report, status, get-artifact) and `recovery_*` run as application use cases on the server and local profiles.
- **Scope:**
  - The API absorbs `/artifacts`, `/captures`, `/media-types` and `/runs/:runId` under existing auth and problem mapping.
  - MCP registers the group, with `verify_*` names unchanged unless recorded.
  - MCP stdio in `apps/mcp` runs on the local profile; `ks verify …` covers the CLI.
  - Decide replacements for `root-host/v1`, `scoped-host/v1` and `evidence-reader/v1` per consumer.
  - Retire 5B's `verification` seam: the local profile composes the application use cases directly, and the executor's `local-services.ts` and host devDependency go.
- **Quality additions:** split `executor.ts` into one use case per `verify_*` operation rather than moving the class; reuse core's `deterministicUuid`; no `process.env` provider reads.
- **Exit:**
  - No catalog row left in `executor` admission.
  - The offline example passes through `ks` with receipts and zero provider calls.
  - Stdio smoke against the local profile.

### 5F — Jev transport consolidation

- **Goal:** one Jev service instance per SQLite database.
- **Scope:**
  - HTTP and MCP in the owner process share that instance; other processes use the client.
  - Define the owner start command and reject dual ownership.
  - `ks jev …` replaces `jev`; the six Jev MCP tools and the registered skill stay.
- **Quality additions:** `jev_*` as an MCP tool-table group and `ks jev` table entries; drop repository-file serving; not-found is an error and unknown errors map to 500; shared exit-code mapping.
- **Must not:** remove `apps/jev` before equivalent surfaces and lifecycle proofs pass (recovery, cancel, retry, auth).
- **Exit:** Jev core, service and client suites pass, with lifecycle proofs recorded.

### 5E1 — Eve early path repair (superseded history)

Superseded by [DeepAgents readiness](./DEEPAGENTS-READINESS.md). Do not implement for this fixture; the former scope below is retained only as history.

- **Goal:** Eve's t14 hosts load the current KS packages, independent of the fold.
- **Scope:**
  - `tools/team/t14-platform-host.mjs`: compose MCP with in-process knowledge services instead of the removed `createApiClient`; load `client` and `core` instead of `client-typescript` and `runtime`.
  - `t14-launcher.mjs`: replace the pre-Unit-1 package list (`client-typescript`, `db-read`, `domain`, `embeddings`, `ingestion`, `runtime`, `schema-workspace`) and the `@aiengineer/knowledge-embeddings` resolution.
  - `t14-ks-host.mjs`: `packages/runtime` → `packages/core`.
- **Must not:** edit KS; change binaries, skills or packaging (that is 5E2).
- **Exit:** Eve's t14 unit and integration tests pass, or are listed with the prerequisite they need (for example a disposable database).

### 5E2 — Eve adaptation to `ks` and the folded surfaces (superseded history)

Superseded by [DeepAgents readiness](./DEEPAGENTS-READINESS.md). Eve stays in its repository, unmaintained for the fixture; an adapter may come later. The former scope below is history, not acceptance.

- **Goal:** Eve uses `ks`, the folded API/MCP surfaces and the new packaging.
- **Scope:**
  - `tools/experiment-runner` (executor entry, tarball pointer).
  - `tools/skill-pack-sync/sync.mjs` and `skill-packs.generated.ts` (skill homes).
  - `agents/verified-research/agent/lib/profiles.ts`, `instructions/surface.ts` and `connections/verification.ts`.
  - The sandbox image (`knowledge-verify`, `knowledge` and `VERIFY_EXECUTOR_URL` → `ks` and its remote configuration).
  - Stage/child input and result manifests if Eve owns them.
- **Exit:**
  - Eve integration smoke on the new services.
  - No reference to removed binaries, packages or entrypoints.

### 5H — Executor removal and Unit 5 acceptance

- **Goal:** delete `apps/verification-executor` and finish the unit.
- **Scope:**
  - Remove its package, exports, binaries and sandbox packer; move its skill home to `skills/` if 5C did not.
  - Final Unit 5 acceptance (full graph, inventories, installed `ks` smoke, DeepAgents smoke against ks).
  - Update the documentation and ledger, and write the bounded Unit 6 (skills) specification, absorbing the [Unit 6 quality additions](./UNIT-6-SKILLS-DIRECTION.md#additions-from-the-2026-09-29-quality-review).
  - Replace `apps/api/src/tests/consumer-transports.integration.test.ts`'s sibling-repository Eve import with a public-contract test (or remove it once DR2's smoke covers it); drop executor entries from the Q0 boundary baseline.
- **Exit:** everything in the Unit 5 specification's acceptance evidence, recorded; rerun the DR2 smoke after executor removal. Full DR4/Unit 6 readiness is not a prerequisite for this minimal smoke.

## Instruction template

Paste this into the next session, replacing `<slice>` with the next slice from the map (next: **5D1**; 5A–5C, Q0 and 5P are delivered and 5E1/5E2 are superseded; 5F now depends only on delivered 5C; run beside 5D3 only with disjoint files, merging 5D3 first):

> Continue the Knowledge Services package cleanup, Unit 5 slice `<slice>`, from local main in `C:/Users/Pinda/Proyectos/BellLabs/platform/knowledge-services`.
>
> Read repository AGENTS.md, then these files in `docs/operations/package-cleanup/`: `workspace/PROGRESS.md` (latest entries), `NEXT-PACKAGE-CLEANUP.md`, `UNIT-5-EXECUTOR-FOLD-CLI-AND-EVE.md` and `UNIT-5-SLICES.md`.
>
> Implement only slice `<slice>`, on its own branch `refactor/ks-unit-5<letter>-<topic>`, with cohesive commits, following the slice's scope, "must not" and exit criteria and the rules for every slice:
> - replay gate at entry with an explicit recorded decision;
> - before/after inventory;
> - catalog rows updated as surfaces change;
> - the sequential full test graph with every failure and skip listed;
> - the slice's packaging smoke;
> - the docs check.
>
> Use one coordinator, at most one worker per disjoint file set and one read-only reviewer; no competing suites. Preserve custody, receipts, authority outcomes, persisted identities, API/MCP parity and Jev. Add no aliases or shims.
>
> Record the slice in the ledger and an evidence record, update navigation and the slice map status, merge locally with a merge commit and return to a clean main. Then name the next slice.
>
> Keep the bounded stage-graph experiment milestone in the handoff (research → reports → ingestion consuming both manifests → restoration and fresh-consumer evaluation; provisional results, distinct from fixture acceptance); do not build its runner.
