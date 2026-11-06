import { describe, expect, it } from "vitest";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { digestCanonicalJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { VerificationCaptureReadApplicationService } from "./verification-capture-reads.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const source = {
  sourceId: "33333333-3333-4333-8333-333333333333",
  kind: "web_page",
  canonicalUri: "https://source.example/report",
  logicalIdentity: "fixture:source",
} as const;
const handle = (name: string, mediaType: string, parents: readonly string[] = []) => {
  const digest = sha256Digest(new TextEncoder().encode(name));
  return {
    artifactId: deterministicUuid("capture-read", name),
    tenantId,
    digest,
    mediaType,
    byteLength: name.length,
    objectKey: `${tenantId}/${name}`,
    createdAt: "2026-09-07T00:00:00.000Z",
    producerActivityId: "fixture",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted" as const,
    parentArtifactIds: [...parents],
  };
};
function fixture() {
  const receipt = handle("receipt", "application/vnd.aiengineer.verification-source-acquisition-receipt+json");
  const content = handle("content", "text/html", [receipt.artifactId]);
  const native = handle("native", "application/vnd.aiengineer.verification-parser-output+json");
  const projectionArtifact = handle("projection", "application/vnd.aiengineer.verification-projection.html_dom+json");
  const transformation = {
    ...handle("transformation", "application/vnd.aiengineer.verification-projection-admission+json", [
      content.artifactId,
      native.artifactId,
      projectionArtifact.artifactId,
    ]),
    transformationSignature: sha256Digest(new TextEncoder().encode("transformation")),
  };
  const resultArtifact = handle("result", "application/vnd.aiengineer.verification-operation-result+json", [
    receipt.artifactId,
    content.artifactId,
    native.artifactId,
    projectionArtifact.artifactId,
    transformation.artifactId,
  ]);
  const request = {
    verificationContractVersion: "verification.v1" as const,
    source: { mode: "acquire" as const, sourceKind: "web_page" as const, sourceUri: source.canonicalUri },
    requestedProjectionKinds: ["html_dom" as const],
  };
  const capture = {
    captureId: "44444444-4444-4444-8444-444444444444",
    sourceId: source.sourceId,
    capturedAt: "2026-09-07T00:00:00.000Z",
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
    projectionKind: "html_dom" as const,
    projectionOrdinal: 0 as const,
    parserVersion: "verification-native-parser.v1" as const,
    imageDigest: `sha256:${"a".repeat(64)}`,
    parserOptionsDigest: `sha256:${"b".repeat(64)}`,
    parserTransformationSignature: `sha256:${"c".repeat(64)}`,
    residualsDigest: `sha256:${"d".repeat(64)}`,
  };
  return {
    state: "succeeded" as const,
    result: {
      schemaVersion: "verification-operation-result.v1" as const,
      operationId,
      useCase: "captureSource" as const,
      requestDigest: digestCanonicalJson(request),
      boundArtifacts: [receipt, content, native, projectionArtifact, transformation],
      output: { request, capture, projections: [projection], acquisitionReceipt: receipt },
      resultArtifact,
    },
    registeredSource: { source, capture },
  };
}
function pdfFixture() {
  const value: any = fixture();
  const receipt = value.result.output.acquisitionReceipt;
  const content = { ...value.result.output.capture.contentArtifact, mediaType: "application/pdf" };
  const native = value.result.output.projections[0].nativeOutputArtifact;
  const textArtifact = handle("pdf-text", "application/vnd.aiengineer.verification-projection.pdf_text+json");
  const textTransformation = {
    ...handle("pdf-text-envelope", "application/vnd.aiengineer.verification-projection-admission+json", [
      content.artifactId,
      native.artifactId,
      textArtifact.artifactId,
    ]),
    transformationSignature: sha256Digest(new TextEncoder().encode("pdf-text-envelope")),
  };
  const geometryArtifact = handle("pdf-geometry", "application/vnd.aiengineer.verification-projection.geometry+json");
  const geometryTransformation = {
    ...handle("pdf-geometry-envelope", "application/vnd.aiengineer.verification-projection-admission+json", [
      content.artifactId,
      native.artifactId,
      geometryArtifact.artifactId,
    ]),
    transformationSignature: sha256Digest(new TextEncoder().encode("pdf-geometry-envelope")),
  };
  const capture = { ...value.result.output.capture, contentArtifact: content };
  const projection = (
    projectionKind: "pdf_text" | "geometry",
    projectionOrdinal: 0 | 1,
    projectionArtifact: any,
    transformationArtifact: any,
  ) => ({
    ...value.result.output.projections[0],
    captureId: capture.captureId,
    sourceArtifact: content,
    nativeOutputArtifact: native,
    projectionArtifact,
    transformationArtifact,
    projectionKind,
    projectionOrdinal,
  });
  const projections = [
    projection("pdf_text", 0, textArtifact, textTransformation),
    projection("geometry", 1, geometryArtifact, geometryTransformation),
  ];
  const request = {
    verificationContractVersion: "verification.v1",
    source: { mode: "acquire", sourceKind: "pdf", sourceUri: "https://source.example/report.pdf" },
    requestedProjectionKinds: ["pdf_text", "geometry"],
  };
  const source = { ...value.registeredSource.source, kind: "pdf", canonicalUri: request.source.sourceUri };
  value.result.output = { request, capture, projections, acquisitionReceipt: receipt };
  value.result.requestDigest = digestCanonicalJson(request);
  value.result.boundArtifacts = [
    receipt,
    content,
    native,
    textArtifact,
    textTransformation,
    geometryArtifact,
    geometryTransformation,
  ];
  value.result.resultArtifact = {
    ...value.result.resultArtifact,
    parentArtifactIds: value.result.boundArtifacts.map((item: any) => item.artifactId),
  };
  value.registeredSource = { source, capture };
  return value;
}

