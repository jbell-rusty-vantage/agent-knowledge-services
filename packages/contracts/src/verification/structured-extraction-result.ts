import { z } from "zod";
import { Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationArtifactHandleSchema } from "./primitives.js";

const artifactReference = z.strictObject({
  artifactId: UuidSchema,
  digest: Sha256DigestSchema,
});

/**
 * The bounded terminal payload for a retained structured-extraction custody
 * publication. It deliberately carries no quality, semantic, or source
 * authority assertion.
 */
export const VerificationStructuredExtractionResultSchema = z.strictObject({
  schemaVersion: z.literal("verification-operation-result.v1"),
  operationId: UuidSchema,
  useCase: z.literal("extractStructuredData"),
  requestDigest: Sha256DigestSchema,
  output: z.strictObject({
    status: z.literal("unverified_candidate"),
    schemaValidation: z.literal("shape_only"),
    candidateArtifact: artifactReference,
    provenanceArtifact: artifactReference,
    precontextArtifact: artifactReference.nullable(),
    executionArtifact: artifactReference,
    manifestDigest: Sha256DigestSchema,
    providerCallDigest: Sha256DigestSchema,
  }),
  resultArtifact: VerificationArtifactHandleSchema,
});

export type VerificationStructuredExtractionResult = z.infer<typeof VerificationStructuredExtractionResultSchema>;
