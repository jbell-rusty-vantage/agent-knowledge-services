import { KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION } from "@aiengineer/knowledge-application";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { canonicalizeJson, digestCanonicalJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { describe, expect, it, vi } from "vitest";
import { CaptureReadPersistenceError, PostgresCaptureReadRepository } from "./verification-capture-reads.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  operationId = id(2),
  attemptId = id(3),
  stepId = id(4),
  receiptId = id(5),
  eventId = id(6),
  at = "2026-09-07T00:00:00.000Z";
const source = {
  sourceId: id(7),
  kind: "web_page" as const,
  canonicalUri: "https://source.example/report",
  logicalIdentity: "fixture:source",
};
const handle = (n: number, name: string, mediaType = "application/json", parents: readonly string[] = []) => {
  const bytes = new TextEncoder().encode(name);
  return {
    artifactId: id(n),
    tenantId,
    digest: sha256Digest(bytes),
    mediaType,
    byteLength: bytes.byteLength,
    objectKey: `private/${name}`,
    createdAt: at,
    producerActivityId: "fixture",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "verification-audit",
    dataClassification: "restricted" as const,
    parentArtifactIds: [...parents],
  };
};
const context = {
  tenantId,
  operationId,
  attemptId,
  missionId: id(8),
  workItemId: id(9),
  correlationId: "capture-read",
  actor: { kind: "service" as const, id: id(10), serviceIdentity: "mission_control_client" as const },
  capabilityVersion: "verification-service.v1",
  idempotencyKey: "capture-read-key",
  reason: "test",
  contractVersion: "v1" as const,
};
const request = {
  verificationContractVersion: "verification.v1" as const,
  source: { mode: "acquire" as const, sourceKind: "web_page" as const, sourceUri: source.canonicalUri },
  requestedProjectionKinds: ["html_dom" as const],
};
const input = { schemaVersion: "verification-service-request.v1" as const, useCase: "captureSource" as const, request };
const durable = {
  schemaVersion: KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION,
  kind: "verification_capture" as const,
  input,
  expectedVersions: { verification: "verification.v1", service: "verification-service-request.v1" },
  authenticatedContext: context,
};
const step = {
  schemaVersion: KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION,
  kind: "verification_capture" as const,
  operationInput: input,
  expectedVersions: durable.expectedVersions,
  context,
  step: { name: "register_and_admit" as const, ordinal: 0 as const },
};

function fixture(
  change: Record<string, unknown> = {},
  patchReceipt: (metadata: any) => any = (metadata) => metadata,
  kind: "html" | "pdf" = "html",
  pdfKinds: readonly ["pdf_text", "geometry"] | readonly ["geometry", "pdf_text"] = ["pdf_text", "geometry"],
) {
  const localSource =
    kind === "pdf" ? { ...source, kind: "pdf" as const, canonicalUri: "https://source.example/report.pdf" } : source;
  const localRequest =
    kind === "pdf"
      ? {
          verificationContractVersion: "verification.v1" as const,
          source: { mode: "acquire" as const, sourceKind: "pdf" as const, sourceUri: localSource.canonicalUri },
          requestedProjectionKinds: pdfKinds,
        }
      : request;
  const contentWithoutSignature = handle(12, "content", kind === "pdf" ? "application/pdf" : "text/html", [id(11)]);
  const receiptMetadata = patchReceipt({
    schemaVersion: "verification-source-acquisition-receipt.v1" as const,
    tenantId,
    operationId,
    sourceId: localSource.sourceId,
    contentDigest: contentWithoutSignature.digest,
    response: {
      sourceKey: "fixture-source",
      sourceUri: localSource.canonicalUri,
      finalUri: localSource.canonicalUri,
      redirectUris: [] as string[],
      status: 200,
      mediaType: kind === "pdf" ? ("application/pdf" as const) : ("text/html" as const),
      capturedAt: at,
      responseMetadata: { contentLength: contentWithoutSignature.byteLength },
    },
  });
  const receiptBytes = new TextEncoder().encode(canonicalizeJson(receiptMetadata));
  const acquisition = {
    ...handle(11, "receipt", "application/vnd.aiengineer.verification-source-acquisition-receipt+json"),
    digest: sha256Digest(receiptBytes),
    byteLength: receiptBytes.byteLength,
    transformationSignature: digestCanonicalJson({
      relation: "verification_source_acquisition_receipt.v1",
      ...receiptMetadata,
    }),
  };
  const content = {
      ...contentWithoutSignature,
      parentArtifactIds: [acquisition.artifactId],
      transformationSignature: digestCanonicalJson({
        relation: "verification_source_acquisition.v1",
        receipt: acquisition,
        contentDigest: contentWithoutSignature.digest,
      }),
    },
    native = handle(13, "native"),
    projectionArtifact = handle(14, "projection"),
    transformation = {
      ...handle(15, "transformation", "application/vnd.aiengineer.verification-projection-admission+json", [
        content.artifactId,
        native.artifactId,
        projectionArtifact.artifactId,
      ]),
      transformationSignature: sha256Digest("transform"),
    };
  const capture = {
    captureId: id(16),
    sourceId: localSource.sourceId,
    capturedAt: at,
    captureMethod: "https_acquire",
    captureMethodVersion: "verification-source-acquisition.v1",
    contentArtifact: content,
  };
  const projection = {
    schemaVersion: "verification-projection-admission.v1" as const,
    captureId: capture.captureId,
    sourceArtifact: content,
    nativeOutputArtifact: native,
    projectionArtifact,
    transformationArtifact: transformation,
    projectionKind: kind === "pdf" ? ("pdf_text" as const) : ("html_dom" as const),
    projectionOrdinal: 0 as const,
    parserVersion: "verification-native-parser.v1" as const,
    imageDigest: `sha256:${"a".repeat(64)}`,
    parserOptionsDigest: `sha256:${"b".repeat(64)}`,
    parserTransformationSignature: `sha256:${"c".repeat(64)}`,
    residualsDigest: `sha256:${"d".repeat(64)}`,
  };
  const geometryArtifact = handle(18, "geometry"),
    geometryTransformation = {
      ...handle(19, "geometry-transformation", "application/vnd.aiengineer.verification-projection-admission+json", [
        content.artifactId,
        native.artifactId,
        handle(18, "geometry").artifactId,
      ]),
      transformationSignature: sha256Digest("geometry-transform"),
    };
  const geometry = {
    ...projection,
    projectionArtifact: geometryArtifact,
    transformationArtifact: geometryTransformation,
    projectionKind: "geometry" as const,
    projectionOrdinal: 1 as const,
  };
  const projections = kind === "pdf" ? [projection, geometry] : [projection];
  const bound =
      kind === "pdf"
        ? [acquisition, content, native, projectionArtifact, transformation, geometryArtifact, geometryTransformation]
        : [acquisition, content, native, projectionArtifact, transformation],
    body = {
      schemaVersion: "verification-operation-result.v1" as const,
      operationId,
      useCase: "captureSource" as const,
      requestDigest: digestCanonicalJson(localRequest),
      boundArtifacts: bound,
      output: { request: localRequest, capture, projections, acquisitionReceipt: acquisition },
    };
  const bytes = new TextEncoder().encode(canonicalizeJson(body));
  const resultArtifact = {
    ...handle(
      17,
      "result",
      "application/vnd.aiengineer.verification-operation-result+json",
      bound.map((item) => item.artifactId),
    ),
    digest: sha256Digest(bytes),
    byteLength: bytes.byteLength,
    producerActivityId: "verification-service:captureSource",
  };
  const result = { ...body, resultArtifact },
    outputSha = digestCanonicalJson(result).slice(7);
  const localInput = { ...input, request: localRequest },
    localDurable = { ...durable, input: localInput },
    localStep = { ...step, operationInput: localInput };
  const row = {
    status: "succeeded",
    request: localDurable,
    request_sha256: digestCanonicalJson(localDurable).slice(7),
    idempotency_key: context.idempotencyKey,
    actor_identity: `service:${context.actor.id}`,
    attempt_id: attemptId,
    mission_id: context.missionId,
    work_item_id: context.workItemId,
    correlation_id: deterministicUuid("correlation", context.correlationId),
    causation_id: null,
    ownership_mode: "standalone",
    external_run_id: null,
    step_id: stepId,
    step_status: "succeeded",
    step_key: "register_and_admit",
    step_kind: "register_and_admit",
    input: localStep,
    input_sha256: digestCanonicalJson(localStep).slice(7),
    receipt_id: receiptId,
    receipt_kind: "register_and_admit.succeeded",
    outcome: "succeeded",
    receipt_input_sha256: digestCanonicalJson(localStep).slice(7),
    output_sha256: outputSha,
    body: { ...result, eventId, fencingToken: 3 },
    artifact_id: resultArtifact.artifactId,
    artifact_type: "verification_bundle",
    bucket_class: "ledger",
    event_id: eventId,
    event_operation_id: operationId,
    event_step_id: stepId,
    event_kind: "step.succeeded",
    event_from_state: "running",
    event_to_state: "succeeded",
    event_guarded_sha256: outputSha,
    event_payload: { outputSha256: outputSha, fencingToken: "3" },
    ...change,
  };
  return {
    row,
    result,
    resultArtifact,
    bytes,
    acquisition,
    receiptBytes,
    source: localSource,
    capture,
    projection,
    projections,
  };
}
function subject(value: ReturnType<typeof fixture>) {
  const hydrate = vi.fn(async ({ artifactId }: { artifactId: string }) => {
    if (artifactId === value.resultArtifact.artifactId)
      return { registration: value.resultArtifact, bytes: value.bytes };
    if (artifactId === value.acquisition.artifactId)
      return { registration: value.acquisition, bytes: value.receiptBytes };
    throw new Error(`UNEXPECTED_HYDRATE:${artifactId}`);
  });
  const repository = {
    createTrustedArtifactResolver: () => ({ authorizeArtifact: vi.fn(), hydrateRegisteredArtifact: hydrate }),
    getRegisteredCapture: vi.fn(async () => ({ source: value.source, capture: value.capture })),
  };
  const admission = {
    hydrateAdmittedProjection: vi.fn(async ({ projectionArtifactId }: { projectionArtifactId: string }) => {
      const receipt = value.projections.find(
        (projection: any) => projection.projectionArtifact.artifactId === projectionArtifactId,
      );
      if (!receipt) throw new Error("UNEXPECTED_PROJECTION");
      return { receipt, projection: { kind: receipt.projectionKind }, content: new Uint8Array() };
    }),
  };
  const database = {
    transaction: async (_tenant: string, work: (client: any) => Promise<any>) =>
      work({ query: async () => ({ rows: [value.row] }) }),
  };
  return {
    read: new PostgresCaptureReadRepository(database as never, repository as never, admission as never),
    hydrate,
    repository,
    admission,
  };
}

describe("PostgresCaptureReadRepository", () => {
  it("authenticates terminal receipt, stored result bytes, registered source, and native projection re-admission", async () => {
    const value = fixture(),
      test = subject(value),
      loaded = await test.read.loadVerifiedCapture(tenantId, operationId);
    expect(loaded).toMatchObject({
      state: "succeeded",
      result: { operationId, useCase: "captureSource" },
      registeredSource: { capture: { captureId: value.capture.captureId } },
    });
    expect(test.hydrate).toHaveBeenCalledTimes(2);
    expect(test.repository.getRegisteredCapture).toHaveBeenCalledWith({ tenantId, captureId: value.capture.captureId });
    expect(test.admission.hydrateAdmittedProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        captureId: value.capture.captureId,
        transformationArtifactId: value.projection.transformationArtifact.artifactId,
        projectionArtifactId: value.projection.projectionArtifact.artifactId,
      }),
    );
  });
  it("hydrates both ordered PDF projections while retaining one deduplicated native-output custody role", async () => {
    const value = fixture({}, undefined, "pdf"),
      test = subject(value),
      loaded = await test.read.loadVerifiedCapture(tenantId, operationId);
    expect(loaded).toMatchObject({
      state: "succeeded",
      result: {
        output: {
          projections: [
            { projectionKind: "pdf_text", projectionOrdinal: 0 },
            { projectionKind: "geometry", projectionOrdinal: 1 },
          ],
        },
      },
    });
    expect(test.admission.hydrateAdmittedProjection).toHaveBeenCalledTimes(2);
    expect(test.admission.hydrateAdmittedProjection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectionArtifactId: value.projections[0]!.projectionArtifact.artifactId }),
    );
    expect(test.admission.hydrateAdmittedProjection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ projectionArtifactId: value.projections[1]!.projectionArtifact.artifactId }),
    );
  });
  it("rejects resealed PDF request ordering and compact parser metadata drift before projection hydration", async () => {
    const wrongOrder = subject(fixture({}, undefined, "pdf", ["geometry", "pdf_text"]));
    await expect(wrongOrder.read.loadVerifiedCapture(tenantId, operationId)).rejects.toMatchObject({
      code: "INTEGRITY",
    });
    expect(wrongOrder.admission.hydrateAdmittedProjection).not.toHaveBeenCalled();
    const driftValue = fixture({}, undefined, "pdf");
    driftValue.result.output.projections[1]!.parserOptionsDigest = `sha256:${"9".repeat(64)}`;
    const drift = subject(driftValue);
    await expect(drift.read.loadVerifiedCapture(tenantId, operationId)).rejects.toMatchObject({ code: "INTEGRITY" });
    expect(drift.admission.hydrateAdmittedProjection).not.toHaveBeenCalled();
  });
  it("rejects malformed identity and fence/result lineage before Storage hydration", async () => {
    const invalid = new PostgresCaptureReadRepository(
      {
        transaction: async () => {
          throw new Error("DATABASE_SHOULD_NOT_RUN");
        },
      } as never,
      {} as never,
      {} as never,
    );
    await expect(invalid.loadVerifiedCapture("bad", "also-bad")).rejects.toMatchObject({ code: "INVALID" });
    for (const changed of [
      { event_payload: { outputSha256: "bad", fencingToken: "3" } },
      { artifact_type: "source_capture" },
      { step_key: "wrong" },
    ]) {
      const test = subject(fixture(changed));
      await expect(test.read.loadVerifiedCapture(tenantId, operationId)).rejects.toMatchObject({ code: "INTEGRITY" });
      expect(test.hydrate).not.toHaveBeenCalled();
    }
  });
  it("rejects source/projection re-admission drift and rechecks the terminal snapshot", async () => {
    const value = fixture(),
      test = subject(value);
    test.admission.hydrateAdmittedProjection.mockResolvedValue({
      receipt: { ...value.projection, captureId: id(99) },
      projection: { kind: "html_dom" },
      content: new Uint8Array(),
    });
    await expect(test.read.loadVerifiedCapture(tenantId, operationId)).rejects.toMatchObject({ code: "INTEGRITY" });
  });
  it("rejects an acquire receipt whose hydrated bytes or registration do not match the signed terminal handle", async () => {
    for (const mutation of [
      (value: ReturnType<typeof fixture>) => ({
        registration: value.acquisition,
        bytes: new TextEncoder().encode("{}"),
      }),
      (value: ReturnType<typeof fixture>) => ({
        registration: { ...value.acquisition, parentArtifactIds: [value.capture.contentArtifact.artifactId] },
        bytes: value.receiptBytes,
      }),
    ]) {
      const value = fixture(),
        test = subject(value),
        base = test.hydrate.getMockImplementation()!;
      test.hydrate.mockImplementation(async (input) =>
        input.artifactId === value.acquisition.artifactId ? mutation(value) : base(input),
      );
      await expect(test.read.loadVerifiedCapture(tenantId, operationId)).rejects.toMatchObject({ code: "INTEGRITY" });
      expect(test.admission.hydrateAdmittedProjection).not.toHaveBeenCalled();
    }
  });
  it("rejects canonical receipt metadata that does not bind the terminal operation or acquisition response", async () => {
    for (const patch of [
      (metadata: any) => ({ ...metadata, operationId: id(99) }),
      (metadata: any) => ({
        ...metadata,
        response: { ...metadata.response, finalUri: "https://other.example/redirect" },
      }),
    ]) {
      const test = subject(fixture({}, patch));
      await expect(test.read.loadVerifiedCapture(tenantId, operationId)).rejects.toMatchObject({ code: "INTEGRITY" });
      expect(test.admission.hydrateAdmittedProjection).not.toHaveBeenCalled();
    }
  });
});
