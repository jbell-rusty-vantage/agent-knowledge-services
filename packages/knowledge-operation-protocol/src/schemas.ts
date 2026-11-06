import { z } from "zod";
import { BindingDescriptorSchema } from "./capability.js";
import { CredentialClaimsSchema } from "./credential.js";
import { EffectBindingSchema, EffectIdentitySchema } from "./effect.js";
import { OperationEnvelopeSchema } from "./envelope.js";
import { ProtocolErrorSchema } from "./errors.js";
import { OperationHandleSchema, OperationStatusSchema } from "./handle.js";
import { EvaluatorIdentitySchema, OriginSchema } from "./origin.js";
import { RefSchema } from "./primitives.js";
import { OperationReceiptSchema, ReceiptLookupSchema } from "./receipt.js";
import {
  CredentialEvaluationSchema,
  DecisionResolutionSchema,
  DecisionResolveRequestSchema,
  ReportObservationRequestSchema,
  ReportReviewRequestSchema,
  ReportSealRequestSchema,
  ReportUseRequestSchema,
} from "./assessment.js";
import { ResearchReportPackageSchema, SelectedReportReadSchema } from "./selected-read.js";
import { KnowledgePlanPreviewSchema } from "./plan-preview.js";
import { KnowledgeReadIntentRequestSchema, KnowledgeReadIntentResultSchema } from "./read-intent.js";

/**
 * The published schema set. Python consumers (Mission Control) generate their validation models from the JSON Schemas
 * written by `scripts/generate-schemas.ts` into `schemas/`; they never import these TypeScript values.
 */
export const PUBLISHED_SCHEMAS = {
  "ref.v2": RefSchema,
  "origin.v2": OriginSchema,
  "evaluator-identity.v2": EvaluatorIdentitySchema,
  "effect-binding.v2": EffectBindingSchema,
  "effect-identity.v2": EffectIdentitySchema,
  "protocol-error.v2": ProtocolErrorSchema,
  "operation-handle.v2": OperationHandleSchema,
  "operation-status.v2": OperationStatusSchema,
  "operation-receipt.v2": OperationReceiptSchema,
  "receipt-lookup.v2": ReceiptLookupSchema,
  "operation-envelope.v2": OperationEnvelopeSchema,
  "binding-descriptor.v2": BindingDescriptorSchema,
  "credential-claims.v2": CredentialClaimsSchema,
  "selected-report-read.v2": SelectedReportReadSchema,
  "research-report-package.v2": ResearchReportPackageSchema,
  "credential-evaluation.v1": CredentialEvaluationSchema,
  "report-observation.v1": ReportObservationRequestSchema,
  "report-seal.v1": ReportSealRequestSchema,
  "report-use.v1": ReportUseRequestSchema,
  "report-review.v1": ReportReviewRequestSchema,
  "decision-resolve.v1": DecisionResolveRequestSchema,
  "use-decision-resolution.v1": DecisionResolutionSchema,
  "knowledge-plan-preview.v1": KnowledgePlanPreviewSchema,
  "knowledge-read-intent-request.v1": KnowledgeReadIntentRequestSchema,
  "knowledge-read-intent-result.v1": KnowledgeReadIntentResultSchema,
} as const;
export type PublishedSchemaName = keyof typeof PUBLISHED_SCHEMAS;

export function publishedJsonSchema(name: PublishedSchemaName): Record<string, unknown> {
  const schema = PUBLISHED_SCHEMAS[name];
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
}
