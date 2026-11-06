import { createPublicKey } from "node:crypto";
import { z } from "zod";
import {
  UuidSchema,
  VerificationBenchmarkComparisonProfileIdSchema,
  VerificationBenchmarkComparisonProfileArtifactReferenceSchema,
  VerificationBenchmarkComparisonPublicationSchema,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { VerificationBenchmarkComparisonProfileCatalog } from "./verification-benchmark-comparison.js";

const schema = z.strictObject({
  schemaVersion: z.literal("verification-benchmark-comparison-runtime.v1"),
  tenantId: UuidSchema,
  profiles: z
    .array(
      z.strictObject({
        profileId: VerificationBenchmarkComparisonProfileIdSchema,
        artifact: VerificationBenchmarkComparisonProfileArtifactReferenceSchema,
      }),
    )
    .min(1)
    .max(2),
  inputPublicKeys: z
    .array(
      z.strictObject({ keyId: z.string().trim().min(1).max(255), publicKeyPem: z.string().trim().min(1).max(4096) }),
    )
    .min(1)
    .max(32),
  runtime: VerificationBenchmarkComparisonPublicationSchema.shape.runtime.omit({ attemptId: true }),
});

/** Operator authority only; parsing grants does not assert live artifact availability. */
export function parseVerificationBenchmarkComparisonRuntimeConfig(raw: string) {
  try {
    if (new TextEncoder().encode(raw).byteLength > 131_072) throw new Error("CONFIG_TOO_LARGE");
    const value = deepFreeze(schema.parse(JSON.parse(raw))),
      publicKeys: Record<string, string> = Object.create(null);
    for (const key of value.inputPublicKeys) {
      if (
        Object.hasOwn(publicKeys, key.keyId) ||
        !key.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----") ||
        !key.publicKeyPem.endsWith("-----END PUBLIC KEY-----")
      )
        throw new Error("KEY_INVALID");
      const parsed = createPublicKey(key.publicKeyPem);
      if (parsed.asymmetricKeyType !== "ed25519") throw new Error("KEY_ALGORITHM_INVALID");
      publicKeys[key.keyId] = parsed.export({ type: "spki", format: "pem" }).toString();
    }
    if (
      (value.runtime.dirty && !value.runtime.dirtyStateArtifact) ||
      (value.runtime.dirtyStateArtifact && value.runtime.dirtyStateArtifact.tenantId !== value.tenantId)
    )
      throw new Error("RUNTIME_CUSTODY_INVALID");
    const catalog = new VerificationBenchmarkComparisonProfileCatalog(
      value.profiles.map((profile) => ({ ...profile, tenantId: value.tenantId })),
    );
    return Object.freeze({
      tenantId: value.tenantId,
      catalog,
      runtime: value.runtime,
      inputPublicKeys: Object.freeze(publicKeys),
    });
  } catch {
    throw new Error("INVALID_VERIFICATION_BENCHMARK_COMPARISON_RUNTIME_CONFIG");
  }
}
