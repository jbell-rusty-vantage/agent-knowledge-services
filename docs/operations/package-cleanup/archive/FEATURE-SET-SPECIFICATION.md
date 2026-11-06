---
status: proposed
owner: knowledge-services
created: 2026-09-19
updated: 2026-09-19
---

# Knowledge Services: final feature set, challenges, and consolidated execution sequence

Status: **Proposed — a challenge to the current plans plus the final feature additions, enhancements and optimizations recommended before Mission Control consumes Knowledge Services.** Nothing here is built. Every item carries evidence of what exists today (observed 2026-09-19), what is added, who owns it, and which gate proves it. The developer approves, redirects or rejects each item through `PHASE-EXPLORATION-INSTRUCTIONS.md`.

This document is a sibling of `SEQUENCED-CLEANUP-PLAN.md`. The cleanup plan owns naming and folder structure. This document owns **feature scope** and the **single merged sequence** in which the pre-Mission-Control implementation plan (`specs/knowledge-services-pre-mission-control/IMPLEMENTATION_PLAN.md`, ledger revision after 208), the cleanup phases, and the features below are executed together. Where the two plans disagreed, §1 records the disagreement and §4 records the resolution.

Reading order: §1 (challenges) → §2 (feature set) → §4 (sequence) → §5 (decisions). §3 (optimizations) and §6 (what "move to Mission Control" means) are reference.

## 0. Summary

| ID | Feature | Kind | Bound to sequence step |
|---|---|---|---|
| F1 | Procedures name only implemented verbs (T10 correctness pass) | enhancement | S1 |
| F2 | Research execution contracts: `ResearchExecutionInput@1`, `OperationEnvelope@1`, `ResearchCompletionReceipt@1` | new contract | S1 |
| F3 | Evidence assurance packet `EvidenceAssurance@1` on every evidence member, report assertion and completion receipt | new feature (the differentiation surface) | S1 contract, S3 proof |
| F4 | Usage and budget ledger `UsageLedger@1` with unknown-not-zero accounting | new feature | S1 contract, S2 runtime |
| F5 | Inspection as a first-class executor operation with recorded findings | enhancement | S2 |
| F6 | `knowledge-research-coordination` skill (absorbs the proposed deep-research skill and the capabilities/workspace procedure) | new skill | S5 |
| F7 | `knowledge-research-synthesis` skill (four reports, final-byte binding, assessment, rebinding) | new skill | S5 |
| F8 | `space_manifest` read operation, profile↔space bindings as data, multi-profile selection wired | enhancement | S2 |
| F9 | Selection eligibility policy in `packages/policy` (representation eligibility, source-diversity groups, per-space budgets) | new policy | S2 |
| F10 | Skill stage contracts and a stage conformance harness (skills tested as real research stages) | new test capability | S5, reused by S6 and Mission Control |
| F11 | Knowledge outbox events `KnowledgeEvent@1` for Mission Control Event Waits | new feature | S7 |
| F12 | Mission Control transfer package: client extension or admitted knowledge-host route, outcome adapter, mission template, run-pin export | integration | S7 |

Structural cleanup (folders, barrels, splits, review records) stays in `SEQUENCED-CLEANUP-PLAN.md` and is referenced by phase number below.

## 1. Challenges to the current plans

These are places where the cleanup plan, the pre-MC specification package, or the working assumption "consolidate and move to Mission Control" is stale, contradictory, or under-scoped. Each has a resolution that §4 adopts.

**C1 — Skills are scheduled twice, in opposite orders.** The cleanup plan puts the skill refresh last ("skills wait until interfaces stop moving", Phase 4). The implementation plan's next action is T10, "skills from real verbs", now, because lane A cannot start on skills that name absent operations. Both are right about different things. *Resolution:* split skill work into a **correctness pass** (F1, now: name only implemented verbs, no structural change, guarded by `node skills/check.mjs`) and an **enhancement pass** (Phase 4 / F6, F7, F10: task context, decision points, worked examples, stage contracts) after structure freezes.

**C2 — "Move to Mission Control" must not mean relocating code.** The accepted boundary is unchanged: Mission Control owns durable lifecycle, dispatch, retry/cancellation classification and Stage Acceptance; Knowledge Services owns algorithms, admission and durable knowledge execution (`ai-engineer-mission-control/AGENTS.md`, ADR 0003 policy-computed acceptance). What moves is the *orchestration shell* the fixture builds around KS, not KS. §6 lists exactly what moves, what stays, and what is new.

