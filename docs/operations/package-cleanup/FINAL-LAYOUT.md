# Knowledge Services final layout

> Current continuation: [NEXT-PACKAGE-CLEANUP.md](./NEXT-PACKAGE-CLEANUP.md) records the merged Jev starting point and the exact Unit 1 missing-fixture exception; it supersedes the earlier green-only prerequisite for that failure only.

Status: accepted (2026-09-27, developer-approved in session).

This is the target package, app, and skill layout for `ai-engineer-knowledge-services`, and the rule for how transports call application code. It supersedes the sequencing in the [archived feature specification](./archive/FEATURE-SET-SPECIFICATION.md) (S0–S7) and [archived orchestration plan](./archive/ORCHESTRATION-PLAN.md) as the source of truth for **what exists and in what order it is built**. The folder-level decisions inside packages recorded in the [Phase 1 memo](./archive/PHASE-1-RECOMMENDATION.md) and [Phase 2 memo](./archive/PHASE-2-RECOMMENDATION.md) stay valid; they become subfolders of the merged packages below. Consult these memos only for those retained decisions, not their superseded execution instructions.

Working rule: **progress over perfection.** Use one branch per unit from integrated local `main`, with multiple cohesive commits as needed. Validate and merge the completed unit into local main before branching for the next unit; remote PR publication is separate. Units are mechanical where specified and are done when their acceptance checks pass, subject only to the explicit Unit 1 baseline exception in the current handoff. No approval memo is required for routine local integration; a unit that changes behavior states and tests that change in its specification. Preserve functionality while progressing toward organized packages/apps, redesigned skills, DeepAgents readiness and pre–Mission Control evaluation.

