---
status: proposed
owner: knowledge-services
created: 2026-09-19
phase: 2
sequence-steps: S2 (F8 data and read, F9 policy), S4 (retrieval, vector-backends, projections, embeddings structure)
---

# Phase 2 recommendation memo: retrieval, embeddings, vector-backends, spaces, projections, selection eligibility

Status: **Recommendation written as the record under the developer override (`PHASE-EXPLORATION-INSTRUCTIONS.md` §"Developer override in force"), then implemented in the same session.** Where this memo offers options it also names the answer taken. It was produced by one agent reading the current tree directly (ground rule 1); no code was changed before the memo was filed (ground rule 2). Every candidate name from `SEQUENCED-CLEANUP-PLAN.md` §5 was checked against the files as they are at Knowledge Services commit `ff7fe97`.

How to read: §1 is the baseline, which moved since the Phase 1 handoff. §2 names the features, decisions and reserved files. §3 is the four structural recommendations. §4 is the consumer-impact table, including apps. §5 is F9. §6 is F8 and the `space_manifest` placement, with the cross-repository flags. §7 is behaviour found while reading that is outside cleanup scope. §8 is the numbered decision list `P2-1 … P2-12`. §9 is the implementation sequence with reservations and verify commands.

## 1. Baseline observed

| Observation | Evidence |
|---|---|
| **Phase 1 is committed.** Knowledge Services is clean at `ff7fe97` ("phase 1 of clean code and feature refinement pre mission control"), branch `main`, parent `28247e1`. The Phase 1 handoff's "dirty and uncommitted" state no longer holds; the developer took the commit decision (handoff §3 item 1). | `git log --oneline -3`, `git status --short` empty |
| Skill conformance green and unchanged: 11 skills, 42 executor operations, 58 executor MCP tools, 78 platform commands, 70 platform MCP tools. | `node skills/check.mjs` exit 0 |
| Documentation freshness green, 290 selected inputs. | `node .agent-docs/cli.mjs check --repo .` exit 0 |
| `corepack pnpm verify` not run at this baseline. The known-red causes from `workspace/sessions/2026-09-19-phase-1-impl/HANDOFF.md` §1 and §3 are assumed to persist; this phase's obligation is to keep every package it touches green standalone and add nothing to that list. | kickoff §5 |
| **The PowerShell tool could not start Node on this machine** ("Starting the CLR failed with HRESULT 80004005"). Git for Windows Bash runs `node` fine; only the `corepack` shim is broken there. | recorded in §9 tooling notes |

Phase 0 items closed by G0 in the previous session (six skills registered, verification review closed, pin narrative reconciled) are unchanged here.

## 2. Feature IDs, decisions and reserved files this memo touches

- Features: **F8** (`space_manifest`, profile↔space bindings as data, multi-profile selection) and **F9** (selection eligibility policy). Consumed, not authored: **F2** (`ResearchCompletionReceipt@1`), **F3** (`EvidenceAssurance@1`), **F4** (`usage_read`), **F10** (stage blocks).
- Decisions: **D4** confirmed (`space_manifest` lives in `db-read`, §6.2). **D5** confirmed (pure policy, no public operation, §5.4). **D9** referenced: the research harness still imports `packages/policy/src`, and F9 adds a file inside that import surface, so the debt is now slightly larger (§4.3). New decisions are numbered `P2-1 … P2-12` in §8 so they do not collide with `D1–D10` or `P1-1 … P1-10`.
- Track K reserved files (`FEATURE-SET-SPECIFICATION.md` §3.4): this memo's implementation **edits none**. `space_manifest` as an executor operation lands in `apps/verification-executor/src/knowledge/operations.ts`; this session designs it and implements only the `db-read` read function and its tests, leaving the registry entry as a recorded follow-up for the executor-registry owner (§6.4). `packages/application/src/index.ts`, `skills/manifest.json` and the pre-MC `implementation/ledger.json` are untouched.
- Sequence placement: the structural work in §3 is `FEATURE-SET-SPECIFICATION.md` §4 step **S4**; F8's data/read and F9 are **S2**. The override runs them now, before lane A (G3) exists, which is a deliberate departure from C9 recorded in §8 as `P2-12`. The mitigation is that the entire Phase 2 blast radius is four internal files (§4), not `application` or `persistence`.

## 3. Package recommendations

Exemplar rules: `SEQUENCED-CLEANUP-PLAN.md` §2. The two that decide this phase are rule 1 ("name folders after concepts this package's own docs already use", sized to actual complexity) and rule 4 (decomposition, not folder count for its own sake).

### 3.1 `packages/retrieval` — the plan's six-way cut is right about the concepts and wrong about the file

Observed: one 863-line `src/index.ts`, one 15-line `src/index.test.ts` holding six dense `it` blocks, no `examples/`. Dependencies: `contracts` (types), `domain` (`deepFreeze`, `sha256Digest`), and a **declared but unused** dependency on `@aiengineer/knowledge-vector-backends` (§7.5).

The file's actual seams, as read:

| Lines | Concept | Depends on |
|---|---|---|
| 1–202 | Types: `RetrievalIntent`, `RetrievalFilter`, `RetrievalSubquery`, `AdvancedRetrievalPlan`, `RetrievalPolicy`, `RetrievalRecord`, `RetrievalFlags`, `GraphEdge`, `RetrievalChannel`, `StageContribution`, `RetrievedCandidate`, `EvidenceMember`, `ImmutableEvidencePacket`, `Reranker`, `RetrievalStages`, `RetrieveOptions` | contracts |
| 204–213 | `ALL_SPACES` | contracts |
| 214–293 | `buildRetrievalPlan`: space admission, filter admission, limit and policy validation, subquery decomposition, intent inference | spaces, lexical (`normalize`) |
| 295–713 | `retrieve`: one function containing authorize/filter, `rankChannel`, lexical, semantic, graph, rerank, fusion, diversity cap, context radius, coverage, abstention, member and packet assembly | everything |
| 715–863 | Helpers: `score`, `exactScore`, `tokenize`, `ftsScore`, `trigramScore`, `cosine`, `matches`, `sum`, `compareCandidate`, `normalize`, `inferIntents`, `inferSpaces`, `stableId` | — |

The plan's concepts (`plan`, `lexical`, `semantic`, `graph`, `rerank`, `spaces`) are all genuinely present — but four of the six exist only as *inlined blocks inside one 419-line closure*, not as separable units. `retrieve` closes over `channelRanks`, `omitted`, `timings`, `eligible` and `plan`, and the insertion order of `channelRanks` is load-bearing (`[...channelRanks]` at line 508 and the seed sort at 433 both depend on it). A naive "move each stage to its folder" refactor would change results.

