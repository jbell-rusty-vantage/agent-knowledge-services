# Knowledge admission and recovery

Implemented P0/P1 boundary, September 2026. These are local contracts and guarded disposable-service proofs. Deployment, durable recovery cases, remote custody and the full research acceptance fixture remain separate work.

## Evidence and effects

Local CLI, HTTP and MCP compose the same authoritative verification-store oracle. Missing verifier, tenant mismatch and declared-oracle configuration reject before database initialization. Admission checks registered artifact bytes and lineage, exact claims, required deterministic/semantic results, replayed policy decision, policy version and host-authorized definition digest, tenant and downstream use. The default tenant matches the verification executor; explicit conflicting settings reject.

Canonical effects require evidence; `candidate.stage` remains non-admission staging. `claim.materialize` uses authoritative statement/type/qualifiers/entity bindings, and optional inline copies must match. Unknown/new claim subjects hold or reject before writes. Dependency holds propagate transitively while complete independent groups can apply.

Each effect claim declares its downstream use, such as `knowledge_ingestion:fact.assert_state` and `knowledge_ingestion:claim.materialize`. Its proposition/qualifiers exactly match the proposal. Its scalar `value` is the canonical JSON string returned by `proposalEffect`: `{effect, subjects}`, where `effect` is the parsed effective proposal excluding `proposalId`, `evidence`, `dependsOn`, `rationale`, `reportBinding`, `proposition`, and `qualifiers`; `subjects` contains full referenced declarations in reference order. Unit/scope rewrites precede comparison. Ordinary prose cannot authorize unrelated SQL effects.

The semantic verifier reviews proposition and value, recording `assertionValueDigest` and the blinded input. Policy-input validation and replay reject missing/altered bindings; old value-bearing judgments require re-verification. Value-free historical replay requires the authenticated recorded prompt identity and exact captured request bytes; live requests retain the current prompt. Deterministic failure always closes admission.

Mechanical-only extraction requires explicit opt-in in the exact host-authorized policy: low-risk direct literal attribute/measurement/provenance, identical string value/proposition/supporting quotes, no qualifiers/entity bindings, materialization-only use. It cannot authorize world-fact publication or bypass a real review/hold. Adjudication retains its existing provenance and authority.

## Snapshots and temporal writes

Preflight requires persisted `inputSnapshot.artifactId` with matching snapshot identity/digest/knowledge clock. Original read-intent and snapshot bytes, tenant, workspace and required operations are verified. Required unavailable/skipped/truncated reads reject; optional unavailable retrieval remains explicit. Historical K is bound only into supported catalog queries; current-head or unsupported historical operations reject.

Reads use repeatable-read transactions and a pinned head. Apply retains separate `begin_batch` concurrency. Conflicting stale writes reject; `rebase_if_disjoint` requires proof against effective normalized slots and records the new head. Duplicate submission reconciles the original receipt.

Unit normalization changes spelling only when vocabulary identifies one meaning. Recognized unqualified legacy price slots are reused; explicit regional/qualified scopes remain distinct and ambiguous aliases reject. Duplicate comparison preserves payload, referenced entity, currency, specification, primary claim and extent content. Bounded corrections retain K0 history and original evidence on adjacent intervals.

Extent locators are tenant-checked UUIDs. Date-only bounds mean UTC midnight; relative phrases belong in `sourceText`. Event precision persists even without an explicit extent; contradictory precision rejects. Amounts must fit `numeric(20,6)` without rounding. Temporal relationships accept only explicit/accepted semantics supported by their SQL helper; non-temporal relationships reject unsupported extents.

## Reports and recovery

Custody registration still returns `admission: not_evaluated`. Legacy `report.publish` supports single-run inline Markdown with authentic `reportCheck` and exact run-qualified `claimRefs`. Missing refs, changed bytes and unsupported mixed-run/artifact-only shapes reject. Full report/provenance evolution remains P3.

Public contracts include `VerificationFailureSet`, `VerificationRecoveryPlan`, `VerificationRecoveryInvalidation` and `VerificationRecoveryReceipt`, with generated JSON schemas. Application functions are `composeVerificationFailureSet`, `admitVerificationRecoveryPlan`, `reconcileVerificationRecoveryReceipt` and `evaluateVerificationRecoveryInvalidation`. They consume trusted immutable batch/plan/result/probe/invalidation reads and signed component-drift evidence, returning bounded decisions and registration-ready artifacts. They do not dispatch workers or mutate publication state.

Recovery retains every original item/question, derives routing, requires changed evidence/claim inputs and complete rerun stages, preserves budgets and rejects judge-only retries or policy/hold bypasses. Unfinished execution reconciles the original operation. Narrowed support stays partial; rejected/held/cancelled/unresolved items do not gain recovered credit. Signed dependency changes and trusted revocation state require revalidation. Receipts bind the complete invalidation closure to tenant, case, plan and signed observations; invalidated and revalidated output IDs come from that recomputed closure. Durable cases/leases/checkpoints and downstream revocation remain P2/P3/P4/P5 work.

## Reproduce the proof

Run `corepack pnpm prove:current-schema` with `KS_TEST_DATABASE_URL`, `KS_TEST_PROJECT_DIR`, and `KS_SCHEMA_PROOF_OUTPUT` pointing to the explicitly guarded disposable Supabase project. The runner verifies project/config/container/loopback identity, schema head, every selected test and zero skips. It emits `compatibility.json` and suite reports. Never use the populated shared database for fresh-chain tests.

The meta repository's `knowledge-services-pre-mission-control/implementation` ledger contains exact acceptance evidence. Synthetic service judgments prove contract behavior, not external model quality or human-reviewed research gold. DB receipt `affected_refs` parity, broader cloud/fresh schema-workspace drift, deployment and full P6/P7 lanes remain recorded later work.
