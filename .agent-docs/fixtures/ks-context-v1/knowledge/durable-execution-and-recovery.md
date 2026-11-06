---
type: concept
title: Durable execution and recovery
description: How verification recovery preserves authority, scope, and bounded repair work.
tags: [verification, recovery, durability, custody, operations]
owner: ai-engineer-knowledge-services
okf_target: "0.2"
sources:
  - id: verification-guide
    resource: ../docs/verification/README.md
    title: Verification Module Guide
  - id: recovery-authority
    resource: ../apps/verification-executor/src/knowledge/recovery-authority.ts
    title: Recovery authority implementation
---

# Durable execution and recovery

**Concept ID:** `durable-execution-and-recovery`

**OKF target:** v0.2. This concept has no human-review attestation.

Verification recovery is a durable, evidence-bound process for a verification
run whose result is incomplete, unavailable, drifted, or invalidated. It is
not a request to rerun an arbitrary new batch. The original membership,
bindings, budgets, deadlines, policy version, and authority artifact constrain
every later repair.

## Route an execution problem

| Situation | Route | What remains authoritative |
| --- | --- | --- |
| Initial verification can complete | Normal worker/executor operation | The sealed run result and its audit artifacts |
| A completed result signals drift or a failed item | Automatic recovery notification and triage | Initial recovery batch plus custody-bound diagnostics |
| A result is missing, cancelled, or unknown | Recovery authority reads a valid unavailable observation | The initial batch; absence does not invent a result |
| A repair requires a provider | Authorized recovery execution | Original reservation, deadline, operation lease, and provider accounting |
| A result or dependency becomes invalid | Invalidation evaluation | Affected outputs are blocked until their required stages revalidate |
| An operator needs environment or restart steps | Verification runbook | See the runbook; this document does not duplicate procedures |

