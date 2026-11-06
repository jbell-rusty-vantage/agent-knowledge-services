import {
  type DecisionResolveRequest,
  DecisionResolveRequestSchema,
  type ReportReviewRequest,
  ReportReviewRequestSchema,
  type ReportUseRequest,
  ReportUseRequestSchema,
} from "./assessment.js";
import { type JsonValue, digestBytes, digestCanonical } from "./canonical.js";
import { bindEffect } from "./effect.js";
import type { CredentialClaims } from "./credential.js";
import type { OperationEnvelope } from "./envelope.js";
import type { Origin } from "./origin.js";
import type { Ref, RefKind } from "./primitives.js";
import {
  REPORT_PACKAGE_VERSION,
  type ResearchReportPackage,
  ResearchReportPackageSchema,
  type SelectedReportRead,
  SelectedReportReadSchema,
  selectedReadDigest,
} from "./selected-read.js";

/** Deterministic fixtures shared by the tests and the golden-vector generator. Not exported from the package index. */
export const PAYLOAD = Buffer.from(
  '{"schemaVersion":"knowledge-ingestion-intent.v1","intentId":"sv-golden","notes":"Café vs Café — 🧪 stays exactly as sent"}\n',
  "utf8",
);

export function missionOrigin(overrides: Partial<Origin> = {}): Origin {
  return {
    kind: "mission_invocation",
    installationId: "00000000-0000-7000-8000-000000000001",
    applicationId: "ai-engineer",
    tenantId: "00000000-0000-7000-8000-0000000000aa",
    issuer: "mission-control",
    subject: "mission-control-runtime",
    mission: {
      missionId: "mission-1",
      runId: "run-1",
      activationId: "activation-1",
      operationId: "op-research-1",
      operationAttempt: 1,
      executionGeneration: 1,
      lane: "deep_agents",
    },
    recoveryAuthorityRef: null,
    invocationId: "inv-0001",
    authenticatedAt: "2026-10-24T20:00:00Z",
    ...overrides,
  };
}

export function retryOrigin(): Origin {
  const base = missionOrigin();
  return missionOrigin({
    mission: { ...(base.mission as NonNullable<Origin["mission"]>), operationAttempt: 2 },
    invocationId: "inv-0002",
    authenticatedAt: "2026-10-24T20:05:00Z",
  });
}

export function recoveryOrigin(): Origin {
  return missionOrigin({
    kind: "recovery",
    subject: "mission-control-reconciler",
    mission: null,
    recoveryAuthorityRef: "recovery-grant-7",
    invocationId: "inv-0009",
    authenticatedAt: "2026-10-24T20:30:00Z",
  });
}

const epochSeconds = (instant: string): number => Math.floor(Date.parse(instant) / 1000);

/** Retry of the golden apply by a NEW attempt: same effect binding (originating origin, bytes), new dispatch. */
export function retryApplyEnvelope(): OperationEnvelope {
  return {
    ...applyEnvelope(),
    dispatchId: "dispatch-0002",
    issuedAt: "2026-10-24T20:05:01Z",
  };
}

/** The effect-scoped recovery credential the new attempt presents (`current_caller_origin` = attempt 2). */
export function effectRecoveryClaims(): CredentialClaims {
  const caller = retryOrigin();
  const envelope = retryApplyEnvelope();
  const effect = envelope.effect as NonNullable<OperationEnvelope["effect"]>;
  const iat = epochSeconds("2026-10-24T20:05:00Z");
  return {
    typ: "ks-knowledge-operation+jwt",
    iss: caller.issuer,
    aud: "knowledge-services",
    sub: caller.subject,
    jti: "jti-recovery-0002",
    iat,
    nbf: iat,
    exp: iat + 300,
    tenant: caller.tenantId,
    application: caller.applicationId,
    binding: envelope.binding,
    origin: caller,
    operations: ["knowledge.apply"],
    effect: { effectKey: effect.effectKey, boundEffectDigest: effect.boundEffectDigest },
    dispatchId: envelope.dispatchId,
    recovery: {
      scope: "effect",
      authorityRef: "recovery-grant-7",
      effectKey: effect.effectKey,
      boundEffectDigest: effect.boundEffectDigest,
    },
  };
}

/** Receipt lookup after the invocation ended: a `recovery` origin with read-only authority. */
export function receiptLookupEnvelope(): OperationEnvelope {
  const base = applyEnvelope();
  return {
    ...base,
    requestId: "req-0009",
    dispatchId: "dispatch-0009",
    operation: "receipt.get",
    effect: null,
    target: { handle: null, effectKey: "effect-0001" },
    input: null,
    requiredCapabilities: ["receiptLookup:by_effect_key"],
    issuedAt: "2026-10-24T20:30:01Z",
  };
}

