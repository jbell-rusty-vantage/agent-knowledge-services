import { z } from "zod";
import { ActorSchema } from "./identity.js";
import {
  CanonicalRecordReferenceSchema,
  ContractVersionSchema,
  ImmutableResourceSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  SourceLocatorSchema,
  UuidSchema,
} from "./primitives.js";
import { PublicKnowledgeDomainSchema, VectorSpaceSchema } from "./spaces.js";

export const PromotionStageSchema = z.enum([
  "source_acceptance",
  "representation_acceptance",
  "vector_space_promotion",
]);
export const PromotionStateSchema = z.enum([
  "candidate",
  "inspected",
  "validated",
  "evaluation_pending",
  "review_required",
  "rejected",
  "approved",
  "published",
  "superseded",
  "withdrawn",
]);

export const ModelAuthoredProposalSchema = ImmutableResourceSchema.extend({
  proposalType: z.enum([
    "source_vetting",
    "document_identity",
    "representation_acceptance",
    "domain_mapping",
    "chunking",
    "projection",
    "promotion",
    "evaluation_query",
    "repair",
  ]),
  proposalStage: PromotionStageSchema,
  correlationId: NonEmptyStringSchema,
  inputArtifactDigests: z.array(Sha256DigestSchema).min(1),
  inputRepresentationDigests: z.array(Sha256DigestSchema),
  proposedAction: NonEmptyStringSchema,
  selectedDomains: z.array(PublicKnowledgeDomainSchema),
  targetContract: NonEmptyStringSchema,
  rationale: NonEmptyStringSchema,
  supportingLocators: z.array(SourceLocatorSchema),
  canonicalReferences: z.array(CanonicalRecordReferenceSchema),
  uncertainty: z.array(NonEmptyStringSchema),
  unresolvedQuestions: z.array(NonEmptyStringSchema),
  alternativesConsidered: z.array(NonEmptyStringSchema),
  requestedReviewClass: NonEmptyStringSchema,
  author: ActorSchema,
  promptDigest: Sha256DigestSchema,
  capabilityProfileVersion: NonEmptyStringSchema,
}).superRefine((proposal, context) => {
  if (proposal.author.kind !== "model")
    context.addIssue({ code: "custom", message: "model-authored proposals require a model actor", path: ["author"] });
  if (proposal.proposalType === "promotion" && proposal.selectedDomains.length === 0)
    context.addIssue({
      code: "custom",
      message: "promotion requires at least one target domain",
      path: ["selectedDomains"],
    });
});
export type ModelAuthoredProposal = z.infer<typeof ModelAuthoredProposalSchema>;

export const PromotionDecisionSchema = ImmutableResourceSchema.extend({
  proposalId: UuidSchema,
  stage: PromotionStageSchema,
  guardedProposalDigest: Sha256DigestSchema,
  decision: z.enum(["accept", "reject", "defer", "request_changes"]),
  targetState: PromotionStateSchema,
  gateResultIds: z.array(UuidSchema),
  decider: ActorSchema,
  policyVersionId: UuidSchema,
  rationale: NonEmptyStringSchema,
  separationOfDutyEvidence: NonEmptyStringSchema,
  expiresAt: IsoDateTimeSchema.optional(),
}).superRefine((decision, context) => {
  if (decision.decider.kind === "model")
    context.addIssue({
      code: "custom",
      message: "a model actor cannot execute a promotion decision",
      path: ["decider"],
    });
  const targets = {
    accept: ["approved"],
    reject: ["rejected", "withdrawn"],
    defer: ["evaluation_pending", "review_required"],
    request_changes: ["candidate", "inspected"],
  } as const;
  if (!(targets[decision.decision] as readonly string[]).includes(decision.targetState)) {
    context.addIssue({ code: "custom", message: "targetState is incompatible with decision", path: ["targetState"] });
  }
});
export type PromotionDecision = z.infer<typeof PromotionDecisionSchema>;

export const RepresentationDecisionSchema = ImmutableResourceSchema.extend({
  representationId: UuidSchema,
  representationDigest: Sha256DigestSchema,
  evaluationDigest: Sha256DigestSchema,
  decision: z.enum(["accept", "reject", "quarantine", "defer"]),
  rationale: NonEmptyStringSchema,
  decider: ActorSchema,
  policyVersionId: UuidSchema,
  expiresAt: IsoDateTimeSchema.optional(),
});
export type RepresentationDecision = z.infer<typeof RepresentationDecisionSchema>;

export const PublicationIntentSchema = z.strictObject({
  vectorStoreId: UuidSchema,
  space: VectorSpaceSchema,
  proposalId: UuidSchema,
  decisionId: UuidSchema,
  guardedProposalDigest: Sha256DigestSchema,
});
export type PublicationIntent = z.infer<typeof PublicationIntentSchema>;

export const ReceiptSchema = ImmutableResourceSchema.extend({
  receiptType: NonEmptyStringSchema,
  operationId: UuidSchema,
  attemptId: UuidSchema,
  idempotencyKey: z.string().min(8),
  action: NonEmptyStringSchema,
  actor: ActorSchema,
  inputManifestDigest: Sha256DigestSchema,
  outputManifestDigest: Sha256DigestSchema,
  previousState: NonEmptyStringSchema.optional(),
  resultingState: NonEmptyStringSchema,
  decisionId: UuidSchema.optional(),
  eventIds: z.array(UuidSchema).min(1),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const OperationEventSchema = z.strictObject({
  id: UuidSchema,
  tenantId: UuidSchema,
  operationId: UuidSchema,
  attemptId: UuidSchema,
  eventType: NonEmptyStringSchema,
  contractVersion: ContractVersionSchema,
  occurredAt: IsoDateTimeSchema,
  correlationId: NonEmptyStringSchema,
  causationId: NonEmptyStringSchema.optional(),
  actor: ActorSchema,
  subjectType: NonEmptyStringSchema,
  subjectId: UuidSchema,
  subjectVersion: z.int().positive(),
  previousState: NonEmptyStringSchema.optional(),
  resultingState: NonEmptyStringSchema.optional(),
  guardedDigest: Sha256DigestSchema.optional(),
  payloadDigest: Sha256DigestSchema,
});
export type OperationEvent = z.infer<typeof OperationEventSchema>;