**Recommendation (P2-1): take the plan's six names, but cut the stage *primitives* into folders and keep the orchestrator whole as a root `retrieve.ts` with a `// Pipeline` banner.** The stage folders own the scoring and expansion functions the pipeline calls; the pipeline owns the mutable accumulation it already owns today. `retrieve()` shrinks by the extracted bodies and keeps its control flow byte-for-byte.

```
packages/retrieval/src/
  index.ts                 // banners: Pipeline · Plan · Space admission · Lexical · Semantic · Graph · Rerank · Types
  types.ts                 // lines 1–202 verbatim
  retrieve.ts              // retrieve(): authorize, stage sequencing, diversity cap, context radius,
                           //            coverage, abstention, member + packet assembly, stableId
  retrieve.test.ts
  spaces/
    index.ts
    admission.ts           // ALL_SPACES, inferSpaces, assertAdmittedSpaces (the SPACE_NOT_ADMITTED throw)
    admission.test.ts
  plan/
    index.ts
    build-plan.ts          // buildRetrievalPlan, inferIntents
    build-plan.test.ts
  lexical/
    index.ts
    text.ts                // normalize, tokenize  (shared: plan/ and retrieve.ts import from here)
    scoring.ts             // score, exactScore, ftsScore, trigramScore
    scoring.test.ts
  semantic/
    index.ts
    cosine.ts              // cosine
    cosine.test.ts
  graph/
    index.ts
    expand.ts              // expandVerifiedGraph(...): the 431–481 frontier walk as a pure function
    expand.test.ts         //   taking (plan, eligible, edges, policy, seeds) and returning ranked
                           //   graph contributions in the same order
  rerank/
    index.ts
    fuse.ts                // sum, compareCandidate, rrf contribution and channel ranking
    fuse.test.ts
packages/retrieval/examples/
  README.md, fixtures.ts
  01-plan-and-admission.ts        (+ .test.ts)   policy-scoped plan; SPACE_NOT_ADMITTED and FILTER_NOT_ALLOWED
  02-fuse-channels.ts             (+ .test.ts)   exact/trigram/fts/semantic fusion; identical digest twice
  03-abstain-and-omit.ts          (+ .test.ts)   coverage abstention, tenant/visibility/retraction omissions
```

`normalize` and `tokenize` sit in `lexical/text.ts` because tokenisation is a lexical concern and `plan/` already normalises with the same function; a root `text.ts` would be a `utils/` by another name (rule 1). `matches` (hard-filter evaluation) stays with the pipeline, since it is admission rather than a retrieval channel.

**The public export surface must not change.** Today the package exports every type in lines 1–202 plus `buildRetrievalPlan` and `retrieve` through `export`-per-declaration. The barrel must re-export exactly those names and nothing more; the newly named internals (`assertAdmittedSpaces`, `expandVerifiedGraph`, `score`, …) stay unexported unless a test imports them by path. Prove it with a declaration diff, as Phase 1's implementer 3 did for acquisition.

Tests: the existing six cases are preserved verbatim in `retrieve.test.ts` (they are pipeline-level), and each new folder gets its own unit tests for the primitive it owns. Add the mutation-catching cases the current suite lacks: `inferSpaces` for each of the eight spaces; `trigramScore` symmetry and empty input; `cosine` dimension mismatch and non-finite rejection; `compareCandidate` tie-break order (score → assurance → freshness → id); graph expansion rejecting an edge whose `locatorDigest` is bound to neither endpoint (already covered at pipeline level, now also at unit level); `maxGraphNodes` stopping expansion.

### 3.2 `packages/vector-backends` — confirmed, with `spaces/` narrowed to storage binding and version pointer

Observed: `index.ts` (4 lines of `export *`), `types.ts` (52), `in-memory-exact.ts` (89), `postgres.ts` (116), `publication.ts` (662), three sibling tests. Only dependency: `domain`.

`publication.ts` seams:

| Lines | Concept |
|---|---|
| 4–136 | Types and ports: `Digest`, `PublicationState`, `PublicationManifests`, `PublicationInspection`, `PublicationInspector`, `ExploratoryPublication`, `ActivePublicationPointer`, `PublicationEvent`, `PublishExploratoryRequest`, `RollbackPublicationRequest`, `PublicationTransaction`, `PublicationRepository` |
| 138–196 | `InMemoryPublicationRepository` (serialisable local repository) |
| 198–212 | `ReconciliationFinding`, `PublicationReconciliationReport` |
| 214–437 | `ExploratoryPublicationCoordinator`: `publish`, `rollback`, `reconcile` |
| 439–576 | `verifyInspection`, `collectInspectionFindings`, `manifestKeys` |
| 578–662 | `validatePublishRequest`, `transactionView`, key builders, freezers |

**Recommendation (P2-2):**

```
packages/vector-backends/src/
  index.ts                 // banners: Backends · Publication · Spaces · Shared types
  types.ts                 // unchanged
  backends/
    index.ts
    in-memory-exact.ts (+ in-memory-exact.test.ts)   moved
    postgres.ts        (+ postgres.test.ts)          moved
  publication/
    index.ts
    types.ts               // manifests, inspection, publication record, requests, transaction + repository ports
    repository.ts          // InMemoryPublicationRepository, transactionView, publicationKey/pointerKey, freezers
    coordinator.ts         // ExploratoryPublicationCoordinator, validatePublishRequest
    verification.ts        // verifyInspection, collectInspectionFindings, manifestKeys, reconciliation types
    coordinator.test.ts, verification.test.ts        (publication.test.ts split by owner)
  spaces/
    index.ts
    version.ts             // ActivePublicationPointer, PublicationEvent, PublicationState  (moved, names unchanged)
    link.ts                // VectorItemEntityLink + validateVectorItemEntityLink  (new, additive)
    link.test.ts
packages/vector-backends/examples/
  README.md, fixtures.ts
  01-exact-search.ts        (+ .test.ts)   tenant, version and lifecycle isolation; deterministic ordering
  02-publish-and-rollback.ts (+ .test.ts)  verified publish, idempotent replay, rollback to an intact predecessor
  03-reconcile-drift.ts     (+ .test.ts)   orphan pointer, manifest mismatch, evaluation regression classifications
```

Two revisions to the plan's `spaces/` proposal, both deliberate:

1. **No `spaces/registry.ts`.** The plan wants "space registry/identity" here. Space *definitions* already have three homes: the eight-space enum and `StoreClassSchema` in `packages/contracts/src/spaces.ts`; the live rows in `retrieval.vector_space` (`slug`, `purpose`, `class`) in the pinned db-contract; and the profile↔space bindings in `chunking`'s `chunk-profile-table.v1` (landed in Phase 1). A fourth definition table in `vector-backends` is precisely the duplication F8 forbids for profiles. What vector-backends genuinely lacks is not definitions but the **binding between a space and the store version that serves it**, which today is implied by loose `vectorStoreSpaceId` / `vectorSpaceVersionId` strings threaded through `PublishExploratoryRequest`.
2. **`version.ts` takes the pointer types, not the rollback method.** The plan says "pointer and rollback migrated out of `publication.ts`". `rollback` shares one `repository.transaction` with `publish` and enforces the same `verifyInspection` invariant; splitting the method out of the coordinator would fracture a transactional invariant to satisfy a folder name. The record types (`ActivePublicationPointer`, `PublicationEvent`, `PublicationState`) move; the method stays in `publication/coordinator.ts`. Recorded as `P2-3`.

`spaces/link.ts` is the one additive surface in this unit. It is the conceptual embedding→structured-entity link the plan asks for, expressed over shapes that already exist in `contracts/src/promotion-selection.ts` (`TargetReference`, `SourceReference`) rather than new ones:

```
VectorItemEntityLink {
  tenantId, vectorSpaceVersionId, vectorItemId, searchProjectionId,
  target: { projectionTargetId, kind: "entity"|"claim"|"record"|"summary"|"chunk", canonicalId },
  lineage: { chunkId, chunkDigest, representationId, representationDigest, captureId, sourceFamilyId },
  admission: { admissionDigest, admittedAt } | { state: "not_admitted" }
}
validateVectorItemEntityLink(link) -> { complete: boolean, issues: string[] }
```

It has **no caller today** and stores nothing. It exists so the S2 publication host and the F8 manifest have one typed shape to agree on, and so the cross-repository proposal in §6.5 has a concrete field list to carry. This is the same shape of additive-with-no-caller change the developer already accepted for `forSpaceAndNodeKinds` in Phase 1; `P2-4` asks for the same confirmation.

### 3.3 `packages/projections` — split confirmed, one folder renamed

Observed: one 165-line `src/index.ts` written with very long lines, one 44-line test, no `examples/`. Consumer: `packages/application/src/preparation/preparation.ts` only. Seams: types (11–44), `validateEvidenceSupport` (46–77), `createProjection` + `projectionText` + `lines` (79–121), disposition→space classification (123–165).

**Recommendation (P2-5):**

```
packages/projections/src/
  index.ts                 // banners: Validation · Projection · Classification · Types
  types.ts                 // EvidenceSupport, SupportedAssertion, ProjectionInput union,
                           // EvidenceValidationResult, DomainDisposition, ClassificationProposal
  validation/
    index.ts
    evidence-support.ts (+ .test.ts)      validateEvidenceSupport
  projection/
    index.ts
    create-projection.ts (+ .test.ts)     createProjection, projectionText, lines
  classification/
    index.ts
    disposition-spaces.ts (+ .test.ts)    classifyProjectionSpaces, dispositionSpace, publicProjectionSpaces
packages/projections/examples/
  README.md, fixtures.ts
  01-validate-and-build.ts      (+ .test.ts)   evidence → validated support set → deterministic projectionId
  02-source-native-fidelity.ts  (+ .test.ts)   faithful text must equal ordered evidence; derived assertions rejected
  03-classify-dispositions.ts   (+ .test.ts)   dispositions → spaces; not_ingestible alone; unresolved identity refused
```

The plan proposed `validation/` and `spaces/`. **`spaces/` is renamed to `classification/`** because it does not build spaces, it maps a disposition to one, and because Phase 2 would otherwise ship three folders named `spaces/` with three different meanings (`retrieval/spaces/` = admission, `vector-backends/spaces/` = storage, `projections/spaces/` = classification) in one phase — the exact ambiguity the plan and the Phase 1 handoff told this memo to avoid. The plan also had nowhere to put `createProjection`, which is the package's main product; `projection/` is that home.

Reformat the long lines while moving (one statement per line, one `case` per line in the two switches). Behaviour is unchanged and the digest of every produced projection must be unchanged — the tests assert `projectionId` stability, which is the guard.

Examples build their fixtures from `documents` directly, **not** through `conversion`, so the open `sectionPath` bug in `packages/conversion/src/deterministic/nodes.ts:65–66` (Phase 1 handoff §3 item 2) cannot reach the `SourceNativeSectionProjectionSchema` array-of-non-empty-string check. Carried forward as `P2-11`.

### 3.4 `packages/embeddings` — reformat and flat files, no folders

Observed: 84 lines, but written with several statements per line; reformatted it is roughly 400 lines of real logic. Seams: constants and types (4–29), `createGatewayEmbeddingAdapterFromEnvironment` + `VercelAiGatewayEmbeddingAdapter` (31–68, including a 3-line `#postWithRetry` that is a full retry loop), `DeterministicFakeEmbeddingAdapter` (70–75), request validation, gateway payload validation, vector validation, digesting, cache keys and retry delay (77–84).

**Recommendation (P2-6): reformat, split into flat sibling files, add `examples/`, do not create folders.** The package has no internal pipeline of its own to name folders after — it has one port (`EmbeddingAdapter`) and two implementations. Folders here would be the over-fragmentation rule 4 warns about, and the plan itself predicted this outcome ("likely stays a small flat module").

```
packages/embeddings/src/
  index.ts        // banners: Contract · Vectors · Cache · Gateway adapter (wired) · Deterministic fake
  types.ts        // ModelDescriptor, EmbedInput, EmbedRequestBase, EmbedOneRequest, EmbedManyRequest,
                  // RetryAttempt, EmbeddedItem, EmbedBatchReceipt, EmbedReceipt, EmbeddingAdapter,
                  // GatewayAdapterOptions, EmbeddingCache, constants
  vectors.ts      // validateVector, vectorDigest, cacheKey, fakeVector   (+ vectors.test.ts)
  cache.ts        // MemoryEmbeddingCache                                  (+ cache.test.ts)
  gateway.ts      // VercelAiGatewayEmbeddingAdapter, createGatewayEmbeddingAdapterFromEnvironment,
                  // validateRequest, validateGatewayData, retryDelay, gatewayError  (+ gateway.test.ts)
  fake.ts         // DeterministicFakeEmbeddingAdapter                     (+ fake.test.ts)
packages/embeddings/examples/
  README.md
  01-deterministic-batch.ts (+ .test.ts)   stable ordering, identical output manifest twice
  02-cache-and-retry.ts     (+ .test.ts)   one idempotency key across a 503 retry; second call served from cache
  03-reject-bad-output.ts   (+ .test.ts)   reordered, partial, wrong-dimension and non-finite responses all reject
```

