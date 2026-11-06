---
status: proposed
owner: knowledge-services
created: 2026-09-19
updated: 2026-09-19
---

# Knowledge Services: sequenced cleanup, naming, and feature plan

Status: **Proposed — naming and feature recommendations, not implementation.** Nothing in this document has been built. Every proposed folder name, interface name, and feature is a recommendation for the developer to approve, redirect, or reject via the phase-by-phase process in `PHASE-EXPLORATION-INSTRUCTIONS.md`.

An earlier developer pass (`docs/operations/internal-fallbacks-and-application-order.md`, `docs/operations/conversion-and-chunking.md`) had already scoped the acquisition/conversion/chunking/application-order slice and paused it pending the verification refactor. That refactor is done. This plan absorbs that prior scoping as its Phase 1 starting point and does not re-cite it repeatedly below — read it directly if you want the original reasoning.

**Feature scope and execution order now live in `FEATURE-SET-SPECIFICATION.md` (2026-09-19).** That document challenges this plan where it was stale (§1 C1–C12), fixes the final feature set (F1–F12), and merges these four phases with the pre-Mission-Control implementation ledger into one sequence (S0–S7 with gates G0–G7). This plan keeps authority over naming and folder structure; where the two disagree on *order* or *scope*, the feature specification's §4 sequence wins. Corrections applied here on 2026-09-19 are marked "(corrected 2026-09-19)".

## 1. The user's stage model, mapped to packages

| Stage | Packages | Health (2026-09-19 survey) |
|---|---|---|
| A. Research: external providers, filesystem scratchpad, subagents | `acquisition`, new deep-research skill | `acquisition` decomposed, has `examples/`; several adapters unwired. Deep-research as a distinct *capability* doesn't exist yet — see §4 |
| B. Locate, assert, verify, store verification artifacts | `verification`, `persistence` | `verification` is the reference pattern (§2). `persistence` legitimately owns ~85 of 115 files as verification records, but flat |
| C. Source-attributed reports, semantic attribution verification | `verification` semantic facade, `application/verification/operations` | Capability exists (`report_register`, `report_get`, `report_assess`); buried in an unorganized 167-file package |
| D. Query existing data, select schema context, emit ingestion intent | `schema-workspace`, `db-read`, `ingestion` | All three clean and correctly scoped already |
| E. Promotion via vector backend: convert, chunk, embed; spaces link embeddings to structured entities | `conversion`, `chunking`, `documents`, `embeddings`, `vector-backends`, `retrieval`, `projections` | `conversion` clean. Everything downstream is under-organized and the "space" concept is unimplemented as a first-class thing — see §5 |

## 2. The exemplar pattern (generalized from `packages/verification`)

1. Sub-domain folders named after **this package's own** pipeline stages, each with its own `index.ts` barrel — never generic `utils/`/`helpers/`.
2. Root `index.ts` re-exports grouped under commented stage banners, so the whole internal sequence reads top to bottom from one file.
3. Contract types come from `@aiengineer/knowledge-contracts` only; a package may re-export a few for convenience but never redefines them.
4. File size discipline via decomposition (roughly 50–600 lines/file), not folder count for its own sake.
5. Tests sit beside implementation as `*.test.ts` siblings.
6. `examples/` is numbered, runnable, paired with `*.test.ts`, and has its own `README.md` distinguishing mocked vs. real behavior and pointing external callers at the platform HTTP/MCP/CLI contract instead of the internal import.
7. Internal/compat code is physically segregated (`src/internal/`, `src/prototype-compat/`).
8. Comments explain *why* (stage boundaries, steering notes), never *what*.
9. A dated review record lands in `docs/operations/reviews/<package>.md` with an explicit acceptance table and named remaining debt.

Don't force verification's exact five-name taxonomy onto other packages — the pattern to copy is "name folders after concepts this package's own docs already use," sized to the package's actual complexity.

## 3. Blast-radius map (drives sequencing)