describe("VerificationCaptureReadApplicationService", () => {
  it("projects an acquired terminal capture without bytes, object keys, or response headers", async () => {
    const value = fixture();
    const resource = await new VerificationCaptureReadApplicationService({
      loadVerifiedCapture: async () => value,
    }).getCapture({ tenantId, operationId });
    expect(resource).toMatchObject({
      captureMode: "acquire",
      disposition: "captured_without_admission",
      capture: { contentArtifact: { sizeBytes: "content".length } },
      projections: [{ projectionKind: "html_dom", projectionOrdinal: 0 }],
    });
    expect(JSON.stringify(resource)).not.toContain("objectKey");
    expect(JSON.stringify(resource)).not.toContain("responseMetadata");
  });

  it("projects the exact acquired PDF text-plus-geometry custody pair", async () => {
    const value = pdfFixture();
    const resource = await new VerificationCaptureReadApplicationService({
      loadVerifiedCapture: async () => value,
    }).getCapture({ tenantId, operationId });
    expect(resource).toMatchObject({
      captureMode: "acquire",
      source: { kind: "pdf" },
      capture: { contentArtifact: { mediaType: "application/pdf" } },
      projections: [
        { projectionKind: "pdf_text", projectionOrdinal: 0 },
        { projectionKind: "geometry", projectionOrdinal: 1 },
      ],
    });
    const badNative = pdfFixture();
    badNative.result.output.projections[1].nativeOutputArtifact = handle("other-native", "application/json");
    await expect(
      new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => badNative }).getCapture({
        tenantId,
        operationId,
      }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_SOURCE_BINDING");
    const parserDrift = pdfFixture();
    parserDrift.result.output.projections[1].parserOptionsDigest = `sha256:${"9".repeat(64)}`;
    await expect(
      new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => parserDrift }).getCapture({
        tenantId,
        operationId,
      }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_SOURCE_BINDING");
    const requestDrift = pdfFixture();
    requestDrift.result.output.request = {
      ...requestDrift.result.output.request,
      requestedProjectionKinds: ["geometry", "pdf_text"],
    };
    requestDrift.result.requestDigest = digestCanonicalJson(requestDrift.result.output.request);
    await expect(
      new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => requestDrift }).getCapture({
        tenantId,
        operationId,
      }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_REQUEST_BINDING");
    const missing = pdfFixture();
    missing.result.output.projections = [missing.result.output.projections[0]];
    await expect(
      new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => missing }).getCapture({
        tenantId,
        operationId,
      }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_PROJECTION_SET");
  });

  it("rejects terminal handle aliasing, request drift, and non-terminal states", async () => {
    const alias = fixture();
    alias.result.boundArtifacts[2] = alias.result.boundArtifacts[1]!;
    await expect(
      new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => alias }).getCapture({
        tenantId,
        operationId,
      }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_BOUND_ARTIFACTS");
    const drift = fixture();
    drift.result.requestDigest = `sha256:${"e".repeat(64)}`;
    await expect(
      new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => drift }).getCapture({
        tenantId,
        operationId,
      }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_REQUEST_BINDING");
    await expect(
      new VerificationCaptureReadApplicationService({
        loadVerifiedCapture: async () => ({ state: "cancelled" }),
      }).getCapture({ tenantId, operationId }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_NOT_TERMINAL");
  });

  it("preserves durable pending, failed, and cancelled state codes for transport mapping", async () => {
    for (const state of ["pending", "failed", "cancelled"] as const) {
      await expect(
        new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => ({ state }) }).getCapture({
          tenantId,
          operationId,
        }),
      ).rejects.toMatchObject({ code: state.toUpperCase() });
    }
  });

  it("rejects foreign projection roles and transformed-parent drift", async () => {
    const foreign = fixture();
    foreign.result.output.projections[0]!.nativeOutputArtifact.tenantId = "99999999-9999-4999-8999-999999999999";
    await expect(
      new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => foreign }).getCapture({
        tenantId,
        operationId,
      }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_TENANT_BINDING");
    const drift = fixture();
    drift.result.output.projections[0]!.transformationArtifact.parentArtifactIds = [];
    await expect(
      new VerificationCaptureReadApplicationService({ loadVerifiedCapture: async () => drift }).getCapture({
        tenantId,
        operationId,
      }),
    ).rejects.toThrow("VERIFICATION_CAPTURE_READ_TRANSFORMATION_BINDING");
  });
});