Mission Control owns cross-service dispatch, cancellation, and retry
classification. Knowledge Services owns the algorithm, admission, durable
knowledge execution, and recovery custody. The division is stated in the
[verification module guide](../docs/verification/README.md#as-built-architecture)
and [integration guide](../docs/verification/INTEGRATION-GUIDE.md).

## Normal worker execution

Normal operation execution is the control-plane path, distinct from a recovery
case. A tenant-scoped canonical worker claims an eligible queued step with a
fenced lease, heartbeats it before work and at roughly one-third of the lease
interval, executes the registered activity, then writes an idempotent receipt
and reconciles the operation. A receipt is keyed by operation, step, and input
digest, so a matching replay returns the existing receipt while a different
output is an idempotency conflict.

An activity exception is classified as retryable or terminal by the activity
registry. A retryable failure returns the step to the queue for another
control-plane attempt; a non-retryable failure is terminal and reconciles the
operation to failed. A completed activity can also publish a domain failure as
its terminal receipt when that is the operation's defined result, rather than
pretending it succeeded. Expired leases are reclaimable; stale lease tokens
cannot heartbeat, complete, or fail a step.

This behavior is implemented by
[`canonical-worker.ts`](../apps/worker/src/canonical-worker.ts) and the
runtime [ledger](../packages/core/src/runtime/ledger.ts). The focused
[worker tests](../apps/worker/src/worker.test.ts) cover normal reconciliation,
unimplemented terminal activity failure, eligibility scoping, and restart
lease reclamation; the [runtime tests](../packages/core/src/runtime/runtime.test.ts)
cover receipt idempotency and stale-lease handling. These retries are not
recovery cases: recovery begins only after the authority-bound verification
batch is triaged for drift, invalidation, unavailability, or repair.

## What the implementation preserves

The trusted fixture root host also records its direct executor submissions in
`orchestration.operation_intent` using the existing `verify_claim` kind. After
authenticating a sealed result and its exact submitted intent, it writes an
immutable `orchestration.operation_receipt` with the audit reference and every
claim disposition. Here `applied` means the execution record was recorded; each
disposition separately states whether its claim is eligible. These records do
not enqueue a `knowledge_service.operation` or impersonate a native worker
receipt. The immutable receipt's usage remains `null`. A trusted host accounting
callback can separately retain a `root-verification-accounting.v1` artifact
bound to that receipt, its audit, and all charged deterministic result revisions.
The host checks scope, totals, call uniqueness, and result custody; absent or
unsettled journal accounting remains unresolved. The T14 launcher supplies this
callback from its run-wide dispatch journal. Canonical history discovers the
supplemental artifacts through scoped registry metadata and audit lineage,
then checks their bytes, receipt bindings, totals, and result custody. It returns
all matching snapshots and selects a cumulative snapshot only when it preserves
every prior call binding and settled charge. Incomparable branches or changed
settlements fail; timestamps do not establish accounting authority. Recovery
consumes the authenticated snapshot. This fixture-host recording seam is implemented in
`apps/verification-executor/src/root-host-verification-receipts.ts`. Its history
reader reconstructs submissions and optional completion receipts from the
canonical ledger, checks their deterministic identities and context, and keeps
missing receipts unresolved. A fresh host with empty local stores exercises
this read path. Full repair execution remains unfinished.

Zero provider usage requires an explicit accounting lifecycle. The root opens
the run when retaining a submission and closes it against the authenticated
sealed result. The T14 journal persists both events, rejects judge dispatch
after closure, and leaves open or unsettled runs unresolved. A zero-call result
contains distinct opening and closing journal digests, no call evidence, and
zero cost; absence of call records alone is insufficient. Reopening verification
makes live accounting pending until the next closure. Run totals retain earlier
charged result revisions and completed zero-call revisions across journal restart.
The canonical proof also covers an absent-quote mechanical failure: semantic
dispatch is refused, the run seals without semantic output, and journal-backed
zero usage allows its failed original to enter recovery and survive restart.

The root host's `readRecoveryEvidence` resolves an executor receipt's audit and
its artifact roles without reading mutable run state. It reuses sealed evidence
validation to check the registered chain, policy replay, and every recorded
claim disposition. This supplies immutable artifact references for recovery;
the repair execution runtime must still be composed.

`authorizeRecoverySubmission` now retains an original authorization before the
first verification result exists. It compiles the retained intent to pin exact
claims, selectors, full-capture context digests, configured verifier profile,
original questions, and host-supplied limits. A per-operation database lock
prevents conflicting authorization creation; subsequent calls must preserve the
same limits and pins. T14 invokes it before its first verification dispatch with
the shared budget's remaining capacity. After completion and accounting are
recorded, the root's `observeRecovery` composes automatic routing with the
durable service and an explicitly configured orchestration source. It remains
unresolved without authenticated original results and settled accounting.
The executor's pre-seal notification cannot consume a receipt that has not yet
been created, so this composition runs after receipt creation.

Contract 0.4.16 distinguishes native `original_operation_id` from direct executor
`original_intent_id`; exactly one is required, with tenant-scoped foreign keys.
An intent must be `verify_claim`. Source and identity cannot change after insertion.
Distinct original IDs may share a binding within one case. An immutable unique
`recovery_binding_owner` record preserves ownership across cases, including when
another case renames the original. Concurrent inserts either observe that owner
or fail serialization under stronger transaction isolation. Persistence defaults to native authority and
validates the configured source against every stored original on read and replay.

`readRecoveryResult` now joins the original authorization to the canonical
completion, immutable artifact chain, and selected accounting snapshot before
delegating to the existing executor recovery result reader. Missing authority,
completion, or accounting returns unresolved. Claim verification alone does
not credit original-question coverage. Repair dispatch remains unfinished.

Recovery lookups carry the original claim ID alongside operation and input
digest. Distinct originals with identical bindings therefore retain separate
verdicts. Omitting that identity when the binding is ambiguous fails closed;
repair accounting still deduplicates charges by operation ID.
The native reader likewise carries original ID into binding lookup, rejects a
substituted original before reading its evidence, and denies ambiguous original
bindings when the caller omits that identity.
The native pre-admission dependency check requires every supplied ID to name a
tenant-scoped native claims or report operation. Unknown IDs and direct executor
intent IDs cannot turn an empty lookup into a completed dependency check; direct
executor recovery still needs its own authenticated artifact-root composition.

The root host's `readRecoveryBatch` uses `RecoveryRunAuthority` and recursive
remote custody validation to reconstruct the original batch. Missing results
remain pending; authenticated results update each original observation while
preserving membership and questions. Read-only authority composition does not
enable probes, invalidation, or resume approval; those require their configured
ports. T14 collection requires this canonical batch and retains its authority
artifact alongside verification evidence.

Notification-only durable service composition can open and read cases without
an execution runtime or checkpoint adapter. Planning, claiming, executing, and
reconciling reject a missing runtime before reservation or mutation; waiting
rejects a missing checkpoint adapter. This does not enable repair dispatch.
T14 collection requires a recovery observation and restores its revision artifacts.

Repeated sealing of an unchanged executor run retains its original completion
time and audit artifact. The executor inspects the stored audit, rebuilds the
audit from the current evidence chain, and requires exact equality before
reusing it. An incompatible audit fails replay instead of replacing an
immutable completion receipt. Verification, judgment, and policy changes still
invalidate the cached seal and require a new one.

An authorization artifact is host-configured, not a public tool parameter. The
recovery authority checks that it names the run, claim/intent digest, tenant,
and the exact initial batch. It then verifies one assertion for every original
item, exact capture/representation bindings, canonicalized claim and selector
inputs, and the initial `pending` state with no attempted repairs. The batch
pin must identify the same immutable artifact as the run pin.

When reading the batch later, the authority hydrates each result from its
operation and validates tenant, input digest, operation id, run id, canonical
binding, revocation state, and every diagnostic artifact's custody. A missing
result may become `unknown` or `cancelled` only through the configured
unavailable-observation authority and only with a constrained execution-family
shape. It never becomes a passing verification result.

These are implemented in
[`recovery-authority.ts`](../apps/verification-executor/src/knowledge/recovery-authority.ts)
and exercised by
[`recovery-authority.test.ts`](../apps/verification-executor/src/knowledge/recovery-authority.test.ts).

## Durable recovery flow

1. The executor authorizes the completed run against its recovery artifact.
2. It builds the authoritative initial batch and triages custody-bound results,
   probes, and invalidations.
3. If every item passes, it reports `not_required`; it does not open a case.
4. Otherwise, it registers a deterministic notification, opens or rereads the
   durable case, and ingests drift idempotently.
5. The durable service selects and authorizes permissible repair work. A repair
   reuses the original identity and cannot silently add items or alter bindings.
6. Results, probes, and invalidations create revisioned receipts; downstream
   outputs remain blocked until required stages revalidate.

[`recovery-routing.ts`](../apps/verification-executor/src/knowledge/recovery-routing.ts)
contains the automatic path. It rejects mismatched policy/decision artifacts,
requires completed results that cite the decision diagnostic, preserves the
initial authority artifact across reopen/read, and uses a deterministic
notification identity. The focused
[routing tests](../apps/verification-executor/src/knowledge/recovery-routing.test.ts)
and [recovery integration tests](../apps/verification-executor/src/knowledge/recovery-routing.integration.test.ts)
cover that boundary.

## Business invariants

- Recovery works from the original denominator and question membership. It does
  not make a partial retry look like a complete new evaluation.
- Custody, tenant, artifact digest, selector/input digest, policy binding, and
  authority pin checks are prerequisites to a recovery decision.
- A recovery case is append/revision based. Notifications are idempotent, and
  reopening does not replace its initial authority artifact.
- A provider call must run under an active, authorized recovery execution
  before the original deadline. The native transaction locks the execution and
  rejects calls or cost beyond its reservation.
- Revocation or incomplete dependency revalidation blocks the dependent output;
  claimed successful replacement work cannot override that rule.
- Recovery is not a semantic override: a deterministic failed prerequisite
  remains failed until evidence and the required verification stages support a
  valid repair.

The implementation for invalidation is in
[`verification-recovery.ts`](../packages/application/src/verification/recovery/verification-recovery.ts),
with adverse-path coverage in
[`verification-recovery.test.ts`](../packages/application/src/verification/recovery/verification-recovery.test.ts).
Provider budget enforcement is in
[`verification-recovery-provider-budget.ts`](../packages/persistence/src/verification-recovery-provider-budget.ts).

## Examples

### One failed claim, one independent output

If a source selector no longer resolves for one claim, recovery classifies that
item and keeps the original batch denominator. The claim's downstream report is
blocked until the required policy/report stages revalidate. An output outside
that dependency closure can remain eligible. This mirrors the invalidation test
case where an independent output is not included in `blockedOutputIds`.

### Provider repair beyond reservation

An authorized repair has a reservation of calls and cost. Before a new provider
attempt, persistence reads the locked execution, checks the case is active and
before deadline, sums settled/reserved attempts, then throws
`RECOVERY_PROVIDER_BUDGET_EXCEEDED` if the added work would exceed either
limit. It does not spend first and reconcile later.

## Failures and operator handoff

Representative fail-closed errors include
`RECOVERY_RUN_AUTHORIZATION_MISMATCH`, `RECOVERY_BATCH_AUTHORIZATION_MISMATCH`,
`RECOVERY_ORIGINAL_MEMBERSHIP_MISMATCH`, `RECOVERY_ORIGINAL_INPUT_MISMATCH`,
`RECOVERY_RESULT_AUTHORITY_MISMATCH`,
`RECOVERY_NOTIFICATION_AUTHORITY_MISMATCH`, and
`RECOVERY_PROVIDER_EXECUTION_NOT_ACTIVE`. These mean authority or execution
preconditions failed; the safe action is to inspect the recorded case and
artifacts, not to submit altered repair inputs.

Use the [operator runbook](../docs/verification/OPERATOR-RUNBOOK.md) for
configuration profiles, ownership grants, worker restart, and deployment
recovery. Use the [operations runbooks](../docs/operations/runbooks.md) for
leases, callbacks, and incident handling. The implementation is still bounded
by the verification module's documented partial/missing quality acceptance
work; a durable recovery receipt proves its scoped custody and decisions, not
human-labelled semantic accuracy or deployment readiness.
