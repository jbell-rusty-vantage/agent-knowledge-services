import { describe, expect, it } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { providerDigest, sha256Digest } from "@aiengineer/knowledge-verification";
import {
  VerificationProviderArtifactComposer,
  type VerificationProviderArtifactRegistrationPort,
} from "./verification-provider.js";
import type { VerificationProviderTransportResponse } from "./verification-provider-transport.js";

const tenantId = "11111111-1111-4111-8111-111111111111",
  encoder = new TextEncoder();
const binding = {
  tenantId,
  operationId: "22222222-2222-4222-8222-222222222222",
  operationStepId: "33333333-3333-4333-8333-333333333333",
  providerAttemptId: "44444444-4444-4444-8444-444444444444",
  profileArtifactId: "55555555-5555-4555-8555-555555555555",
  profileDigest: `sha256:${"a".repeat(64)}`,
  dispatchFencingToken: 12,
};
async function setup(failCapture = false) {
  const artifacts = new Map<string, { handle: VerificationArtifactHandle; bytes: Uint8Array; type: string }>();
  const records: VerificationProviderTransportResponse[] = [];
  const repository: VerificationProviderArtifactRegistrationPort = {
    async registerContentAddressedArtifact(input) {
      const digest = sha256Digest(input.bytes),
        existing = artifacts.get(digest);
      if (existing) return existing.handle;
      const handle: VerificationArtifactHandle = {
        artifactId: `00000000-0000-4000-8000-${String(artifacts.size + 1).padStart(12, "0")}`,
        tenantId,
        digest,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
        objectKey: digest,
        createdAt: input.createdAt,
        producerActivityId: input.producerActivityId,
        producerVersion: input.producerVersion,
        encryptionClass: input.encryptionClass,
        retentionClass: input.retentionClass,
        dataClassification: "restricted",
        parentArtifactIds: [...(input.parentArtifactIds ?? [])],
        ...(input.transformationSignature ? { transformationSignature: input.transformationSignature } : {}),
      };
      artifacts.set(digest, { handle, bytes: new Uint8Array(input.bytes), type: input.artifactType });
      return handle;
    },
  };
  const composer = new VerificationProviderArtifactComposer(repository, {
    tenantId,
    storageBucket: "test",
    producerActivityId: "test",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "test",
    now: () => "2026-09-06T00:00:00.000Z",
    externalProcessingGrant: { providerId: "gateway", dataClassification: "synthetic", modalities: ["text"] },
    transportResponse: {
      binding,
      async record(input) {
        if (failCapture) throw new Error("CAPTURE_UNAVAILABLE");
        records.push(input.response);
      },
    },
  });
  const requestBytes = encoder.encode('{"request":1}'),
    requestDigest = providerDigest({ request: 1 });
  await composer.registerInput(encoder.encode("synthetic"), "text/plain");
  await composer.persistBeforeDispatch({ requestBytes, requestDigest });
  return { composer, artifacts, records, requestDigest };
}

describe("operation-bound provider transport custody", () => {
  it("retains the observed status independently of misleading body text and preserves the v1 response envelope", async () => {
    const item = await setup();
    await item.composer.persistAfterResponse({
      requestDigest: item.requestDigest,
      rawResponseBytes: encoder.encode('{"status":200,"error":"busy"}'),
      httpStatus: 503,
    });
    expect(item.records[0]).toMatchObject({ httpStatus: 503, binding });
    const transport = item.composer.transportResponseArtifact(item.requestDigest)!;
    expect(transport.parentArtifactIds).toEqual([
      item.composer.responseEnvelopeArtifact(item.requestDigest)!.artifactId,
      binding.profileArtifactId,
    ]);
    expect(transport.digest).toBe(sha256Digest(item.artifacts.get(transport.digest)!.bytes));
    const envelope = item.artifacts.get(item.composer.responseEnvelopeArtifact(item.requestDigest)!.digest)!;
    expect(Object.keys(JSON.parse(new TextDecoder().decode(envelope.bytes))).sort()).toEqual(
      ["rawResponseArtifactId", "rawResponseDigest", "requestArtifactId", "requestDigest", "schemaVersion"].sort(),
    );
  });
  it.each([undefined, 0, 199, 600, 200.5, NaN])("does not infer missing or invalid status %s", async (httpStatus) => {
    const item = await setup();
    await expect(
      item.composer.persistAfterResponse({
        requestDigest: item.requestDigest,
        rawResponseBytes: encoder.encode("{}"),
        ...(httpStatus === undefined ? {} : { httpStatus }),
      }),
    ).rejects.toThrow("PROVIDER_TRANSPORT_HTTP_STATUS_REQUIRED");
    expect(item.records).toHaveLength(0);
  });
  it("allows exact repeated raw/precontext persistence but rejects changed status", async () => {
    const item = await setup(),
      response = { requestDigest: item.requestDigest, rawResponseBytes: encoder.encode("{}"), httpStatus: 200 };
    await item.composer.persistAfterResponse(response);
    const original = item.composer.transportResponseArtifact(item.requestDigest);
    await item.composer.persistAfterResponse({ ...response, precontextBytes: encoder.encode("[]") });
    expect(item.composer.transportResponseArtifact(item.requestDigest)).toEqual(original);
    expect(item.records).toHaveLength(2);
    await expect(item.composer.persistAfterResponse({ ...response, httpStatus: 503 })).rejects.toThrow(
      "PROVIDER_TRANSPORT_RESPONSE_DRIFT",
    );
  });
  it("does not expose a durable capture when canonical recording fails", async () => {
    const item = await setup(true);
    await expect(
      item.composer.persistAfterResponse({
        requestDigest: item.requestDigest,
        rawResponseBytes: encoder.encode("{}"),
        httpStatus: 200,
      }),
    ).rejects.toThrow("CAPTURE_UNAVAILABLE");
    expect(item.composer.transportResponseArtifact(item.requestDigest)).toBeUndefined();
    expect(item.composer.rawResponseArtifact(item.requestDigest)).toBeDefined();
  });
});
