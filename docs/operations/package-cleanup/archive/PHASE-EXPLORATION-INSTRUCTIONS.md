---
status: proposed
owner: knowledge-services
created: 2026-09-19
---

# Phase exploration and recommendation instructions

This is an operating instruction for running each phase of `SEQUENCED-CLEANUP-PLAN.md`. It exists because naming, folder structure, and feature scope should be decided by the developer, not silently implemented by an agent. Every phase runs an **explore-and-recommend** pass before any code changes and ends in a written recommendation memo.

## Developer override in force (2026-09-19)

The developer has pre-approved the memo recommendations for the remaining phases (`docs/operations/code-quality-and-delivery-process.md` §"Main-developer override": an explicit instruction is sufficient; do not ask again). What changes:

1. **No approval wait.** Write the phase memo as the record, then implement it in the same session. Where the memo offers options, take its own recommendation. The developer reviews after the fact by reading the memo, the result files and the diff; a rejection reopens the unit.
2. **Still required:** the memo itself (naming and scope must be written down before code moves), one result file per implementation unit, coordinator re-verification of every result, the gates that protect the shared sequence (`FEATURE-SET-SPECIFICATION.md` §3.4 reserved files before G3; lane A rerun after each S4 phase; disposable-only proofs; never the populated database), and honest verify reporting.
3. **Speed.** Implementation units with disjoint file reservations may run in parallel subagents up to the four-agent cap in `ORCHESTRATION-PLAN.md` §2; exploration stays a single agent reading directly (ground rule 1). Phase memos may be written by the same session that implements them.
4. **`apps/` is in scope.** `apps/api`, `apps/cli`, `apps/mcp`, `apps/worker` and `apps/verification-executor` are cleanup targets, not only consumers. Each phase memo covers the app modules that consume the packages it touches (transport handlers, worker activities, executor hosts), and Phase 3 owns the apps' own structure (folder order, barrels, tests beside code, examples, review records), since the transports must move together with `application` subpaths. Record any app change against the ADR 0004 call-graph rule (in-process servers call `application`; out-of-process callers use the client).

The two paragraphs below describe the pre-override process and remain the fallback if the developer withdraws the override.

## Ground rules for every phase

1. **One agent, working directly.** Read source files, `AGENTS.md`s, and the relevant sections of `SEQUENCED-CLEANUP-PLAN.md` yourself with Read/Grep/Bash. Do not spawn further sub-agents or background forks to do the reading for you — a prior pass on this exact plan lost two of five delegated research forks to silent failures, and the fix is not delegating that layer at all, not delegating it more carefully.
2. **No implementation during exploration.** Do not rename files, move code, create packages, or edit skill manifests during this pass. The deliverable is a memo, not a diff.
3. **Verify, don't just copy.** `SEQUENCED-CLEANUP-PLAN.md` §4–§6 already contains candidate names and structures from the 2026-09-19 survey. Treat them as a starting hypothesis, not the answer — read the actual current files before endorsing, revising, or rejecting each candidate.
4. **Ground features in what's already true.** New capabilities (the deep-research skill, the promotion policy engine, the space registry) should cite the existing operation IDs, contract files, or `absentOperations` entries that motivate them. Don't invent product scope beyond what the developer described.
5. **Surface open questions instead of guessing.** Where the plan flags a developer decision (e.g., whether `observability` is intentionally thin, where ephemeral research storage lives), present the options and a recommendation — do not silently pick one and move on.
6. **One memo per phase**, in the format in §2, appended to this file or filed as a sibling doc (`PHASE-<n>-RECOMMENDATION.md`) — developer's call which.

## Phase order

```
Phase 0 — baseline and doc hygiene
Phase 1 — acquisition, research-coordination skill design, conversion, chunking, documents, application folders
Phase 2 — retrieval, embeddings, vector-backends, spaces, projections, selection eligibility policy
Phase 3 — application (remaining), persistence, contracts, and the apps' own structure (api, cli, mcp, worker, verification-executor)
Phase 4 — full skill refresh
```

