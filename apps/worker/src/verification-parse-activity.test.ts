import { describe, expect, it, vi } from "vitest";
import { VerificationParseArtifactResultSchema } from "@aiengineer/knowledge-contracts";
import { executeVerificationParseArtifact } from "./verification-parse-activity.js";

const tenantId = "11111111-1111-4111-8111-111111111111",
  captureId = "12121212-1212-4121-8121-121212121212",
  operationId = "22222222-2222-4222-8222-222222222222",
  attemptId = "33333333-3333-4333-8333-333333333333",
  digest = `sha256:${"a".repeat(64)}`;
const handle = {
  artifactId: "44444444-4444-4444-8444-444444444444",
  tenantId,
  digest,
  mediaType: "text/html",
  byteLength: 1,
  objectKey: "tenant/source",
  createdAt: "2026-09-05T00:00:00.000Z",
  producerActivityId: "fixture",
  producerVersion: "v1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted" as const,
  parentArtifactIds: [],
};
const context = {
  tenantId,
  operationId,
  attemptId,
  correlationId: "parse-fixture",
  actor: {
    kind: "service" as const,
    id: "88888888-8888-4888-8888-888888888888",
    serviceIdentity: "knowledge_worker" as const,
  },
  capabilityVersion: "verification.v1",
  idempotencyKey: "parse-fixture",
  reason: "fixture",
  contractVersion: "v1" as const,
};
const request = { verificationContractVersion: "verification.v1" as const, captureId, sourceArtifact: handle };
const lease = {
  stepId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  leaseToken: "parse-lease",
  fencingToken: 1,
  holderIdentity: "parse-worker",
};
const result = VerificationParseArtifactResultSchema.parse({
  schemaVersion: "verification-operation-result.v1",
  operationId,
  useCase: "parseArtifact",
  requestDigest: digest,
  sourceArtifact: handle,
  output: {
    status: "canonical_projection_admitted",
    projections: [
      {
        schemaVersion: "verification-projection-admission.v1",
        captureId,
        sourceArtifact: handle,
        projectionKind: "html_dom",
        projectionOrdinal: 0,
        nativeOutputArtifact: handle,
        projectionArtifact: handle,
        transformationArtifact: handle,
        parserVersion: "verification-native-parser.v1",
        imageDigest: digest,
        parserOptionsDigest: digest,
        parserTransformationSignature: digest,
        residualsDigest: digest,
      },
    ],
  },
  resultArtifact: handle,
});
describe("executeVerificationParseArtifact", () => {
  it("uses the server-owned context and checks activity liveness around application execution", async () => {
    const assertActive = vi.fn().mockResolvedValue(undefined),
      execute = vi.fn().mockResolvedValue(result);
    const resolveKind = vi.fn().mockResolvedValue("html");
    await expect(
      executeVerificationParseArtifact(
        { context, request, lease },
        { service: { execute }, resolveKind, assertActive, pollMs: 10_000 },
      ),
    ).resolves.toEqual(result);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ context, request, lease, kind: "html", signal: expect.any(AbortSignal) }),
    );
    expect(assertActive).toHaveBeenCalledTimes(3);
  });
  it("does not call application parsing when the durable operation is inactive", async () => {
    const execute = vi.fn();
    await expect(
      executeVerificationParseArtifact(
        { context, request, lease },
        {
          service: { execute },
          resolveKind: async () => "html",
          assertActive: async () => {
            throw new Error("CANCELLED");
          },
        },
      ),
    ).rejects.toThrow("CANCELLED");
    expect(execute).not.toHaveBeenCalled();
  });
});
