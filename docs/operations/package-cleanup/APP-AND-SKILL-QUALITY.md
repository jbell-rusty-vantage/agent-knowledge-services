# App and skill quality plan

Status: **proposed**, 2026-09-29. Source-backed review of `apps/*` and `skills/` against [FINAL-LAYOUT §2–§4](./FINAL-LAYOUT.md#4-how-transports-call-application), written before 5D1 so the remaining Unit 5 folds land in clean structure instead of growing today's large files. Line numbers are from the reviewed tree (`refactor/ks-unit-5c-ks-cli` at `80e83c8` plus uncommitted 5C closure docs) and will drift; re-verify at slice entry. Decisions marked **(decide)** need the developer before the slice that depends on them.

## Developer decisions (2026-09-29)

1. **Toolchain:** Biome (format + lint) and dependency-cruiser (architecture rules).
2. **MCP names:** group prefixes everywhere — `knowledge_*`, `verify_*`, `db_*`, `jev_*`. The platform `knowledge_verify_*` tools become `verify_*`; dotted names (`source.discover`) become underscore names in their group. No aliases; skills and catalog rows adapt (R3). The final per-tool name table is recorded in 5P.
3. **Test convention:** `src/tests/` mirroring source folders, with `src/tests/support/` for shared fixtures and identities, in every app. Moves keep test identities recorded (renamed paths listed in the slice inventory).
4. **Unit 8 timing:** after Unit 6, in parallel with DR1–DR5; not a fixture gate.

Still open: the Unit 6 merge-map corrections (§4).

Goal: an enterprise-maintainable service — one obvious place for each concern, transports that are thin by construction, enforced boundaries and formatting, and skills that a DeepAgents consumer loads without silent drops. Behavior, custody, receipts, authority outcomes and persisted identities are preserved exactly as in the rest of the cleanup.

## 1. What the review found

| Area | Finding (evidence) | Consequence |
| --- | --- | --- |
| Tooling | No formatter, linter or import-boundary checker in the repository; CI runs only `pnpm verify`. Dense one-line files coexist with formatted ones; the uncommitted `apps/jev/src/mcp.ts` diff is a one-file formatter pass with no config. | Style drifts per session; FINAL-LAYOUT's "apps import only host + contracts" is enforced only by review. |
| API | `apps/api/src/server.ts` is 2,763 lines: one `buildServer` closure (`:395–2763`) holds auth, problem mapping, read mappers, drift logic, admission and every route; `ServerOptions` is 225 lines of optional ports copied field-by-field from host (`composition.ts:146–208`). | Every 5D fold would add to this file. |
| API | Authorization/admission in handlers: eight copies of "`is*Admitted` missing → 503 / false → 403" (`:1686–2063`), tenant/actor/correlation checks repeated ~6× (incl. `a2a-http.ts:100–129`), profile-capture route re-implements bearer auth (`:1497–1511`). | Violates the four-step handler shape (§4.2). |
| API | Runtime deps on application, core, persistence, retrieval; `server.ts:87` imports `DeterministicFakeEmbeddingAdapter`; `buildServer` silently builds in-memory services when a port is missing (`:404–405`). | Violates §4.1; a missing production port would not fail. |
| API | **Correctness gap:** A2A retrieval (`a2a-http.ts:131–137`) bypasses `RetrievalRunInputSchema` and the `retrieval: "v1"` check that `submitCanonicalRetrievalRun` applies to HTTP. | Two transports, two validation paths. |
| API | Error mapping by message string (`:448–495`); some problems lack `application/problem+json`; "unavailable" is 503 `INTERNAL_ERROR` in some routes and `CAPABILITY_NOT_ADMITTED` in others. `logger: false`; the 500 branch discards the error unlogged (`:516–521`). | Unobservable failures; inconsistent client contract. |
| MCP | `apps/mcp/src/index.ts` is 1,250 lines: schemas, admission tables, ~10 executor factories, Fastify host, Vercel handler, `main()`. A name-based if/else chain (`:628–757`); the context schema is defined five times; 53 tools share template descriptions ("Bounded ${name} workflow"). | Tool descriptions are what agents read; templated text is poor agent UX. |
| MCP | The surface ledger `apps/mcp/src/tests/operation-catalog.ts` is load-bearing (slice rules, DeepAgents grants, CODE-MAP) and holds logic, yet lives in a test folder; its test imports other apps' `src/` by relative path. | Source of truth is not a module; FINAL-LAYOUT §4.5 places it in application. |
| MCP names | Three styles coexist: dotted (`source.discover`), `knowledge_verify_*`, and the target `verify_*`. After 5D3 both `knowledge_verify_claims` and `verify_claims` would exist. | Decided: group prefixes, applied in 5P. |
| CLI | Two command tables: `KS_COMMANDS` (`ks-commands.ts`) maps onto `CLI_COMMANDS` (`commands.ts:116–237`) with a 280-line dispatch switch; three hand-rolled argv parsers; help lists names only. ~850 lines of benchmark/attestation/demo logic live in the transport and import the verification package directly; canonical JSON re-implemented twice. | Every new command edits two tables and a switch. |
| Worker | Far from "a lease loop over `ks.activities[kind]`" (§4.3): `activity-registry.ts` (1,259) holds ~25 schemas and preparation, governed-index, vector-store authority and evaluation use cases; `index.ts` (1,065) is ~700 lines of host composition reading 27 env vars (bucket fallback ×13, 11 hand-rolled grant parsers); sealers and verification activities are use cases; deps on seven algorithm/persistence packages. | **No unit owns worker extraction** — Units 3–5 explicitly exclude it. §4.3/§4.4 currently have no delivery unit. |
| Executor ↔ worker | The executor imports worker `src/` by relative path (`root-host-selection*.ts`, `knowledge/promotion-selection-host.ts`) and tsup inlines it into `root-host/v1`; the worker's comment points back to executor-owned ports. | A hidden app→app cycle the 5D2 fold must break. |
| Executor orphans | Test-only fixtures in production `src/` (`selected-candidate-fixture.ts` 801 lines, `report-dependency-fixture.ts`, `recovery-test-fixtures.ts`) with hard-coded sibling-repo paths; `root-host-*` (accounting, coverage, recovery authorization/evidence, receipts) has no named owner — 5D3 only "decides replacements for `root-host/v1`". | Could be silently dropped at 5H. |
| Tests | Mixed conventions (`src/tests/` in api/mcp/cli; colocated in worker/jev/application/executor); two DB gate variables (`DATABASE_URL`+storage vs `RUN_LOCAL_PERSISTENCE_TESTS`); `retrieval-history.integration.test.ts` 1,207 lines; `consumer-transports.integration.test.ts` imports a sibling repository's Eve adapter. | Hard to find and run the right tests. |
| Jev | Small and clean (its MCP `execute` wrapper is the best error pattern of the apps) but serves repository files over HTTP (`index.ts:44–45`, `http.ts:87–104`), returns `{error:"NOT_FOUND"}` as success, maps unknown errors to 400, and misreports unknown commands (`index.ts:86`). | Fold these into 5F. |
| Skills | Five skills lack `name:`; four use YAML-list `allowed-tools` (the Agent Skills spec defines a space-delimited string); `check.mjs` passes anyway (never parses frontmatter; one aggregate text digest per skill, never compared to the manifest; links may leave the package). No `deepagents` dependency exists. | Details in §4. |

## 2. New and changed work, by slot

### Close 5C first (blocking, bookkeeping)

Done 2026-09-29: validated, recorded and merged locally (see the ledger's 5C closure entry).

At review time local `main` (`f62cc3e`) does **not** contain 5C: its implementation is committed on `refactor/ks-unit-5c-ks-cli` (`80e83c8`), but the ledger's 5C session entry and `workspace/evidence/unit5c-validation.json` are missing, and the handoff text already calls 5C merged. Before anything else: run the slice's full validation, write the evidence and ledger entry, resolve the `apps/jev/src/mcp.ts` formatting-only diff (revert it; formatting arrives with Q0), merge locally, return to clean `main`.

### Q0 — quality gates (new slice, after 5C merges, before 5P)

Branch `chore/ks-q0-quality-gates`. Mechanical; no behavior change. **Delivered 2026-09-29** (see the ledger's Q0 entry and `tools/quality/README.md`).

- Toolchain (decided): **Biome** for format + lint and **dependency-cruiser** for architecture rules, pinned as root devDependencies.
- One formatting-only commit over the repository, recorded in `.git-blame-ignore-revs`. Exclude generated files, fixtures, sealed evidence, vendored and historical receipts — byte-sensitive files must not change (verify digests of sealed/fixture inputs before and after).
- Lint at a ratchet: rules that pass today as errors, the rest as warnings with a recorded count that may only fall.
- Boundary rules encoding FINAL-LAYOUT §4 as they exist today, with a recorded baseline of current violations that may only shrink: no `apps/* → apps/*/src`, apps import only host/contracts/client (plus transport libs; tests exempt), host imports no app, no `packages/* → apps/*`, no production edge `knowledge-db → persistence`.
- Add `format:check`, `lint` and `boundaries` to `pnpm verify` and CI.

### 5P — transport structure before the folds (new slice, before 5D1)

Branch `refactor/ks-unit-5p-transport-structure`. Structure only; preserve every route, tool, command, status code and message. Record golden error-mapping tests **first**.

- **Catalog as a module.** Move the data and state functions of `apps/mcp/src/tests/operation-catalog.ts` to `packages/application/src/operations/catalog.ts` (beside `surface.ts`, per §4.5), exported. The parity test stays a test; it stops importing other apps' `src/` by relative path. Update slice rules, DEEPAGENTS-READINESS DR2 and CODE-MAP to the new path.
- **MCP registration table.** A typed `ToolDefinition { name, group, inputSchema, authority, description, run }`; split `index.ts` into `tools/{knowledge,verify,db,operations,system}.ts`, `errors.ts` (one mapper) and `server/{http,vercel}.ts`; one shared context schema. `index.ts` keeps composition only. Registration must be checked against the catalog so drift fails.
- **API route modules.** `plugins/{correlation,auth,problem}.ts`, `http/{route,problem-map,read-map}.ts`, `routes/<group>/*.ts` each exporting `register(server, host)`; `buildServer` takes the host services instead of the 225-line `ServerOptions` bag. A declarative `route({ method, url, access, params, query, body, call, map })` helper removes the 33 `requireAccess` and 12 empty-query parse repetitions. One `sendProblem` sets `application/problem+json` everywhere.
- **Guards, deduplicated in place:** one tenant/actor/correlation guard and one admission helper replace the repeated blocks (moving the policy itself into application is 5D work).
- **Small correctness/ops fixes carried by this slice** (each with its own test and ledger note, since they are behavior changes): A2A retrieval through `submitCanonicalRetrievalRun`; log the API 500 path with correlation id.
- **Test support:** `apps/api/src/tests/support/` for identities and DB fixtures; one DB gate variable; move the stray `src/verification-benchmark-reads.test.ts`; delete the deprecated `auth.ts` shim once its 10 test imports move.
- Canonical MCP names (decided: group prefixes): record the full old → new name table and apply it in the tool table; update catalog, parity and inventory tests, CLI/skill references and DR2 notes in the same slice. No aliases.

Exit: `server.ts` and MCP `index.ts` are composition-only; identical catalog, parity, no-HTTP-shim and golden error tests; full graph as in every slice.

### Additions to 5D1–5D3 (each slice's exit gains these)

- New operations land as route/tool/command **table entries** in the 5P modules; `server.ts`, MCP `index.ts` and CLI dispatch do not grow.
- Folded handlers follow the four-step shape: authorization and admission live in application use cases that return typed failures; transports keep only credential extraction and context construction. Move the admission blocks and the demo route's inline `AgenticKnowledgeService` loop (`server.ts:2482–2553`) when their group folds.
- **CLI:** collapse `CLI_COMMANDS` into `KS_COMMANDS` entries `{ profile, schema, summary, run }` as each group folds (5D1 starts it); one shared argv parser (`node:util parseArgs` + zod); help and a generated command reference from the table; errors from the contracts code set, not ad-hoc strings.
- **5D2:** break the executor ↔ worker relative imports — the activity registry, `CanonicalDurableKnowledgeWorker` and promotion-selection ports move to application/host first, and no package or app imports `apps/*/src`. Name the owner of each `root-host-*` module. Move test-only fixtures to host test support with their suites (preserving identities), replacing sibling-repo paths with explicit configuration.
- **5D3:** split `executor.ts` (895-line class, 16 methods) into one use case per `verify_*` operation instead of moving the class; reuse core's `deterministicUuid`; no `process.env` provider reads (`capture.ts:269,295`) — providers stay explicit as in 5B.
- Do not carry over: god classes, locally re-implemented utilities (`shortId`, `safeName`, canonical JSON), silent in-memory defaults, message-string error matching.

### Additions to 5F (Jev)

Port `jev_*` as a `tools/jev.ts` group and `ks jev` table entries; drop repository-file serving from the service; route errors through the shared mappers (not-found is an error, unknown errors are 500); exit codes from the shared CLI mapping.

### Additions to 5H

Replace `consumer-transports.integration.test.ts`'s sibling-repo Eve import with a `KnowledgeClient`/HTTP-MCP contract test (or delete it once DR2's smoke covers it); remove executor catalog rows; move `examples/` content that remains useful next to its new owner; the boundary baseline from Q0 loses every executor entry.

### Unit 8 — worker extraction and service hardening (new unit, proposed)

Owns FINAL-LAYOUT §4.3/§4.4, which no unit currently delivers. Behavior-preserving; slice it like Unit 5.

- **8A worker activities:** move handler groups from `activity-registry.ts`, the sealers and the verification activities into `application/src/<group>/activities/` keyed by operation kind; keep `CanonicalActivityRegistry` and failure classification in application as `ks.activities`.
- **8B worker composition and configuration:** move `createWorkerExecution` construction and the 27 env reads into host (one validated config schema; grants parsed once). Worker ≈ `index.ts`, `loop.ts`, `canonical-worker.ts`, memory mode; deps = host + contracts. Move `canonical-fixture-worker.ts` and `process-restart-fixture.ts` to proofs (Unit 7 if not earlier).
- **8C operability across API/MCP/worker:** structured logging with correlation id and no secrets, a bounded per-call MCP event, readiness that reflects host dependencies, body limits and timeouts, drained shutdown with a deadline.
- **8D contracts:** attach contracts schemas to API routes and generate OpenAPI from them, replacing the hand-maintained `openapi.json` parity; typed error-code → HTTP/MCP/exit-code table from contracts.
- **8E CLI utilities:** benchmark/attestation/demo logic into application or proofs; thin command adapters remain.
- **8F test conventions:** finish moving every app to `src/tests/` mirroring source with `support/` (decided; api starts in 5P, folded code lands there during 5D), one DB gate variable, split oversized suites by `describe`.

Sequencing (decided): after Unit 6, in parallel with DR1–DR5, which live in `research_ingestion_systems_agent`. It costs no fixture time and does not reopen the accepted order (KS cleanup → DeepAgents readiness → real fixtures → Mission Control). 8A–8B change no public surface; Unit 8 is not a fixture gate.

## 3. Updated sequence

```
close 5C → Q0 → 5P → 5D1 → 5D2 → 5D3 (5F beside, disjoint files, 5D3 merges first) → 5H (+ DR2 smoke)
  → Unit 6 → Unit 8 ∥ DR1–DR5 → real fixtures → Unit 7 (scheduling exception retained) → Mission Control
```

## 4. Skills — additions to the Unit 6 direction

Recorded in [UNIT-6-SKILLS-DIRECTION.md](./UNIT-6-SKILLS-DIRECTION.md#additions-from-the-2026-09-29-quality-review); summary:

- **Command coverage gate:** `ks` today has no `db` schema/read/ingest, `knowledge` source/content/report, recovery or checkpoint commands; four skills can only name the executor binary. Unit 6 entry requires every operation a skill names to resolve in the `ks` table and the catalog.
- **`check.mjs` rebuild:** pinned `deepagents` devDependency and its parser; per-file SHA-256 (bytes, not UTF-8 text) stored in and compared to `manifest.json`; package-contained links only; one rule set for every skill; run against the installed tarball; replace the prose regex "seal is not admission" requirement with a single shared statement in `knowledge-research`.
- **Specify `knowledge-research`:** routing table, stage order, shared rules stated once (untrusted content, seal ≠ admission, handles not payloads, unknown usage ≠ zero, receipts authoritative, batch limits), workspace file convention, stop conditions, and report authoring moved out of ingest. Its F6 dependencies (`completion_submit`, `usage_read`, `space_manifest`) are not in any catalog; the skill must not describe them as available.
- **Merge-map corrections (decide):** verification exceeds ~500 lines when merged → `references/{chain,recovery,recovery-operations}.md` with recovery triggers in the description; vector-store publish/rollback is write authority — keep it out of the read-side retrieval body (reference file with stated authority, or evaluation); document embedding (`knowledge embed run/verify/status`); `knowledge-db` needs read-only vs write references so stage files can grant read-only.
- **Deduplicate:** content-link section, source-receipt text, budget/handles boilerplate, competing "overrides every other skill" statements.