Cross-app import counts (`apps/api`, `apps/mcp`, `apps/cli`, `apps/worker`, `apps/verification-executor`), 2026-09-19:

| Package | Imports | Risk |
|---|---|---|
| `contracts` | 141 | Highest — every transport, every skill's data shape |
| `application` | 102 | Highest — composes nearly everything, also the messiest |
| `persistence` | 101 | Highest |
| `verification` | 94 | High, already refactored to standard |
| `runtime` | 51 | Medium-high |
| `domain`, `ingestion`, `schema-workspace`, `db-read`, `config` | 12–17 | Medium |
| `policy`, `client-typescript`, `conversion`, `embeddings`, `acquisition`, `documents`, `chunking` | 2–7 | Low |
| `evaluation`, `testkit` | 1–2 | Lowest |

Rehearse the review-and-rename process on low-risk packages first, do the genuinely new design work (spaces/promotion) while it's still small, and take on `application`/`persistence`/`contracts` last, since a naming mistake there ripples into every skill.

**`apps/` are cleanup targets (developer decision 2026-09-19).** The five apps in the table's header are not only import consumers: each phase covers the app modules that consume the packages it touches, and Phase 3 (§6) owns the apps' own structure, review records and examples. See `PHASE-EXPLORATION-INSTRUCTIONS.md` §"Developer override in force".

**Consumers the table above omits (corrected 2026-09-19):** `fixtures/openai-pre-mc/*.ts` import `knowledge-runtime`, `knowledge-persistence`, `knowledge-application`, worker and API internals and `packages/persistence/test/disposable.mjs`; `scripts/` proofs import application and persistence; the research harness (`research_ingestion_systems_agent`) imports the executor package, `packages/contracts/dist`, `packages/policy/src` and the persistence disposable helper. Treat all three as import consumers during every rename, and see `FEATURE-SET-SPECIFICATION.md` §1 C8 / D9 for the harness debt. The sequencing consequence is in that document's §4: lane A (P6.2) is built before Phase 1's application move and Phases 2–3, and rerun after each phase as the regression net.

## 4. Phase 1 — acquisition, research capability, conversion, chunking, application folders

### 4.1 Naming and structure recommendations

**`chunking`** (currently one 289-line file): split into
- `profiles/` — `ChunkProfileRegistry` and the 7 named profiles (one file per profile family or a `profiles/registry.ts` + `profiles/definitions.ts` pair)
- `chunker/` — `chunkDocument`
- `qa/` — `validateChunks`
- `examples/` — currently missing entirely

**`documents`** (currently one 164-line file): split into
- `nodes/` — document node construction
- `locators/` — source locator construction
- `examples/`

**`application`** folders (top-level, already mostly domain-named — keep the names, fix the two real problems):
- Keep as-is: `operations/`, `preparation/`, `source-discovery/`, `checkpoints/`, `promotion-selection/`, and under `verification/`: `admission/`, `operations/`, `source-acquisition/`, `recovery/`, `benchmark/`.
- Fold `diagnostics/` (34 files, top-level, duplicating the `verification-diagnostics-*` naming already used inside `verification/`) into `verification/diagnostics/`. Drop the redundant `verification-diagnostics-` file-name prefix once nested — e.g. `verification/diagnostics/adversarial.ts`, not `diagnostics/verification-diagnostics-adversarial.ts`.
- Root `index.ts`: replace the flat 108-line `export *` list with commented domain banners — `// Use cases: preparation`, `// Use cases: source discovery`, `// Use cases: checkpoints`, `// Use cases: promotion selection`, `// Verification: admission`, `// Verification: operations`, `// Verification: source acquisition`, `// Verification: recovery`, `// Verification: benchmark`, `// Verification: diagnostics`. This is application's version of verification's "Stage N" banners, grouped by domain instead of pipeline order since application isn't itself a single pipeline.

