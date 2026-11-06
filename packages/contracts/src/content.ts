import { z } from "zod";
import {
  ArtifactReferenceSchema,
  ImmutableResourceSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  SourceLocatorSchema,
  UuidSchema,
} from "./primitives.js";

export const SourceRoleSchema = z.enum(["official", "primary", "authoritative_secondary", "community", "unknown"]);
export const ContentClassificationSchema = z.enum(["public", "restricted", "confidential", "sensitive"]);
export const SourceSchema = z.strictObject({
  id: UuidSchema,
  tenantId: UuidSchema,
  kind: NonEmptyStringSchema,
  canonicalIdentity: NonEmptyStringSchema,
  role: SourceRoleSchema,
  publisher: NonEmptyStringSchema.optional(),
  classification: ContentClassificationSchema,
});
export type Source = z.infer<typeof SourceSchema>;

export const SourceCaptureSchema = ImmutableResourceSchema.extend({
  sourceId: UuidSchema,
  artifact: ArtifactReferenceSchema,
  capturedAt: IsoDateTimeSchema,
  captureMethod: NonEmptyStringSchema,
  contentType: NonEmptyStringSchema,
  byteIdentityVerified: z.boolean(),
});
export type SourceCapture = z.infer<typeof SourceCaptureSchema>;

export const DocumentSchema = z.strictObject({
  id: UuidSchema,
  tenantId: UuidSchema,
  documentKind: NonEmptyStringSchema,
  canonicalTitle: NonEmptyStringSchema,
  canonicalSourceId: UuidSchema,
  lifecycle: z.enum(["active", "corrected", "retracted", "superseded", "tombstoned"]),
  supersedesId: UuidSchema.optional(),
});
export const DocumentVersionSchema = ImmutableResourceSchema.extend({
  documentId: UuidSchema,
  versionLabel: NonEmptyStringSchema,
  publishedAt: IsoDateTimeSchema.optional(),
  effectiveAt: IsoDateTimeSchema.optional(),
  revision: NonEmptyStringSchema.optional(),
  correctionState: z.enum(["original", "corrected", "retracted"]),
  predecessorId: UuidSchema.optional(),
  sourceCaptureIds: z.array(UuidSchema).min(1),
});
export type Document = z.infer<typeof DocumentSchema>;
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const RepresentationClassSchema = z.enum([
  "source_native",
  "rendered_snapshot",
  "faithful_normalization",
  "structural_extraction",
  "semantic_projection",
  "retrieval_projection",
]);
export const AcceptanceStateSchema = z.enum([
  "candidate",
  "inspected",
  "accepted",
  "rejected",
  "quarantined",
  "deferred",
  "superseded",
]);
export const DocumentRepresentationSchema = ImmutableResourceSchema.extend({
  documentVersionId: UuidSchema,
  artifact: ArtifactReferenceSchema,
  representationClass: RepresentationClassSchema,
  representationKind: NonEmptyStringSchema,
  mediaType: NonEmptyStringSchema,
  language: NonEmptyStringSchema.optional(),
  fidelity: z.enum(["byte_identical", "faithful", "derived"]),
  sourceNativeByteIdentity: z.boolean(),
  acceptanceState: AcceptanceStateSchema,
  transformationRunId: UuidSchema.optional(),
  supersedesId: UuidSchema.optional(),
}).superRefine((representation, context) => {
  if (
    representation.representationClass === "source_native" &&
    (!representation.sourceNativeByteIdentity || representation.fidelity !== "byte_identical")
  ) {
    context.addIssue({
      code: "custom",
      message: "source_native requires proven byte identity",
      path: ["sourceNativeByteIdentity"],
    });
  }
  if (representation.sourceNativeByteIdentity && representation.representationClass !== "source_native") {
    context.addIssue({
      code: "custom",
      message: "byte identity is reserved for source_native representations",
      path: ["representationClass"],
    });
  }
});
export type DocumentRepresentation = z.infer<typeof DocumentRepresentationSchema>;

export const DocumentNodeKindSchema = z.enum([
  "heading",
  "paragraph",
  "list",
  "table",
  "figure",
  "formula",
  "code_block",
  "citation",
  "transcript_segment",
]);
export const DocumentNodeSchema = ImmutableResourceSchema.extend({
  representationId: UuidSchema,
  parentId: UuidSchema.optional(),
  ordinal: z.int().nonnegative(),
  kind: DocumentNodeKindSchema,
  role: NonEmptyStringSchema.optional(),
  text: z.string(),
  locator: SourceLocatorSchema,
  language: NonEmptyStringSchema.optional(),
});
export type DocumentNode = z.infer<typeof DocumentNodeSchema>;

export const VettingAssessmentSchema = z.strictObject({
  sourceId: UuidSchema,
  captureId: UuidSchema,
  sourceRole: SourceRoleSchema,
  identityConfidence: z.number().min(0).max(1),
  authenticity: z.enum(["verified", "plausible", "unresolved", "failed"]),
  rights: z.enum(["allowed", "restricted", "unknown", "denied"]),
  relevance: z.number().min(0).max(1),
  integrityChecks: z.array(NonEmptyStringSchema),
  securityFindings: z.array(NonEmptyStringSchema),
  intendedSpaces: z.array(NonEmptyStringSchema),
  unresolvedConflicts: z.array(NonEmptyStringSchema),
});
export type VettingAssessment = z.infer<typeof VettingAssessmentSchema>;

export const RepresentationEvaluationSchema = z.strictObject({
  representationId: UuidSchema,
  representationDigest: Sha256DigestSchema,
  coverage: z.number().min(0).max(1),
  locatorCoverage: z.number().min(0).max(1),
  readingOrderScore: z.number().min(0).max(1),
  semanticConsistency: z.number().min(0).max(1).optional(),
  preservesNegationNumbersUnitsAndCitations: z.boolean(),
  findings: z.array(NonEmptyStringSchema),
  disposition: z.enum(["accept", "reject", "quarantine", "repair", "manual_review"]),
});
export type RepresentationEvaluation = z.infer<typeof RepresentationEvaluationSchema>;
