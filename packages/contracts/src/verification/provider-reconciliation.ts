import { z } from "zod";
import { IsoDateTimeSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationArtifactHandleSchema } from "./primitives.js";
const time = IsoDateTimeSchema.refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, "Canonical UTC timestamp required");
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u);
export const VerificationProviderReconciliationSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-provider-reconciliation.v1"),
    tenantId: UuidSchema,
    operationId: UuidSchema,
    operationStepId: UuidSchema,
    providerAttemptId: UuidSchema,
    budgetId: UuidSchema,
    providerId: z.enum(["gateway-structured-extraction.v1", "interfaze-extraction.v1"]),
    model: z.string().min(1).max(255),
    dispatchFence: UuidSchema,
    dispatchFencingToken: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    requestDigest: Sha256DigestSchema,
    executionArtifact: VerificationArtifactHandleSchema,
    requestArtifact: VerificationArtifactHandleSchema,
    billingEvidenceArtifact: VerificationArtifactHandleSchema,
    originalState: z.enum(["dispatched", "uncertain"]),
    reservationCostMicros: z.int().positive().max(20_000_000),
    decision: z.strictObject({
      action: z.literal("settle_original_attempt"),
      actualCostMicros: z.int().min(0).max(20_000_000),
      basis: z.enum(["synthetic_fixture", "supplier_statement"]),
      redispatchAuthorized: z.literal(false),
    }),
    operatorId: name,
    ticketId: name,
    issuedAt: time,
    expiresAt: time,
    seal: z.strictObject({
      purpose: z.literal("provider_accounting_only"),
      payloadDigest: Sha256DigestSchema,
      signature: z.strictObject({
        algorithm: z.literal("Ed25519"),
        keyId: name,
        signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
      }),
    }),
  })
  .superRefine((value, context) => {
    if (
      new Date(value.expiresAt).getTime() <= new Date(value.issuedAt).getTime() ||
      new Date(value.expiresAt).getTime() - new Date(value.issuedAt).getTime() > 86_400_000
    )
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Decision validity must be positive and at most 24 hours",
      });
    for (const key of ["executionArtifact", "requestArtifact", "billingEvidenceArtifact"] as const)
      if (value[key].tenantId !== value.tenantId)
        context.addIssue({ code: "custom", path: [key], message: "Evidence tenant mismatch" });
  });
export type VerificationProviderReconciliation = z.infer<typeof VerificationProviderReconciliationSchema>;
export const ApplyProviderReconciliationRequestSchema = z.strictObject({ artifact: VerificationArtifactHandleSchema });
export type ApplyProviderReconciliationRequest = z.infer<typeof ApplyProviderReconciliationRequestSchema>;
export const VerificationProviderReconciliationResourceSchema = z.strictObject({
  tenantId: UuidSchema,
  operationId: UuidSchema,
  providerAttemptId: UuidSchema,
  artifact: z.strictObject({ artifactId: UuidSchema, digest: Sha256DigestSchema }),
  actualCostMicros: z.int().min(0).max(20_000_000),
  releasedReservationCostMicros: z.int().positive().max(20_000_000),
  appliedAt: time,
  redispatchAuthorized: z.literal(false),
});
export type VerificationProviderReconciliationResource = z.infer<
  typeof VerificationProviderReconciliationResourceSchema
>;
