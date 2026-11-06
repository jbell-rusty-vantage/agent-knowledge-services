import { z } from "zod";
import { Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationSelectorSchema } from "./selectors.js";

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const pointer = z
  .string()
  .max(4096)
  .refine(
    (value) => value === "" || (value.startsWith("/") && !/~(?:[^01]|$)/u.test(value)),
    "RFC6901 pointer required",
  );
const comparison = z.enum([
  "exact",
  "normalized_text",
  "decimal",
  "percentage",
  "currency",
  "unit",
  "date",
  "datetime",
  "enum",
  "identifier",
  "checksum",
]);
const artifact = z.strictObject({ artifactId: UuidSchema, digest: Sha256DigestSchema });
const derivation = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("direct"), comparison }),
    z.strictObject({
      kind: z.literal("normalized"),
      comparison,
      operation: z.enum([
        "trim_ascii",
        "ascii_whitespace_collapsed",
        "decimal_exact",
        "percentage_exact",
        "currency_code_amount",
        "unit_token",
        "date_calendar",
        "datetime_instant",
        "enum_membership",
        "identifier_format",
        "checksum",
      ]),
    }),
  ])
  .superRefine((value, context) => {
    if (value.kind !== "normalized") return;
    const allowed: Record<string, readonly string[]> = {
      normalized_text: ["trim_ascii", "ascii_whitespace_collapsed"],
      decimal: ["decimal_exact"],
      percentage: ["percentage_exact"],
      currency: ["currency_code_amount"],
      unit: ["unit_token"],
      date: ["date_calendar"],
      datetime: ["datetime_instant"],
      enum: ["enum_membership"],
      identifier: ["identifier_format"],
      checksum: ["checksum"],
    };
    if (!allowed[value.comparison]?.includes(value.operation))
      context.addIssue({ code: "custom", message: "Normalization operation does not match comparison" });
  });
export const VerificationAcceptedExtractionLeafSchema = z
  .strictObject({
    path: pointer,
    value: scalar,
    rawValue: scalar,
    derivation,
    source: z.strictObject({
      captureId: UuidSchema,
      representationArtifactId: UuidSchema,
      representationDigest: Sha256DigestSchema,
      selector: VerificationSelectorSchema,
      selectedContentDigest: Sha256DigestSchema,
      fragmentId: z.string().regex(/^fragment:[a-f0-9]{64}$/u),
    }),
    computation: z
      .strictObject({
        schemaVersion: z.literal("verification-cross-field-total.v1"),
        operation: z.enum(["identity", "sum", "difference", "product", "ratio", "percent_change"]),
        operandPaths: z.array(pointer).min(1).max(10000),
        tolerance: z.string().max(4096),
      })
      .optional(),
    lineage: z.strictObject({
      schemaVersion: z.literal("verification-extraction-leaf-lineage.v1"),
      sourceArtifact: artifact,
      nativeOutputArtifact: artifact,
      transformationArtifact: artifact,
      projectionArtifact: artifact,
      parserVersion: z.literal("verification-native-parser.v1"),
      imageDigest: Sha256DigestSchema,
      parserOptionsDigest: Sha256DigestSchema,
      parserTransformationSignature: Sha256DigestSchema,
    }),
  })
  .superRefine((leaf, context) => {
    if (
      leaf.source.representationArtifactId !== leaf.lineage.projectionArtifact.artifactId ||
      leaf.source.representationDigest !== leaf.lineage.projectionArtifact.digest
    )
      context.addIssue({ code: "custom", message: "Leaf projection lineage mismatch" });
    if (leaf.derivation.kind === "direct" && leaf.value !== leaf.rawValue)
      context.addIssue({ code: "custom", message: "Direct derivation must preserve the selected scalar value" });
  });

/** Persisted field evidence is mechanical proof, never a human-gold label. */
export const VerificationExtractionFieldEvidenceResultSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-extraction-field-evidence.v1"),
    valid: z.boolean(),
    candidateValid: z.boolean(),
    checks: z.array(
      z.strictObject({
        code: z.string(),
        path: z.string().max(4096),
        status: z.enum(["passed", "failed"]),
        detail: z.string(),
      }),
    ),
    acceptedLeaves: z.array(VerificationAcceptedExtractionLeafSchema).max(10000),
  })
  .superRefine((result, context) => {
    if (!result.valid && result.acceptedLeaves.length !== 0)
      context.addIssue({ code: "custom", message: "Rejected result cannot accept leaves" });
    if (result.valid && (!result.candidateValid || result.checks.some((check) => check.status === "failed")))
      context.addIssue({ code: "custom", message: "Accepted result contains failed checks" });
    if (new Set(result.acceptedLeaves.map((leaf) => leaf.path)).size !== result.acceptedLeaves.length)
      context.addIssue({ code: "custom", message: "Duplicate accepted leaf path" });
  });
export type VerificationExtractionFieldEvidenceResult = z.infer<typeof VerificationExtractionFieldEvidenceResultSchema>;