**Confirmed, already-known gap to close here, not redesign:** `application/src/preparation/preparation.ts:22`'s `profileFor` (single profile per `document_kind`) should call `chunking`'s existing `ChunkProfileRegistry.forSpace()` (multi-profile selection), which already exists and is unused by application.

### 4.2 Reasoned feature additions for this phase

**Deep-research skill (new capability, user-requested).** Today's `knowledge-acquisition-and-vetting` skill teaches an agent to call individual acquisition operations (`source_discover`, `source_import`, `source_attempt`, `source_reconcile`, `source_select`); it does not teach an agent to run a long, self-directed research session before any of those calls happen. The gap: nothing today tells an agent *how long to work*, *where to keep working notes*, or *when it has compiled enough material to be worth importing*.

Proposed shape (for Phase 1 exploration to confirm, not build yet):
- New skill id `knowledge-deep-research`, following the existing `knowledge-*` naming convention (7 of 9 current skills use it; `schema-explore` and `vector-store-management` are the exceptions).
- Composes, rather than replaces: external search/scrape MCP tools already available to the agent (Firecrawl, Tavily, arxiv-style identity resolution), the filesystem as an ephemeral scratchpad, and existing Knowledge Services `source_discover`/`source_import` operations as the promotion path out of scratch into custody.
- A named scratchpad convention keeps ephemeral working memory clearly separate from custody-grade capture (an important existing boundary: "acquisition" means sealed, attested bytes; scratch is pre-custody). Candidate layout for exploration to refine:
  ```
  <sandbox-root>/research/<objective-id>/
    notes/          free-form working notes, hypothesis tracking
    fetched/        raw fetched material not yet imported
    candidates.md   running log of candidate sources with relevance judgment
    compiled/       drafted, source-attributed material pending verification
  ```
