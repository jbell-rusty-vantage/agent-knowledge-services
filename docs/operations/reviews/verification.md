# Verification package review

Status: **Reference — reviewed 2026-09-16; see validation and limitations below.**

## Scope and baseline

Reviewed `packages/verification` at repository HEAD
`08703d3fdaa887286473b54a6612b1963f1a5789`, with the existing working tree retained.
The developer explicitly requested this module and verification-executor review, examples,
clean code and skill updates, with emphasis on assertions, locators and diverse media.
Semantic optimization is deferred by the developer. No general sprint-completion evidence
was supplied; this review does not certify that sprint or the entire Knowledge Services inventory.

There were existing conversion, ingestion-test relocation, worker, skill and module-manifest
edits. They were not reset or folded into a commit. This is an in-place, reviewable local change;
no branch synchronization, PR, merge, deployment or repository-wide delivery-control rollout
is claimed. The older seven-phase clean-code recommendation remains a separate broad plan;
this review does not certify all of its phases complete.

The package owns algorithms. Application composition owns admitted service use cases;
external consumers use HTTP/client/CLI/MCP. The companion
[executor review](verification-executor.md) covers agent intents and local execution.

## Developer requirements and evidence

| ID | Observable acceptance | Assessment / evidence |
|---|---|---|
| VER-REVIEW-01 | Explain assertion versus verification and the extent/diversity of capabilities from implementation | Present: [library capability matrix](../../../packages/verification/CAPABILITIES.md) and [acquisition capabilities](../../../apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md) trace 14 claim types, 12 selectors, 11 field comparisons, report/authority/audit behavior and limitations |
| VER-REVIEW-02 | Show how agents locate evidence across media; do not call a schema or projection type an end-to-end capability | Partial product capability, fully documented: native projection examples exist, but admitted arbitrary raw image/audio/video routes and executor native selector intents do not |
| VER-REVIEW-03 | Clean code without weakening evidence integrity | Shared internal offset conversion replaces duplicate algorithms; reported coordinates, surrogate boundaries and BOM behavior corrected with regression tests |
| VER-REVIEW-04 | Runnable default examples show success and meaningful failure without paid calls | Present: 12 real selector paths and ambiguous-quote/context recovery; synthetic projections explicitly labelled |
| VER-REVIEW-05 | Update skills and generated navigation with usable distributed examples | Present: canonical platform skill 1.2.0, executor skill 1.1.0, references/template, full-content digest checks and research-consumer regeneration |
| VER-REVIEW-06 | Leave semantic optimization for later | Preserved: no semantic model, prompt, algorithm or threshold change |

## Code review and intentional changes

- G5/G33/F1: `src/text-offsets.ts` centralizes code-point-aligned slicing behind a two-argument
  internal function shared by built-in positions, PDF, DOM and repository ranges.
- G26: built-in character positions now retain the requested coordinate basis in reported ranges
  instead of labelling converted UTF-16 indexes as byte/code-point indexes.
- G3: invalid/empty/noninteger ranges and surrogate-splitting ranges fail closed consistently.
  UTF-8 slice decoding preserves U+FEFF as text rather than dropping it as a stream BOM.
- Public exports and serialized contracts are unchanged. Corrected coordinate results can differ
  from historical retained results for affected Unicode inputs; replay should expose that drift,
  not silently rewrite old bundles. No golden digest was refreshed.

No broad API migration is needed. Existing semantic authorization, prototype compatibility,
audit signing, provider policy and decomposition/report product semantics are retained.
Remaining readability debt includes long orchestration functions, wildcard package exports,
and permissive internal projection-validation typing; this focused review is not a claim that
every item in the previous refactor plan has disappeared.

## Validation

See the companion executor review for the shared validation matrix, packaging and consumer
checks. Package examples are included in typechecking and Vitest. Root `pnpm verify` now also
runs both verification example commands after build so executor CLI drift fails visibly.

## Product gaps and decisions still needed

The developer's universal-media aspiration is not yet fully implemented. Native locator
exposure through executor intents, admitted OCR/transcription/frame representations,
and representation-preserving acquisition fallbacks need explicit interface and parser work.
No fallback should turn missing chart/audio/video evidence into a text-based pass. These are
reported gaps, not newly implemented capabilities or silently waived acceptance criteria.
Human-gold calibration, source-rights decisions, vendor approval and semantic quality evidence
remain as documented in the dated verification acceptance guide.

## Close-out 2026-09-19

