import { z } from "zod";
import { Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationArtifactHandleSchema, VerificationContractVersionSchema } from "./primitives.js";

/** Artifact-only public input. Parser identity, modality and source metadata are resolved server-side. */
export const ParseArtifactRequestSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  captureId: UuidSchema,
  sourceArtifact: VerificationArtifactHandleSchema,
});
export type ParseArtifactRequest = z.infer<typeof ParseArtifactRequestSchema>;

const projection = z.strictObject({
  schemaVersion: z.literal("verification-projection-admission.v1"),
  captureId: UuidSchema,
  sourceArtifact: VerificationArtifactHandleSchema,
  projectionKind: z.enum(["html_dom", "pdf_text", "geometry"]),
  projectionOrdinal: z.int().nonnegative().max(1),
  nativeOutputArtifact: VerificationArtifactHandleSchema,
  projectionArtifact: VerificationArtifactHandleSchema,
  transformationArtifact: VerificationArtifactHandleSchema,
  parserVersion: z.literal("verification-native-parser.v1"),
  imageDigest: Sha256DigestSchema,
  parserOptionsDigest: Sha256DigestSchema,
  parserTransformationSignature: Sha256DigestSchema,
  residualsDigest: Sha256DigestSchema,
});

/** Successful parsing proves canonical parser custody only; it asserts no extraction or policy admission. */
export const VerificationParseArtifactResultSchema = z.strictObject({
  schemaVersion: z.literal("verification-operation-result.v1"),
  operationId: UuidSchema,
  useCase: z.literal("parseArtifact"),
  requestDigest: Sha256DigestSchema,
  sourceArtifact: VerificationArtifactHandleSchema,
  output: z.strictObject({
    status: z.literal("canonical_projection_admitted"),
    projections: z.array(projection).min(1).max(2),
  }),
  resultArtifact: VerificationArtifactHandleSchema,
});
export type VerificationParseArtifactResult = z.infer<typeof VerificationParseArtifactResultSchema>;