- "Blob storage as intermediate offload" (user's phrase) likely reuses the existing storage adapter in `packages/persistence` rather than inventing a second storage path — Phase 1 exploration should confirm whether ephemeral research artifacts get a distinct bucket/prefix from custody captures, or stay filesystem-only until promoted.
- Mission Control state integration is explicitly future work (Mission Control doesn't own this yet); design the skill so a later durable-objective binding is additive, not a rewrite.
- This is a **skill-and-convention** addition, not a new package — it teaches composition of existing and Phase-1-cleaned capabilities. It belongs in Phase 1 because it depends on the acquisition/inspection boundary being clear first.

**Inspection as a first-class, real operation.** Today `verify_read_capture`/`verify_search_capture` exist only inside the executor; the platform-side `source inspect` is unsupported. Worth deciding in this phase whether inspection becomes a real platform operation (read/search sealed bytes without promoting them) — it's the natural companion to the deep-research skill, since a research agent needs to look at what it fetched before deciding to import it.

## 5. Phase 2 — the vector-space / promotion loop

### 5.1 Naming and structure recommendations

**`retrieval`** (currently one 863-line file): split into
- `plan/` — policy-scoped query plan assembly
- `lexical/` — lexical retrieval execution
- `semantic/` — semantic/embedding retrieval execution
- `graph/` — graph retrieval execution
- `rerank/` — rerank and diversity re-ordering
- `spaces/` — `ALL_SPACES`, `admittedSpaces`, `inferSpaces`, `SPACE_NOT_ADMITTED` (space admission, not space storage — see `vector-backends/spaces/` below)

Root `index.ts` banners: `// Stage: plan`, `// Stage: lexical`, `// Stage: semantic`, `// Stage: graph`, `// Stage: rerank`, `// Stage: space admission`.

**`embeddings`** (currently one 84-line file, densely formatted): likely stays a small flat module rather than forcing a folder split — recommend reformatting for readability (one statement per line) and adding `examples/`, and let Phase 2 exploration judge whether `requests/`, `identity/` (cache/route keys), `batches/`, `receipts/` folders are actually warranted at this size or are over-fragmentation.

**`projections`** (currently one 165-line file mixing concerns): split into
- `validation/` — support-set and digest validation (deterministic checks)
- `spaces/` — projection-to-space construction

**`vector-backends`** (currently `in-memory-exact.ts`, `postgres.ts`, `publication.ts` at 662 lines, `types.ts`): split into
- `backends/` — the raw adapters (`in-memory-exact.ts`, `postgres.ts`)
- `publication/` — publish/pointer mechanics, trimmed of space-identity concerns
- `spaces/` — **new**: space registry/identity, version pointers, rollback, and the relational link from an embedding to a structured entity. This is the module that doesn't exist today and is the concrete answer to "are we under-delivering on spaces."

**Space as a first-class concept — where it already partly lives.** `packages/contracts` already has `spaces.ts` and `vector-store.ts` schema files; this is not a missing-type problem, it's a missing-registry/missing-implementation problem. Recommend:
- A new bounded read operation, naming it `space_manifest` for consistency with the existing `schema_manifest` operation naming convention already used by `schema-explore` — lists defined spaces, their admitted node kinds, and their profile bindings. Natural home: `schema-workspace` or `db-read`, for Phase 2 exploration to decide.
- `vector-backends/spaces/registry.ts` (space definitions), `vector-backends/spaces/link.ts` (embedding → structured entity linkage), `vector-backends/spaces/version.ts` (pointer/rollback, migrated out of `publication.ts`).

These directly close two already-tracked gaps in `skills/manifest.json`: `vector-store-management.absentOperations` (`store search`, `space rebuild`) and `knowledge-preparation-and-promotion.absentOperations` (`promotion_selection_select`, `promotion select`).

### 5.2 Reasoned feature additions for this phase

**Promotion policy engine (corrected 2026-09-19).** `packages/policy/src/promotion-policy.ts` only validates a decision against gate results, so a *selection* policy is indeed absent. But it is not true that `application/promotion-selection/` has "nowhere to call into": P5.4 (accepted) added `PromotionSelectionSchema` / `PromotionSelectionAuthoritySchema`, and T3/T4 landed host-composed authority with exact membership, budget and digest enforcement in `application/promotion-selection` and the executor selection host. The missing layer is narrower — the eligibility rule set of the specification's §5.1 representation table, source-lineage diversity groups and per-space budgets as a pure function. That is `FEATURE-SET-SPECIFICATION.md` F9 (`packages/policy/src/selection-eligibility.ts`), which adds **no** public operation; `promotion_selection_select` stays absent (decision D5). Do not build a second membership enforcer.

**Source-attributed report compiler.** The report capabilities exist (`report_register`, `report_get`, `report_assess`, `knowledge_verify_report`) but aren't packaged as a guided capability the way verification's semantic facade is. Worth exploring whether report assembly deserves its own thin composition surface (in `application`, not a new package) that explicitly pairs "verified assertions" with "schema-context selection" as its two required inputs, matching the user's Stage C → Stage D flow.

**Relational entity linkage.** Beyond the space registry itself, decide the actual foreign-key shape connecting an embedding row to a structured entity row — this is schema-level work that belongs with `ai-engineer-db-contract`'s ownership, so Phase 2 exploration should scope it as a cross-repo proposal, not implement it inside `vector-backends` alone.

## 6. Phase 3 — the high blast-radius core

### 6.1 Naming and structure recommendations

**`application`** — remaining phases beyond the Phase 1 folder move: freeze the root barrel during any active work, migrate `persistence`'s imports of application's verification implementations to type-only imports, then optionally expose subpaths (`./operations`, `./verification`, `./source-discovery`) once transports (MCP first) are ready to consume them directly instead of the flat root export.

**`persistence`** (currently 115 files, flat, ~85 verification-record files): split into
- `postgres/` — core Postgres client/query adapters
- `storage/` — blob/object storage adapters
- `ledger/` — operation ledger persistence
- `runtime/` — runtime wiring adapters, including the shared verification host factory
- `verification-records/` — the ~85 verification-* files. Name it explicitly `verification-records/`, not `verification/`, to keep it visually distinct from importing `@aiengineer/knowledge-verification` (the algorithm package) in the same files — several files here already import both.

**`contracts`** (86 files, flat but coherent): optional domain bucketing only if it doesn't block this phase; not urgent per the survey.

**Open question, not a recommendation:** `observability` is 2 files against a stated scope of "operation telemetry, SLO summaries, manifest reconciliation." Flag for the developer to decide if it's intentionally minimal or genuinely under-built — do not assume an answer.

## 7. Phase 4 — full skill refresh, last

Refresh all 9 existing skills (not only the 4 tied to Phase 1) plus the new `knowledge-deep-research` skill once Phases 1–3 land and interfaces stop moving. Each skill gets: task context and prerequisites, the agent's actual decision points (which operation, how to interpret results, when to escalate or fall back), focused references instead of an inline wall of text, a normal-path and a failure-path worked example, and `node skills/check.mjs` conformance. Keep the existing two-manifest split (`apps/verification-executor/skills/manifest.json` canonical for the sandboxed `knowledge-verify` distribution, `skills/manifest.json` canonical for the other 8+1) — it's intentional, not duplication to merge away.

## 8. Before Phase 1 starts

(corrected 2026-09-19) The verification refactor is committed: Knowledge Services is clean at `28247e1` ("verification package refactor checkpoint", 2026-09-19 06:12). What Phase 0 still owes is the review-record close-out in `docs/operations/reviews/verification.md` against that revision, and registration of the **six** skills missing from `.agent-docs/modules.json` (`knowledge-acquisition-and-vetting`, `knowledge-preparation-and-promotion`, `knowledge-retrieval-and-evidence`, `knowledge-evaluation`, `knowledge-verification-recovery`, `vector-store-management`). Phase 0 also reconciles the contract pin narrative: `IMPLEMENTATION_PLAN.md` §1.2 says 0.4.13 / `20260915010000`; the fixture manifest pins 0.4.14 / `20260916010000`. (corrected 2026-09-19) The three `package.json` pins in `packages/persistence`, `packages/schema-workspace` and `apps/verification-executor` are 0.4.16 (head `20260916020200`), so the reconciliation covers three values, and `IMPLEMENTATION_PLAN.md` §1.2 now records all three.

## 9. Summary sequence

(superseded 2026-09-19) The four phases below are still the structural plan, but they no longer run as a standalone sequence. `FEATURE-SET-SPECIFICATION.md` §4 merges them with the implementation ledger (T10–T14, P4.4, P5.x, P6.x, P7.x) and the new features into steps S0–S7. In that sequence:

```
S0  Phase 0 baseline (+ pin reconciliation, file reservations)
S1  skills correctness pass (T10, not the Phase 4 enhancement) · F2/F3/F4 contracts ·
    Phase 1 low-blast only: chunking · documents · acquisition unwiring  (no application move)
S2  T11–T14 · P5 acceptance · F5 inspection · F8 space_manifest · F9 selection policy · F4 runtime
S3  P6.2 lane A on the unmoved tree  ← regression baseline
S4  Phase 1 remainder (application move) → Phase 2 → Phase 3, lane A rerun after each
S5  Phase 4 skill enhancement · F6 coordination · F7 synthesis · F10 stage conformance · freeze
S6  lanes B, C, E
S7  F11 outbox · F12 Mission Control transfer · lane D · handoff
```

The deep-research skill named in §4.2 is renamed and re-homed as `knowledge-research-coordination` (F6, decision D2), and its scratchpad layout is replaced by the specification's §6 workspace layout (C7). See `PHASE-EXPLORATION-INSTRUCTIONS.md` for how each phase actually gets worked: an explore-and-recommend pass first, developer approval, only then implementation.