export function readOnlyRecoveryClaims(): CredentialClaims {
  const caller = recoveryOrigin();
  const envelope = applyEnvelope();
  const effect = envelope.effect as NonNullable<OperationEnvelope["effect"]>;
  const iat = epochSeconds("2026-10-24T20:30:00Z");
  return {
    typ: "ks-knowledge-operation+jwt",
    iss: caller.issuer,
    aud: "knowledge-services",
    sub: caller.subject,
    jti: "jti-recovery-0009",
    iat,
    nbf: iat,
    exp: iat + 300,
    tenant: caller.tenantId,
    application: caller.applicationId,
    binding: envelope.binding,
    origin: caller,
    operations: ["receipt.get"],
    effect: null,
    dispatchId: "dispatch-0009",
    recovery: {
      scope: "read_only",
      authorityRef: caller.recoveryAuthorityRef as string,
      effectKey: effect.effectKey,
      boundEffectDigest: effect.boundEffectDigest,
    },
  };
}

export function applyEnvelope(): OperationEnvelope {
  const origin = missionOrigin();
  const effect = bindEffect({ effectKey: "effect-0001", nativePayload: PAYLOAD, originatingOrigin: origin });
  return {
    protocolVersion: "ks.knowledge_operation.v2",
    requestId: "req-0001",
    dispatchId: "dispatch-0001",
    tenant: origin.tenantId,
    application: "ai-engineer",
    binding: "aiengineer-postgres",
    operation: "knowledge.apply",
    effect,
    target: { handle: null, effectKey: null },
    cancelRequestId: null,
    input: {
      nativeContract: { name: "knowledge-ingestion-intent", version: "v1" },
      payloadDigest: digestBytes(PAYLOAD),
      payloadBytes: PAYLOAD.byteLength,
      payloadRef: {
        kind: "artifact",
        id: "artifact-intent-0001",
        version: "artifact.v1",
        digest: digestBytes(PAYLOAD),
        tenant: origin.tenantId,
        binding: "aiengineer-postgres",
      },
      inlinePayload: null,
      upstream: [],
    },
    governors: {
      deadline: "2026-10-24T20:10:00Z",
      maxItems: 64,
      partialResults: "forbid",
      budget: { calls: 0, tokens: 0, costUsd: "0" },
    },
    requiredCapabilities: ["knowledge.apply", "receiptLookup:by_effect_key"],
    pinnedSchema: {
      name: "aiengineer-database-contract",
      version: "aiengineer-database-contract.v1",
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
    },
    issuedAt: "2026-10-24T20:00:01Z",
  };
}

/** A `found` receipt lookup of an admitted Biotech effect with its delivery state composed from the outbox. */
export function pendingDispatchLookup() {
  const origin = missionOrigin({ applicationId: "biotech" });
  const effect = bindEffect({ effectKey: "effect-bg-0001", nativePayload: PAYLOAD, originatingOrigin: origin });
  const body = {
    handle: {
      protocolVersion: "ks.knowledge_operation.v2",
      tenant: origin.tenantId,
      application: "biotech",
      binding: "biotech-graph",
      operationId: "op-effect-bg-0001",
    },
    effect: {
      ...effect,
      currentCallerOrigin: origin,
      dispatchId: "dispatch-bg-0001",
      envelopeDigest: digestBytes("envelope-bg-0001"),
      dispatchSequence: 1,
    },
    outcome: "pending_dispatch",
    nativeReceiptRef: {
      kind: "receipt",
      id: "dsp-bg-0001",
      version: "knowledge-verification.dispatch_outbox.v1",
      digest: digestBytes("admission-payload-bg-0001"),
      tenant: origin.tenantId,
      binding: "biotech-graph",
    },
    affectedRefs: [],
    concurrencyToken: { before: null, after: null },
    processedRevocationEpoch: 0,
    itemOutcomes: [],
    appliedAt: "2026-10-24T20:01:00Z",
    details: { receiptState: "pending_dispatch", dispatchId: "dsp-bg-0001" },
  };
  return {
    disposition: "found",
    receipt: { ...body, digest: digestCanonical(body as unknown as JsonValue) },
    delivery: {
      state: "applied",
      dispatchId: "dsp-bg-0001",
      targetBinding: "biotech-graph",
      nativeState: "acknowledged",
      ackDigest: digestBytes("expected-marker-bg-0001"),
      ackedAt: "2026-10-24T20:02:00Z",
      graphTxRef: "neo4j-tx-0001",
      checkedAt: "2026-10-24T20:03:00Z",
    },
  };
}

const READ_TENANT = "00000000-0000-7000-8000-0000000000aa";
const READ_BINDING = "aiengineer-postgres";

/** A qualified handle naming an illustrative record by the digest of its canonical bytes. */
function handleOf<K extends RefKind>(kind: K, record: { id: string; schemaVersion: string }): Ref<K> {
  return {
    kind,
    id: record.id,
    version: record.schemaVersion,
    digest: digestCanonical(record as unknown as JsonValue),
    tenant: READ_TENANT,
    binding: READ_BINDING,
  };
}

