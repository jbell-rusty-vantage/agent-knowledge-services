# Durable verification recovery cases

Knowledge Services persists the P1.4 failure set, admitted repair plan, invalidation and independently reconciled receipt. A case preserves the original question and requirement set, authority history, attempts, spending and unresolved work. Mission Control can later coordinate these records; the case service does not implement a mission workflow or call a semantic provider.

`DurableVerificationRecoveryService` is exported from the application package. `PostgresDurableVerificationRecoveryStore` implements its canonical persistence port. The executor's `knowledge/recovery-durable.ts` composes them with existing artifact custody, checkpoints and admitted verification operations. Hosts retain ownership of those clients and their shutdown. Cross-repository agent procedures and public authority admission remain separate integration work; no endpoint accepts an arbitrary producer-supplied verification verdict as authority.

## Authority and identity

The host supplies `DurableRecoveryEvidenceAuthority`. Its initial batch includes every original question, requirement and candidate, the original operation/input bindings, and authorized limits. Verification runs alone cannot reconstruct this denominator. The port must read authenticated evidence and review decisions; an agent's final message is insufficient.

After opening the case, the durable store owns its immutable initial batch and subsequent counters. Reopening the same case is idempotent. Changing its initial batch or authority fails. A second case cannot readmit the same original operation/input pair to obtain fresh limits. Regrouping work within a case retains every original member. A policy notification does not reset attempts or change the claim's pinned policy/profile binding.

`initialBatch` retains that original authority. Before admitting another plan, the service independently verifies the latest settled candidate for each original item using its authorized operation, input and binding. The new failure set can preserve a successful earlier repair while repairing another item. Original membership, requirements, policy/profile and cumulative limits remain fixed; preserved results are not charged again. Dependency claims include both original dependencies and those in the current plan's verified failure set.

Each admitted changed-input repair has one deterministic execution ID and planned operation ID, derived from tenant, case, original candidate and repair digest. Its immutable authorization is stored before operation registration. The runtime adapter verifies that authorization and the original plan, then uses `PostgresKnowledgeOperationService` with an explicitly admitted verification capability. The host's pure materializer supplies the existing request format and real actor/attempt context. It must not create placeholder mission or attempt records.

## Claims, reservations and reconciliation

Claims cover sorted original/dependency keys and carry an expiry and monotonic fence. An expired claim does not authorize repeating unknown external work. Reconciliation recovers an already authorized operation under its original deterministic identity, including operation registration success followed by a lost database-link acknowledgment. Linked pending operations use their existing owner recovery path; the case service never invokes an independent unchanged-request retry loop.

Semantic repair rounds are distinct from worker step attempts. Reservations survive process loss and unknown outcomes. Independent terminal usage settles each execution once; repeated receipts use the latest immutable usage total for the original plan rather than adding another charge. A new plan inherits prior spending, probe history and per-original attempts. Missing authorizations cannot be presented as completed repair attempts.

Review, operator and exhaustion outcomes retain their members and require a verified checkpoint before the wait releases claims. The wait record includes current plan/attempt state and outstanding reservations. Resume requires a new authenticated evidence, review or policy authority revision with the expected prior digest. A changed authority record can support a new independently verified observation; it cannot mutate the original denominator, erase attempts, replenish the budget or bypass P1.4 policy/profile checks.

## Artifact custody and drift

Recovery artifacts use the existing versioned executor storage profile, bucket and artifact vocabulary. Logical identity includes the record's provenance, while byte storage remains digest-addressed. Both existing canonical `tenant/prefix/digest` keys and executor `artifacts/digest` handles retain their original identity. Local materialization rejects path escapes and symlink ancestors before writing bytes.

Custody verifies the JSON record and its parent/attestation closure before acknowledgment. Canonical `recovery_artifact_reference` rows retain every dependency, including initial authority, diagnostics, probe receipts, invalidation audits and checkpoints. Reference insertion is serialized against artifact retirement. A stored JSON pointer without retained, resolvable bytes does not prove persistence.

`ingestDurableRecoveryDrift` uses the existing verification drift outbox. A trusted owner maps an observation to affected cases. The bridge persists an idempotent case notification before acknowledging that same outbox claim. Missing custody, partial case persistence and acknowledgment loss leave the original notification recoverable; unmapped observations remain unacknowledged. There is no second notification scheduler.

## Validation boundaries

The P2.5 proof uses the canonical disposable PostgreSQL/Storage project, actual admitted operation records and reconstructed service/custody clients. Its authority and provider outcomes are explicit fixtures; it does not establish live model quality, a deployment or full fixture-lane acceptance. The evidence record in the pre-Mission Control implementation ledger binds the final source hashes, commands, failures and RC09/RC12 results.

The owning tests are `knowledge/recovery-durable-cases.integration.test.ts` and `knowledge/recovery-durable-drift.test.ts` in the executor, plus durable contracts/application tests and canonical `supabase/tests/durable_verification_recovery.sql`. The current-schema and artifact-custody proof commands supply compatibility evidence for the pinned database contract. Existing [checkpoint proofs](CHECKPOINTS.md) cover actual producer process termination and sandbox removal.