**C3 — The surface Mission Control would call for research operations does not exist.** Today Mission Control consumes seventeen verification methods of `KnowledgeClient` through `packages/mission-kernel/src/verification-dispatch.ts`. The published client (`packages/client-typescript`) exposes verification, retrieval, vector store, promotion and evaluation. It does **not** expose schema, bounded reads, ingestion, reports, source import/select, content links, checkpoints or recovery; those live only on the sandbox executor's `knowledge` CLI/HTTP/MCP (`apps/verification-executor/src/knowledge/operations.ts`, 25 top-level operations plus `verify_*`, `checkpoint_*`, `recovery_*`, `content_*`). A research mission needs all of them. This is the largest unresolved decision for the transfer (D1).

**C4 — Several recorded facts are stale.**
- Cleanup plan §8 says the verification refactor is uncommitted. Knowledge Services is clean at `28247e1` (2026-09-19 06:12, "verification package refactor checkpoint"). Phase 0 still owes the review-record close-out and the doc-map registration.
- Six skills, not five, are missing from `.agent-docs/modules.json`: `knowledge-acquisition-and-vetting`, `knowledge-preparation-and-promotion`, `knowledge-retrieval-and-evidence`, `knowledge-evaluation`, `knowledge-verification-recovery`, `vector-store-management`.
- `IMPLEMENTATION_PLAN.md` §1.2 pins contract 0.4.13 / head `20260915010000`; the fixture manifest now pins 0.4.14 / head `20260916010000`. One migration of drift between authoritative documents. (corrected 2026-09-19) The package pins in `packages/persistence`, `packages/schema-workspace` and `apps/verification-executor` are 0.4.16 (head `20260916020200`), a third value; §1.2 of the plan now records all three and the fixture pin is unchanged pending a developer decision.
- The latest session handoff describes P6.1 as "0 captures, 0 claims, 0 queries". The fixture directory now records 48 distinct origin/digest documents, 37 admitted projections, 109 candidate claims across three years and 36 candidate queries, all `review_required`. P6.1 is materially further than the plan narrative.

**C5 — "No promotion policy exists" is overstated.** `packages/policy/src/promotion-policy.ts` validates a decision against gate results only, so a *selection* policy is indeed absent. But P5.4 (accepted) added `PromotionSelectionSchema` and `PromotionSelectionAuthoritySchema`, and T3/T4 landed host-composed authority, exact membership, budget and digest enforcement in `application/promotion-selection` plus the executor selection host. *Resolution:* F9 is a narrow pure policy (which candidates are eligible, why, and under which per-space budget and diversity group), not a second membership enforcer, and it adds no public operation (D5).

**C6 — "Spaces are unimplemented" is overstated.** `packages/contracts/src/spaces.ts` defines the eight-space enum and typed domain projections; the database contract has `retrieval.vector_store_space`, `space_publication`, `projection_target`, `vector_store_*` and `vector_space_version`; `chunking` already has `ChunkProfileRegistry.forSpace()`. What is missing is (a) a bounded **read** that reports spaces, admitted node kinds, profile bindings, active generation and budgets, (b) the profile↔space↔node-kind table living as **data** instead of prose in `docs/operations/conversion-and-chunking.md`, and (c) `preparation.ts:22` still selecting one profile by `document_kind`. That is F8, and it is smaller than a new registry module.

**C7 — The proposed deep-research scratchpad layout contradicts the specification.** Cleanup plan §4.2 proposes `research/<objective-id>/{notes,fetched,candidates.md,compiled}`. Specification §6 already fixes a per-run, per-attempt workspace: immutable `inputs/`, bounded `discovery/`, `captures/` references, `claims/`, `reports/`, `ingestion/`, `retrieval/`, `manifest.json`, `handoff.md`, with children in their own subdirectories and checkpoint allowlists over those paths. *Resolution:* the coordination skill (F6) uses the specification layout; `discovery/` is the bounded scratchpad; no second layout.

**C8 — The blast-radius map omits three real consumers.** `fixtures/openai-pre-mc/*.ts` import `@aiengineer/knowledge-runtime`, `knowledge-persistence`, `knowledge-application`, worker and API internals, and `packages/persistence/test/disposable.mjs`. `scripts/` proofs import application and persistence. The research harness (`research_ingestion_systems_agent`) imports the executor package, `packages/contracts/dist`, `packages/policy/src/` and the persistence disposable helper. A rename in `application` or `persistence` breaks lane preparation and the research harness, not only the five apps. The harness importing `packages/policy/src` is also an ADR 0004 violation (out-of-process callers use the client) and should be recorded as debt (D9).

