import { describe, expect, it, vi } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import {
  structuredExtractionArtifactTransformationSignature,
  type RetainedStructuredExtractionCandidate,
} from "@aiengineer/knowledge-application";
import { canonicalizeJson, digestCanonicalJson, sha256Digest } from "@aiengineer/knowledge-verification";
import {
  PostgresStructuredExtractionLifecycleStore,
  type DurableStructuredExtractionLifecycle,
  type StructuredExtractionLifecycleIdentity,
} from "./verification-structured-extraction-lifecycle.js";
import type { LeasedStep } from "./types.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const startedAt = "2026-09-06T03:20:00.000Z";
const capturedAt = "2026-09-06T03:20:01.123Z";
const retainingAt = "2026-09-06T03:20:01.124Z";
const completedAt = "2026-09-06T03:20:02.000Z";
const bytes = (value: unknown) => new TextEncoder().encode(canonicalizeJson(value));
const handle = (value: number, overrides: Partial<VerificationArtifactHandle> = {}): VerificationArtifactHandle => ({
  artifactId: id(value),
  tenantId: id(1),
  digest: digestCanonicalJson({ value }),
  mediaType: "application/json",
  byteLength: 16,
  objectKey: `${id(1)}/${value}`,
  createdAt: startedAt,
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
  ...overrides,
});

const identity = (): StructuredExtractionLifecycleIdentity => ({
  tenantId: id(1),
  operationId: id(2),
  operationStepId: id(3),
  producerAttemptId: id(4),
  requestDigest: digestCanonicalJson("operation"),
  stepInputDigest: digestCanonicalJson("step"),
  captureId: id(5),
  profileArtifact: handle(6),
  schemaArtifact: handle(7),
  sourceArtifact: handle(8),
  representationArtifact: handle(9),
  transformationArtifact: handle(10),
  promptDigest: digestCanonicalJson("prompt"),
  schemaDigest: digestCanonicalJson("schema"),
});
const lease: LeasedStep = {
  id: id(3),
  tenantId: id(1),
  operationId: id(2),
  stepKey: "extract_and_register",
  stepKind: "extract_and_register",
  inputSha256: digestCanonicalJson("step").slice(7),
  status: "running",
  attemptCount: 1,
  maxAttempts: 3,
  rowVersion: 1,
  holderIdentity: "worker",
  leaseToken: id(11),
  fencingToken: 2,
  expiresAt: "2026-09-06T03:30:00.000Z",
};
const capture = {
  tenantId: id(1),
  providerAttemptId: id(12),
  operationId: id(2),
  operationStepId: id(3),
  profileArtifactId: id(6),
  profileDigest: digestCanonicalJson({ value: 6 }),
  dispatchFencingToken: 1,
  httpStatus: 200,
  responseEnvelopeArtifactId: id(15),
  transportArtifactId: id(16),
  transportDigest: digestCanonicalJson({ value: 16 }),
  capturedAt,
} as const;

function row(status: "running" | "retaining" | "retained" = "running") {
  const value = identity(),
    retaining = status !== "running",
    retained = status === "retained";
  return {
    id: id(20),
    tenant_id: value.tenantId,
    operation_id: value.operationId,
    operation_step_id: value.operationStepId,
    producer_attempt_id: value.producerAttemptId,
    identity_sha256: digestCanonicalJson(value).slice(7),
    request_sha256: value.requestDigest.slice(7),
    step_input_sha256: value.stepInputDigest.slice(7),
    capture_id: value.captureId,
    profile_artifact_id: value.profileArtifact.artifactId,
    profile_sha256: value.profileArtifact.digest.slice(7),
    schema_artifact_id: value.schemaArtifact.artifactId,
    schema_artifact_sha256: value.schemaArtifact.digest.slice(7),
    source_artifact_id: value.sourceArtifact.artifactId,
    source_sha256: value.sourceArtifact.digest.slice(7),
    representation_artifact_id: value.representationArtifact.artifactId,
    representation_sha256: value.representationArtifact.digest.slice(7),
    transformation_artifact_id: value.transformationArtifact.artifactId,
    transformation_sha256: value.transformationArtifact.digest.slice(7),
    prompt_sha256: value.promptDigest.slice(7),
    schema_digest_sha256: value.schemaDigest.slice(7),
    status,
    started_at: startedAt,
    retention_started_at: retaining ? retainingAt : null,
    completed_at: retained ? completedAt : null,
    provider_attempt_id: retaining ? capture.providerAttemptId : null,
    original_dispatch_fencing_token: retaining ? capture.dispatchFencingToken : null,
    http_status: retaining ? capture.httpStatus : null,
    captured_at: retaining ? capture.capturedAt : null,
    provider_request_artifact_id: retaining ? id(13) : null,
    provider_request_sha256: retaining ? digestCanonicalJson({ value: 13 }).slice(7) : null,
    raw_response_artifact_id: retaining ? id(14) : null,
    raw_response_sha256: retaining ? digestCanonicalJson({ value: 14 }).slice(7) : null,
    response_envelope_artifact_id: retaining ? id(15) : null,
    response_envelope_sha256: retaining ? digestCanonicalJson({ value: 15 }).slice(7) : null,
    transport_artifact_id: retaining ? id(16) : null,
    transport_sha256: retaining ? digestCanonicalJson({ value: 16 }).slice(7) : null,
    candidate_artifact_id: retained ? id(17) : null,
    candidate_sha256: null,
    precontext_artifact_id: null,
    precontext_sha256: null,
    provenance_artifact_id: retained ? id(18) : null,
    provenance_sha256: null,
  };
}