`validateRequest` stays with the gateway file only if both adapters keep calling it; they do (lines 49 and 74), so it belongs in a shared place — put it in `vectors.ts` next to the other validators, or keep a two-line `validation.ts`. Implementer's call, recorded in the result file; the export surface must not change either way. The `examples/README.md` states plainly that example 02 uses a stub `fetch` and that **no example makes a live provider call**.

## 4. Consumer impact

### 4.1 Import counts, measured

Method: `rg` for `@aiengineer/knowledge-<pkg>` across `apps`, `packages`, `scripts`, `fixtures`, excluding `node_modules` and `dist`; `package.json`, `pnpm-lock.yaml`, `catalog/README.md` and `docs/` hits removed.

| Package | Code consumers | Where |
|---|---|---|
| `retrieval` | **3 files** | `packages/application/src/preparation/knowledge.ts`; `packages/testkit/src/retrieval-fixtures.ts`; `packages/testkit/src/broad-evaluation-corpus.ts` |
| `vector-backends` | **1 file** | `packages/application/src/preparation/knowledge.ts` |
| `projections` | **1 file** | `packages/application/src/preparation/preparation.ts` |
| `embeddings` | **10 files** | `apps/api/src/{index,server,retrieval-executor}.ts`; `apps/worker/src/{index,activity-registry}.ts`; `packages/application/src/preparation/knowledge.ts` (+ its test); `scripts/{prove-governed-indexing,prove-canonical-retrieval-api,canonical-fixture}.ts` |
| `policy` | ~13 files | `apps/worker/src/verification-{metric,claims}-sealer.ts`; `apps/verification-executor/src/{executor.ts,knowledge/evidence-oracle.ts,knowledge/recovery-host-canonical.ts,knowledge/recovery-executor-evidence.ts}`; `packages/application/src/verification/{admission/verification-seal-policy.ts,operations/verification-replay.ts}`, `src/diagnostics/verification-diagnostics-policy-replay.ts`; four tests |
| `db-read` | ~30 files | `packages/ingestion/**` (21), `apps/verification-executor/src/knowledge/**` (8), `scripts/prove-current-schema.mjs` |

**The finding that reframes this phase: no app imports `retrieval`, `vector-backends` or `projections` at all.** The canonical HTTP retrieval path in `apps/api/src/retrieval-executor.ts` runs through `@aiengineer/knowledge-persistence` (`PostgresCanonicalRepository`, `HybridSearchResult`, `RETRIEVAL_SUPPORT_LIMITS`) and `contracts`, not through the `retrieval` package. The `retrieval` package is the in-memory evaluation and exploratory-index engine used by `application/preparation/knowledge.ts` (`AgenticKnowledgeService`) and by `testkit` corpora. That is worth stating loudly, because the plan's blast-radius table implies these packages are hot and they are not; it also means the `retrieval` split cannot break a transport.

### 4.2 Per-consumer impact of this phase

| Consumer | Impact | Action in this phase |
|---|---|---|
| `apps/api` (`index.ts`, `server.ts`, `retrieval-executor.ts`) | none. Imports only `createGatewayEmbeddingAdapterFromEnvironment`, `DeterministicFakeEmbeddingAdapter` and the `EmbeddingAdapter` type, all through the package root, all kept | typecheck only |
| `apps/worker` (`index.ts`, `activity-registry.ts`) | none. Same three names through the root | typecheck only |
| `apps/verification-executor` | none from §3. Its `policy` imports are `verification-policy` functions, untouched by F9's new file | typecheck only |
| `apps/mcp`, `apps/cli` | none. Neither imports any Phase 2 package; `store search` and `space rebuild` stay `unsupported` in `apps/cli/src/commands.ts:127,220` and no skill changes | nothing |
| `packages/application/src/preparation/knowledge.ts` | none. Imports `retrieve`, `ImmutableEvidencePacket`, `RetrievalPolicy`, `RetrievalRecord`, `InMemoryExactCosineBackend`, `PublicationManifests`, `EmbeddingAdapter` — all preserved | typecheck only |
| `packages/application/src/preparation/preparation.ts` | none. Imports `createProjection`, `EvidenceSupport` | typecheck only |
| `packages/testkit` | none. Imports retrieval types and `retrieve` | typecheck, test |
| `packages/ingestion`, `apps/verification-executor` (db-read) | none. §6 adds a new file to `db-read`; nothing existing moves | typecheck |
| `scripts/prove-*`, `scripts/canonical-fixture.ts` | none. Root-imported embeddings names preserved | typecheck as part of the repo typecheck |
| `scripts/prove-verification-*.ts` `paths=[…]` digest lists | reference `packages/application/src/verification/…`, never a Phase 2 package | unaffected; still a Phase 3 hazard |
| research harness (`research_ingestion_systems_agent`) | imports `packages/policy/src` directly (ADR 0004 violation, D9). F9 adds `selection-eligibility.ts` inside that surface | no change here; D9's testkit fix stays Phase 3 |
| `fixtures/openai-pre-mc/*.ts` | none. They import `runtime`, `persistence`, `application`, worker/API internals — no Phase 2 package | nothing |

### 4.3 What Phase 3 owns in the apps

`apps/` is in scope as a cleanup target, and this memo's honest answer for Phase 2 is that **the app modules consuming Phase 2 packages need no edit**: every import is root-level and every name survives. Recorded for Phase 3, which owns the apps' own structure: `apps/api/src/retrieval-executor.ts` (retrieval transport, tests not beside code), `apps/worker/src/activity-registry.ts` (embedding, conversion and promotion activities in one large file), `apps/worker/src/promotion-selection.ts` (339 lines composing the selection host), `apps/verification-executor/src/knowledge/promotion-selection{,-host}.ts`, and review records plus `examples/` for all five apps.

## 5. F9 — selection eligibility policy

### 5.1 What exists, so F9 does not duplicate it

- `packages/policy/src/promotion-policy.ts` is nine lines: it validates a *decision* against gate results (`validatePromotionDecision`). It says nothing about which candidates are eligible.
- Membership, budget, authority, digest and deadline enforcement is already implemented **server-side in one transaction** in `packages/persistence/src/promotion-selection.ts`: it compares the selection against independently registered authority bytes (`PROMOTION_SELECTION_AUTHORITY_MISMATCH`), measures each member through the host `measure` port, rejects unknown usage (`PROMOTION_SELECTION_USAGE_UNKNOWN`) and enforces `maxMembers`/`maxBytes`/`maxTokens`/`maxCostMicros` (`PROMOTION_SELECTION_BUDGET_EXCEEDED`), then materialises exact membership only after all read-side authority checks pass.
- `PromotionSelectionSchema` in `contracts` already enforces the structural rules (a domain projection needs a canonical target and admitted claims; a chunk target must identify the selected chunk; source-native sections must be faithful content, not derived projections; selected chunk bytes must appear in source lineage).
- `apps/verification-executor/src/knowledge/promotion-selection-host.ts` composes the ports; `packages/application/src/promotion-selection/promotion-selection.ts` reconciles prepare/embed/index operations and is explicitly "not a second scheduler".

