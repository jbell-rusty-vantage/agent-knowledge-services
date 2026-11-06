import { describe, expect, it } from "vitest";
import {
  StructuredExtractionProviderCallSnapshotSchema,
  VerificationStructuredExtractionExecutionSchema,
  VerificationStructuredExtractionPublicationSchema,
  VerificationStructuredExtractionSourceCustodySchema,
  type VerificationArtifactHandle,
} from "./index.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const at = (second: number) => `2026-09-06T04:20:${String(second).padStart(2, "0")}.000Z`;
const handle = (value: number, tenantId = id(1)): VerificationArtifactHandle => ({
  artifactId: id(value),
  tenantId,
  digest: sha(String(value % 10)),
  mediaType: "application/json",
  byteLength: 10,
  objectKey: `${tenantId}/${value}`,
  createdAt: at(0),
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});

function execution() {
  return {
    schemaVersion: "verification-structured-extraction-execution.v1",
    verificationContractVersion: "verification.v1",
    tenantId: id(1),
    operationId: id(2),
    operationStepId: id(3),
    producerAttemptId: id(4),
    requestDigest: sha("a"),
    stepInputDigest: sha("b"),
    profileArtifact: handle(5),
    runtime: {
      deploymentId: "worker.prod",
      capabilityVersion: "extract.v1",
      platform: "node24-linux-x64",
      code: { gitSha: "uncommitted", dirty: true, dirtyStateArtifact: handle(6) },
    },
    execution: { mode: "synthetic_transport", networkPolicy: "disabled" },
    versions: { parser: "gateway-json.v1", extractor: "structured-extraction.v1", canonicalization: "rfc8785.v1" },
    createdAt: at(0),
  } as const;
}

function publication() {
  const e = execution(),
    raw = handle(14),
    capture = {
      tenantId: id(1),
      providerAttemptId: id(20),
      operationId: id(2),
      operationStepId: id(3),
      profileArtifactId: id(5),
      profileDigest: e.profileArtifact.digest,
      dispatchFencingToken: 7,
      httpStatus: 200,
      responseEnvelopeArtifactId: id(13),
      transportArtifactId: id(12),
      transportDigest: handle(12).digest,
      capturedAt: at(2),
    };
  return {
    schemaVersion: "verification-structured-extraction-publication.v1",
    verificationContractVersion: "verification.v1",
    tenantId: id(1),
    operationId: id(2),
    operationStepId: id(3),
    producerAttemptId: id(4),
    requestDigest: sha("a"),
    stepInputDigest: sha("b"),
    lifecycleIdentityDigest: sha("c"),
    execution: {
      artifact: { ...handle(7), digest: sha("d") },
      payloadDigest: sha("d"),
      runtimeDigest: sha("e"),
      manifest: e,
    },
    input: {
      captureId: id(8),
      profileArtifact: handle(5),
      schemaArtifact: handle(9),
      sourceArtifact: handle(10),
      representationArtifact: handle(11),
      transformationArtifact: handle(15),
      promptDigest: sha("f"),
      schemaDigest: sha("1"),
    },
    response: {
      capture,
      providerRequestArtifact: handle(16),
      rawResponseArtifact: raw,
      responseEnvelopeArtifact: handle(13),
      transportArtifact: handle(12),
    },
    providerCall: {
      providerAttemptId: id(20),
      budgetId: id(21),
      providerId: "gateway-structured-extraction.v1",
      model: "openai-gpt-5-mini",
      configurationDigest: sha("2"),
      attemptOrdinal: 0,
      reservationCostMicros: 100,
      state: "settled",
      actualCostMicros: 10,
      pricingBasis: "synthetic_transport",
      costEvidenceArtifact: raw,
      supplierBillingVerified: false,
    },
    providerCallDigest: sha("3"),
    output: {
      status: "unverified_candidate",
      schemaValidation: "shape_only",
      candidateArtifact: handle(17),
      provenanceArtifact: handle(18),
      precontextArtifact: null,
      outputDigest: sha("4"),
    },
    startedAt: at(1),
    retentionStartedAt: at(3),
    completedAt: at(4),
    seal: {
      payloadDigest: sha("5"),
      purpose: "artifact_custody_only",
      signature: { algorithm: "Ed25519", keyId: "custody-key.v1", signatureBase64: `${"A".repeat(86)}==` },
    },
  } as const;
}

describe("structured extraction execution and publication contracts", () => {
  it("admits only bounded runtime identity with an execution-mode network policy", () => {
    expect(VerificationStructuredExtractionExecutionSchema.parse(execution()).execution.mode).toBe(
      "synthetic_transport",
    );
    expect(() =>
      VerificationStructuredExtractionExecutionSchema.parse({
        ...execution(),
        endpointUrl: "https://provider.invalid",
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionExecutionSchema.parse({
        ...execution(),
        runtime: { ...execution().runtime, code: { gitSha: "uncommitted", dirty: false } },
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionExecutionSchema.parse({
        ...execution(),
        execution: { mode: "synthetic_transport", networkPolicy: "allowlisted" },
      }),
    ).toThrow();
  });

  it("bounds dirty source custody to unique logical listed-file paths", () => {
    const source = {
      schemaVersion: "verification-structured-extraction-source-custody.v1",
      tenantId: id(1),
      scope: "listed_files",
      files: [{ path: "KS/packages/application/src/file.ts", sha256: sha("a"), byteLength: 1, bytesBase64: "eA==" }],
      totalByteLength: 1,
    } as const;
    expect(VerificationStructuredExtractionSourceCustodySchema.parse(source).scope).toBe("listed_files");
    expect(() =>
      VerificationStructuredExtractionSourceCustodySchema.parse({
        ...source,
        files: [{ ...source.files[0], path: "../secret" }],
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionSourceCustodySchema.parse({
        ...source,
        files: [source.files[0], source.files[0]],
        totalByteLength: 2,
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionSourceCustodySchema.parse({ ...source, totalByteLength: 2 }),
    ).toThrow();
  });

  it("keeps producer output explicitly unverified and requires a custody signature", () => {
    expect(VerificationStructuredExtractionPublicationSchema.parse(publication()).output).toMatchObject({
      status: "unverified_candidate",
      schemaValidation: "shape_only",
    });
    expect(() =>
      VerificationStructuredExtractionPublicationSchema.parse({
        ...publication(),
        seal: { payloadDigest: sha("5"), purpose: "artifact_custody_only" },
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionPublicationSchema.parse({ ...publication(), qualityClaims: { verified: true } }),
    ).toThrow();
  });

  it("represents unknown cost as null and bounds settled cost by the reservation", () => {
    const call = publication().providerCall;
    expect(
      StructuredExtractionProviderCallSnapshotSchema.parse({ ...call, state: "uncertain", actualCostMicros: null })
        .actualCostMicros,
    ).toBeNull();
    expect(StructuredExtractionProviderCallSnapshotSchema.parse({ ...call, attemptOrdinal: 0 }).attemptOrdinal).toBe(0);
    expect(() =>
      StructuredExtractionProviderCallSnapshotSchema.parse({ ...call, state: "uncertain", actualCostMicros: 0 }),
    ).toThrow();
    expect(() => StructuredExtractionProviderCallSnapshotSchema.parse({ ...call, actualCostMicros: 101 })).toThrow();
  });
});