const artifactRow = (artifact: VerificationArtifactHandle) => ({
  id: artifact.artifactId,
  tenant_id: artifact.tenantId,
  sha256: artifact.digest.slice(7),
  media_type: artifact.mediaType,
  size_bytes: artifact.byteLength,
  object_path: artifact.objectKey,
  created_at: artifact.createdAt,
  producer_activity_id: artifact.producerActivityId,
  producer_version: artifact.producerVersion,
  content_encoding: artifact.contentEncoding ?? null,
  encryption_class: artifact.encryptionClass,
  retention_class: artifact.retentionClass,
  data_classification: artifact.dataClassification,
  parent_artifact_ids: artifact.parentArtifactIds,
  transformation_signature: artifact.transformationSignature?.slice(7) ?? null,
  attestation_artifact_id: artifact.attestationArtifactId ?? null,
});

function database(
  stored: Record<string, unknown>,
  artifacts: ReadonlyMap<string, VerificationArtifactHandle> = new Map(),
) {
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    if (sql.startsWith("select id from knowledge_service.operation")) return { rows: [{ id: id(2) }] };
    if (sql.startsWith("select step.id from knowledge_service.operation_step")) return { rows: [{ id: id(3) }] };
    if (sql.startsWith("select set_config")) return { rows: [] };
    if (sql.startsWith("select provider.id")) return { rows: [{ id: capture.providerAttemptId }] };
    if (sql.startsWith("select * from orchestration.verification_structured_extraction")) return { rows: [stored] };
    if (sql.startsWith("select a.id,a.tenant_id")) {
      const artifact = artifacts.get(String(params?.[1]));
      return { rows: artifact ? [artifactRow(artifact)] : [] };
    }
    throw new Error(`UNEXPECTED_SQL:${sql.slice(0, 48)}`);
  });
  const transaction = vi.fn(async (_tenant: string, work: (client: { query: typeof query }) => Promise<unknown>) =>
    work({ query }),
  );
  return { store: new PostgresStructuredExtractionLifecycleStore({ transaction } as never), query, transaction };
}

function retainingLifecycle(): DurableStructuredExtractionLifecycle {
  const value = identity();
  const providerRequestArtifact = handle(13),
    rawResponseArtifact = handle(14),
    responseEnvelopeArtifact = handle(15),
    transportArtifact = handle(16);
  return {
    identity: value,
    identityDigest: digestCanonicalJson(value),
    status: "retaining",
    startedAt,
    retentionStartedAt: retainingAt,
    completedAt: null,
    capture,
    providerRequestArtifact,
    rawResponseArtifact,
    responseEnvelopeArtifact,
    transportArtifact,
    candidateArtifact: null,
    precontextArtifact: null,
    provenanceArtifact: null,
  };
}

function runningLifecycle(): DurableStructuredExtractionLifecycle {
  const value = identity();
  return {
    identity: value,
    identityDigest: digestCanonicalJson(value),
    status: "running",
    startedAt,
    retentionStartedAt: null,
    completedAt: null,
    capture: null,
    providerRequestArtifact: null,
    rawResponseArtifact: null,
    responseEnvelopeArtifact: null,
    transportArtifact: null,
    candidateArtifact: null,
    precontextArtifact: null,
    provenanceArtifact: null,
  };
}