So the gap is narrow and real: **nothing turns `SPECIFICATION.md` §5.1's representation-eligibility table into a function anyone can call before proposing.** F9 fills exactly that, and adds no enforcement.

### 5.2 Shape

`packages/policy/src/selection-eligibility.ts`, pure, no I/O, no zod parsing of foreign bytes:

```ts
evaluateSelectionEligibility(candidate: SelectionCandidate, context: SelectionEligibilityContext): SelectionEligibility
```

`SelectionCandidate` (the caller's view of one proposed member, deliberately narrower than `PromotionSelection["selected"][number]`):

- `content: { kind: "node" | "chunk" | "claim" | "entity" | "record" | "summary"; id; digest }`
- `targetSpaces: readonly VectorSpace[]`
- `lineage: { chunkId; chunkDigest; representationId; representationClass; captureId; sourceFamilyId }[]`
- `admittedClaims: { runId; claimId; claimDigest; admissionDigest; status }[]` where `status` is the evidence claim status
- `locators: { reconstructable: boolean }` (the section case) and `temporalLink`, `entityLink` booleans (the atomic case)
- `reportAdmission?: { admitted: boolean; dependencies: { ref: string; eligible: boolean }[] }` (the summary case)
- `revoked: boolean`
- `estimatedBytes`, `estimatedTokens`, `estimatedCostMicros`

`SelectionEligibilityContext`: `{ storeClass: StoreClass; admittedSpaces: readonly VectorSpace[]; promotableClaimStatuses?: readonly string[] }`.

Result:

```
{ eligible: boolean,
  reasons: readonly EligibilityReason[],          // stable codes, always populated when ineligible
  representationKind: RepresentationKind,
  diversityGroup: string,
  spaceBudgetEffect: readonly { space: VectorSpace; members: 1; bytes; tokens; costMicros }[] }
```

`RepresentationKind` is the §5.1 table, one value per row: `raw_source_bytes`, `faithful_source_section`, `atomic_projection`, `derived_summary`, `exploratory_draft`.

### 5.3 The rules, each traced to its source

| Representation | Rule implemented | Source |
|---|---|---|
| `raw_source_bytes` | never eligible for embedding; `RAW_BYTES_STORED_NOT_EMBEDDED` | §5.1 row 1 |
| `faithful_source_section` | needs admitted relevance **and** reconstructable locators; `SECTION_RELEVANCE_NOT_ADMITTED`, `SECTION_LOCATOR_NOT_RECONSTRUCTABLE`. Eligible for `source_native_sections` only; `SECTION_NOT_ELIGIBLE_FOR_OFFICIAL_SPACE` otherwise | §5.1 row 2, and `PromotionSelectionSchema`'s source-native rule |
| `atomic_projection` | needs at least one admitted claim whose status promotes, plus temporal and entity links; `PROJECTION_CLAIM_NOT_ADMITTED`, `PROJECTION_CLAIM_STATUS_NOT_PROMOTABLE`, `PROJECTION_TEMPORAL_LINK_MISSING`, `PROJECTION_ENTITY_LINK_MISSING` | §5.1 row 3, `IMPLEMENTATION_PLAN.md` §1.2 settlement |
| `derived_summary` | needs report admission and **every** material dependency eligible; `SUMMARY_REPORT_NOT_ADMITTED`, `SUMMARY_DEPENDENCY_INELIGIBLE`. Never counted as independent corroboration — it shares its dependencies' diversity group | §5.1 row 4, §5.3 |
| `exploratory_draft` | eligible only when `storeClass === "internal_exploratory"`; `DRAFT_OFFICIAL_SPACE_DENIED` | §5.1 row 5 |
| any | revocation is terminal: `REVOKED` | §5.3 "claims whose policy has been revoked … must be filtered immediately" |
| any | a target space outside `context.admittedSpaces` yields `SPACE_NOT_ADMITTED` | consistency with `retrieval`'s admission error |

The **T2 settlement** is a named constant, not a literal sprinkled through branches:
`PROMOTABLE_CLAIM_STATUSES = ["directly_supported", "supported_with_qualification", "derived_verified", "literal_extraction_verified"]`, with a comment recording that `verified` means *policy-admitted official knowledge* and is therefore an admission outcome, not a promotion input (`IMPLEMENTATION_PLAN.md` §1.2, "Settlement").

**Diversity group**: `lineage:<sourceFamilyId>:<captureId>` derived from the candidate's first lineage entry in sorted order, so a summary and its supporting chunks that come from one capture land in one group, which is what §5.3 requires ("a summary and its ten supporting chunks cannot crowd out independent evidence"). A candidate with no lineage gets `lineage:unknown` and is ineligible with `LINEAGE_MISSING` — lineage is not optional for anything that reaches a space.

**`spaceBudgetEffect` reports, it does not enforce.** It returns the per-space cost of admitting this one candidate so a caller can subtract before proposing. Budget rejection stays in `packages/persistence/src/promotion-selection.ts` where the authority bytes are. `FEATURE-SET-SPECIFICATION.md` §3.2 wants diversity grouping to shrink embedding volume *before* the budget check; this result is the input that makes that possible, and wiring it is S2 host work, not this unit.

### 5.4 Surface (D5 confirmed)

No public operation. `promotion_selection_select` and `promotion select` stay in `skills/manifest.json`'s `absentOperations` for `knowledge-preparation-and-promotion`, unchanged, so `node skills/check.mjs` stays at 11/42/58/78/70. Callers arrive in S2: the executor selection host pre-checks before membership enforcement, and the preparation skill teaches agents to pre-check so proposals stop failing late. This unit ships the function and its tests only.

## 6. F8 — `space_manifest`, and what it can honestly report today

### 6.1 What exists

- The eight-space enum, `StoreClassSchema` and the typed domain projections: `packages/contracts/src/spaces.ts`.
- `chunk-profile-table.v1` with per-profile `spaces` and `nodeKinds`: `packages/chunking/src/profiles/definitions.ts`, typed by `ChunkProfileSchema`/`ChunkProfileTableSchema` in `packages/contracts/src/chunking.ts` (P1-2, landed).
- Live rows in the pinned contract 0.4.16 workspace: `retrieval.vector_space` (`slug`, `purpose`, `class`), `retrieval.vector_store_space` (`authority_class`, `active_space_version_id`), `retrieval.vector_space_version` (`dims`, `precision`, `publication_lifecycle`, `promoted`), `retrieval.space_publication` (`status`, `expected_item_count`, `published_at`, manifests), `retrieval.vector_store` (`store_class`, `quota_profile` jsonb).
- The naming and shape precedent: `schema_manifest` in `apps/verification-executor/src/knowledge/operations.ts:48–58` is a thin `defineKnowledgeOperation` whose `run` calls library functions and whose `gate` fails on head mismatch.

### 6.2 Placement (D4 confirmed: `db-read`)

`db-read` is right and `schema-workspace` is wrong for the reason D4 gives — this read must reflect live rows and live publication state, and `schema-workspace` is a static pinned bundle with no database handle. `db-read` already owns `ReadExecutor` with `head`, `runIntent`, `sqlReadonly` and the artifact ledger, and is already the home of every bounded live read the executor exposes.

### 6.3 The obstacle, found by reading the pinned catalog

**The pinned query catalog has 35 named queries and not one of them touches a space, a store, a version or a publication.** The entries are `entity.*`, `events.*`, `evidence.*`, `facts.*`, `knowledge.head`, `receipts.*`, `relationships.*`, `reports.*`, `retrieval.evidence_packet`, `retrieval.hybrid_search`, `staging.*`, `vocab.*`. A catalog-driven `space_manifest` therefore cannot read its live half today, and reaching for `sqlReadonly` to get around that would put ad-hoc SQL where the catalog discipline exists precisely to prevent it.

**Recommendation (P2-7): build `space_manifest` as a manifest with a declared availability boundary, not as a read that silently omits what it cannot see.** The parts that are knowable without new catalog entries are reported; the parts that are not are listed in an explicit `unavailable[]` with the catalog query each one needs. That is honest, it is testable without a database, and it makes the db-contract proposal in §6.5 concrete instead of aspirational.

### 6.4 Shape

`packages/db-read/src/space-manifest.ts`:

```ts
export const SPACE_MANIFEST_SCHEMA_VERSION = "space-manifest.v1";

export interface SpaceManifestEntry {
  readonly space: VectorSpace;
  readonly storeClass?: StoreClass;                 // from live rows when available
  readonly authorityClass?: "official" | "exploratory" | "user_managed";
  readonly admittedNodeKinds: readonly DocumentNode["kind"][];   // union of bound profiles' nodeKinds
  readonly profileBindings: readonly { name; version; strategy; nodeKinds }[];
  readonly activePublication?: { vectorStoreSpaceId; vectorSpaceVersionId; publicationId; status;
                                 expectedItemCount; publishedAt };
  readonly budget: { reserved; remaining; basis: string } | { status: "unavailable"; reason: string };
}

export interface SpaceManifest {
  readonly schemaVersion: typeof SPACE_MANIFEST_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly atKnowledgeSeq: number | null;
  readonly contract: { migrationHead: string; workspaceFingerprint?: string };
  readonly profileTable: { schemaVersion: string };      // provenance of the bindings, never a second copy
  readonly spaces: readonly SpaceManifestEntry[];
  readonly unavailable: readonly { field: string; reason: string; requires: string }[];
}

export function buildSpaceManifest(input: BuildSpaceManifestInput): SpaceManifest;   // pure
export async function readSpaceManifest(reads: SpaceManifestReads, input): Promise<SpaceManifest>;
```

- `buildSpaceManifest` is pure and takes both the space list and the profile table as **structural inputs**, generic in the space type (`<Space extends string>`), so `db-read` depends on neither the `chunking` algorithm package nor `contracts`. The executor operation passes `VectorSpaceSchema.options` and `CHUNK_PROFILE_TABLE`, and gets back `SpaceManifest<VectorSpace>`. (Corrected during implementation: an earlier draft of this section had `db-read` take a direct `@aiengineer/knowledge-contracts` dependency for the types. Structural inputs are better layering — `contracts` defines the vocabulary, `db-read` only assembles — and they avoid a `pnpm-lock.yaml` change in a phase whose whole safety argument is a small blast radius. No second profile table can exist either way.)
- `readSpaceManifest` takes a narrow port `SpaceManifestReads { workspace; catalog(); head(tenantId); runIntent(raw) }`, which `ReadExecutor` satisfies structurally. It inspects `catalog()` for the space queries named in §6.5; it includes only those that exist, and records every absent one in `unavailable[]` with its `requires` string. With today's catalog it returns the static half plus five `unavailable` rows and touches no database — which makes it fully unit-testable now and correct the moment db-contract ships the queries.
- `db-read` gains **no new dependency**: the vocabulary types (`VectorSpace`, `StoreClass`, `ChunkProfileTable`, node kinds) arrive as generic structural inputs from the caller, so `package.json` and `pnpm-lock.yaml` are untouched.
- **The executor registry entry is not written in this session.** `space_manifest` in `apps/verification-executor/src/knowledge/operations.ts` is a Track K reserved file before G3. The follow-up unit for the registry owner is specified in §9.4: `name: "space_manifest"`, `cli: { command: ["space", "manifest"] }`, input `{ tenantId?, spaces? }`, `run` calling `readSpaceManifest(services.reads, …)` with `CHUNK_PROFILE_TABLE`, and a `gate` that fails when `unavailable[]` contains a field the caller required. No skill lists `space_manifest` yet, so `skills/check.mjs` numbers do not move in either session.

### 6.5 Cross-repository flags for `ai-engineer-db-contract`

Two proposals, neither designed here beyond its field list, per the instruction not to design tables.

**(a) Five catalog queries** so `space_manifest` can read live rows under the existing bounded-role discipline instead of ad-hoc SQL:

| Proposed query | Role | Reads | Fills |
|---|---|---|---|
| `retrieval.spaces_for_tenant` | `app_reader` | `retrieval.vector_space` | `space`, `purpose`, space `class` |
| `retrieval.store_spaces_for_tenant` | `app_reader` | `retrieval.vector_store_space` ⋈ `retrieval.vector_store` | `storeClass`, `authorityClass`, `activeSpaceVersionId` |
| `retrieval.active_space_publication` | `app_reader` | `retrieval.space_publication` ⋈ `vector_space_version` | `activePublication` (id, version, status, expected count, publishedAt) |
| `retrieval.space_version_config` | `app_reader` | `retrieval.vector_space_version` | dims, precision, `publication_lifecycle`, `promoted` |
| `retrieval.store_quota_usage` | `pipeline_agent` | `retrieval.vector_store.quota_profile` plus item counts | `budget.reserved` / `budget.remaining` |

**(b) Per-space budgets do not exist in the contract today.** The only budgets in the system are `vector_store.quota_profile` (per *store*: `maximumDocuments`, `maximumBytes`, `maximumSpaces`) and `PromotionSelection.budget` (per *selection*: members, bytes, tokens, cost, deadline). F8 asks the manifest for "reserved and remaining per-space budgets", and nothing can compute that. Until the contract carries a per-space reservation, `budget` in every entry is `{ status: "unavailable", reason: "no per-space reservation exists in contract 0.4.16", requires: "db-contract per-space budget proposal" }`. Saying so is the point; inventing a number would be worse than the gap.

**(c) The relational embedding→entity link.** `retrieval.projection_target`, `retrieval.chunk_claim_link` and `retrieval.chunk_entity_mention` exist; what is missing is the explicit row binding a `retrieval.vector_item` to its projection target and its admission. `spaces/link.ts` (§3.2) is the KS-side shape to carry into that proposal. Flagged, not designed.

### 6.6 What this phase deliberately does **not** do for F8

F8(b) — replacing `profileFor` in `packages/application/src/preparation/preparation.ts:22` (one profile per `document_kind`) with `forSpaceAndNodeKinds(space) ∩ observedNodeKinds` and recording the selection in the routing receipt — is a **behaviour change inside `application`**, is scheduled S2 by `PHASE-1-RECOMMENDATION.md` §9, and is not in this phase's unit list. `forSpaceAndNodeKinds` is already there waiting for it. Recorded as `P2-8` and carried to the handoff.

## 7. Behaviour and hygiene findings outside cleanup scope

Found while reading; none is fixed inside a structural change.

1. **`retrieve`'s graph stage checks `seen.size >= maxGraphNodes` inside the edge loop, after `frontier` is built** (`index.ts:460`). The cap therefore bounds *newly seen* nodes, not total expansion work, and a dense edge set still walks every edge at each depth. Not a correctness bug against any stated invariant; worth a decision when graph retrieval becomes a production path.
2. **`plan.graph.maxDepth` is hard-capped to 1** (`Math.min(1, policy.maxGraphDepth)`, line 286) while `RetrievalPolicy.maxGraphDepth` and the test policy both say 2. Either the cap is a deliberate freeze that should be named as a constant with a reason, or the policy field is misleading. It silently makes depth-2 policies unreachable.
3. **`evidenceScore` and `evidenceTerms` are computed over `selected`, but `selected` is capped by `finalK` and the diversity rule** (lines 616–634), so raising `maxPerSource` can change an abstention decision without any new evidence entering the corpus. Worth an explicit test either way.
4. **`ALL_SPACES` in `retrieval` is a hand-written copy of `VectorSpaceSchema.options`.** After the split it should derive from the contract enum so a ninth space cannot silently miss admission. Doing it now would change nothing observable and is cheap — recorded as `P2-9`, recommended yes.
5. **`packages/retrieval/package.json` declares `@aiengineer/knowledge-vector-backends` as a dependency that `src/` never imports.** Removing it touches the lockfile; recorded as `P2-10`, recommended: leave it, note it, remove it in Phase 3 with the other dependency hygiene.
6. **`publication.ts`'s `verifyInspection` hard-codes `precision !== "halfvec"`** while `PublicationInspection.precision` is typed `"halfvec" | "vector" | string`. The type admits values the check rejects. Narrow the type or state the policy; not a cleanup edit.
7. Carried from Phase 1 §7: `overlapTokens` is declared but never applied by the chunker; `selectForStrategy` falls back to every node when a strategy's kinds are absent; `adjacentDuplicateRatio` over-counts per span pair. All three belong to the F8 slice, not here.
8. Carried from the Phase 1 handoff §3: the `sectionPath` hole in `packages/conversion/src/deterministic/nodes.ts:65–66` still stands and still fails three `application` tests. Phase 2 keeps clear of it by building projection examples from `documents` rather than `conversion` (§3.3).

## 8. Decisions taken

The override means these are decided here and reviewed afterwards. Each says what was done.

| ID | Decision | Answer taken |
|---|---|---|
| P2-1 | `retrieval` split shape | The plan's six concepts as folders for the stage *primitives*; the orchestrator stays whole in `src/retrieve.ts` with a `// Pipeline` banner, because `retrieve()` owns load-bearing mutable accumulation (§3.1) |
| P2-2 | `vector-backends` split | `backends/`, `publication/` (types, repository, coordinator, verification), `spaces/` (version, link); `types.ts` unchanged (§3.2) |
| P2-3 | `rollback` migrated into `spaces/version.ts`? | **No.** Record types move; the method stays in `publication/coordinator.ts` because it shares a transaction and the `verifyInspection` invariant with `publish` (§3.2) |
| P2-4 | `spaces/registry.ts` in `vector-backends`? | **No registry.** Space definitions already live in `contracts`, the db-contract rows and `chunk-profile-table.v1`; a fourth copy is the duplication F8 forbids. `spaces/` holds the version pointer types and the conceptual entity link instead (§3.2) |
| P2-5 | `projections` folder names | `validation/`, `projection/`, `classification/` — **not** `spaces/`, so Phase 2 does not ship three `spaces/` folders with three meanings (§3.3) |
| P2-6 | `embeddings` split vs reformat | Reformat plus flat sibling files (`types`, `vectors`, `cache`, `gateway`, `fake`) plus `examples/`; no folders (§3.4) |
| P2-7 | `space_manifest` when the catalog cannot serve it | Ship `buildSpaceManifest` (pure) and `readSpaceManifest` (catalog-aware) with an explicit `unavailable[]` naming the five missing catalog queries; never ad-hoc SQL (§6.3, §6.4) |
| P2-8 | F8(b) `profileFor` → `forSpaceAndNodeKinds` in `preparation.ts` | **Not in this phase.** It is an `application` behaviour change scheduled S2; carried to the handoff (§6.6) |
| P2-9 | `ALL_SPACES` derived from `VectorSpaceSchema.options` | Yes, in the retrieval unit. Same values, one source (§7.4) |
| P2-10 | Remove `retrieval`'s unused `vector-backends` dependency | No; note it, remove it in Phase 3 with the lockfile change (§7.5) |
| P2-11 | Projection examples built through `conversion`? | No; build fixtures from `documents` so the open `sectionPath` bug stays out of Phase 2 (§3.3) |
| P2-12 | Running S4 structure before lane A (G3) exists | Accepted under the override, with the mitigation stated: the measured blast radius is four internal files and no transport, export surfaces are frozen and proved by declaration diff, and every consumer is typechecked and tested (§2, §4) |

Confirmations of existing decisions: **D4** yes, `db-read` (§6.2). **D5** yes, pure policy, absent operations stay absent (§5.4). **D9** unchanged; noted that F9 widens the harness's ADR 0004 debt surface slightly (§4.2).

## 9. Implementation sequence

Rules: disjoint file reservations; at most three implementer subagents live (developer's cap for this session); each unit's result file at `workspace/sessions/2026-09-19-phase-2/<unit>-result.md`; the coordinator re-runs every verify command itself before logging the unit.

### 9.1 Reservations

| Unit | Reservation | Wave |
|---|---|---|
| P2-U1 retrieval | `packages/retrieval/**`, `docs/operations/reviews/retrieval.md` | 1 |
| P2-U2 vector-backends | `packages/vector-backends/**`, `docs/operations/reviews/vector-backends.md` | 1 |
| P2-U3 projections + embeddings | `packages/projections/**`, `packages/embeddings/**`, `docs/operations/reviews/{projections,embeddings}.md` | 1 |
| P2-U4 F9 selection eligibility | `packages/policy/**`, `docs/operations/reviews/policy.md` | 2 |
| P2-U5 `space_manifest` in db-read | `packages/db-read/**`, `docs/operations/reviews/db-read.md` | 2 |
| P2-U6 consumer verification | nothing; typecheck and test only | coordinator |
| P2-U7 registration and doc map | `.agent-docs/modules.json`, `.agent-docs/config.json` | coordinator |

`.agent-docs/modules.json` and `.agent-docs/config.json` are **reserved to the coordinator**: they are single shared JSON files that every unit would otherwise edit, and a merge conflict there is a doc-map rebuild away from silent drift. Implementers write their own review record (a disjoint file) and state their `modules.json` delta in the result file; the coordinator applies all deltas once and rebuilds.

### 9.2 Verify commands

Per unit, run by the implementer and re-run by the coordinator, from `C:\Users\Pinda\Proyectos\aiengineer\ai-engineer-knowledge-services`:

```
corepack pnpm --filter @aiengineer/knowledge-<pkg> typecheck
corepack pnpm --filter @aiengineer/knowledge-<pkg> test
corepack pnpm --filter @aiengineer/knowledge-<pkg> examples      # where the unit adds examples/
```

Consumers per unit: U1 → `application`, `testkit` typecheck + `testkit` test; U2 → `application` typecheck; U3 → `application`, `api`, `worker` typecheck; U4 → `application`, `worker`, `verification-executor` typecheck; U5 → `ingestion`, `verification-executor` typecheck.

Repository-wide, by the coordinator after each unit: `node skills/check.mjs` (must stay `11/42/58/78/70`), `node .agent-docs/cli.mjs check --repo .`, and `git status --short` inspected for files no implementer owns — editor format-on-save reformatted an unowned executor file in the previous session, and formatting-only diffs are restored to HEAD after confirming they are formatting-only.

### 9.3 Export-surface proof

Every unit in wave 1 is a pure internal reorganisation. Before and after, capture the package's declaration surface and diff it:

```
corepack pnpm --filter @aiengineer/knowledge-<pkg> build
# then compare the exported names in dist/index.d.ts before and after
```

A non-empty diff for U1, U2 or U3 is a stop condition, not a thing to explain in the result file. U4 and U5 are additive by design, so their diff is expected to contain only the new names and must contain nothing else.

### 9.4 Recorded follow-up units (not this session)

1. **`space_manifest` executor registry entry** — `apps/verification-executor/src/knowledge/operations.ts` (Track K, reserved before G3), plus its CLI/MCP surface and the `knowledge-research-coordination` manifest move from `absentOperations` to `operations` when F6 is authored. Shape in §6.4.
2. **F8(b) multi-profile selection** in `packages/application/src/preparation/preparation.ts` and the routing receipt (§6.6).
3. **F9 callers** — the executor selection host pre-check and the preparation skill's pre-check guidance (§5.4).
4. **db-contract proposals** — the five catalog queries, the per-space budget question, and the vector-item→entity link row (§6.5).
5. Phase 3 items surfaced here: the apps' own structure (§4.3), `retrieval`'s unused dependency (P2-10), the `maxGraphDepth` cap and the abstention-versus-diversity coupling (§7.2, §7.3).

## Appendix: evidence index

- Plan package: `SEQUENCED-CLEANUP-PLAN.md` §2, §3, §5; `FEATURE-SET-SPECIFICATION.md` §1 (C5, C6, C8, C9), §2 (F8, F9), §3, §4, §5 (D4, D5, D9); `PHASE-EXPLORATION-INSTRUCTIONS.md` §"Developer override in force" and §"Phase 2"; `PHASE-1-RECOMMENDATION.md` §4.2, §8, §9; `workspace/KICKOFF-PHASE-2.md`; `workspace/sessions/2026-09-19-phase-1/HANDOFF.md` §4; `workspace/sessions/2026-09-19-phase-1-impl/HANDOFF.md` §1, §3, §5.
- Specification: `…/specs/knowledge-services-pre-mission-control/SPECIFICATION.md` §5.1, §5.2, §5.3; `IMPLEMENTATION_PLAN.md` §1.2 ("Settlement", the three-value pin record).
- Knowledge Services at `ff7fe97`: `packages/retrieval/src/{index.ts,index.test.ts}`; `packages/embeddings/src/{index.ts,index.test.ts}`; `packages/projections/src/{index.ts,index.test.ts}`; `packages/vector-backends/src/{index,types,in-memory-exact,postgres,publication}.ts` and the three tests; `packages/policy/src/{index,authorization,capability-policy,promotion-policy,retrieval-policy}.ts`; `packages/persistence/src/promotion-selection.ts:17,32–82,189`; `packages/contracts/src/{spaces,vector-store,promotion-selection}.ts`; `packages/chunking/src/profiles/{definitions,registry}.ts`; `packages/db-read/src/{index,canonical,rows,read-intent,read-executor,snapshot}.ts`; `packages/application/src/{promotion-selection/promotion-selection.ts,preparation/preparation.ts,preparation/knowledge.ts}`; `apps/verification-executor/src/knowledge/{operations.ts:30–90,promotion-selection-host.ts,promotion-selection.ts,context.ts}`; `apps/worker/src/{index.ts:26–36,promotion-selection.ts}`; `apps/api/src/retrieval-executor.ts:1–25`; `apps/cli/src/commands.ts:110–135,210–232`; `skills/manifest.json` (all ten entries dumped); `turbo.json`; root `package.json` scripts; `packages/chunking/{package.json,tsconfig.examples.json,src/index.ts,examples/README.md}` as the exemplar; `docs/operations/reviews/conversion.md` as the review-record format; `.agent-docs/{modules.json,config.json}`.
- Pinned database contract 0.4.16 (`../../../ai-engineer-db-contract/workspace`): `manifest.json` (`migration_head` `20260916020200`, catalog version, fingerprint); `queries/catalog.json` (35 entries, none space-related); `relations/retrieval/{vector_space,vector_space_version,vector_store_space,space_publication,vector_store}.md`.
