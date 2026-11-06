import { z } from "zod";
import { Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationStructuredExtractionResultSchema } from "./structured-extraction-result.js";
import { VerificationStructuredExtractionFailureResultSchema } from "./structured-extraction-failure-result.js";

/** Public custody result. Contains compact references, never Storage paths or provider content. */
export const VerificationStructuredExtractionResourceSchema = z
  .strictObject({
    verificationContractVersion: z.literal("verification.v1"),
    tenantId: UuidSchema,
    operationId: UuidSchema,
    requestDigest: Sha256DigestSchema,
    publication: z.strictObject({
      artifact: z.strictObject({ artifactId: UuidSchema, digest: Sha256DigestSchema }),
      signatureStatus: z.literal("verified"),
      purpose: z.literal("artifact_custody_only"),
    }),
    output: z.union([
      VerificationStructuredExtractionResultSchema.shape.output,
      VerificationStructuredExtractionFailureResultSchema.shape.output,
    ]),
  })
  .superRefine((value, context) => {
    if (
      value.output.status === "failed" &&
      value.output.category !== (value.output.code === "PROVIDER_HTTP_FAILURE" ? "provider_http" : "producer_contract")
    )
      context.addIssue({
        code: "custom",
        path: ["output", "category"],
        message: "Failure category must match provider code",
      });
  });
export type VerificationStructuredExtractionResource = z.infer<typeof VerificationStructuredExtractionResourceSchema>;