**C9 — Structural cleanup and scored lanes are sequenced against each other.** The fixture requires frozen code for lanes B/C and reruns affected gates after any code fix. If Phase 3 (application/persistence/contracts) lands after lane B, every B run is invalidated. Conversely, cleanup without a regression net is how a naming mistake in `application` ripples into every skill. *Resolution:* lane A (deterministic, cheap to rerun) is built **before** the high-blast cleanup phases and rerun after each phase; all structural cleanup completes before the B/C bundle freezes. Lane A becomes the cleanup's safety net.

**C10 — Four overlapping "new skill" ideas.** The cleanup plan proposes `knowledge-deep-research`. Specification §4 names three new procedures: research coordination, research synthesis, capabilities/workspace. `PRE_MC_EVE_TEAM.md` says coordination, synthesis and workspace procedures remain implementer work. *Resolution:* two skills (F6, F7). Coordination absorbs the long-horizon deep-research loop and the workspace/checkpoint procedure, because the checkpoint operations already exist on the executor and a coordinator that cannot checkpoint is not a coordinator. Synthesis stays separate because it has different inputs (admitted manifests), a different exit artifact (final-byte report binding) and a different failure path (rebinding after edits).

**C11 — Usage accounting is required by the specification and has no owner.** The specification says "usage accounting and bounded execution are required now"; fixture gates A02/A03 and budget exhaustion depend on it; Eve charges child usage to the parent. `packages/observability` is two in-memory files and no usage contract exists. This is a feature (F4), not the open question the cleanup plan frames.

**C12 — The differentiation is not yet a product surface.** Specification §2 defines six separate status axes (execution, evidence, admission, canonical application, retrieval publication, research coverage) and insists they never collapse into one `verified` flag. Today those axes exist as prose and as scattered receipt fields. A fresh consumer (lane E) cannot ask "how confident should I be in this member, and why" and get one typed, replayable answer. F3 makes the assurance object first-class.

## 2. Final feature set

Each feature records: what exists today (observed), what is added, owner, contract or operation names (proposed unless stated), proof gate, and the decision it depends on.

### F1 — Procedures name only implemented verbs (T10)

*Today:* ten skills at `skills/`; `node skills/check.mjs` reads the executor registry, executor MCP, platform `CLI_COMMANDS` and platform MCP tool list. The retrieval skill already names `retrieve run/packet/citations` and `retrieval.replay_citations`, which exist, while `manifest.json` lists four operations for it. Promotion, publication and consumer procedures still describe some host-owned transitions loosely (handoff §6.6).
*Add:* one correctness pass per skill: name only implemented verbs, list every catalog operation the skill owns, keep `absentOperations` honest (`store search`, `space rebuild`, `source inspect/vet`, `document inspect`, `chunk inspect` are declared-unsupported in `apps/cli/src/commands.ts`), regenerate examples from catalogs, sync packs onto the explicit run pin.
*Owner:* `skills/`, `skills/manifest.json`, harness skill-pack sync.
*Proof:* `node skills/check.mjs` and harness `skills:check` green; digests recorded on the pin. This is ledger unit P4.2's first half; acceptance still needs independent review.

### F2 — Research execution contracts

*Today:* `packages/contracts/src` has checkpoints, source discovery, content links, promotion selection, publication, vector store, retrieval and verification schemas. There is no schema for the run input, the operation envelope or the completion receipt that specification §2 names as `ResearchExecutionInput@1`, `OperationEnvelope@1`, `ResearchCompletionReceipt@1`. The P6.2 runner and the P7.2 handoff both need them, and Mission Control's Completion Contract evaluates the receipt.
*Add:* `packages/contracts/src/research-execution.ts` with the three schemas exactly as specification §2 tables them, plus a generator check. `ResearchCompletionReceipt@1` carries per-question coverage against the frozen denominator, artifact manifests, canonical delta and receipts, active publication, retrieval proof, final checkpoint, unresolved items, usage totals (F4) and the assurance summary (F3). Execution outcome and quality disposition remain separate fields, mapped to the seven outcomes in INTERFACES §6.
*Owner:* contracts; validation in application; runner consumes.
*Proof:* schema tests; P6.2 runner rejects any completion candidate that does not validate; `readiness.json` embeds the receipt digest.

### F3 — Evidence assurance packet (the differentiation surface)