function candidate(lifecycle: DurableStructuredExtractionLifecycle): RetainedStructuredExtractionCandidate {
  const value = lifecycle.identity,
    output = { value: "42" },
    outputDigest = sha256Digest(bytes(output));
  const parents = [
    value.profileArtifact.artifactId,
    value.schemaArtifact.artifactId,
    value.sourceArtifact.artifactId,
    value.representationArtifact.artifactId,
    value.transformationArtifact.artifactId,
    lifecycle.transportArtifact!.artifactId,
    lifecycle.responseEnvelopeArtifact!.artifactId,
    lifecycle.providerRequestArtifact!.artifactId,
    lifecycle.rawResponseArtifact!.artifactId,
  ];
  const envelope = {
    schemaVersion: "verification-extraction-candidate.v1",
    tenantId: value.tenantId,
    operationId: value.operationId,
    providerAttemptId: capture.providerAttemptId,
    originalDispatchFencingToken: capture.dispatchFencingToken,
    profileArtifactId: value.profileArtifact.artifactId,
    profileDigest: value.profileArtifact.digest,
    promptDigest: value.promptDigest,
    schemaDigest: value.schemaDigest,
    outputDigest,
    outputVerification: "unverified_candidate",
    output,
  };
  const envelopeBytes = bytes(envelope),
    envelopeDigest = sha256Digest(envelopeBytes);
  const candidateArtifact = handle(17, {
    digest: envelopeDigest,
    byteLength: envelopeBytes.byteLength,
    createdAt: retainingAt,
    parentArtifactIds: parents,
    transformationSignature: structuredExtractionArtifactTransformationSignature({
      artifactType: "verification_extraction_candidate",
      payloadDigest: envelopeDigest,
      tenantId: value.tenantId,
      operationId: value.operationId,
      providerAttemptId: capture.providerAttemptId,
      originalDispatchFencingToken: capture.dispatchFencingToken,
      profileArtifactId: value.profileArtifact.artifactId,
      profileDigest: value.profileArtifact.digest as `sha256:${string}`,
      promptDigest: value.promptDigest as `sha256:${string}`,
      schemaDigest: value.schemaDigest as `sha256:${string}`,
      parentArtifactIds: parents,
    }),
  });
  const provenance: RetainedStructuredExtractionCandidate["provenance"] = {
    schemaVersion: "verification-structured-extraction-provenance.v1",
    tenantId: value.tenantId,
    operationId: value.operationId,
    providerAttemptId: capture.providerAttemptId,
    operationStepId: value.operationStepId,
    originalDispatchFencingToken: capture.dispatchFencingToken,
    createdAt: retainingAt,
    producerAttemptId: value.producerAttemptId,
    status: "unverified_candidate",
    profile: {
      artifact: value.profileArtifact,
      profileId: "registered_default",
      profileVersion: "fixture.v1",
      providerId: "gateway-structured-extraction.v1",
      providerConfigurationDigest: digestCanonicalJson("provider"),
    },
    extraction: {
      schemaArtifact: value.schemaArtifact,
      schemaId: "fixture",
      schemaVersion: "1",
      schemaDigest: value.schemaDigest as `sha256:${string}`,
      promptDigest: value.promptDigest as `sha256:${string}`,
      selectedEvidence: [{ path: "/value", selectedContentDigest: digestCanonicalJson("42") }],
    },
    input: {
      captureId: value.captureId,
      sourceArtifact: value.sourceArtifact,
      representationArtifact: value.representationArtifact,
      transformationArtifact: value.transformationArtifact,
    },
    response: {
      transportArtifact: lifecycle.transportArtifact!,
      responseEnvelopeArtifact: lifecycle.responseEnvelopeArtifact!,
      requestArtifact: lifecycle.providerRequestArtifact!,
      rawResponseArtifact: lifecycle.rawResponseArtifact!,
      httpStatus: capture.httpStatus,
      capturedAt: capture.capturedAt,
      externalRequests: 0,
      memoryFetches: 1,
    },
    candidate: {
      artifact: candidateArtifact,
      digest: candidateArtifact.digest as `sha256:${string}`,
      outputDigest,
      byteLength: candidateArtifact.byteLength,
      status: "unverified_candidate",
    },
    precontext: null,
  };
  const provenanceBytes = bytes(provenance),
    provenanceDigest = sha256Digest(provenanceBytes),
    provenanceParents = [candidateArtifact.artifactId, ...parents];
  const provenanceArtifact = handle(18, {
    digest: provenanceDigest,
    byteLength: provenanceBytes.byteLength,
    createdAt: retainingAt,
    parentArtifactIds: provenanceParents,
    transformationSignature: structuredExtractionArtifactTransformationSignature({
      artifactType: "verification_structured_extraction_provenance",
      payloadDigest: provenanceDigest,
      tenantId: value.tenantId,
      operationId: value.operationId,
      providerAttemptId: capture.providerAttemptId,
      originalDispatchFencingToken: capture.dispatchFencingToken,
      profileArtifactId: value.profileArtifact.artifactId,
      profileDigest: value.profileArtifact.digest as `sha256:${string}`,
      promptDigest: value.promptDigest as `sha256:${string}`,
      schemaDigest: value.schemaDigest as `sha256:${string}`,
      parentArtifactIds: provenanceParents,
    }),
  });
  return {
    status: "unverified_candidate",
    output,
    candidateArtifact,
    precontextArtifact: null,
    provenance,
    provenanceArtifact,
  };
}

