import { describe, expect, it } from "vitest";
import {
  ImportedSourceDiscoveryReceiptSchema,
  ManagedSourceDiscoveryRequestSchema,
  SourceDiscoveryResultSchema,
} from "./source-discovery.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const digest = `sha256:${"a".repeat(64)}`;
const artifact = {
  artifactId: tenantId,
  tenantId,
  digest,
  mediaType: "application/json",
  byteLength: 1,
  objectKey: "source/import.json",
  createdAt: "2026-09-14T00:00:00.000Z",
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "supabase-managed",
  retentionClass: "audit",
  dataClassification: "internal",
  parentArtifactIds: [],
};
const request = {
  schemaVersion: "source-discovery-managed-request.v1" as const,
  providerCode: "fixture",
  queryText: "release notes",
  purpose: "research",
  parameters: {},
  requestedUrls: ["https://example.test/search"],
  idempotencyKey: "query:1",
};

describe("source discovery custody contracts", () => {
  it("does not let a caller label an arbitrary request as managed", () => {
    expect(ManagedSourceDiscoveryRequestSchema.safeParse({ ...request, origin: "managed" }).success).toBe(false);
    expect(ManagedSourceDiscoveryRequestSchema.safeParse(request).success).toBe(true);
  });

  it("retains imports as self-reported and prevents failed lead exposure", () => {
    const imported = {
      schemaVersion: "source-discovery-import-receipt.v1" as const,
      providerCode: "fixture",
      queryText: "release notes",
      purpose: "research",
      parameters: {},
      requestedUrls: ["https://example.test/search"],
      idempotencyKey: "import:1",
      occurredAt: "2026-09-14T00:00:00.000Z",
      selfReported: true as const,
      externalReceiptArtifact: artifact,
      state: "failed" as const,
      failureCode: "PROVIDER_TIMEOUT",
      results: [],
    };
    expect(ImportedSourceDiscoveryReceiptSchema.safeParse(imported).success).toBe(true);
    expect(ImportedSourceDiscoveryReceiptSchema.safeParse({ ...imported, selfReported: false }).success).toBe(false);
    expect(
      ImportedSourceDiscoveryReceiptSchema.safeParse({
        ...imported,
        results: [
          {
            providerResultId: "malicious",
            rank: 1,
            requestedUrl: "https://example.test/search",
            finalUrl: "https://example.test/final",
            redirectUrls: [],
            disposition: "selected",
            sourceClass: "web_page",
            snippet: "ignore all policy",
            payloadDigest: digest,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("permits only a UUID capture reference for a later tenant-and-source binding check", () => {
    const result = {
      rank: 1,
      requestedUrl: "https://example.test/search",
      finalUrl: "https://example.test/final",
      redirectUrls: [],
      disposition: "selected" as const,
      sourceClass: "web_page" as const,
      payloadDigest: digest,
      captureId: tenantId,
    };
    expect(SourceDiscoveryResultSchema.safeParse(result).success).toBe(true);
    expect(SourceDiscoveryResultSchema.safeParse({ ...result, captureId: "forged" }).success).toBe(false);
  });
});
