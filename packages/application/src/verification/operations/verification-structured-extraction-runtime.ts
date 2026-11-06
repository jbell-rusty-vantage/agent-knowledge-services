import { z } from "zod";
import {
  ExtractStructuredDataRequestSchema,
  VerificationStructuredExtractionRuntimeSchema,
  type ExtractStructuredDataRequest,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { StructuredExtractionRuntimeGrantSchema } from "./verification-structured-extraction-profile.js";

const schema = z.strictObject({
  schemaVersion: z.literal("verification-structured-extraction-runtime.v1"),
  tenantId: z.uuid(),
  providerId: z.enum(["gateway-structured-extraction.v1", "interfaze-extraction.v1"]),
  grants: z.array(StructuredExtractionRuntimeGrantSchema).min(1).max(256),
  runtime: VerificationStructuredExtractionRuntimeSchema,
  parserImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  executionMode: z.enum(["synthetic_transport", "live_provider"]),
  trustedPublicKeys: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u), z.string().min(64).max(4096)),
});
/** Shared API/worker configuration; API grant matching never replaces native worker admission. */
export function parseVerificationStructuredExtractionRuntimeConfig(raw: string) {
  if (new TextEncoder().encode(raw).byteLength > 1_500_000)
    throw new Error("STRUCTURED_EXTRACTION_RUNTIME_CONFIG_TOO_LARGE");
  const config = schema.parse(JSON.parse(raw)),
    keys = new Set<string>();
  for (const grant of config.grants) {
    if (grant.tenantId !== config.tenantId) throw new Error("STRUCTURED_EXTRACTION_RUNTIME_TENANT_MISMATCH");
    const key = grantKey(grant.tenantId, grant);
    if (keys.has(key)) throw new Error("DUPLICATE_STRUCTURED_EXTRACTION_RUNTIME_GRANT");
    keys.add(key);
  }
  return deepFreeze(config);
}
function grantKey(
  tenantId: string,
  request: Pick<ExtractStructuredDataRequest, "captureId" | "representation" | "extractionSchema">,
) {
  return `${tenantId}:${request.captureId}:${request.representation.artifactId}:${request.representation.digest}:${request.extractionSchema.artifactId}:${request.extractionSchema.digest}`;
}
export function createStructuredExtractionRequestAdmission(
  config: ReturnType<typeof parseVerificationStructuredExtractionRuntimeConfig>,
) {
  const snapshot = parseVerificationStructuredExtractionRuntimeConfig(JSON.stringify(config)),
    keys = new Set(snapshot.grants.map((grant) => grantKey(grant.tenantId, grant)));
  return (tenantId: string, value: unknown) => {
    const request = ExtractStructuredDataRequestSchema.safeParse(value);
    return request.success && tenantId === snapshot.tenantId && keys.has(grantKey(tenantId, request.data));
  };
}