*Today:* evidence packets carry claim/run/manifest/admission references, source locators, world/knowledge bounds and contradiction state (T7 official packets exist on `disposable-ks-p5-retrieval`). Report assertions bind run-qualified claim digests. Policy evaluation is replayable (`packages/policy/verification-policy.ts::replayVerificationPolicy`). But there is no single object that states, per evidence member, the six axes and the reason.
*Add:* `EvidenceAssurance@1` in `packages/contracts`: `{ execution, evidence: { captureIntegrity, deterministic, semanticVerdict, authority, provenanceTrust }, admission: { outcome, policyId, policyVersion, intendedUse }, canonicalApplication, publication: { generation, state, revocation }, coverage, temporal: { worldInterval, precision, knowledgeSeq, evaluationCutoff }, explanation: [{ code, stage, evidenceRef }], assuranceDigest }`. Attached to every retrieval evidence member, every report assertion in `report_get`, and the completion receipt as an aggregate (counts per axis value). `explanation` is derived from the sealed policy inputs and deterministic results, never authored by the agent. Provider-attested versus self-reported acquisition and inference versus reported-fact labels are fields, not prose.
*Owner:* contracts; computed in `packages/application` from verification/policy/ingestion receipts; persisted with publication metadata; exposed through the HTTP retrieval path and `report_get`.
*Proof:* lane A R01–R03 assert the object is present and consistent with receipts; lane E asserts a fresh consumer can distinguish inference from reported fact and receive an explicit gap using only this object; F05-style tampering changes `assuranceDigest`.
*Why this is the feature to protect:* it turns "robust verification enforcement" from an internal property into something a consumer, a course generator, and later Mission Control's Proof Gate can read and gate on.

### F4 — Usage and budget ledger

*Today:* `packages/observability` records in-memory `OperationMetric` with `usageTokens` and `costUsd`; skills instruct "unknown usage is unknown, never zero"; Eve divides parent quota across children; fixture §5 pins spend, token and provider-call ceilings; no persisted ledger, no reservation, no unknown marker.
*Add:* `UsageLedger@1`: entries keyed by run/stage/attempt/child/operation with provider, cached versus uncached tokens where available, provider calls, artifact bytes, embedding tokens, spend, and a tri-state `{ known, unknown, reconciledLater }` per quantity. Reservation records for finalization/checkpoint/report capacity. Aggregation math stays in `observability`; storage in `persistence`; the executor exposes a bounded `usage_read` on the run scope; the completion receipt embeds totals. Budget exhaustion produces the durable partial report and a non-passing completion, as the fixture requires.
*Owner:* contracts, observability, persistence, executor.
*Proof:* A02/A03 and budget-exhaustion cases; Eve child usage charged to the parent with descendant telemetry (P4.3/P4.6 evidence); lane C reports known/unknown separately.
*Decision:* D8 (observability stays a small math package; the ledger is stored, not in-memory).

### F5 — Inspection as a first-class executor operation

*Today:* `packages/acquisition/src/inspect/` has read, search and observe over sealed bytes with examples; the executor exposes `verify_read_capture` and `verify_search_capture`; platform `source inspect` is declared unsupported. `docs/operations/internal-fallbacks-and-application-order.md` lists the inspection dimensions that may be recorded.
*Add:* one executor operation `source_inspect` that runs read/search/observe on a sealed capture and registers an `InspectionFindings@1` artifact (identity conflict, declared versus observed media type, redirects, replay integrity, rights observations, secret-class findings without values, extraction-loss notes, node-kind inventory after conversion). Findings are observations, never admission; excerpts are display text, never locators. Platform `source inspect` stays unsupported this release.
*Owner:* acquisition (algorithms), executor knowledge operations, acquisition skill.
*Proof:* the two-inspection loop in the preparation skill uses the recorded findings; S02/S04 cases show findings never change authority.
*Decision:* D3.

### F6 — `knowledge-research-coordination` skill

*Today:* no coordination procedure; the Eve coordinator role and the fixture stage graph describe the behavior; the executor has `checkpoint_*`, `source_*`, `db_*`, `schema_*`, `report_*`, `recovery_*` operations; the run pin is explicit (P4.1 accepted).
*Add:* the long-horizon procedure the cleanup plan called deep research, written as a stage: translate objective to questions and freeze the coverage denominator; database preflight through `knowledge-db`; discovery through provider skills plus `source_discover`/`source_import`/`source_select`; the specification §6 workspace layout with `discovery/` as the bounded scratchpad; when to capture (identity proven, relevance judged, rights known) and when to stop discovering (coverage plan satisfied, budget reserve reached); child assignment and manifest merge per INTERFACES §5; checkpoint triggers per specification §6; completion candidate submission through a new executor operation `completion_submit` that validates `ResearchCompletionReceipt@1` (F2) and registers it as an artifact for the deterministic evaluator. Required new operations: `completion_submit`, `usage_read` (F4), `space_manifest` (F8). Everything else composes existing operations. Mission Control binding is additive: the same receipt becomes the Completion Candidate.
*Owner:* `skills/knowledge-research-coordination/`; executor for the two new operations.
*Proof:* F10 stage conformance in recorded and live modes; lane B stage 1 handoff gate.
*Decision:* D2 (name; retire `knowledge-deep-research`).