Each phase must be approved before the next phase's exploration starts, since later phases build on naming decisions made earlier (e.g., Phase 2's `spaces/` naming depends on what Phase 1 confirms about the workspace layout the coordination skill uses).

**Where each phase sits in the merged sequence (added 2026-09-19).** `FEATURE-SET-SPECIFICATION.md` §4 places these phases inside steps S0–S7 alongside the implementation ledger. In short: Phase 0 is S0; Phase 1's low-blast splits (chunking, documents, acquisition unwiring) may run in S1, but its application folder move waits for S4 because `application/src/index.ts` is hot during T11–T13; Phases 2 and 3 run in S4 only after lane A (S3) exists as the regression net; Phase 4 is S5 and includes the two new skills (F6, F7) and the stage conformance harness (F10). Each phase memo must name the feature IDs (F1–F12) and developer decisions (D1–D10) it touches, and must not edit a Track K reserved file (see that document's §3.4) before gate G3.

## Phase 0 — baseline and doc hygiene

**Explore:** current `git status`/`git log` state of `ai-engineer-knowledge-services`; `docs/operations/reviews/verification.md`; `skills/manifest.json` vs. `.agent-docs/modules.json` vs. `skills/AGENTS.md`'s generated table.

**Reason about and recommend:**
- How to record the verification refactor as a closed baseline (commit message, review-doc update, or both) without sweeping unrelated in-flight changes into it.
- The exact `.agent-docs/modules.json` entries needed to register the 5 currently-missing skills (`knowledge-acquisition-and-vetting`, `knowledge-preparation-and-promotion`, `knowledge-retrieval-and-evidence`, `knowledge-evaluation`, `knowledge-verification-recovery`, `vector-store-management` — confirm the exact list against current disk state, it may have changed).

**Deliverable:** a short memo — proposed commit/baseline approach, proposed doc-registration diff (described, not applied), any discrepancies found versus the 2026-09-19 survey.

## Phase 1 — acquisition, deep-research skill, conversion, chunking, documents, application folders

**Explore:** `packages/acquisition/src`, `packages/chunking/src`, `packages/documents/src`, `packages/conversion/src` and its `examples/`, `packages/application/src` (full directory listing plus `index.ts`), `skills/knowledge-acquisition-and-vetting/SKILL.md`, `skills/knowledge-preparation-and-promotion/SKILL.md`, `skills/manifest.json` entries for both, and the provider-composition framing (Firecrawl/Tavily/vendor MCP position relative to Knowledge Services) wherever it's currently documented.

**Reason about and recommend:**
- Confirm or revise the proposed `chunking` split (`profiles/`, `chunker/`, `qa/`) and `documents` split (`nodes/`, `locators/`) against the actual current file contents — are these genuinely separable concerns, or does the current single file already read cleanly at its size?
- Confirm or revise the `application` folder-banner proposal and the `diagnostics/` → `verification/diagnostics/` fold; check for any consumer that imports `diagnostics/*` by its current path that would need a compatible export.
- Design the **research-coordination skill** (F6 in `FEATURE-SET-SPECIFICATION.md`; the deep-research idea lives inside it) in detail: confirm the skill id `knowledge-research-coordination` (decision D2), use the specification §6 workspace layout rather than a new scratchpad convention (C7), decide whether `discovery/` artifacts get a distinct blob-storage class or stay filesystem-only until checkpointed, decide the skill's surfaces (`executor-cli`/`executor-mcp`/`platform-cli`), and describe — in plain terms, not code — how it composes external search MCP tools, the workspace, `source_discover`/`source_import`/`source_select`, child assignments and checkpoints into one coherent long-horizon research procedure. Name the operations it needs that don't exist yet (F6 lists `completion_submit`, `usage_read`, `space_manifest`); do not invent others without a feature ID.
- Assess whether inspection becomes the executor operation `source_inspect` in this phase (F5, decision D3) while platform `source inspect` stays unsupported, and why.

**Deliverable:** a memo covering (a) confirmed/revised folder and file names for the four packages, (b) the deep-research skill design with concrete names, directory conventions, and required new/reused operations, (c) the `application` banner and diagnostics-fold plan with any consumer-impact notes, (d) open questions.

