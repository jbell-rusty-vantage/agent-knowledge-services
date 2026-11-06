> **Status (2026-09-19):** superseded. The refactor this document recommended was implemented on 2026-09-19 (see the package [README](../README.md) for the current layout, sequence and invariants). Retained for history; file paths and symbol names below refer to the pre-refactor tree and are not updated.

# Final verification clean-code implementation plan

**Authority:** this document replaces the previous contents of `CLEAN-CODE-RECOMMENDATION.md` and supersedes conflicting recommendations in the companion documents. Updated 2026-09-11. This is an implementation specification; writing it has not implemented the refactor.

**Objective:** make verification readable as a sequence of named operations, expose intentional interfaces, and make tests prove clearly named behavior.

## 1. Agent handoff and document roles

When assigned to implement this plan, complete phases 0–7 below. Integrate tests with each subsystem change. Revalidate the current source first and preserve unrelated working-tree edits. Continue through routine naming, placement and test decisions without a per-phase approval ceremony.

| Document | Role |
| --- | --- |
| This file | Authoritative scope, decisions, implementation order and completion criteria. |
| [COMPREHENSION.md](COMPREHENSION.md) | Current interfaces and agent call sequences; update to the final implementation. |
| [CLEAN-TESTING-RECOMMENDATION.md](CLEAN-TESTING-RECOMMENDATION.md) | Detailed test-quality findings, examples and names, incorporated subject to this plan. |
| [TESTING-COMPREHENSION.md](TESTING-COMPREHENSION.md) | Current test map and interpretation; update when tests move. |

Read the workspace's clean-general, clean-functions, clean-names and clean-tests skills. Apply one responsibility per operation, meaningful names, bounded argument lists and one behavioral concept per test. Prefer exhaustive TypeScript unions, switches or tables over unnecessary class hierarchies. Do not split clear expressions just to increase the function count.

### Ready-to-use implementation prompt

> Implement packages/verification/CLEAN-CODE-RECOMMENDATION.md in ai-engineer-knowledge-services. Treat it as the authoritative plan, with its linked testing recommendation supplying detailed test requirements. Complete phases 0–7, preserve unrelated edits and retained verification behavior, and defer the explicitly listed product changes. Keep the comprehension documents current. Finish with verified results, an API migration map and any specifically identified deferred prototype/experiment caller failures. Do not stop after planning or after only the first phase.

This prompt is for the future implementing agent. The present task only creates the plan.

## 2. Scope and settled decisions

### Included

- Production algorithms, local interfaces, ports and exports in `packages/verification/src`.
- Their tests, including production assertions currently using prototype-named fixtures.
- Verification-related contract tests whose proofs need strengthening, especially public audit inspection validation.
- Minimal production caller/type updates in this repository required by intentional local API changes. Executor/application/worker production composition is included for these updates, not workflow redesign.
- Test tooling, necessary dependency builds and documentation.
- A maintained usage-sequence file and an API migration map.

### Deferred

- Prototype compatibility algorithm cleanup and prototype/experiment caller migration.
- Benchmark/experiment execution redesign, database migrations, deployment, live model evaluation and new product capabilities.
- Product semantics changes listed in section 4.

Benchmark publication integrity helpers remain in scope for shared mechanical cleanup and signature regression coverage. That does not expand the task into benchmark orchestration.

| Topic | Implementation decision |
| --- | --- |
| Public API | Replace wildcard exports with explicit exports from owning files. Do not add a `public-api.ts` forwarding layer. Keep names that are already clear; rename deliberately where meaning is hidden. |
| Compatibility | Local names and parameter shapes may change. Do not build compatibility layers solely for deferred prototype/experiment callers. Document their migration needs. |
| Serialized contracts | Preserve wire/retained fields, versions, check/error codes, verdicts, hashes and signature projections. A clearer local API does not require a wire rename. |
| Types | Colocate operation inputs/results with their operation. Keep genuinely shared audit contracts/ports in `provenance/model.ts`. No package-wide `types.ts`. |
| Shared functions | One named capability file when actual consumers share the same meaning. No `utils.ts`, `helpers.ts`, `lib.ts` or catch-all internal barrel. |
| Schema admission | Use a discriminated local result: success always contains its admitted schema. Preserve canonical snapshots and private process-local compiled bindings. |
| Semantic authorization | Keep runtime authorization and its unforgeable object association. Replace the four positional parameters of `authorizeSemanticCase` with a named input object and update production callers. |
| Result vocabulary | Keep schema validity, mechanical status, semantic disposition, authority and policy admission distinct. Do not call aggregation “sealing.” |
| Report summaries | Distinguish mechanical preparation from assessed summaries in local names/types and docs; preserve serialized shape and calculation behavior. |
| Source authority | Preserve the current at-least-one qualifying independent-family threshold. Explain it; do not change it into a quorum. |
| Test style | One behavior per test. Multiple assertions may jointly establish that behavior, including proving an action did not occur. |
| Coverage | Add the matching optional coverage provider and production-source inclusion configuration during implementation. Inspect branch gaps; no arbitrary percentage target. |