### F7 — `knowledge-research-synthesis` skill

*Today:* `report_register`, `report_get`, `report_assess` exist; `research-report.v1` is implemented (DB contract 0.4.0); the ingest skill teaches register → assess → rebind in passing.
*Add:* a dedicated stage procedure: consume admitted manifests only; produce the four required reports (model timeline, product timeline, capability matrix, integrated synthesis) as templates with required sections; derive the assertion ledger from final bytes; bind every substantive span to scoped `(runId, claimId, claimDigest)`; label inference with premises; state gaps and disagreements; register, assess, and rebind after any edit; never omit required questions. Includes the derived-summary rules from specification §3.5.
*Owner:* `skills/knowledge-research-synthesis/`.
*Proof:* F10 conformance; fixture gates on report completeness, factual precision and citation integrity; F10/F11 fault cases.

### F8 — `space_manifest`, profile↔space bindings as data, multi-profile selection

*Today:* see C6. The eight-space enum, DB space tables and `forSpace()` exist; the profile table is prose; preparation picks one profile by `document_kind`.
*Add:* (a) the profile↔space↔node-kind table as a versioned data structure in `chunking`'s registry, the only source the skill and the host both read; (b) `preparation.ts` selects the set `forSpace(space) ∩ observedNodeKinds`, skipping `table-row-groups-v1` without tables, and records the selection in the routing receipt; (c) a bounded executor read `space_manifest` in `db-read` that returns, per tenant: defined spaces, store class, admitted node kinds, profile bindings, active publication generation, reserved and remaining per-space budgets. Naming follows `schema_manifest`.
*Owner:* chunking (data), application/preparation (selection), db-read + executor (read).
*Proof:* multi-profile preview requires `qa.valid` per profile; P03 no over-membership; the preparation skill cites the manifest instead of the prose table.
*Decision:* D4 (home is db-read, because it reads live DB rows; schema-workspace is static).

### F9 — Selection eligibility policy

*Today:* see C5. Membership, budgets and authority are enforced at the host; the *eligibility* rule set of specification §5.1 (raw bytes stored not embedded; faithful sections need admitted relevance plus reconstructable locators; atomic projections need exact admitted claims with temporal and entity links; derived summaries need report admission plus all material dependencies; drafts are exploratory only) is not a function anyone calls.
*Add:* `packages/policy/src/selection-eligibility.ts`: pure `evaluateSelectionEligibility(candidate, context) → { eligible, reasons[], representationKind, diversityGroup, spaceBudgetEffect }` implementing the §5.1 table, source-lineage diversity groups (a summary and its supporting chunks share a group), the T2 settlement (`verified` means policy-admitted; `directly_supported`, `supported_with_qualification`, `derived_verified`, `literal_extraction_verified` promote), and revocation state. Called by the executor selection host before membership enforcement and by the worker; the preparation skill teaches agents to pre-check so proposals stop failing on eligibility.
*Owner:* policy; consumed by application/promotion-selection and the executor host.
*Proof:* P01/P05/P06/R02 reason codes come from this function; no new public operation (`promotion_selection_select` stays absent).
*Decision:* D5.

### F10 — Skill stage contracts and a stage conformance harness

*Today:* `check.mjs` validates command and tool names against catalogs. Nothing runs a skill as a stage with real inputs and checks its exit artifacts. The fixture stage graph (research → reports → ingestion) and Mission Control's Completion Contract both need exactly that.
*Add:* (a) a `stage:` block in each skill's frontmatter: required inputs (artifact types and pins), required outputs (artifact types), required receipts, gates (which deterministic checks must pass), stop rules, and the completion-receipt fields the stage fills; `check.mjs` validates the block against catalogs and artifact types. (b) `skills/stages/` conformance runner: for each skill, a fixture with inputs, a recorded agent transcript (lane A style, fake or recorded judges) and a live mode (lane B style, pinned model), executed against a disposable KS host; it validates outputs, receipts and gates, never narrative bytes. (c) P6.2 reuses the runner for the three producing stages; P7.2 exports the stage blocks as the Mission Control stage completion contracts.
*Owner:* skills, testkit, executor test hosts.
*Proof:* all twelve skills (ten existing plus F6, F7) pass recorded mode before the B/C bundle freezes; live mode results are recorded, not claimed as acceptance.

### F11 — Knowledge outbox events

