import { z } from "zod";
import { NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";

const MediaTypeSchema = NonEmptyStringSchema.max(255);

/** A registered immutable artifact, deliberately excluding its storage locator. */
export const VerificationArtifactReferenceSchema = z.strictObject({
  artifactId: UuidSchema,
  digest: Sha256DigestSchema,
  mediaType: MediaTypeSchema,
  sizeBytes: z.int().nonnegative(),
});
export type VerificationArtifactReference = z.infer<typeof VerificationArtifactReferenceSchema>;
