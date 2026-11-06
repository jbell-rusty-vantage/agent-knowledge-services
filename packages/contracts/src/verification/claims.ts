import { z } from "zod";
import { AssertionSchema, VerificationBundleSchema } from "./model.js";
import { VerificationArtifactHandleSchema, VerificationIdSchema } from "./primitives.js";
import { NonEmptyStringSchema, Sha256DigestSchema } from "./index-primitives.js";

/** Artifact payload for claim verification.  It is deliberately artifact based: excerpts
 * shown to an operator are never accepted as evidence selectors. */
export const VerificationClaimsArtifactSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-claims-artifact.v1"),
    bundle: VerificationBundleSchema,
  })
  .superRefine((value, context) => {
    if (value.bundle.assertions.some((assertion) => assertion.kind !== "claim"))
      context.addIssue({
        code: "custom",
        path: ["bundle", "assertions"],
        message: "claim verification accepts claim assertions only",
      });
    if (value.bundle.metricObservations.length !== 0)
      context.addIssue({
        code: "custom",
        path: ["bundle", "metricObservations"],
        message: "claim verification does not accept metric observations",
      });
  });
export type VerificationClaimsArtifact = z.infer<typeof VerificationClaimsArtifactSchema>;

export const ReportCitationInputSchema = z.strictObject({
  citationId: NonEmptyStringSchema,
  /** Binds to the report assertion's declared evidence edge; status is derived server-side. */
  evidenceId: NonEmptyStringSchema,
});

/** Offsets are UTF-16 offsets into the exact bytes decoded from `report`, not display text. */
export const ReportAssertionInputSchema = z
  .strictObject({
    assertion: AssertionSchema,
    exactText: NonEmptyStringSchema,
    start: z.int().nonnegative(),
    end: z.int().positive(),
    citationRequired: z.boolean(),
    claimWeight: z.number().positive().max(100),
    severity: z.enum(["low", "medium", "high", "critical"]),
    citations: z.array(ReportCitationInputSchema).max(32),
    requiredQualifiers: z.array(NonEmptyStringSchema).max(32),
    consistencyKey: NonEmptyStringSchema.optional(),
    consistencyFacet: z.enum(["entity", "date", "number", "other"]).optional(),
    contextKey: NonEmptyStringSchema.optional(),
    normalizedValue: NonEmptyStringSchema.optional(),
    negated: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.assertion.kind !== "report_assertion")
      context.addIssue({
        code: "custom",
        path: ["assertion", "kind"],
        message: "report ledger entries must be report assertions",
      });
    if (value.end <= value.start)
      context.addIssue({ code: "custom", path: ["end"], message: "end must be greater than start" });
  });

export const VerificationReportLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-report-ledger.v1"),
    /** Exact registered report bytes whose UTF-16 offsets are described below. */
    reportArtifact: VerificationArtifactHandleSchema,
    bundle: VerificationBundleSchema,
    assertions: z.array(ReportAssertionInputSchema).min(1).max(512),
  })
  .superRefine((value, context) => {
    if (value.bundle.metricObservations.length !== 0)
      context.addIssue({
        code: "custom",
        path: ["bundle", "metricObservations"],
        message: "report verification does not accept metric observations",
      });
    if (value.bundle.assertions.some((item) => item.kind !== "report_assertion"))
      context.addIssue({
        code: "custom",
        path: ["bundle", "assertions"],
        message: "report verification accepts report assertions only",
      });
    const reportAssertionIds = new Set(
      value.bundle.assertions.filter((item) => item.kind === "report_assertion").map((item) => item.assertionId),
    );
    if (
      reportAssertionIds.size !== value.assertions.length ||
      new Set(value.assertions.map((item) => item.assertion.assertionId)).size !== value.assertions.length
    )
      context.addIssue({
        code: "custom",
        path: ["assertions"],
        message: "ledger assertions must bijectively cover report assertions",
      });
    for (const item of value.assertions) {
      const bound = value.bundle.assertions.find((candidate) => candidate.assertionId === item.assertion.assertionId);
      if (!bound || JSON.stringify(bound) !== JSON.stringify(item.assertion))
        context.addIssue({
          code: "custom",
          path: ["assertions"],
          message: "ledger assertion must exactly match its bundled assertion",
        });
      if (
        item.assertion.outputArtifactId !== value.reportArtifact.artifactId ||
        item.assertion.outputRange?.start !== item.start ||
        item.assertion.outputRange?.end !== item.end
      ) {
        context.addIssue({
          code: "custom",
          path: ["assertions"],
          message: "report assertion offsets must bind the exact report artifact",
        });
      }
      for (const citation of item.citations)
        if (!bound?.evidence.some((edge) => edge.evidenceId === citation.evidenceId))
          context.addIssue({
            code: "custom",
            path: ["assertions"],
            message: "citation must bind declared assertion evidence",
          });
    }
  });
export type VerificationReportLedger = z.infer<typeof VerificationReportLedgerSchema>;

export const VerificationReportWideSummarySchema = z.strictObject({
  claimWeightedCitationCompleteness: z.number().min(0).max(1),
  citationCorrectness: z.number().min(0).max(1).nullable(),
  validPointerConditionalCitationCorrectness: z.number().min(0).max(1).nullable(),
  pointerFailures: z.array(VerificationIdSchema).max(4_096),
  misplacedCitationIds: z.array(VerificationIdSchema).max(4_096),
  duplicateAssertionGroups: z.array(z.array(VerificationIdSchema).min(2).max(512)).max(512),
  conflictAssertionGroups: z.array(z.array(VerificationIdSchema).min(2).max(512)).max(512),
  missingQualifierAssertionIds: z.array(VerificationIdSchema).max(512),
  consistencyMismatchGroups: z.array(z.array(VerificationIdSchema).min(2).max(512)).max(512),
  crossSectionMismatches: z
    .array(
      z.strictObject({
        facet: z.enum(["entity", "date", "number", "other"]),
        assertionIds: z.array(VerificationIdSchema).min(2).max(512),
      }),
    )
    .max(512),
  independentSourceFamilyCount: z.int().nonnegative().max(4_096),
  distinctSourceFamilyCount: z.int().nonnegative().max(4_096),
  unsupportedHighSeverityAssertionIds: z.array(VerificationIdSchema).max(512),
});
export type VerificationReportWideSummary = z.infer<typeof VerificationReportWideSummarySchema>;

/** Canonical retained body that binds report-wide mechanics to the gated deterministic result. */
export const VerificationReportGateArtifactSchema = z.strictObject({
  schemaVersion: z.literal("verification-report-result.v1"),
  coverageScope: z.literal("producer_declared_assertions_only"),
  deterministicResultDigest: Sha256DigestSchema,
  reportWide: VerificationReportWideSummarySchema,
});
export type VerificationReportGateArtifact = z.infer<typeof VerificationReportGateArtifactSchema>;