*Today:* INTERFACES §2.3 proposes a recoverable outbox for externally observed events; the drift outbox exists for verification; Mission Control has Event Wait durable controls but nothing to wait on from KS except polling operation status.
*Add:* `KnowledgeEvent@1` with stable event IDs and reference-only payloads: operation terminal, admission changed, canonical batch committed, publication activated/revoked/rolled back, checkpoint committed, recovery case outcome. Transactionally bound where the write is transactional; consumers deduplicate and can poll receipts after callback loss.
*Owner:* persistence (outbox table only if db-contract cannot express it; propose to db-contract first), application, API.
*Proof:* D03-style loss cases; a Mission Control Event Wait fixture consumes one event end to end in P7.2.

### F12 — Mission Control transfer package

*Today:* MC consumes verification dispatch only (C3). P7.2 requires public schemas, catalogs, the explicit run pin, the completion contract, samples, checkpoints, outcome adapters and retry/cancellation guidance.
*Add:* (a) the surface decision D1 implemented: either the executor HTTP becomes an admitted, authenticated **knowledge host** route with a `KnowledgeClient` namespace for schema/db/ingest/report/source/content/checkpoint/recovery/completion operations, or those operations migrate to the platform API and worker; (b) the outcome adapter table (`succeeded`, `completed_without_admission`, `review_required`, `quality_rejected`, `operation_failed`, `cancelled`, `reconciliation_unresolved`) mapped to MC terminal outcomes (`accepted`, `not_accepted`, `revision_required`, `execution_failed`, `cancelled`, …) with `not_accepted` never retried as `execution_failed`; (c) a Mission Template for the three-stage research graph plus the restore and fresh-consumer proof stages, whose stage completion contracts are the F10 stage blocks; (d) the run-pin export as the Agent Executor Binding input; (e) the completion evaluator as a library MC can call, so acceptance is computed identically in the standalone runner and in MC.
*Owner:* KS (client, evaluator library, template data); MC (template registration, binding) in its own repository.
*Proof:* P7.2 exit: a standalone consumer executes the research capability through public contracts without importing KS internals; one MC Stage Graph fixture runs the template end to end against the same release bundle.
*Decision:* D1.

## 3. Optimizations

### 3.1 Structural

- Keep the cleanup plan's package targets. Add the three omitted consumers to the blast-radius map (C8) and treat `fixtures/openai-pre-mc/*.ts`, `scripts/`, and the research harness as first-class import consumers during every rename.
- Expose the disposable-services test helper through `@aiengineer/knowledge-testkit` so fixture scripts and the harness stop importing `packages/persistence/test/disposable.mjs` and `packages/policy/src` (D9).
- `persistence` at 115 files has 74 `verification-*` files; the `verification-records/` name in the cleanup plan is right. Split it **after** lane A exists (S4), never before.
- The `application` folder move is merge-safe only while `index.ts` is cold. It is hot during T11–T13. Move it in S4, not S1.

### 3.2 Runtime and cost

- Conversion reuse by (bytes digest, configuration digest) with tenant/rights compatibility is already the rule; make the reuse hit visible in the routing receipt so the usage ledger (F4) can credit it.
- Source-diversity grouping (F9) reduces embedding volume before the budget check, not after; the fixture's 25% redundant-document control becomes a measured exclusion, not a quota.
- Keep the semantic batch profile (16 claims, two concurrent batches, flush at source completion) as tunable pins; the stage harness (F10) records throughput per stage so tuning has a baseline.
- Two disposable projects stay: `disposable-ks-p0-p1` for membership/publication proofs, `disposable-ks-p5-retrieval` for schema/retrieval proofs. Do not add a third for cleanup regression; lane A runs on the existing pair.

### 3.3 Verification enforcement

- The assurance object (F3) is computed once at admission and copied, never recomputed by a consumer; revocation updates it through the existing drift/revocation path.
- Recovery stays the only path for unsuccessful outcomes; the coordination skill (F6) routes, it never retries. The ledger already accepts P1.4/P2.5/P4.5; do not reopen them.
- The completion evaluator (F12e) and the stage harness (F10) share one validator so "the agent's final message is a completion candidate" holds identically in fixtures and missions.

### 3.4 Process

- Two tracks with file reservations. **Track K** (fixture-critical, ledger-owned): T10–T14, P5 acceptance, P6.1, P6.2. **Track C** (cleanup and features with blast radius ≤ 7 imports): chunking, documents, acquisition unwiring, F2/F3/F4 contract authoring, F8 data table, F9 policy. Track C never edits a Track K reserved file until G3.
- One coordinator writes the ledger; cleanup phase memos are filed as siblings (`PHASE-<n>-RECOMMENDATION.md`) and cross-reference the ledger units they touch.
- Every step ends with the same three artifacts: review record, lane A rerun receipt (once G3 exists), and skill conformance receipt.