/** Illustrative immutable records (wire shape only; their content is research-core's, not the protocol's). */
const READ_ASSERTION = {
  schemaVersion: "research-core.assertion.v2",
  id: "assertion-a-1",
  tenant: READ_TENANT,
  binding: READ_BINDING,
  proposition: "The cited trial enrolled 412 participants.",
};
const READ_FRAGMENT = {
  schemaVersion: "research-core.fragment.v2",
  id: "fragment-e-1",
  tenant: READ_TENANT,
  binding: READ_BINDING,
  selectedDigest: digestBytes("412 participants were enrolled"),
};
const READ_REPORT: Ref<"report"> = {
  kind: "report",
  id: "report-7-r1",
  version: "research-report.v2",
  digest: digestBytes("report-7-r1"),
  tenant: READ_TENANT,
  binding: READ_BINDING,
};

export function selectedMembersRead(): SelectedReportRead {
  return SelectedReportReadSchema.parse({
    report: READ_REPORT,
    exact: true,
    purpose: "evaluation_evidence",
    selection: {
      mode: "members",
      assertions: [handleOf("assertion", READ_ASSERTION)],
      evidence: [handleOf("fragment", READ_FRAGMENT)],
    },
  });
}

export function selectedRevisionRead(): SelectedReportRead {
  return SelectedReportReadSchema.parse({
    report: READ_REPORT,
    exact: true,
    purpose: "evaluation_subject",
    selection: { mode: "revision" },
  });
}

export function selectedMembersPackage(): ResearchReportPackage {
  const read = selectedMembersRead();
  return ResearchReportPackageSchema.parse({
    schema: REPORT_PACKAGE_VERSION,
    report: read.report,
    revision: read.report.id,
    kind: {
      kind: "report_kind",
      id: "evidence_report",
      version: "research-report-kind.v1",
      digest: digestBytes("evidence_report"),
      tenant: READ_TENANT,
      binding: READ_BINDING,
    },
    purpose: read.purpose,
    request: selectedReadDigest(read),
    selection: read.selection,
    body: null,
    ledger: null,
    assertions: [{ handle: handleOf("assertion", READ_ASSERTION), record: READ_ASSERTION }],
    evidence: [{ handle: handleOf("fragment", READ_FRAGMENT), record: READ_FRAGMENT }],
  });
}

const USE_DECISION: Ref<"use_decision"> = {
  kind: "use_decision",
  id: "ud-run-7-0123456789abcdef",
  version: "research-core.use_decision.v2",
  digest: digestBytes("ud-run-7-0123456789abcdef"),
  tenant: READ_TENANT,
  binding: READ_BINDING,
};

/** A judge evaluator credential (WI-03): own subject, own credential reference, a vendor other than the producer's. */
export function judgeClaims(): CredentialClaims {
  const origin = missionOrigin({ subject: "mission-control-judge", invocationId: "invocation-judge-0001" });
  const iat = epochSeconds("2026-10-27T20:00:00Z");
  return {
    typ: "ks-knowledge-operation+jwt",
    iss: origin.issuer,
    aud: "knowledge-services",
    sub: origin.subject,
    jti: "jti-judge-0001",
    iat,
    nbf: iat,
    exp: iat + 300,
    tenant: origin.tenantId,
    application: origin.applicationId,
    binding: "aiengineer-postgres",
    origin,
    operations: ["report.observe"],
    effect: null,
    dispatchId: "dispatch-judge-0001",
    recovery: null,
    evaluation: { role: "judge", credentialRef: "judge.default", provider: "openai", family: "gpt-6" },
  };
}

export function reportUseRequest(): ReportUseRequest {
  return ReportUseRequestSchema.parse({
    schema: "report-use.v1",
    report: READ_REPORT,
    subject: READ_REPORT,
    use: "report_consumption",
    audience: "official",
    purpose: "official",
    boundEffectDigest: digestCanonical({ report: READ_REPORT.digest, use: "report_consumption" }),
    targetSchema: "research-report.v2",
    normalizedValues: {},
    policy: { ...READ_REPORT, kind: "policy", id: "report-use-policy", version: "policy.v1", digest: digestBytes("p") },
    rubric: { ...READ_REPORT, kind: "rubric", id: "report-use-rubric", version: "rubric.v1", digest: digestBytes("r") },
    expiresAt: null,
  });
}

export function reportReviewRequest(): ReportReviewRequest {
  return ReportReviewRequestSchema.parse({
    schema: "report-review.v1",
    decision: USE_DECISION,
    outcome: "approve",
    boundEffectDigest: digestCanonical({ report: READ_REPORT.digest, use: "report_consumption" }),
    qualifiersDigest: null,
    rationale: "Premises, assumptions and stated uncertainty reviewed against the sealed evidence.",
  });
}

export function decisionResolveRequest(): DecisionResolveRequest {
  return DecisionResolveRequestSchema.parse({ schema: "decision-resolve.v1", decision: USE_DECISION });
}