## Phase 2 — retrieval, embeddings, vector-backends, spaces, projections, promotion policy

**Explore:** `packages/retrieval/src/index.ts` in full, `packages/embeddings/src/index.ts`, `packages/vector-backends/src` (all files), `packages/projections/src/index.ts`, `packages/contracts/src/spaces.ts` and `vector-store.ts`, `packages/policy/src`, `skills/vector-store-management/SKILL.md` and its `absentOperations`, `skills/knowledge-preparation-and-promotion/SKILL.md`'s `absentOperations`, and how `schema-workspace`/`db-read` currently expose manifests (for the `space_manifest` naming precedent).

**Reason about and recommend:**
- Confirm or revise the `retrieval` split into `plan/`, `lexical/`, `semantic/`, `graph/`, `rerank/`, `spaces/` — check whether the current 863-line file's actual seams match this cut, or whether the real boundaries fall differently.
- Confirm or revise `vector-backends`' `backends/`, `publication/`, `spaces/` split, and decide the exact shape of `spaces/registry.ts`, `spaces/link.ts`, `spaces/version.ts` (or better names) — what fields does a space definition need, what does the entity-link record look like at a conceptual level.
- Decide where `space_manifest` (or a better-named bounded read operation) belongs: `schema-workspace` or `db-read`, and why.
- Design the promotion policy engine's decision inputs and outputs in `packages/policy` — what does "promote this source" actually mean as a policy decision (inputs: verified assertions, report quality, cost/budget signals?; output: a promotion grant feeding `application/promotion-selection/`).
- Flag explicitly if the embedding-to-structured-entity relational linkage requires a cross-repo proposal to `ai-engineer-db-contract` rather than living entirely in `vector-backends`.
- Judge whether `embeddings` and `projections` warrant folder splits at their current size or just reformatting + examples.

**Deliverable:** a memo with confirmed/revised names for all five packages' internal structure, a concrete space-registry and promotion-policy design (still no code), the `space_manifest` placement decision, and a flagged list of anything that needs `ai-engineer-db-contract` involvement.

## Phase 3 — application (remaining), persistence, contracts

**Explore:** `packages/application/src` post-Phase-1 state, `packages/persistence/src` (all files, or a representative sample per subgroup), `packages/contracts/src` directory listing, and every place `persistence` imports `application` implementations directly (not just ports).

**Reason about and recommend:**
- Confirm or revise the `persistence` split (`postgres/`, `storage/`, `ledger/`, `runtime/`, `verification-records/`) and the `verification-records/` naming rationale (avoiding collision with the `@aiengineer/knowledge-verification` algorithm package).
- Concrete migration plan for making `persistence`'s application imports type-only, and what breaks if done in the wrong order relative to the application folder move.
- Whether `contracts` domain-bucketing is worth doing now or stays deferred; if worth doing, propose bucket names.
- Answer or scope the `observability` open question (2 files vs. its stated responsibility) — present options, recommend one, do not assume.

**Deliverable:** a memo with confirmed/revised names for `persistence`, the type-only-import migration plan, a contracts bucketing recommendation (or explicit deferral), and the observability recommendation with rationale.

## Phase 4 — full skill refresh

**Explore:** all 9 existing `skills/*/SKILL.md` plus the new deep-research skill's Phase-1 design, `docs/operations/code-quality-and-delivery-process.md` §6 (skill enhancement checklist), and `node skills/check.mjs`'s actual coverage.

**Reason about and recommend:**
- Per skill, what's missing against the §6 checklist (task context, decision points, references, worked normal/failure examples) — this can be a short table, not a full rewrite yet.
- Sequencing within the phase: which skills are safe to refresh in parallel vs. which share references and should move together.

**Deliverable:** a per-skill gap table and a proposed refresh order.

## After each memo

The developer reviews the memo, approves/edits/rejects each naming and feature recommendation, and only then does implementation for that phase begin — as its own change, following the module-review and delivery-workflow steps in `docs/operations/code-quality-and-delivery-process.md`.