## 4. Consolidated execution sequence

Rule: **nothing scored runs on code that will still move, and nothing high-blast moves without lane A as the regression net.** Each step names what it takes from the cleanup plan (Phase n), the ledger (Pn.n/Tn) and this document (Fn), and the gate that releases the next step.

| Step | Contents | Sources | Gate |
|---|---|---|---|
| **S0 Baseline** | Close the verification refactor review record against `28247e1`; register the six missing skills in `.agent-docs/modules.json` and rebuild the doc map; reconcile the pin narrative to 0.4.14 / `20260916010000` in `IMPLEMENTATION_PLAN.md` §1.2 and the cleanup plan; post file reservations for Track K hot files; record a `pnpm verify` baseline. | Phase 0; C4 | **G0:** verify green, reservations posted, plan documents agree on the pin |
| **S1 Correctness and contracts** (parallel-safe) | F1 skills-from-real-verbs (T10); F2, F3, F4 contract authoring (schemas and tests only); F10a stage frontmatter schema; P6.1 corpus and candidate labels to fixture §3 minima, still `review_required`; Phase 1 low-blast splits only: `chunking`, `documents`, `acquisition` unwired adapters and examples. Not the application folder move. | T10, P6.1; Phase 1 partial; F1–F4, F10a | **G1:** `skills/check.mjs` and harness `skills:check` green; contract tests green; P6.1 minima met |
| **S2 Roles, surfaces, policy** | T11 role catalogs (consumer search/replay real; publisher cannot self-activate); T12 CLI and MCP adapters proved separately; F5 `source_inspect`; F8 `space_manifest` + data table + multi-profile selection; F9 selection eligibility; F4 runtime (`usage_read`, stored ledger); T13 Eve dispatch against a real host; T14 nano/mini slice (P4.4) once D7 sets a spend ceiling; independent review of T4–T7 and T10 → accept P5.1, P5.2, P5.3, P4.2. | T11–T14, P4.4, P5.x; F4, F5, F8, F9 | **G2:** P4.4 and P5.3 accepted by an independent reviewer; T6 re-proof green after the identity write-path |
| **S3 Lane A baseline** | P6.2 `fixture:openai` runner; all 65 cases through public transports on real isolated services; F3 assurance object asserted in R01–R03 and E-precursor packets; label-poisoning R04. | P6.2; F2, F3 | **G3:** lane A green on the unmoved tree. This receipt is the cleanup regression baseline. |
| **S4 Structural cleanup under the net** | Phase 1 remainder (application folder move, diagnostics fold, barrel banners); Phase 2 (`retrieval`, `embeddings`, `vector-backends` with `spaces/`, `projections`); Phase 3 (`application` remaining phases, `persistence` split incl. `verification-records/`, light `contracts` pass, testkit disposable helper for D9). Each phase: explore-and-recommend memo → approval → implementation → review record → **lane A rerun**. | Phases 1–3 | **G4:** lane A green on the final structure; structure frozen; review records filed |
| **S5 Skills as stages** | Phase 4 enhancement of all ten skills; F6 coordination and F7 synthesis skills; F10b/c stage conformance harness in recorded mode for all twelve, live mode recorded where spend allows; pin digests frozen; bundle frozen. | Phase 4; F6, F7, F10 | **G5:** twelve skills pass recorded stage conformance; bundle digest recorded |
| **S6 Scored agent lanes** | P6.3 lane B (three runs each on CLI and MCP); P6.4 lane C live discovery under the ceiling; P6.5 lane E fresh consumer using only published contracts and the F3 assurance object; human gold review binding. | P6.3–P6.5 | **G6:** lanes pass their §8 gates or terminate with explicit `review_required` |
| **S7 Transfer and deployment** | F11 outbox events; F12 transfer package under D1; P7.1 lane D on the identified target; P7.2 handoff with readiness receipt; one Mission Control Stage Graph fixture consuming the template. | P7.1, P7.2; F11, F12 | **G7:** five-lane readiness receipt plus the MC fixture run on the same release bundle |

Parallelism: S1 items are independent of each other and of S2's Track K work except where a file reservation says otherwise. S4 phases are sequential. S6 lanes B and C may interleave; E runs after B. S7 starts after G6 except D1 design, which may start at S2.

What the sequence removes from the older plans: the cleanup plan's Phase 4 no longer includes the correctness pass (moved to S1); the implementation plan's "T10 → T11 → T12 → T13 → T14 → P6.2" order is preserved inside S1–S3; the deep-research skill is renamed and re-homed (F6, S5).

