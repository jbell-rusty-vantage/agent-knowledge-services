import { describe, expect, it, vi } from "vitest";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { VerificationParseArtifactResultSchema } from "@aiengineer/knowledge-contracts";
import { ParseArtifactApplicationService, type ParseArtifactLease } from "./verification-parse.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  captureId = "12121212-1212-4121-8121-121212121212",
  operationId = "22222222-2222-4222-8222-222222222222",
  attemptId = "33333333-3333-4333-8333-333333333333",
  digest = `sha256:${"a".repeat(64)}` as const;
function handle(id: string, parents: string[] = []) {
  return {
    artifactId: id,
    tenantId: tenant,
    digest,
    mediaType: "application/json",
    byteLength: 2,
    objectKey: `${tenant}/${id}`,
    createdAt: "2026-09-05T00:00:00.000Z",
    producerActivityId: "fixture",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted" as const,
    parentArtifactIds: parents,
  };
}
const source = handle("44444444-4444-4444-8444-444444444444"),
  native = handle("55555555-5555-4555-8555-555555555555"),
  projection = handle("66666666-6666-4666-8666-666666666666"),
  envelope = handle("77777777-7777-4777-8777-777777777777", [
    source.artifactId,
    native.artifactId,
    projection.artifactId,
  ]);
const receipt = {
  schemaVersion: "verification-projection-admission.v1" as const,
  captureId,
  sourceArtifact: source,
  nativeOutputArtifact: native,
  projectionArtifact: projection,
  transformationArtifact: envelope,
  projectionKind: "html_dom" as const,
  projectionOrdinal: 0,
  parserVersion: "verification-native-parser.v1" as const,
  imageDigest: digest,
  parserOptionsDigest: digest,
  parserTransformationSignature: digest,
  residualsDigest: digest,
};
const context = {
  tenantId: tenant,
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
const lease: ParseArtifactLease = {
  stepId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  leaseToken: "parse-lease",
  fencingToken: 1,
  holderIdentity: "parse-worker",
};

describe("ParseArtifactApplicationService", () => {
  it("reuses admitted projections and registers one lineage-bound parse result", async () => {
    const calls: any[] = [];
    const service = new ParseArtifactApplicationService(
      {
        async getRegisteredCapture() {
          return { capture: { contentArtifact: source } };
        },
        async registerFencedContentAddressedArtifact(input) {
          calls.push(input);
          return {
            ...handle(
              "99999999-9999-4999-8999-999999999999",
              input.artifact.parentArtifactIds ? [...input.artifact.parentArtifactIds] : [],
            ),
            digest: sha256Digest(input.artifact.bytes),
            byteLength: input.artifact.bytes.byteLength,
          };
        },
      },
      {
        async parseAndAdmit() {
          return [receipt];
        },
      },
      {
        storageBucket: "audit",
        producerVersion: "v1",
        encryptionClass: "managed",
        retentionClass: "audit",
        now: () => "2026-09-05T00:00:00.000Z",
      },
    );
    const result = await service.execute({
      context,
      request: { verificationContractVersion: "verification.v1", captureId, sourceArtifact: source },
      kind: "html",
      lease,
    });
    expect(result.output.status).toBe("canonical_projection_admitted");
    expect(VerificationParseArtifactResultSchema.parse(result)).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      lease,
      artifact: {
        artifactType: "verification_parse_result",
        producerAttemptId: attemptId,
        parentArtifactIds: [source.artifactId, native.artifactId, projection.artifactId, envelope.artifactId],
      },
    });
  });
  it("rejects a changed full handle before parser admission or result registration", async () => {
    const parseAndAdmit = vi.fn(),
      register = vi.fn();
    const service = new ParseArtifactApplicationService(
      {
        async getRegisteredCapture() {
          return { capture: { contentArtifact: source } };
        },
        registerFencedContentAddressedArtifact: register,
      },
      { parseAndAdmit },
      {
        storageBucket: "audit",
        producerVersion: "v1",
        encryptionClass: "managed",
        retentionClass: "audit",
        now: () => "2026-09-05T00:00:00.000Z",
      },
    );
    await expect(
      service.execute({
        context,
        request: {
          verificationContractVersion: "verification.v1",
          captureId,
          sourceArtifact: { ...source, objectKey: "forged" },
        },
        kind: "html",
        lease,
      }),
    ).rejects.toThrow("PARSE_ARTIFACT_SOURCE_BINDING_INVALID");
    expect(parseAndAdmit).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
  it("rejects a malformed parser receipt before writing a result artifact", async () => {
    const register = vi.fn(),
      malformed = { ...receipt, parserVersion: "unexpected" };
    const service = new ParseArtifactApplicationService(
      {
        async getRegisteredCapture() {
          return { capture: { contentArtifact: source } };
        },
        registerFencedContentAddressedArtifact: register,
      },
      {
        async parseAndAdmit() {
          return [malformed] as unknown as readonly (typeof receipt)[];
        },
      },
      {
        storageBucket: "audit",
        producerVersion: "v1",
        encryptionClass: "managed",
        retentionClass: "audit",
        now: () => "2026-09-05T00:00:00.000Z",
      },
    );
    await expect(
      service.execute({
        context,
        request: { verificationContractVersion: "verification.v1", captureId, sourceArtifact: source },
        kind: "html",
        lease,
      }),
    ).rejects.toThrow();
    expect(register).not.toHaveBeenCalled();
  });
  it("honours cancellation immediately before fenced result registration", async () => {
    const controller = new AbortController(),
      register = vi.fn();
    const service = new ParseArtifactApplicationService(
      {
        async getRegisteredCapture() {
          return { capture: { contentArtifact: source } };
        },
        registerFencedContentAddressedArtifact: register,
      },
      {
        async parseAndAdmit() {
          controller.abort();
          return [receipt];
        },
      },
      {
        storageBucket: "audit",
        producerVersion: "v1",
        encryptionClass: "managed",
        retentionClass: "audit",
        now: () => "2026-09-05T00:00:00.000Z",
      },
    );
    await expect(
      service.execute({
        context,
        request: { verificationContractVersion: "verification.v1", captureId, sourceArtifact: source },
        kind: "html",
        lease,
        signal: controller.signal,
      }),
    ).rejects.toThrow("PARSE_ARTIFACT_CANCELLED");
    expect(register).not.toHaveBeenCalled();
  });
});