Committed revision: `28247e16ea5dd95ae6442e4b8cc5848c3c633153` ("verification package refactor
checkpoint", 2026-09-19), branch `main`, clean tree. The working-tree changes this review described
at `08703d3f…` were committed as the chain `d0379a5` … `28247e1` (eight commits, all 2026-09-19).
This section closes the review against that chain; the 2026-09-16 record above is retained unchanged.

### What the refactor commits did

| Commit | Change |
|---|---|
| `d0379a5` rename claims to report and split diagnostics tests by owner | `src/claims` → `src/report` (`report-wide.ts`, `decomposition.ts`); `semantic/diagnostics.test.ts` split into `semantic/authorize.test.ts`, `report/report-wide.test.ts`, `report/decomposition.test.ts`, `authority/assessment.test.ts` and `providers/providers.test.ts`. |
| `08d446c` explicit facade | `src/index.ts` is a named-export facade with stage banners (Stage 0 primitives, 1 capture integrity, 2 selector integrity, 3 mechanical correctness, 4 semantic support, 5 provenance) plus a labelled block of contract types some consumers still reach through this package. No `export *` remains under `packages/verification/src`. |
| `4bf7cb2` move prototype compat to a subpath export and rename the engine golden | `@aiengineer/knowledge-verification/prototype-compat` subpath (`src/prototype-compat/{index,arithmetic,bundle,digest,json-pointer,text-locator}.ts`); `deterministic/engine-golden.fixture.ts` replaces the `*-parity` name. |
| `c05a4f4` add one runnable example per pipeline stage | `examples/01-canonical-digest.ts` … `06-seal-inspect-replay.ts`, each with a `.test.ts`, shared `bundle-fixture.ts`, `run.ts` running 01–06; no credentials, network, files or parser process. |
| `95d2131` document the refactored package and register modules | `packages/verification/CAPABILITIES.md`, `apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md`, README rewrite, `src/AGENTS.md`, older recommendation and comprehension notes moved to `packages/verification/docs/`, `.agent-docs` module registrations. |
| `492a677` point consumer tests at the renamed engine golden fixture | `scripts/live-gate1.ts`, `scripts/prove-verification-parser-v2-visible.ts`. |
| `d181c13` add mutation-catching tests for the semantic gate, dispatch order, and resolver digest claims | Tests only: `semantic/authorize.test.ts`, `providers/providers.test.ts`, `evidence-selection/resolve-evidence-selector.test.ts`. |
| `28247e1` verification package refactor checkpoint | Commits this review record and `verification-executor.md`; executor skill 1.1.0 (`examples/offline.mjs`, `references/capabilities.md`), `intents.ts` and `locate.ts` changes, `skills/manifest.json` (platform skill 1.2.0), `skills/check.mjs`, root `package.json` `verify` running `examples:verification`. It also carries conversion route and examples, ingestion test relocation and vector-backend publication changes outside this review's scope. |

### Acceptance rows closed by committed work

| ID | Close-out |
|---|---|
| VER-REVIEW-01 | Closed: both capability documents are committed (`95d2131`). |
| VER-REVIEW-02 | Not closed; still partial product capability. Committed documentation records the gap. `28247e1` touched `apps/verification-executor/src/intents.ts` and `locate.ts`; the companion executor review owns that assessment. |
| VER-REVIEW-03 | Closed for the reviewed scope: `evidence-selection/text-offsets.ts` (committed earlier at `91bc7d9`), the report rename, the explicit facade and the prototype-compat subpath are committed; `d181c13` adds mutation-catching tests without algorithm changes. |
| VER-REVIEW-04 | Closed: six stage examples plus their tests (`c05a4f4`); root `verify` runs them after build (`28247e1`). |
| VER-REVIEW-05 | Closed: platform skill 1.2.0 and executor skill 1.1.0 with references, capabilities and the offline scaffold (`28247e1`); `skills/AGENTS.md` and `docs/agents/CODE-MAP.md` regenerated. Six platform skills that were still unregistered in `.agent-docs/modules.json` were added on 2026-09-19 after this checkpoint (Phase 0 close-out). |
| VER-REVIEW-06 | Preserved: no semantic model, prompt, algorithm or threshold changed in the chain; the only `semantic/authorize.ts` edit (`08d446c`) drops an explicit return-type annotation on `semanticJudgeInput`. |

### Debt still named

- Long orchestration functions and permissive internal projection-validation typing remain as
  listed under "Code review and intentional changes"; the wildcard-export item is resolved by `08d446c`.
- The facade still re-exports contract types "some consumers still reach through this package";
  the banner asks consumers to import from `@aiengineer/knowledge-contracts` directly. Not removed.
- Everything under "Product gaps and decisions still needed" is unchanged.
- Validation for this close-out: `node .agent-docs/cli.mjs check --repo .` clean (274 inputs,
  2026-09-19). `corepack pnpm verify` at `28247e1` is **red**, exit 1 at the typecheck stage:
  `@aiengineer/knowledge-ingestion#typecheck` reports 61 errors in 9 files because `28247e1`
  moved `packages/ingestion/src/*.test.ts` and `test-fixtures.ts` into `src/tests/` as pure renames
  without rewriting their `./apply.js`-style relative imports. Outside this package; not fixed here.
  Test, build and example stages did not run in that chain. Full record in the Phase 1 G0 result file
  under `ai-engineer-meta/ai-engineer-architecture/notes/proposals/knowledge-services-package-cleanup/workspace/sessions/2026-09-19-phase-1-impl/`.
