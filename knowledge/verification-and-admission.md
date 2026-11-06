---
type: concept
title: Verification and admission
description: How Knowledge Services verifies evidence and admits it to knowledge effects after the SV-17 cutover.
tags: [verification, evidence, admission, ingestion, policy, exact-use]
owner: ai-engineer-knowledge-services
aliases: [deterministic gate, exact-use admission, use class, policy outcome, sealed evidence]
questions:
  - Can a semantic judgment override a deterministic failure?
  - What is the difference between verification success and admission?
  - What evidence is needed before a verified claim can be ingested?
  - Which use classes need an exact-use binding?
implementation_status: implemented-with-quality-gates
decision_status: reference
validation_status: source-and-test-inspected
okf_target: "0.2"
sources:
  - id: verification-guide
    resource: ../docs/verification/README.md
    title: Verification Module Guide
  - id: exact-use-admission
    resource: ../packages/knowledge-db/src/ingestion/exact-use-admission.ts
    title: Exact-use admission inside the ingestion transaction
  - id: exact-use-oracle
    resource: ../packages/knowledge-db/src/ingestion/exact-use-oracle.ts
    title: Production evidence oracle (exact-use bound)
  - id: admission-implementation
    resource: ../packages/knowledge-db/src/ingestion/evidence-admission.ts
    title: Evidence admission implementation
  - id: k01-apply-port
    resource: ../packages/bindings/aiengineer-postgres/src/ingestion-apply.ts
    title: K01 knowledge.apply port (AI Engineer ingestion) and use-class enforcement
  - id: verification-transport
    resource: ../packages/application/src/verification/operations/verification-transport.ts
    title: Verification context and admission ports
  - id: verification-host
    resource: ../packages/host/src/verification/host-runtime.ts
    title: Shared verification host runtime
---

# Verification and admission

**Concept ID:** `verification-and-admission`

**OKF target:** v0.2. This concept has no human-review attestation.

Knowledge Services treats verification as evidence compilation followed by a
policy decision. It does not turn a model confidence score or caller-supplied
claim text into authority. A claim can support a knowledge effect only after
the verification component has issued an exact-use decision for it and the
intended downstream use is admitted for its use class.

## Route a request

First choose the [execution profile and transport](execution-profiles-and-transports.md).
SV-17 made the `knowledge_verification` component (2.4.0) the only authority for
verification runs, claims and seals. The legacy `verification.v1` claims,
report, metric, adjudication, audit-bundle, semantic, run/case read, drift and
recovery surfaces were removed, and their AIDB tables were withdrawn by
contract 0.5.0.

| Need | Use | Result |
| --- | --- | --- |
| Verify claims, seal a run, read a run | `ks.knowledge_operation.v2` (K01) on the verification executor, with a K07 issuer credential | Component run, claim and seal records; a K01 receipt |
| Check a capture, parse, structured extraction, extraction, extraction replay or benchmark | Retained `verification.v1` use cases through the API, CLI, MCP or worker | A versioned verification result and its artifacts |
| Turn verified claims into corpus changes | `knowledge.apply` over K01, or `knowledge-ingestion-intent.v1` plan and apply on the executor, carrying `exactUse` | Admitted, held or rejected proposal receipts |
| Stage uncertain material for people | `candidate.stage` | A candidate only; no canonical knowledge effect |
| Capture, locate or register material in a sandbox | Executor capture and artifact tools | A non-authoritative capture cache; no verification authority |

