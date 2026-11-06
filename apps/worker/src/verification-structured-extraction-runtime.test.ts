import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import { createConfiguredVerificationStructuredExtractionHandler } from "./verification-structured-extraction-runtime.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const handle = {
  artifactId: id(3),
  tenantId: id(1),
  digest: `sha256:${"a".repeat(64)}`,
  mediaType: "application/json",
  byteLength: 1,
  objectKey: "key",
  createdAt: "2026-09-06T00:00:00.000Z",
  producerActivityId: "test",
  producerVersion: "v1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
};
const key = generateKeyPairSync("ed25519"),
  privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
const grant = {
  tenantId: id(1),
  captureId: id(2),
  sourceArtifact: handle,
  representation: handle,
  transformation: handle,
  extractionSchema: handle,
  producerProfile: handle,
};
const config = {
  schemaVersion: "verification-structured-extraction-runtime.v1",
  tenantId: id(1),
  providerId: "gateway-structured-extraction.v1",
  grants: [grant],
  runtime: {
    deploymentId: "test",
    capabilityVersion: "v1",
    platform: "node",
    code: { gitSha: "a".repeat(40), dirty: false },
  },
  parserImageDigest: `sha256:${"a".repeat(64)}`,
  executionMode: "synthetic_transport",
  trustedPublicKeys: { test: publicKey },
};
const base = {
  database: {} as PostgresCanonicalRepository,
  tenantId: id(1),
  projectUrl: "http://localhost:54321",
  serviceRoleKey: "test",
  maximumArtifactBytes: 1_000_000,
};
const environment = (value: unknown = config) => ({
  VERIFICATION_STRUCTURED_EXTRACTION_CONFIG_JSON: JSON.stringify(value),
  VERIFICATION_STRUCTURED_EXTRACTION_SIGNING_KEY_ID: "test",
  VERIFICATION_STRUCTURED_EXTRACTION_SIGNING_PRIVATE_KEY_PEM: privateKey,
});
const syntheticFetch: typeof fetch = async () => {
  throw new Error("CONFIGURATION_MUST_NOT_FETCH");
};
describe("structured extraction runtime configuration", () => {
  it("does not register an unconfigured handler and requires an explicit synthetic port", () => {
    expect(createConfiguredVerificationStructuredExtractionHandler({ ...base, environment: {} })).toBeUndefined();
    expect(() =>
      createConfiguredVerificationStructuredExtractionHandler({ ...base, environment: environment() }),
    ).toThrow("TRANSPORT_MISMATCH");
  });
  it("rejects tenant and signing authority mismatch before any artifact access", () => {
    expect(() =>
      createConfiguredVerificationStructuredExtractionHandler({
        ...base,
        environment: environment({ ...config, tenantId: id(9) }),
        syntheticFetch,
      }),
    ).toThrow("TENANT_MISMATCH");
    expect(() =>
      createConfiguredVerificationStructuredExtractionHandler({
        ...base,
        environment: environment({ ...config, trustedPublicKeys: { test: publicKey + " " } }),
        syntheticFetch,
      }),
    ).toThrow("SIGNING_TRUST_MISMATCH");
  });
  it("rejects ambiguous grants and missing live-provider credentials", () => {
    expect(() =>
      createConfiguredVerificationStructuredExtractionHandler({
        ...base,
        environment: environment({ ...config, grants: [grant, grant] }),
        syntheticFetch,
      }),
    ).toThrow("DUPLICATE_STRUCTURED_EXTRACTION_RUNTIME_GRANT");
    expect(() =>
      createConfiguredVerificationStructuredExtractionHandler({
        ...base,
        environment: environment({ ...config, executionMode: "live_provider" }),
      }),
    ).toThrow("PROVIDER_KEY_REQUIRED");
  });
  it("registers only the extraction activity for a valid server-owned synthetic configuration", () => {
    const handler = createConfiguredVerificationStructuredExtractionHandler({
      ...base,
      environment: environment(),
      syntheticFetch,
    });
    expect(handler?.operationKind).toBe("verification_structured_extraction");
    expect(handler?.stepName).toBe("extract_and_register");
  });
});