Implementation entrypoint: [execution workspace](./workspace/README.md) and [progress ledger](./workspace/PROGRESS.md). The [final implementation review](./FINAL-REVIEW.md) records source-backed considerations. Complete [unit 0's reproducible baseline](./UNIT-0-BASELINE.md) before mechanical merges; it does not replace the seven-unit sequence.

Historical developer clarification (2026-09-27; Eve integration superseded by the 2026-09-29 decision below): no live consumers currently use these services. The Eve research agent is the test consumer and intended real integration; adapt it directly to the new services and updated skills. No legacy compatibility adapters or staged production migration are required. After cleanup and Eve adaptation, run the pre–Mission Control testing with the updated skills. This clarification supersedes compatibility gates below or in historical review text wherever they imply supporting old consumers during the transition.

Developer decision (2026-09-29): the test consumer and real fixture harness is the config-composed DeepAgents stage runner, with real compiled sync and native async children. Eve stays untouched and unmaintained for the fixture; an adapter may come later. Order: KS cleanup/readiness → DeepAgents readiness → real fixtures → Mission Control. This supersedes Eve adaptation/skill-sync requirements throughout this layout; persisted-data preservation remains unchanged.

## 1. Why

A 2026-09-27 survey (source lines excluding tests, `@aiengineer/*` dependencies from each `package.json`):

- Verification is most of the repository: ~90% of `packages/application`, ~half of `packages/persistence`, ~half of `apps/worker`, 168 of 191 files in `scripts/`, plus `packages/verification` (13.4k) and `apps/verification-executor` (9.8k).
- `apps/verification-executor` is a second service: its own CLI (`knowledge-verify`), MCP server (`verify_*`), HTTP routes, store, skill home, and application logic in `src/knowledge/`.
- Six packages are under 600 lines (`domain` 87, `observability` 11 and unused, `config` 164, `documents` 195, `chunking` 364, `runtime` 599).
- Four chains exist only to feed one consumer: `schema-workspace → db-read → ingestion` (only the executor); `projections`, `vector-backends`, `embeddings` → `retrieval` (only application).
- Transports do not all follow ADR 0004: MCP still calls the API over HTTP (`createApiClient`), ownership/admission and the retrieval executor live in `apps/api`, API and worker each wire their own `*-runtime.ts` files, and the worker imports algorithm packages directly.

Review correction at `9084428`: verification ownership/admission factories already exist in application, and API/MCP share `packages/persistence/src/verification-host-runtime.ts`. The API-local retrieval executor and residual HTTP shims remain. Units 2–3 reuse this shared implementation; the survey above is not a claim that all admission still lives in API.

`persistence` importing `application` is correct (adapters implement application ports) and is not changed.

## 2. Organizing principle

Mission Control sees Knowledge Services as **one agent capability** with tool groups. Each group has the same name at every layer: application folder, MCP tool prefix, CLI subcommand, skill.

Apply this naming target through the relevant unit specifications and update the DeepAgents consumer bindings and skills together with intentional interface changes. Existing names are an inventory to map, not a requirement for legacy aliases. The internal `application/src/verification` folder may remain behind the `verify` group. Capability grants use explicit descriptors, not prefix inference.

| Group | Scope | MCP prefix | CLI | Skill |
|---|---|---|---|---|
| knowledge | sources → preparation → publication → retrieval → evidence, evaluation | `knowledge_*` | `ks knowledge …` | `knowledge-sources`, `knowledge-preparation`, `knowledge-retrieval`, `knowledge-evaluation` |
| verify | captures, claims, reports, admission, recovery | `verify_*` (names unchanged) | `ks verify …` | `knowledge-verification` |
| db | schema navigation, bounded reads, ingestion | `db_*` | `ks db …` | `knowledge-db` |
| jev | Jev System One decisions and worker service (implemented; consolidation pending) | `jev_*` | `ks jev …` | `jev-system-one` |

`knowledge-research` is the coordination skill over all groups. Mission Control grants groups per workflow (research/ingest: `knowledge` + `db`; a coding workflow: `verify` or read-only `db`).

## 3. Target layout

```
apps/
  api/        HTTP + A2A. Absorbs application/operations/a2a-adapter and the executor's /artifacts, /captures routes.
  mcp/        One MCP server (Streamable HTTP + stdio). Tool groups above; `verify_*` names unchanged.
  cli/        One binary `ks` → `ks knowledge|verify|db|jev …`. Remote mode via KnowledgeClient;
              `pack:sandbox` is a cli build target (replaces knowledge-verify packaging).
  worker/     One durable worker: lease loop + application's activity registry.

packages/
  contracts/      Public Zod schemas and error codes (published)                 unchanged
  client/         KnowledgeClient (folder rename of client-typescript; npm name unchanged)
  core/           domain + runtime + observability                               (3 → 1)
  host/           config + composition root: createHost(profile)                  (new; absorbs config)
  sources/        acquisition + inspection                                       (rename of acquisition)
  preparation/    conversion + documents + chunking                              (3 → 1)
  retrieval/      search (was retrieval) + projections + embeddings + vector-backends (4 → 1)
  policy/         admission and selection eligibility                            unchanged
  evaluation/     evaluation                                                     unchanged
  verification/   verification algorithms                                        unchanged
  knowledge-db/   schema-workspace + db-read + ingestion                         (3 → 1)
  application/    src/{operations,knowledge,verification,db}/ — use cases, ports, activity registry
  persistence/    Postgres/Supabase adapters for application ports               unchanged
  testkit/        devDependency only

services/
  docling/        unchanged
  parser/         rename of verification-parser

skills/           One home. Eight skills plus the manifest Mission Control consumes.
  knowledge-research        coordination (planned F6)
  knowledge-sources         ← knowledge-acquisition-and-vetting
  knowledge-preparation     ← knowledge-preparation-and-promotion
  knowledge-retrieval       ← knowledge-retrieval-and-evidence + vector-store-management
  knowledge-evaluation      unchanged
  knowledge-verification    ← knowledge-verification + executor's knowledge-verify + knowledge-verification-recovery (reference file)
  knowledge-db              ← knowledge-db + schema-explore + knowledge-ingest
  jev-system-one            kept here; grows with the Jev integration
  manifest.json             capability manifest

proofs/           was scripts/: proofs/verification/<feature>/…, one shared tsconfig; sprint-only proofs archived
```

Original target counts before Jev integration: 23 → 14 packages, 5 → 4 apps, 12 → 8 skills, one MCP server, one CLI. The merged checkout now has 24 packages and 6 apps, including packages/jev and apps/jev. Unit 1 produces 15 packages and retains 6 apps. Later unit specifications must reconcile the final host counts while preserving implemented Jev capabilities; these older counts do not authorize deleting Jev.

Mechanical units preserve behavior and interfaces except for their specified package/import moves. Later surface-consolidation units may change routes, tool names, CLI commands, and client methods deliberately, with DeepAgents consumer bindings and skills adapted to the new contract. Preserve persisted identity strings (for example the `packages/conversion` / `packages/chunking` procedure identities in `packages/persistence/src/preparation.ts`); the absence of live consumers does not authorize rewriting stored evidence or the populated shared database.

The npm **namespace** stays; private merged packages take unit 1's new names. Folder-only renames retain npm names unless explicitly specified otherwise. Inventory executor host exports, old binaries, environment names, tarball locations, and skill paths to validate the DeepAgents consumer directly (historical review R4). Remove obsolete interfaces as part of that coordinated change; do not build forwarding adapters solely to preserve the old test setup.

## 4. How transports call application

ADR 0004 stays the rule: **in-process servers (API, MCP, worker) call `packages/application`; out-of-process callers use `KnowledgeClient` over HTTP.** The layout adds the piece that makes it enforceable: `packages/host`.

### 4.1 One composition root

```ts
const ks = await createHost(profile); // "server" (Postgres + Supabase) | "local" (file store, offline)

ks.knowledge.sources.capture(ctx, input)
ks.knowledge.retrieval.search(ctx, input)
ks.verify.claims.submit(ctx, input)
ks.db.read(ctx, intent)
ks.operations.submit(ctx, envelope) / ks.operations.get(ctx, id)
ks.activities                           // worker activity registry, keyed by operation kind
```

- `host` reads configuration (absorbs `packages/config`), builds persistence and storage adapters, and returns application services grouped by tool group.
- Apps import only `@aiengineer/knowledge-host` and `@aiengineer/knowledge-contracts`. They do not import persistence, runtime, or algorithm packages.
- This restriction concerns internal production runtime imports by API/MCP/worker and local CLI; transport libraries and test-only dependencies are allowed. Remote CLI explicitly imports `@aiengineer/knowledge-client`. Tests must not turn devDependencies into runtime dependencies.
- Ownership, admission gates (`is*RequestAdmitted`), `CanonicalRetrievalExecutor`, and the per-app `*-runtime.ts` compositions move to application (as ports and use cases) and host (as wiring).
- The `local` profile replaces the executor's `VERIFY_STORE_DIR` mode and serves the CLI's offline commands.
- Profiles expose only supported capabilities. A file store alone does not make capture/judging offline; unit 5 must map those existing callers explicitly. Offline mode has no implicit network/database fallback. Host owns resource lifecycle and cleanup; remote CLI entrypoints load no local host until an offline command selects it.

### 4.2 Handler shape

Every API route, MCP tool, CLI command, and A2A skill does exactly four things:

1. Parse input with the `contracts` schema.
2. Build an `OperationContext` (actor, tenant, trace, idempotency key).
3. Call one application function through `host`.
4. Map the result or error.

Application raises one error-code set defined in `contracts`. Each transport maps it: HTTP status (API), MCP error (MCP), exit code `0` success / `1` quality gate failed / `2` usage, auth, network or executor error (CLI). Handlers contain no SQL and no authorization logic.

Transports still extract/validate credentials and construct trusted caller context; application enforces tenant, ownership, capability and admission policy. Preserve existing error mappings during migration. Centralizing schemas/codes is not permission to change callers' failure semantics in a mechanical unit.

### 4.3 Durable work

- API and MCP start durable work with `ks.operations.submit(...)` and return the accepted operation. Reads, and synchronous API-owned kinds such as `retrieval_run`, call application directly.
- The worker is a lease loop over `ks.activities[kind](ctx, step)`. It holds no use-case logic.

### 4.4 Per transport

| Surface | Calls | Notes |
|---|---|---|
| `apps/api` (HTTP + A2A) | `host` server profile | A2A is a second binding over the same services |
| `apps/mcp` Streamable HTTP | `host` server profile | `createApiClient` shim removed once §4.1 ports exist |
| `apps/mcp` stdio | `host` local profile | A remote agent uses the HTTP MCP endpoint, not a local proxy |
| `apps/worker` | `host` server profile, activity registry | No algorithm-package imports |
| `apps/cli` remote, sandbox package | `KnowledgeClient` → API | Replaces `VERIFY_EXECUTOR_URL`; store and credentials never enter the sandbox |
| `apps/cli` offline | `host` local profile | Lazy-loaded so remote commands do not load application |
| Mission Control, DeepAgents, other repos | `KnowledgeClient`, or HTTP MCP for agents in sandboxes | Never import internal packages |

### 4.5 Catalog parity

`packages/application/src/operations/surface.ts` is the list of operation names and schemas. Bindings stay hand-written. One test asserts every catalog operation is exposed on API, MCP, and CLI or is listed as an explicit exclusion.

This is the target catalog role. Today that file describes durable steps and admission, while executor/read operations have other catalogs. Unit 4 must inventory both reads and mutations and distinguish declared, admitted, and executable operations by profile/transport. An exclusion carries a reason; a declared kind is never automatically made executable. Existing ingestion transaction/receipt semantics do not acquire a second operation ledger merely for parity.

## 5. Units of work

Each unit has its own specification in this folder before it starts.

| Unit | Scope | Behavior change | Spec |
|---|---|---|---|
| 1 | Mechanical package merges: `core`, `preparation`, `retrieval`, `knowledge-db` | None | [`UNIT-1-PACKAGE-MERGES.md`](./UNIT-1-PACKAGE-MERGES.md) |
| 2 | Add `packages/host` (absorbs `config`); move API and worker runtime wiring into it | None intended | [`UNIT-2-HOST-COMPOSITION.md`](./UNIT-2-HOST-COMPOSITION.md) (delivered) |
| 3 | Ownership, admission, retrieval executor into application; delete MCP `createApiClient` | MCP no longer calls the API | [`UNIT-3-APPLICATION-AND-MCP.md`](./UNIT-3-APPLICATION-AND-MCP.md) (delivered) |
| 4 | Application folders by tool group; A2A adapter into `apps/api`; testkit to devDependency; naming pass (`acquisition`→`sources`, `client-typescript`→`client`, `verification-parser`→`parser`); catalog parity test | None | [`UNIT-4-APPLICATION-ORDER-AND-CATALOG.md`](./UNIT-4-APPLICATION-ORDER-AND-CATALOG.md) (delivered) |
| 5 | Fold `verification-executor` into api/mcp/cli/application via host profiles | Executor binaries replaced by `ks` | [`UNIT-5-EXECUTOR-FOLD-CLI-AND-EVE.md`](./UNIT-5-EXECUTOR-FOLD-CLI-AND-EVE.md) |
| 6 | Eight canonical skills; Agent Skills metadata, DeepAgents parser conformance, manifest ids/digests and installed packaging | Skill names and validation change | [UNIT-6-SKILLS-DIRECTION.md](./UNIT-6-SKILLS-DIRECTION.md) — proposed; full spec at 5H |
| 7 | `scripts/` → `proofs/`; archive sprint-only proofs | None | to write |
| Q0, 5P (proposed) | Quality gates (format, lint ratchet, boundary rules in CI); transport structure before the 5D folds (catalog module, MCP tool table, API route modules) | None, except two recorded fixes (A2A retrieval validation, logged API 500s) | [APP-AND-SKILL-QUALITY.md](./APP-AND-SKILL-QUALITY.md) |
| 8 (proposed) | Worker extraction (§4.3/§4.4: activities to application, composition/config to host) and service hardening (logging, readiness, generated OpenAPI, CLI utilities out, test conventions) | None intended | [APP-AND-SKILL-QUALITY.md §2](./APP-AND-SKILL-QUALITY.md#unit-8--worker-extraction-and-service-hardening-new-unit-proposed); after Unit 6, parallel with DR1–DR5 (developer, 2026-09-29) |

Unit 5 starts with dependency inversion: unit 1 leaves `knowledge-db → persistence → application`; application cannot then depend on knowledge-db until its persistence coupling is replaced by injected interfaces. Keep that prerequisite separate from unit 1's mechanical moves. Run the minimal DeepAgents smoke against ks for Unit 5, consolidate and validate the eight skills in Unit 6, and complete DR1–DR5 before real fixtures. After cleanup is complete, run the pre–Mission Control testing. Specifications for units 2–7 are written against the preceding validated state; the workspace ledger records their entry/exit gates.

Accepted sequencing adjustment (developer, 2026-09-27): a bounded pre–Mission Control engineering experiment may run before unit 7's proof-folder reorganization once its service, DeepAgents, skill and fixture prerequisites are satisfied. It runs a small real stage graph sequentially — research/verification → reports → ingestion/publication, with ingestion consuming both upstream manifests — then restoration and fresh-consumer evaluation. Each stage is a separate agent session with explicit inputs, durable outputs and validated handoffs; manual launch is acceptable and production scheduling, Temporal and a Mission Control dashboard are not prerequisites. Its results are provisional engineering results, kept distinct from full fixture acceptance under the [OpenAI fixture](../../../../../aiengineer/ai-engineer-meta/ai-engineer-architecture/specs/knowledge-services-pre-mission-control/OPENAI_FIXTURE.md). The milestone and its prerequisites are tracked in the [continuation](./NEXT-PACKAGE-CLEANUP.md).

Proposed Unit 6 direction: each skill uses only standard `name` (directory-equal, lowercase-hyphen, ≤64), `description` (what/when, ≤1,024), optional `license`, `compatibility` (≤500), `metadata` (string values), and `allowed-tools`. Keep the body under about 500 lines with one-level `references/`, `scripts/`, `assets/`. Put KS version, operations, surfaces and per-file SHA-256 in `manifest.json`. `skills/check.mjs` must use DeepAgents `parseSkillMetadata` / `listSkills` and fail on skipped skills, retaining existing catalog checks. Stage files own role bindings by manifest id plus digest. The [Unit 6 stub](./UNIT-6-SKILLS-DIRECTION.md) records the five current missing-name defects.

Deliberately deferred until they cause a problem: unifying the three capture/parse paths (knowledge acquisition + Docling, verification capture + `services/verification-parser`, executor Firecrawl parse); renames inside `packages/verification`; the two `deterministicUuid` functions (`runtime` two-argument, `documents` one-argument).

## 6. Dated documents

Review records under `docs/operations/reviews/` and the phase memos under [archive/](./archive/README.md) are dated records. They keep pre-merge paths (`packages/conversion`, `packages/db-read`, …); read them with the mapping in §3. Live navigation (`AGENTS.md`, `docs/agents/CODE-MAP.md`, `knowledge/*.md`, `.agent-docs/`) is updated by the unit that moves the code.