Keeping existing legacy exports explicitly is acceptable when it costs nothing and exposes no new internals. Removing them is not a prerequisite for a clear production facade. Compatibility work must not become the project.

## 3. Invariants to preserve

| Invariant | Required evidence |
| --- | --- |
| Capture/projection bytes match registered digests and lengths. | Valid control plus corruption cases, including changed bytes of the same length. |
| Selector definitions and selected bytes remain bound. | Exact selection expectations and dishonest-resolver rejection. |
| Earlier deterministic failure cannot become semantic/policy success. | Closed-gate result plus no judge call; report gates preserve earlier failure. |
| Runtime composition owns producer/verifier identity. | Runtime/declaration mismatch and non-independent deployment cases. |
| Judges receive only authorized evidence. | Exact input-envelope assertions, not just call counts. |
| Canonicalization, arithmetic, ordering and retained digests stay stable. | Independent byte/numeric expectations and existing production golden results. |
| Accepted leaves use one verified selection pass. | A resolver whose second response would differ; one call and first-selection custody. |
| Admission and request persistence precede provider dispatch. | Boundary trace and failures that prevent fetch. |
| Response/status retention is separate from interpretation. | HTTP success with invalid output, HTTP failure with success-looking output, persistence failure. |
| Artifact authorization immediately precedes corresponding hydration. | Interaction trace and authorization denial preventing hydration. |
| Replay reproduces retained mechanics, semantics and policy. | Separate deterministic, semantic, artifact-binding and policy-drift cases. |
| Unsigned integrity differs from verified signature authority. | Signature status assertions and actual Ed25519 tests. |

Never refresh a golden digest merely because moving code made it fail. Determine whether bytes, ordering, errors or meaning changed. Do not weaken a test to accommodate a regression.

## 4. Product questions excluded from cleanup

The default actions are settled here so these questions do not block independent work.

| Question | Action during implementation |
| --- | --- |
| Missing report evidence currently reaches a non-null assumption. | Characterize and preserve the existing precondition failure. Do not substitute a mechanical “missing” verdict. Record explicit validation/error semantics as a follow-up. |
| Report coverage is producer-declared assertions only. | Preserve and document it; no new model-based discovery or factual-recall claim. |
| Executor report check uses the first evidence edge for a cited claim. | Document; defer multi-evidence aggregation. |
| Corroboration can be satisfied by one qualifying family. | Preserve, document and test the threshold. |
| Rescue budgets permit more than the current one search call. | Preserve one call and pending-mechanical-admission status; no retries/search expansion. |
| Review reasons alone do not change report mechanical status. | Preserve and directly test this distinction. |
| Request schema accepts more than runtime capability admission. | Document/test the separate boundaries; do not broaden admission. |
| Retained result names could be clearer. | Improve local naming without changing wire fields. Defer versioned contract redesign. |

If a stronger test exposes a pre-existing invariant violation, record the smallest reproducer and distinguish it from your refactor. Continue independent phases. Do not claim completion while a mandatory invariant is known to fail. Historical-format migration or new product semantics require a separate explicit decision, not a silent cleanup patch.

## 5. Implementation phases

### Phase 0 — Baseline and ownership

1. Read applicable workspace/repository instructions and inspect `git status` plus existing diffs.
2. Reconcile this plan with current code. Earlier review: 110 verification tests and 85 contracts tests passed. Those are historical counts, not today's guarantee. Several provider/prototype files already contained unrelated edits.
3. Inventory actual exports and their consumers; distinguish production from deferred prototype/experiment callers.
4. Run verification/contracts tests and relevant package typechecks. Record pre-existing failures. Check whether package imports resolve built `dist` exports and rebuild dependencies before downstream validation after changing them.
5. Strengthen tests before refactoring each subsystem. Phase 1 can proceed subsystem by subsystem; every test move need not precede every code change.

