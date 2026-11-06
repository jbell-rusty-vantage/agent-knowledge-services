import { z } from "zod";
import { Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { StructuredExtractionFailureCodeSchema } from "./structured-extraction-failure.js";
import { VerificationArtifactHandleSchema } from "./primitives.js";

const artifactReference = z.strictObject({
  artifactId: UuidSchema,
  digest: Sha256DigestSchema,
});

/**
 * The bounded failed terminal payload for a retained structured-extraction
 * provider failure. It deliberately contains neither a candidate nor a
 * semantic, source-authority, or quality assertion.
 */
export const VerificationStructuredExtractionFailureResultSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-operation-result.v1"),
    operationId: UuidSchema,
    useCase: z.literal("extractStructuredData"),
    requestDigest: Sha256DigestSchema,
    output: z.strictObject({
      status: z.literal("failed"),
      code: StructuredExtractionFailureCodeSchema,
      category: z.enum(["provider_http", "producer_contract"]),
      automaticRetry: z.literal(false),
      candidateArtifact: z.null(),
      executionArtifact: artifactReference,
      manifestDigest: Sha256DigestSchema,
      providerCallDigest: Sha256DigestSchema,
    }),
    resultArtifact: VerificationArtifactHandleSchema,
  })
  .superRefine((value, context) => {
    const expectedCategory = value.output.code === "PROVIDER_HTTP_FAILURE" ? "provider_http" : "producer_contract";
    if (value.output.category !== expectedCategory) {
      context.addIssue({
        code: "custom",
        path: ["output", "category"],
        message: "failure category must be derived from the native provider failure code",
      });
    }
  });

export type VerificationStructuredExtractionFailureResult = z.infer<
  typeof VerificationStructuredExtractionFailureResultSchema
>;
