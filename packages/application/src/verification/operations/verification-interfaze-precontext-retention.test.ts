import { describe, expect, it } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { InterfazeStructuredExtractionProvider, sha256Digest } from "@aiengineer/knowledge-verification";
import {
  VerificationProviderArtifactComposer,
  type VerificationProviderArtifactRegistrationPort,
} from "./verification-provider.js";

const tenantId = "7e769668-4b41-43a8-b49f-f2f7524e9972";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("synthetic Interfaze precontext retention boundary", () => {
  it("retains full raw/precontext artifacts while returning only a compact canonical record", async () => {
    const registrations: Array<
      Parameters<VerificationProviderArtifactRegistrationPort["registerContentAddressedArtifact"]>[0]
    > = [];
    const identities = new Map<string, VerificationArtifactHandle>();
    const repository: VerificationProviderArtifactRegistrationPort = {
      async registerContentAddressedArtifact(input) {
        registrations.push(input);
        const key = `${input.artifactType}:${sha256Digest(input.bytes)}`;
        const existing = identities.get(key);
        if (existing) return existing;
        const ordinal = (identities.size + 1).toString().padStart(12, "0");
        const handle = {
          artifactId: `00000000-0000-4000-8000-${ordinal}`,
          tenantId,
          digest: sha256Digest(input.bytes),
          mediaType: input.mediaType,
          byteLength: input.bytes.byteLength,
          objectKey: `restricted/${ordinal}`,
          createdAt: "2026-09-08T00:00:00.000Z",
          producerActivityId: "synthetic-interfaze-boundary",
          producerVersion: "v1",
          encryptionClass: "managed",
          retentionClass: "verification-audit",
          dataClassification: "restricted",
          parentArtifactIds: input.parentArtifactIds ?? [],
        } as VerificationArtifactHandle;
        identities.set(key, handle);
        return handle;
      },
    };
    const composer = new VerificationProviderArtifactComposer(repository, {
      tenantId,
      storageBucket: "proof",
      producerActivityId: "synthetic-interfaze-boundary",
      producerVersion: "v1",
      encryptionClass: "managed",
      retentionClass: "verification-audit",
      now: () => "2026-09-08T00:00:00.000Z",
      externalProcessingGrant: {
        providerId: "interfaze",
        dataClassification: "synthetic",
        modalities: ["text"],
        zdrPolicy: "required",
      },
    });
    await composer.registerInput(encoder.encode("selected source fragment"), "text/plain");
    const privatePrecontext = "precontext-canary:" + "x".repeat(8_192);
    const rawOnly = "raw-response-canary:" + "y".repeat(4_096);
    const responseBody = {
      id: "synthetic-provider-response",
      model: "interfaze-beta",
      rawOnly,
      choices: [{ message: { content: JSON.stringify({ value: "selected source fragment" }) } }],
      precontext: [{ name: "scraper", result: { privatePrecontext } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    };
    const rawBytes = encoder.encode(JSON.stringify(responseBody));
    const provider = new InterfazeStructuredExtractionProvider({
      apiKey: "synthetic-no-network-key",
      artifactSink: {
        assertExternalProcessingAdmission: (input) => composer.assertRegisteredInputAdmission(input),
        persistBeforeDispatch: (input) => composer.persistBeforeDispatch(input),
        persistAfterResponse: (input) => composer.persistAfterResponse(input),
      },
      fetch: async () => new Response(rawBytes, { status: 200, headers: { "content-type": "application/json" } }),
    });

    const result = await provider.extract({
      prompt: "Extract the single selected field.",
      schemaName: "synthetic_compact_projection",
      schema: {
        type: "object",
        description: "One compact source-bound field.",
        properties: { value: { type: "string", description: "Selected source field.", maxLength: 80 } },
        required: ["value"],
        additionalProperties: false,
      },
      execution: {},
    });

    const request = registrations.find((item) => item.artifactType === "verification_provider_request");
    const raw = registrations.find((item) => item.artifactType === "verification_provider_raw_response");
    const envelope = registrations.find((item) => item.artifactType === "verification_provider_response_envelope");
    const precontext = registrations.find((item) => item.artifactType === "verification_provider_precontext");
    const precontextEnvelope = registrations.find(
      (item) => item.artifactType === "verification_provider_precontext_envelope",
    );
    for (const item of [request, raw, envelope, precontext, precontextEnvelope]) expect(item).toBeDefined();
    expect(raw!.dataClassification).toBe("restricted");
    expect(precontext!.dataClassification).toBe("restricted");
    expect(raw!.bytes).toEqual(rawBytes);
    expect(decoder.decode(precontext!.bytes)).toContain(privatePrecontext);
    expect(precontext!.bytes.byteLength).toBeLessThanOrEqual(64_000);
    expect(raw!.bytes.byteLength).toBeLessThanOrEqual(160_000);
    expect(envelope!.parentArtifactIds).toEqual([
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ]);
    expect(precontextEnvelope!.parentArtifactIds).toEqual([
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
    ]);

    const compact = JSON.stringify(result);
    expect(result).toMatchObject({ output: { value: "selected source fragment" }, precontext: [{ name: "scraper" }] });
    expect(result.precontext[0]).not.toHaveProperty("result");
    expect(compact).not.toContain(rawOnly);
    expect(compact).not.toContain(privatePrecontext);
    expect(encoder.encode(compact).byteLength).toBeLessThan(1_024);
  });
});
