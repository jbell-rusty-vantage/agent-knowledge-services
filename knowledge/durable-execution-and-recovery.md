---
type: concept
title: Durable execution and recovery
description: How durable workers lease, retry and cancel steps, and where verification recovery went after SV-17.
tags: [verification, recovery, durability, custody, operations]
owner: ai-engineer-knowledge-services
aliases: [retry, cancellation, worker restart, lease reclamation, recovery case]
questions:
  - When is a failed step retried, and when is it terminal?
  - Does a retry re-evaluate evidence?
  - Where did the verification recovery host go?
implementation_status: partial
decision_status: reference
validation_status: source-and-test-inspected
okf_target: "0.2"
sources:
  - id: verification-guide
    resource: ../docs/verification/README.md
    title: Verification Module Guide
  - id: canonical-worker
    resource: ../apps/worker/src/canonical-worker.ts
    title: Canonical durable worker
  - id: runtime-ledger
    resource: ../packages/core/src/runtime/ledger.ts
    title: Runtime step ledger
---

# Durable execution and recovery

**Concept ID:** `durable-execution-and-recovery`

**OKF target:** v0.2. This concept has no human-review attestation.

Durable execution is the control-plane path a queued Knowledge Services
operation follows: claim a step under a fenced lease, execute the registered
activity, and write an idempotent receipt. Mission Control owns cross-service
dispatch, cancellation and retry classification; Knowledge Services owns the
algorithm, admission and durable knowledge execution. The division is stated in
the [verification module guide](../docs/verification/README.md#as-built-architecture)
and [integration guide](../docs/verification/INTEGRATION-GUIDE.md).

| Situation | Route | What remains authoritative |
| --- | --- | --- |
| A queued operation step can run | Canonical worker | The step receipt keyed by operation, step and input digest |
| A step fails with a retryable error | The step returns to the queue | The same operation, step and input digest |
| A step fails terminally | The operation reconciles to failed | The terminal receipt |
| A verification run, claim or seal must be repeated | `ks.knowledge_operation.v2` on the verification component | The component's run, claim and seal records (see [verification and admission](verification-and-admission.md)) |
| An operator needs environment or restart steps | Verification runbook | See the runbook; this document does not duplicate procedures |

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
cover receipt idempotency and stale-lease handling. These retries are
control-plane attempts of one step, not a re-evaluation of evidence.

## Verification recovery (retired in SV-17)

The executor-hosted verification recovery host, its recovery authority and
routing, the root fixture host's recovery receipts, the application
invalidation service and the recovery provider budget were removed in SV-17.
Their AIDB tables (`knowledge_service.recovery_*`) and the `verify_claim`
orchestration intents they read were withdrawn by contract 0.5.0, and the
sealed file-store runs they consumed are no longer authoritative. The executor
refuses `KNOWLEDGE_RECOVERY_CONFIG_JSON` at startup
(`EXECUTOR_RETIRED_CONFIGURATION`), and the `recovery_*` executor operations no
longer exist.

A verification run, its claims and its seal are now owned by the
`knowledge_verification` component (2.5.0) and reached only through
`ks.knowledge_operation.v2`. A repeated or corrected verification is a new
operation on that component with its own exact-use admission; it is not a
repair of a file-store run. No replacement recovery-case service exists yet;
do not cite the removed paths as current behavior.

## Native commits across a lost protocol receipt (WI-05)

`knowledge.apply` journals every dispatch before native dispatch, in its own committed transaction
(component 2.5.0 `effect_dispatch`: dispatch id, per-effect sequence, envelope, envelope digest, caller
origin, bound digest; bytes other than the bound effect's refuse `EFFECT_CONFLICT` there; an uncommitted
refused dispatch never pins the key). The native transaction stamps its
commit with that dispatch (`effect_commit`, inside the AI Engineer ingestion transaction or the Biotech
admission + outbox enqueue); a second native commit of an effect refuses `EFFECT_ALREADY_COMMITTED` and
rolls back. A commit without a protocol receipt is `native_only`: `knowledge.apply` and `receipt.get`
rebuild the ORIGINAL dispatch's receipt from the journal and the binding's read-back of the committed
native receipt (`KnowledgeApplyPort.reconstruct`), record it first-writer-wins
(`record_protocol_receipt` refuses a receipt naming another dispatch) and never apply again. What cannot
be reconstructed stays `UNRESOLVED_EFFECT`. Every refusal carries `details.dispatch` (`not_journaled`,
`journaled_uncommitted`, `committed`, `unknown`) so Mission Control rejects only a dispatch that provably did nothing.
`journaled_uncommitted` is reported only for a typed pre-commit refusal after the dispatch is fenced
(`abandon_effect_dispatch` under the commit lock, `details.fenced`): a native commit still in flight either finishes
first (then `committed`) or is refused `DISPATCH_ABANDONED`. Connection loss, timeouts and other untyped failures are
`unknown`. Pending graph dispatch stays `pending_dispatch`; the BKS
consumer's marker reconciles a graph commit whose PostgreSQL acknowledgment was lost. Code:
`packages/host/src/knowledge-operation/service.ts` (`apply`, `recoverNative`), the bindings'
`component-backend.ts`, `ingestion-apply.ts`, `biotech-graph/src/apply-port.ts`; fresh-process proofs:
`apps/verification-executor/src/knowledge-operation/native-recovery.integration.test.ts` (Biotech,
real BKS consumer and Neo4j) and `aidb-apply.integration.test.ts` (AI Engineer).

## Failures and operator handoff

Use the [operator runbook](../docs/verification/OPERATOR-RUNBOOK.md) for
configuration profiles, ownership grants, worker restart, and deployment
recovery. Use the [operations runbooks](../docs/operations/runbooks.md) for
leases, callbacks, and incident handling. A durable step receipt proves its
scoped custody and decision, not human-labelled semantic accuracy or deployment
readiness.