## 5. Decisions required from the developer

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Which surface Mission Control calls for research operations | (a) admit the executor HTTP as an authenticated knowledge-host route and extend `KnowledgeClient` with that namespace; (b) migrate schema/db/ingest/report/source/content/checkpoint/recovery to platform API + worker | (a) for this release; it preserves INTERFACES §1 ("consolidation is shared behavior and parity, not merging processes"). Record (b) as a later ADR. Design may start at S2; implementation is S7. |
| D2 | New skill names | `knowledge-research-coordination` + `knowledge-research-synthesis`; or keep a separate `knowledge-deep-research` | Two skills; retire the deep-research name; the coordination skill's core loop is the deep-research procedure |
| D3 | Inspection surface | executor `source_inspect` now, platform `source inspect` stays unsupported; or admit both | Executor only this release |
| D4 | Home of `space_manifest` | `db-read` + executor operation; or `schema-workspace` | `db-read`; it reads live rows and budgets |
| D5 | Selection policy public surface | pure policy only; or add `promotion select`/`promotion_selection_select` | Pure policy; keep the absent operations absent |
| D6 | Cleanup versus scored lanes ordering | this document's S-sequence (lane A first, cleanup under the net, freeze before B/C); or cleanup after lanes | S-sequence |
| D7 | Spend ceiling for T14 and lane C | operator-set value per provider | Required before S2's T14; no live run without it |
| D8 | `observability` scope | stays a small math package with the stored usage ledger elsewhere; or grows into telemetry infrastructure | Small; F4 storage lives in persistence |
| D9 | Research harness imports of KS internals (`packages/policy/src`, persistence test helper) | record as debt and fix via testkit in S4; or block B until fixed | Record now, fix in S4 Phase 3; do not block S2 |
| D10 | Whether `EvidenceAssurance@1` changes the DB contract | store as publication/projection metadata JSON (no migration); or add typed columns | Metadata JSON first; propose columns to db-contract only if retrieval filters need them |

## 6. What "consolidate and move to Mission Control" means

| Concern | Today | After transfer | Who owns the code |
|---|---|---|---|
| Stage graph orchestrator (research → reports → ingestion, restore, fresh consumer) | standalone fixture runner (P6.2) | Mission Control Mission Template using Stage Graph; stage completion contracts are the F10 stage blocks | MC registers; KS ships the template data and evaluator library |
| Explicit run/child pin | fixture/run manifest (P4.1) | Agent Executor Binding / Profile input | KS exports; MC binds |
| Completion candidate → acceptance | deterministic runner evaluates `ResearchCompletionReceipt@1` | MC computes the Completion Contract using the same evaluator library; `terminal_outcome: accepted` | KS evaluator; MC decision procedure |
| Unsuccessful verification → recovery | durable recovery cases (P4.5 accepted) | Remediation nodes as visible program work; cases stay in KS | KS |
| Checkpoint and continuation | executor `checkpoint_*` | disposable sessions (ADR 0002) restore from KS checkpoints | KS operations; MC session policy |
| Child assignments | Eve scaffold (P4.6 accepted) | Swarm members / child activations with grants | harness adapter; MC governors |
| Budgets and grants across nodes | fixture pins + F4 ledger | MC governors read the F4 ledger; KS keeps per-operation accounting | both |
| Capability catalog and intake | deferred (plan §1.1) | MC coordinator skill and missions intake | MC, later |
| Everything else: acquisition, conversion, chunking, verification, admission, ingestion, reports, content links, selection, publication, retrieval, evaluation, schema workspace | KS | KS | KS |

Nothing in the last row moves. Consolidation inside KS means one application behavior behind two distributions with tested parity, not one process.

## 7. How this specification is proven done

| Feature | Proof artifact | Lane or gate |
|---|---|---|
| F1 | conformance receipts, pin digests | G1 |
| F2 | schema tests; runner rejection of invalid candidates | G1, G3 |
| F3 | assurance object present and consistent on packets, report assertions, receipts | G3 (R01–R03), G6 (lane E) |
| F4 | stored ledger; A02/A03; child usage charged to parent; known/unknown reported | G2, G6 (lane C) |
| F5 | findings artifact; S02/S04 | G2 |
| F6, F7 | recorded stage conformance; lane B stage handoffs | G5, G6 |
| F8 | multi-profile preview with `qa.valid`; manifest read | G2 |
| F9 | reason codes on P01/P05/P06/R02 | G2, G3 |
| F10 | twelve skills pass recorded mode | G5 |
| F11 | one event consumed by an MC Event Wait fixture | G7 |
| F12 | standalone public-contract consumer; MC template fixture | G7 |

A passing check, a listed operation name or a filed memo is not proof. Each row above needs the named artifact on the named gate.