**Exit:** a recorded baseline, preserved existing edits and a clear distinction between regressions, stale builds and deferred callers.

### Phase 1 — Trustworthy test names and proofs

Implement the six findings in [testing recommendation section 3](CLEAN-TESTING-RECOMMENDATION.md#3-first-priority-make-each-test-prove-its-stated-claim):

1. Start from a valid public audit resource, add only a forbidden storage field, and prove rejection for that field.
2. Inspect the exact judge input for evidence isolation, separately from confidence semantics.
3. Include admission, request persistence, fetch and response retention in provider traces; prove earlier failures prevent the next action.
4. Reject a resolver whose claimed digest disagrees with returned bytes.
5. Prove accepted leaves retain one authoritative selection even when another resolution would differ.
6. Test correctly signed but wrong DSSE subject/dependency bindings separately from invalid signatures.

Split compound tests into independently named behaviors. Use `describe` for the operation and `it` for outcome plus condition. Parameterize cases sharing one rule; avoid a large switch over unrelated arrangements. Build a fresh valid fixture and change one relevant fact in each negative case.

Use precise failure codes/statuses/paths and verify an earlier unrelated gate did not explain rejection. For hash checks, use equal-length byte corruption. For inner lineage/policy bindings, recompute fixture hashes where appropriate so the inner rule is reached.

Rename fixture helpers to disclose defaults and effects. Require a separate source in tests claiming evidence support. Keep actual crypto and real core composition when those interactions are the subject. Do not mock the algorithm being proved or assert private helper calls.

Move decomposition/report/authority cases from `semantic/diagnostics.test.ts` to their owners. Split dense deterministic, extraction and provenance files by operation where useful. Preserve the behavior matrix, not the test count.

**Exit:** titles match assertions, negative tests reach their intended gates, and existing guarantees remain represented.

### Phase 2 — Explicit facade and justified shared capabilities

Replace wildcard exports in the root and relevant submodule indexes with explicit operations, ports and intentional contract pass-throughs. Export from owners; no extra forwarding layer. Keep package-private selection internals and test helpers off the root facade.

Review duplication before extracting:

| Candidate | Rule |
| --- | --- |
| Deep freeze | Share only matching recursion/ownership behavior. Replace the undeclared `knowledge-domain` import in benchmark publication with the local capability; do not add that dependency for freezing. |
| JSON Pointer | Share traversal only when token/index/missing-property/depth behavior matches. Keep selected-value encoding and domain errors at callers. |
| Text search | Share identical occurrence search where production consumers need it. Prototype-only duplication does not justify expanding scope. |
| JSON preflight | Verify cycles, repeated references, budgets and failure precedence before sharing a walker. Keep domain limits/errors local. |
| Raw hash wrappers | Replace duplicate SHA-256 implementation with `sha256Digest` after checking bytes/prefix parity. |
| Unicode offsets | Share only after proving identical surrogate/coordinate behavior; otherwise retain explicit local implementations. |

Create `internal/freeze.ts`, `internal/json-pointer.ts` or another named capability only when justified by actual use. Do not create a speculative kernel or move domain behavior into generic helpers. Record why similar functions remain separate if their encodings/errors differ.

**Exit:** intentional imports, no undeclared shared-helper dependency, no altered observable bytes/errors.

### Phase 3 — Deterministic verification and selectors

Refactor `verifyDeterministicBundle` into readable stages:

```text
parse bundle
  → index hydrated artifacts and duplicate identities
  → verify captures and projection bindings
  → establish runtime principal separation
  → verify assertions and evidence
  → verify metric dependencies and exact calculations
  → build deterministic result
```

Helper names are an implementation choice; procedure and meaning are not. Keep named context objects small. Do not replace many parameters with one giant mutable object containing every phase's state. Prefer returned checks/results; explicitly name any local collection mutation.

Keep cycle detection, operand binding, exact arithmetic and aggregation order visible. Use `buildDeterministicResult`, not `sealDeterministicResult`, for aggregation without signing. Keep simple canonical/hash/fraction functions simple.

In selector parsing, replace `any` with narrowed `unknown`, use the projection discriminated union, and replace long positional helper calls with named inputs. Unfold dense HTML/PDF/table/media procedures without adding a general CSS/XPath engine or new selector kinds.

**Tests:** captures, projection lineage, principals, metric graph failures, independent numeric expectations, Unicode/CRLF/offset boundaries, ambiguity/overlap, dishonest resolvers and resource limits.

**Exit:** a reader can narrate the engine without unpacking nested expressions; retained deterministic expectations are unchanged.

### Phase 4 — Schema admission and extraction evidence

Make `ExtractionSchemaAdmission` a local discriminated result whose successful branch always carries `schema`. Preserve runtime result properties, canonical snapshot and private admitted-object/compiled-node association. Explain that deserializing its snapshot does not recreate runtime admission.

Split schema parsing into object, array and scalar admission. Preserve descriptions, subset restrictions, null/absence behavior, limits and error precedence.

Refactor fields into:

```text
validate work limits and candidate
  → index rules, evidence and representations
  → verify representation and resolve each field once
  → compare selected scalar under its declared rule
  → check duplicates and replay totals
  → build field result and optional immutable accepted leaves
```

Use an exhaustive comparison table or switch with named comparators. Preserve explicit source components; locator metadata is never a field value. Keep `verifyExtractionFields` and `verifyExtractionFieldsWithEvidence` as alternative entry points over the same pass, not sequential requirements.

Keep accepted leaves all-or-none, retain raw values/computation metadata and leave registered parser lineage/persistence in application composition.

**Tests:** admission discriminant/runtime binding, exact/normalized/null values, independent source bytes, all-or-none evidence, post-call input mutation, single selection, duplicate/total rules and work limits. Split the current large leaf test into separate promises.

**Exit:** types explain admission, comparisons are independently readable, evidence adds no second resolution.

### Phase 5 — Claims, authority, semantics and providers

**Claims/report:** preserve readable decomposition logic and colocate its tests. Distinguish mechanical report preparation from summaries using actual semantic assessments in local names/types. Preserve serialized fields. Share consistency grouping only where it represents the same rule. Apply section 4's coverage/missing-edge decisions.

**Authority/rescue/attribution:** keep these separate from semantic support and policy admission. Clarify the corroboration threshold and single rescue call. Do not replace readable authority logic with a complex predicate framework.

**Semantics:** keep `verifyAssertionSemantics` as mechanical closure → runtime authorization → execution. Retain separate authorization/execution for staged workflows. Convert authorization to a named input object. Preserve brand/WeakSet enforcement, fragment hashes, blinded evidence, empty tool capabilities and trusted adapter identity.

Extract verdict-specific output guards without changing the lattice. Make execution read: snapshot adapters → primary judgment → required independent second judgment → reconcile. Family and deployment independence are both required. Provider confidence remains uncalibrated.

**Providers:** name admission, request retention, dispatch, raw retention and interpretation stages. Keep vendor-specific semantics separate. Preserve HTTP status, accounting/model observations, Interfaze policy headers/precontext behavior and cancellation/deadline handling. Add no automatic retry path. Preserve existing ownership/snapshot guarantees across awaits.

**Tests:** direct report-gate cases; mechanical summaries leave semantics unassessed; source authority boundaries; fragment authorization; exact judge envelope; same-family/same-deployment distinctions; critical risk with missing second judge; unnecessary optional judge not called; provider admission/persistence failures.

**Exit:** trust transitions and effects are visible; no stage impersonates full policy admission.

### Phase 6 — Provenance, inspection and replay

Keep shared audit contracts/ports in `provenance/model.ts`. Preserve detached payloads and signature optionality. Share only identical policy/artifact checks between sealing and inspection, preserving their different failure-reporting behavior.

Make lineage validation read as handle indexing → parent/edge checks → closure → cycle rejection. Keep building, sealing, inspecting and replaying distinct.

```text
inspect audit
  → authorize and hydrate each retained artifact as a pair
  → replay deterministic checks and report gates
  → validate retained policy inputs
  → reconstruct recorded semantics when required
  → replay policy
  → compare outcomes/digests
```

Do not authorize multiple artifacts in advance of their individual hydration. Keep retained semantic replay separate from fresh model judgment. Preserve public error sanitization and unsigned-versus-verified status.

**Tests:** coherent successful seal/replay path; authorization denial; equal-length changed bytes; deterministic/policy/semantic drift; signed-but-wrong DSSE bindings; builder/key identity; actual crypto and ownership across awaits.

**Exit:** procedures are readable and tests isolate each integrity gate.

### Phase 7 — Validation, documentation and handoff

1. Add the coverage provider matching the installed Vitest version (previous snapshot: 4.1.11). Include production files even if unimported by tests; exclude fixtures/tests from coverage metrics and identify prototype exclusions explicitly. Inspect critical uncovered branches rather than chasing a percentage.
2. Remove `--passWithNoTests` from the established contracts test script so lost discovery fails. Add no brittle per-test wall-clock threshold.
3. Run focused tests, full verification/contracts tests, typechecks and builds, rebuilding dependencies before downstream checks. Run impacted production consumer checks. Do not run unrelated live proof suites.
4. Perform targeted mutation checks in an isolated/reversible context: bypass digest validation, reopen a semantic gate, admit a forged case, allow same-deployment second judgment, bypass persistence-before-dispatch. Record the named test that detects each mutation and restore all mutations. No new mutation framework is required.
5. Add `USAGE-SEQUENCE.md` beside this plan. Include a complete small local extraction example and an explicitly illustrative trusted claims/report sequence, identifying outer ports/registered inputs, failed gates and expected outputs. Keep it outside the public source facade. Execute the self-contained example against source without live services.
6. Update both comprehension guides and their links/maps. Mark implemented recommendations and keep deferred behavior changes distinct. Link the usage file from the README and module guide.
7. Add an API migration table here or in a linked implementation record: old symbol/signature → new symbol/signature → updated production callers → deferred callers. Distinguish local API changes from preserved wire contracts.

**Exit:** completion criteria below are met and the final code/tests can be followed from the documentation.

## 6. Commands and failure handling

From the repository root:

```powershell
corepack.cmd pnpm --filter @aiengineer/knowledge-verification test
corepack.cmd pnpm --filter @aiengineer/knowledge-contracts test
corepack.cmd pnpm --filter @aiengineer/knowledge-verification typecheck
corepack.cmd pnpm --filter @aiengineer/knowledge-contracts typecheck
corepack.cmd pnpm --filter @aiengineer/knowledge-verification build
corepack.cmd pnpm --filter @aiengineer/knowledge-contracts build

# After installing/configuring the matching optional coverage provider:
corepack.cmd pnpm --filter @aiengineer/knowledge-verification exec vitest run --coverage
```

This is a command inventory, not a required build order. Build contracts and other dependencies before downstream checks consuming their `dist` exports. Contracts build may regenerate artifacts; inspect those diffs. Readability changes must not cause unintended wire-schema changes.

Classify failures as pre-existing, stale build, regression or explicitly deferred caller migration. Fix regressions and production caller failures. Never hide a test or broaden a skip pattern to get green results. If only deferred prototype/experiment callers fail, report the full command as failing, list exact affected cases and report passing production checks separately.

Keep temporary probes/mutations out of the final diff. If coverage or another mandatory check is blocked, state the concrete blocker; do not mark that check successful.

## 7. Completion criteria

- [ ] Explicit facade with intentional operations, ports and contract pass-throughs; private internals remain private.
- [ ] Deterministic, extraction, semantic/provider and provenance entry points read as coherent named sequences.
- [ ] Local admission/authorization types explain their preconditions without weakening runtime trust.
- [ ] Shared mechanics have justified homes; different encodings/errors remain distinct.
- [ ] Retained bytes, check codes, verdicts, policy ownership and effect ordering remain unchanged.
- [ ] Six assertion-quality findings have focused proofs or a source-based explanation of equivalent existing coverage.
- [ ] Claims/report/authority tests are discoverable beside owners, with useful names and independent fixtures.
- [ ] Boundary compositions, real crypto and critical regression cases remain; no tests merely mirror extracted helpers.
- [ ] Mandatory checks pass, or exact pre-existing/deferred/environmental failures are disclosed without concealing new production regressions.
- [ ] Coverage gaps were inspected and critical mutation checks recorded.
- [ ] Usage example is validated, comprehension guides reflect final code, and API migration map is complete.

The final implementation report must state what changed and why, actual commands/results, any retained-behavior discrepancy, migration-map location and deferred items. Do not declare the whole plan implemented while a mandatory phase remains unfinished. Deployment, publishing and database work are not implied.
