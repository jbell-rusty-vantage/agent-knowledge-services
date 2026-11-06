import { describe, expect, it } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { providerDigest } from "@aiengineer/knowledge-verification";
import {
  AccountedVerificationProviderSink,
  VerificationProviderArtifactComposer,
  type VerificationProviderArtifactRegistrationPort,
} from "./verification-provider.js";

const tenantId = "7e769668-4b41-43a8-b49f-f2f7524e9972";
const requestOne = providerDigest({ request: 1 });
const requestTwo = providerDigest({ request: 2 });
const text = new TextEncoder();

describe("VerificationProviderArtifactComposer", () => {
  it("accepts only trusted public or synthetic classifications and requires explicit Interfaze ZDR", () => {
    const repository: VerificationProviderArtifactRegistrationPort = {
      async registerContentAddressedArtifact() {
        throw new Error("must-not-write");
      },
    };
    const config = {
      tenantId,
      storageBucket: "proof",
      producerActivityId: "test",
      producerVersion: "v1",
      encryptionClass: "test",
      retentionClass: "test",
      now: () => "2026-09-06T00:00:00.000Z",
    };
    expect(
      () =>
        new VerificationProviderArtifactComposer(repository, {
          ...config,
          externalProcessingGrant: { providerId: "interfaze", dataClassification: "public", modalities: ["text"] },
        }),
    ).toThrow("INTERFAZE_ZDR_POLICY_REQUIRED");
    expect(
      () =>
        new VerificationProviderArtifactComposer(repository, {
          ...config,
          externalProcessingGrant: {
            providerId: "interfaze",
            dataClassification: "sensitive" as never,
            modalities: ["text"],
            zdrPolicy: "required",
          },
        }),
    ).toThrow("PROVIDER_EXTERNAL_PROCESSING_GRANT_INVALID");
    expect(
      () =>
        new VerificationProviderArtifactComposer(repository, {
          ...config,
          externalProcessingGrant: {
            providerId: "gateway",
            dataClassification: "public",
            modalities: ["text"],
            zdrPolicy: "required",
          },
        }),
    ).toThrow("PROVIDER_ZDR_POLICY_UNSUPPORTED");
    expect(
      () =>
        new VerificationProviderArtifactComposer(repository, {
          ...config,
          externalProcessingGrant: {
            providerId: "interfaze",
            dataClassification: "public",
            modalities: ["text"],
            zdrPolicy: "required",
          },
        }),
    ).not.toThrow();
  });

  it("retains one exact repeated error body and gives each request its own response envelope", async () => {
    const calls: Array<{ artifactType: string; parentArtifactIds?: readonly string[]; bytes: Uint8Array }> = [];
    const identities = new Map<string, VerificationArtifactHandle>();
    const repository: VerificationProviderArtifactRegistrationPort = {
      async registerContentAddressedArtifact(input) {
        calls.push(input);
        const key = `${input.artifactType}:${new TextDecoder().decode(input.bytes)}`;
        const existing = identities.get(key);
        if (existing) return existing;
        const identity = {
          artifactId: `00000000-0000-4000-8000-${String(identities.size + 1).padStart(12, "0")}`,
          tenantId,
          digest: providerDigest({ key }),
          mediaType: input.mediaType,
          byteLength: input.bytes.byteLength,
          objectKey: `proof/${identities.size}`,
          createdAt: "2026-09-06T00:00:00.000Z",
          producerActivityId: "test",
          producerVersion: "v1",
          encryptionClass: "test",
          retentionClass: "test",
          dataClassification: "restricted",
          parentArtifactIds: input.parentArtifactIds ?? [],
        } as unknown as VerificationArtifactHandle;
        identities.set(key, identity);
        return identity;
      },
    };
    const composer = (attempt: string) =>
      new VerificationProviderArtifactComposer(repository, {
        tenantId,
        storageBucket: "proof",
        producerActivityId: "test",
        producerVersion: "v1",
        encryptionClass: "test",
        retentionClass: "test",
        now: () => "2026-09-06T00:00:00.000Z",
        producerAttemptId: attempt,
        externalProcessingGrant: { providerId: "gateway", dataClassification: "synthetic", modalities: ["text"] },
      });
    const first = composer("00000000-0000-4000-8000-000000000111");
    const second = composer("00000000-0000-4000-8000-000000000222");
    for (const [sink, digest, body] of [
      [first, requestOne, { request: 1 }],
      [second, requestTwo, { request: 2 }],
    ] as const) {
      await sink.registerInput(text.encode("synthetic"), "text/plain");
      await sink.persistBeforeDispatch({ requestDigest: digest, requestBytes: text.encode(JSON.stringify(body)) });
      await sink.persistAfterResponse({
        requestDigest: digest,
        rawResponseBytes: text.encode("rate limited"),
        precontextBytes: text.encode('[{"name":"ocr","result":"same"}]'),
      });
    }
    expect(first.rawResponseArtifact(requestOne)?.artifactId).toBe(second.rawResponseArtifact(requestTwo)?.artifactId);
    expect(first.responseEnvelopeArtifact(requestOne)?.artifactId).not.toBe(
      second.responseEnvelopeArtifact(requestTwo)?.artifactId,
    );
    expect(calls.filter((call) => call.artifactType === "verification_provider_response_envelope")).toHaveLength(2);
    expect(calls.filter((call) => call.artifactType === "verification_provider_precontext_envelope")).toHaveLength(2);
    expect(first.precontextArtifact(requestOne)).toBeDefined();
    expect(first.precontextEnvelopeArtifact(requestOne)).toBeDefined();
  });

  it("claims the persisted reservation before dispatch and prevents a denied owner from fetching", async () => {
    const events: string[] = [];
    const repository: VerificationProviderArtifactRegistrationPort = {
      async registerContentAddressedArtifact(input) {
        return {
          artifactId: "00000000-0000-4000-8000-000000000301",
          tenantId,
          digest: providerDigest({ bytes: [...input.bytes] }),
          mediaType: input.mediaType,
          byteLength: input.bytes.byteLength,
          objectKey: "proof",
          createdAt: "2026-09-06T00:00:00.000Z",
          producerActivityId: "test",
          producerVersion: "v1",
          encryptionClass: "test",
          retentionClass: "test",
          dataClassification: "restricted",
          parentArtifactIds: [],
        } as unknown as VerificationArtifactHandle;
      },
    };
    const composer = new VerificationProviderArtifactComposer(repository, {
      tenantId,
      storageBucket: "proof",
      producerActivityId: "test",
      producerVersion: "v1",
      encryptionClass: "test",
      retentionClass: "test",
      now: () => "2026-09-06T00:00:00.000Z",
      externalProcessingGrant: { providerId: "gateway", dataClassification: "synthetic", modalities: ["text"] },
    });
    await composer.registerInput(text.encode("synthetic"), "text/plain");
    const sink = new AccountedVerificationProviderSink(
      composer,
      {
        async reserve() {
          events.push("reserve");
        },
        async claimDispatch() {
          events.push("claim");
          return { claimed: true };
        },
        async settle() {
          events.push("settle");
          return { attempt: { state: "settled" } };
        },
        async markUncertain() {
          events.push("uncertain");
          return { state: "uncertain" };
        },
      },
      { tenantId, budgetId: "00000000-0000-4000-8000-000000000302", budgetKey: "proof", ceilingCostMicros: 1_000_000 },
      {
        attemptId: "00000000-0000-4000-8000-000000000303",
        providerId: "gateway-test",
        model: "model",
        reservationCostMicros: 1,
      },
    );
    const request = providerDigest({ request: "ok" });
    await sink.persistBeforeDispatch({ requestDigest: request, requestBytes: text.encode('{"request":"ok"}') });
    expect(events).toEqual(["reserve", "claim"]);
    const denied = new AccountedVerificationProviderSink(
      composer,
      {
        async reserve() {},
        async claimDispatch() {
          return { claimed: false };
        },
        async settle() {
          throw new Error("must-not-settle");
        },
        async markUncertain() {
          return { state: "uncertain" };
        },
      },
      { tenantId, budgetId: "00000000-0000-4000-8000-000000000302", budgetKey: "proof", ceilingCostMicros: 1_000_000 },
      {
        attemptId: "00000000-0000-4000-8000-000000000304",
        providerId: "gateway-test",
        model: "model",
        reservationCostMicros: 1,
      },
    );
    await expect(
      denied.persistBeforeDispatch({ requestDigest: request, requestBytes: text.encode('{"request":"ok"}') }),
    ).rejects.toThrow("ACCOUNTED_PROVIDER_DISPATCH_NOT_CLAIMED");
  });
});