describe("structured extraction lifecycle persistence", () => {
  it("recovers the original running timestamp under an exact replacement lease", async () => {
    const subject = database(row());
    const result = await subject.store.initialize({ identity: identity(), lease });
    expect(result.status).toBe("running");
    expect(result.startedAt).toBe(startedAt);
    expect(subject.query.mock.calls.map(([sql]) => String(sql).split(" ")[0])).toEqual([
      "select",
      "select",
      "select",
      "select",
    ]);
  });

  it("rejects malformed and stale lease authority before lifecycle access", async () => {
    const malformed = database(row());
    await expect(
      malformed.store.initialize({ identity: identity(), lease: { ...lease, leaseToken: "bad" } }),
    ).rejects.toThrow("LIFECYCLE_LEASE_INVALID");
    expect(malformed.transaction).not.toHaveBeenCalled();
    const stale = database(row());
    stale.query.mockImplementationOnce(async () => ({ rows: [] }));
    await expect(stale.store.initialize({ identity: identity(), lease })).rejects.toThrow("OPERATION_NOT_ACTIVE");
    expect(
      stale.query.mock.calls.some(([sql]) => String(sql).includes("verification_structured_extraction where")),
    ).toBe(false);
  });

  it("rejects persisted immutable identity drift", async () => {
    const changed = row();
    changed.source_sha256 = "f".repeat(64);
    await expect(database(changed).store.initialize({ identity: identity(), lease })).rejects.toThrow("IDENTITY_DRIFT");
  });

  it("returns the original retention time on an exact capture retry", async () => {
    const artifacts = new Map([13, 14, 15, 16].map((value) => [id(value), handle(value)]));
    const result = await database(row("retaining"), artifacts).store.beginRetention({
      lifecycle: runningLifecycle(),
      lease,
      capture,
    });
    expect(result.status).toBe("retaining");
    expect(result.retentionStartedAt).toBe(retainingAt);
    expect(result.capture).toEqual(capture);
  });

  it("rejects changed candidate output before opening a transaction", async () => {
    const lifecycle = retainingLifecycle(),
      retained = candidate(lifecycle),
      subject = database(row("retaining"));
    const changed = { ...retained, output: { value: "changed" } };
    await expect(subject.store.completeRetention({ lifecycle, lease, candidate: changed })).rejects.toThrow(
      "LIFECYCLE_PAYLOAD_DRIFT",
    );
    expect(subject.transaction).not.toHaveBeenCalled();
  });

  it("returns the original completion time on an exact retained candidate retry", async () => {
    const lifecycle = retainingLifecycle(),
      retained = candidate(lifecycle);
    const stored = {
      ...row("retained"),
      candidate_sha256: retained.candidateArtifact.digest.slice(7),
      provenance_sha256: retained.provenanceArtifact.digest.slice(7),
    };
    const artifacts = new Map<string, VerificationArtifactHandle>(
      [13, 14, 15, 16].map((value) => [id(value), handle(value)]),
    );
    artifacts.set(retained.candidateArtifact.artifactId, retained.candidateArtifact);
    artifacts.set(retained.provenanceArtifact.artifactId, retained.provenanceArtifact);
    const result = await database(stored, artifacts).store.completeRetention({ lifecycle, lease, candidate: retained });
    expect(result.status).toBe("retained");
    expect(result.completedAt).toBe(completedAt);
    expect(result.candidateArtifact).toEqual(retained.candidateArtifact);
    expect(result.provenanceArtifact).toEqual(retained.provenanceArtifact);
  });
});