The transport is not an algorithm authority. API and MCP compose the same
application ports in
[`verification-transport.ts`](../packages/application/src/verification/operations/verification-transport.ts),
wired by host
[`createVerificationHostRuntime`](../packages/host/src/verification/host-runtime.ts).
Every MCP verification tool calls application in process; MCP never proxies
HTTP. The retained operation catalog is in the
[verification module guide](../docs/verification/README.md#operation-kinds-and-use-cases).

## Ordered verification decision

The as-built pipeline asks these questions in order:

1. Are captured bytes or a canonical representation preserved?
2. Does the stored selector deterministically resolve the cited evidence?
3. Do mechanical checks for identity, type, value, units, time, normalization,
   and arithmetic pass?
4. Does the selected evidence support the complete atomic claim?
5. Does the applicable policy admit the result for this use?

Later stages can add restrictions. Semantic judgment and policy cannot reverse
an earlier deterministic failure. The service records support, world
correctness, attribution faithfulness, source authority, and provenance
integrity independently; an aggregate score cannot replace any one of them.
The full verdict lattice and policy outcomes are defined in the
[verification guide](../docs/verification/README.md#verdict-lattice-and-policy-outcomes),
while algorithm entry points live in
[`packages/verification`](../packages/verification/README.md).

## Admission invariants

- A non-staging proposal needs an eligible, run-qualified claim. In production
  the [exact-use oracle](../packages/knowledge-db/src/ingestion/exact-use-oracle.ts)
  makes a cited run eligible only when the intent carries an `exactUse` binding
  that declares it; without `exactUse` nothing is eligible. The executor-hosted
  file-store evidence oracle was retired in SV-17 and its setting
  (`KNOWLEDGE_EVIDENCE_ORACLE`) is refused at startup.
- The exact-use decision is admitted inside the native ingestion transaction by
  [`admitExactUseWithin`](../packages/knowledge-db/src/ingestion/exact-use-admission.ts),
  the code path shared with the PostgreSQL research binding. The decision binds
  the effect digest, so a changed effect needs a new decision.
- The declared use must be admissible for its K08 use class. The registry is
  [`catalog/research/use-classes.json`](../catalog/research/use-classes.json)
  (executor setting `KNOWLEDGE_USE_CLASSES_FILE`); an official or consequential
  use without `exactUse` is `REVIEW_REQUIRED`. The K01 `knowledge.apply` port
  enforces this before applying. The use comes from the K01 envelope
  (`use`/`audience`) or the intent's `declaredUse`; there is no default, a
  missing use or a disagreement between the two refuses `SCHEMA_UNSUPPORTED`
  ([`ingestion-apply.ts`](../packages/bindings/aiengineer-postgres/src/ingestion-apply.ts); the Biotech apply port is
  [`apply-port.ts`](../packages/bindings/biotech-graph/src/apply-port.ts)).
- `knowledge.plan_preview` (AI Engineer) runs the same checks and native planner
  read-only, before a decision exists, and answers the plan id, bound effect
  digest, native payload digest, authoritative epoch, normalized-values digest
  and migration head `knowledge.apply` would use, so the decision can bind the
  plan-level digest exactly. Semantic plan identity ignores the exact-use decision
  fields and dispatch effect key; the full intent digest still binds them for
  duplicate/conflict checks. Each request consumes a fresh credential nonce but
  performs no native write or effect admission
  ([`IngestionExecutor.preview`](../packages/knowledge-db/src/ingestion/executor.ts);
  [real AIDB preview/apply proof](../apps/verification-executor/src/knowledge-operation/aidb-apply.integration.test.ts)).
- `decision.resolve` returns the current stored decision's authoritative `runId`,
  including after review succession. Callers do not parse opaque decision names
  ([resolution](../packages/host/src/knowledge-operation/assessment.ts);
  [opaque successor test](../packages/host/src/knowledge-operation/assessment-resolution.test.ts)).
- Inline claim text, qualifiers and subject bindings must match the bound
  claim, and a planned effect is compared with a canonical encoding, so
  paraphrased evidence cannot authorize a changed SQL effect.
- New subjects use the deterministic identity the apply step will create; claim
  bindings may only use known subject, object or context roles. Publication of
  a legacy report package is refused; publish through v2.
- Held dependencies hold their downstream closure, while independent proposals
  can still be admitted. The receipt distinguishes admitted, held, rejected,
  superseded and duplicate/no-op effects.

These controls are implemented by
[`evidence-admission.ts`](../packages/knowledge-db/src/ingestion/evidence-admission.ts),
the deterministic [planner](../packages/knowledge-db/src/ingestion/plan.ts) and
the [apply path](../packages/knowledge-db/src/ingestion/apply.ts), which writes
through the pinned database contract. Admission does not grant schema ownership
to this service.

## Trusted assessment and review (Sprint OC WI-03)

The ordinary path from a registered report to a usable decision runs through
authenticated K01 operations, never through process memory or a test-populated
cache: `report.observe` (independent judge/auditor observations; the role is the
credential's `evaluation` grant, the producer's own subject refuses
`evaluator_is_producer`), `report.seal` (the exact VerificationRun and manifest),
`report.decide` (the exact use decision for a declared use, audience and
purpose), `report.review` (the credential subject reviews under a live grant; a
successor decision is persisted) and `decision.resolve` (the current successor
and its read-only exact-use eligibility, also from a fresh executor). The
operations are composed in
[`assessment.ts`](../packages/host/src/knowledge-operation/assessment.ts) over the
existing coordinator and review services; there is no second verification engine.

Checking producer assertions is distinct from independent coverage: support
observations come from judges, the census of material claims from the auditor's
own discovery pass, and producer observations never cover. An ungrounded
disagreement between evaluators holds (`disputed_verdict`); only contrary
evidence or an integrity failure rejects.

A role observes a run once: its first observations stand and a failing or unsupported verdict is
sticky for that revision (`evaluator_role_observed` refuses any later one), so re-running a judge
until it passes is impossible; only a reviewer decision moves the outcome. A revocation after
Mission Control promoted a revision does not demote it; that is a W1 prerequisite (OVE-169).

W1 limit (OVE-169) of the per-role cap: a role batch recorded only in part (for example a transport failure mid-request) cannot be completed by a rerun with new observation ids, which refuses `evaluator_role_observed`; Mission Control treats that as observed and the run seals with the partial batch, so the likely outcome is a hold or an unmet obligation rather than a pass, and only a reviewer decision moves it. A same-run census replay under a new census id is refused the same way, which is harmless: the first census stands. W1 must observe this path on its first real judge failure.

Recommendations and forecasts carry a typed judgment basis (`judgment`:
rationale, assumptions, uncertainty, horizon; the premises are the assertion's
`premises`). A use-specific policy in
[`catalog/research/judgment-policies.json`](../catalog/research/judgment-policies.json)
may admit one for an official or consequential use; the decision then requires
review and names `judgment_not_entailed:<id>` permanently. Approval satisfies the
review only: it is never fact entailment. Without an admitting policy the OQ4
exclusion holds (`non_entailed`); with one but an incomplete basis it holds
`judgment_basis_incomplete`. Tests:
[judgment aggregation](../packages/research-core/src/verification/aggregate.test.ts),
[governed judgments](../packages/application/src/research/judgment.test.ts) and the
`trusted_assessment` check of the
[backend conformance suite](../packages/host/src/tests/conformance/backends/suite.ts)
on in-memory, aiengineer-postgres and biotech-graph.

## Examples

### A fact change with an exact-use decision

An intake sends a `fact.assert_state` proposal citing `{ runId, claimId }` and
an `exactUse` binding issued by the verification component for that run. The
planner admits the fact only when the run is declared by `exactUse`, the inline
statement and qualifiers match, and the canonical effect equals the bound
effect digest. Changing `status` after the decision yields
`PROPOSAL_REVERIFICATION_REQUIRED`; it needs a new decision.

### A safe partial result

A `candidate.stage` proposal may be planned without canonical evidence because
it creates review work, not canonical knowledge. If a dependent materialization
cannot be admitted, it is held. An independent materialization with valid
evidence can proceed. This prevents a single ambiguity from becoming either an
unreviewed write or an unnecessary batch-wide failure.

## Failure behavior

Admission is fail-closed. Typical outcomes are `EVIDENCE_REQUIRED`,
`EVIDENCE_NOT_ELIGIBLE`, `EVIDENCE_INTENDED_USE_MISMATCH`,
`INLINE_CLAIM_MISMATCH`, `CLAIM_SUBJECT_REVERIFICATION_REQUIRED`,
`PROPOSAL_REVERIFICATION_REQUIRED` and `REVIEW_REQUIRED`. These are planning
decisions, not a signal to synthesize replacement evidence.

Tests: [exact-use oracle](../packages/knowledge-db/src/ingestion/tests/exact-use-oracle.test.ts),
[use-class admission](../packages/knowledge-db/src/ingestion/tests/use-class-admission.test.ts),
[exact-use integration](../packages/knowledge-db/src/ingestion/tests/exact-use.integration.test.ts),
[evidence admission](../packages/knowledge-db/src/ingestion/tests/evidence-admission.test.ts),
the [K01 apply port](../apps/verification-executor/src/knowledge-operation/native-ports.test.ts)
and the [K01 conformance suite](../apps/verification-executor/src/knowledge-operation/conformance.test.ts),
which includes an official use without `exactUse` answering `REVIEW_REQUIRED`. The
[backend conformance suite](../packages/host/src/tests/conformance/backends/suite.ts) runs every registered backend
([executor composition](../apps/verification-executor/src/knowledge-operation/backend-conformance.test.ts)) on its
disposable store: describe honesty, exact register/read, apply with receipt, lost-acknowledgment reconciliation and
revocation before dispatch.
The [integration guide](../docs/verification/INTEGRATION-GUIDE.md) defines the
cross-service boundary; Mission Control dispatches and classifies
retry/cancellation, while Knowledge Services owns verification algorithms and
policy admission.

## Current limits

This is an implementation description, not a quality certification. The
verification guide records partial and missing acceptance evidence, including
human-labelled calibration, citation-completeness, and sealed quality
benchmark work. It also documents surface deviations from the design
specification. Read [current acceptance state](../docs/verification/README.md#current-acceptance-state)
before treating a passing service result as proof of those broader claims.

Verification read ports are composed by host for both the API and MCP, and
the [API/MCP parity test](../apps/mcp/src/tests/api-mcp-parity.test.ts) covers
success, tenant, actor, missing-capability and not-found outcomes per tool.

For deployment and operator actions, use the authoritative
[operator runbook](../docs/verification/OPERATOR-RUNBOOK.md) and
[durable execution and recovery](durable-execution-and-recovery.md), rather
than this concept note. The durable verification recovery host was retired in
SV-17.

## Locators and media coverage

The [library capability matrix](../packages/verification/CAPABILITIES.md) and the [executor acquisition capabilities](../apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md) distinguishes twelve library selectors from public acquisition and executor intents. Executor extractions currently select exact text quotes; geometry and transcript projection resolvers do not perform OCR or transcription. [Runnable examples](../packages/verification/examples/README.md) demonstrate these limits and deterministic failures.
