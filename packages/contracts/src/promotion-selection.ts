import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./primitives.js";
import { RepresentationClassSchema } from "./content.js";
import { VectorSpaceSchema } from "./spaces.js";

const MAX_SELECTION_MEMBERS = 512;
const Reason = NonEmptyStringSchema.max(2_000);
const Identifier = NonEmptyStringSchema.max(256);
const Count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ContentReference = z.strictObject({
  kind: z.enum(["node", "chunk", "claim", "entity", "record", "summary"]),
  id: UuidSchema,
  digest: Sha256DigestSchema,
});
const TargetReference = z.strictObject({
  projectionTargetId: UuidSchema,
  kind: z.enum(["entity", "claim", "record", "summary", "chunk"]),
  canonicalId: UuidSchema,
});
const SourceReference = z.strictObject({
  chunkId: UuidSchema,
  chunkDigest: Sha256DigestSchema,
  representationId: UuidSchema,
  representationDigest: Sha256DigestSchema,
  representationClass: RepresentationClassSchema,
  captureId: UuidSchema,
  sourceFamilyId: Identifier,
});
const ClaimBinding = z.strictObject({
  runId: Identifier,
  claimId: Identifier,
  claimDigest: Sha256DigestSchema,
  admissionDigest: Sha256DigestSchema,
});
const SelectedMember = z.strictObject({
  memberId: Identifier,
  content: ContentReference,
  target: TargetReference,
  targetSpaces: z.array(VectorSpaceSchema).min(1).max(VectorSpaceSchema.options.length),
  sourceChunks: z.array(SourceReference).min(1).max(MAX_SELECTION_MEMBERS),
  admittedClaims: z.array(ClaimBinding).max(MAX_SELECTION_MEMBERS),
  contentLinkReceiptIds: z.array(UuidSchema).min(1).max(MAX_SELECTION_MEMBERS),
  reason: Reason,
  estimatedBytes: Count,
  estimatedTokens: Count,
  estimatedCostMicros: Count,
});
const ExcludedMember = z.strictObject({
  content: ContentReference,
  targetSpaces: z.array(VectorSpaceSchema).min(1).max(VectorSpaceSchema.options.length),
  reason: Reason,
});

/** Candidate selection only. References and estimates require independent server validation. */
export const PromotionSelectionSchema = z
  .strictObject({
    schemaVersion: z.literal("promotion-selection.v1"),
    tenantId: UuidSchema,
    expectedKnowledgeHead: Count,
    runPinDigest: Sha256DigestSchema,
    policyDigest: Sha256DigestSchema,
    selected: z.array(SelectedMember).min(1).max(MAX_SELECTION_MEMBERS),
    excluded: z.array(ExcludedMember).max(MAX_SELECTION_MEMBERS),
    budget: z.strictObject({
      maxMembers: z.int().positive().max(MAX_SELECTION_MEMBERS),
      maxBytes: Count,
      maxTokens: Count,
      maxCostMicros: Count,
      deadline: IsoDateTimeSchema,
    }),
    proposedBy: Identifier,
    requiredReviewer: Identifier,
  })
  .superRefine((selection, context) => {
    const reject = (message: string) => context.addIssue({ code: "custom", message });
    const unique = (values: readonly string[], label: string) => {
      if (new Set(values).size !== values.length) reject(`${label} must be unique`);
    };
    const contentKey = (content: z.infer<typeof ContentReference>) => `${content.kind}:${content.id}`;
    const selectedSpaces = new Set<string>();
    const referenceBindings = new Map<string, string>();
    const remember = (kind: string, key: string, binding: unknown) => {
      const identity = `${kind}:${key}`;
      const value = JSON.stringify(binding);
      const prior = referenceBindings.get(identity);
      if (prior !== undefined && prior !== value) reject(`${kind} identity has conflicting immutable bindings`);
      referenceBindings.set(identity, value);
    };
    unique(
      selection.selected.map((member) => member.memberId),
      "member IDs",
    );
    unique(
      selection.selected.map((member) => `${contentKey(member.content)}:${member.target.projectionTargetId}`),
      "content/target pairs",
    );
    if (selection.proposedBy === selection.requiredReviewer) reject("promotion requires an independent reviewer");
    if (selection.selected.length > selection.budget.maxMembers)
      reject("selected membership exceeds the reserved member limit");
    const bytes = selection.selected.reduce((total, member) => total + BigInt(member.estimatedBytes), 0n);
    const tokens = selection.selected.reduce((total, member) => total + BigInt(member.estimatedTokens), 0n);
    const cost = selection.selected.reduce((total, member) => total + BigInt(member.estimatedCostMicros), 0n);
    if (bytes > BigInt(selection.budget.maxBytes)) reject("selected bytes exceed the reserved byte limit");
    if (tokens > BigInt(selection.budget.maxTokens)) reject("selected tokens exceed the reserved token limit");
    if (cost > BigInt(selection.budget.maxCostMicros)) reject("selected cost exceeds the reserved cost limit");
    const contentDigests = new Map<string, string>();
    for (const member of [...selection.selected, ...selection.excluded]) {
      const key = contentKey(member.content);
      const prior = contentDigests.get(key);
      if (prior !== undefined && prior !== member.content.digest)
        reject("one content identity cannot name different digests");
      contentDigests.set(key, member.content.digest);
      unique(member.targetSpaces, "member target spaces");
    }
    for (const member of selection.selected) {
      remember("projection target", member.target.projectionTargetId, [member.target.kind, member.target.canonicalId]);
      remember(
        "canonical target",
        `${member.target.kind}:${member.target.canonicalId}`,
        member.target.projectionTargetId,
      );
      for (const source of member.sourceChunks) {
        remember("source chunk", source.chunkId, source);
        remember("source representation", source.representationId, [
          source.representationDigest,
          source.representationClass,
        ]);
      }
      for (const claim of member.admittedClaims)
        remember("admitted claim", JSON.stringify([claim.runId, claim.claimId]), claim);
      for (const space of member.targetSpaces) selectedSpaces.add(`${contentKey(member.content)}:${space}`);
      unique(
        member.sourceChunks.map((source) => source.chunkId),
        "member source chunks",
      );
      unique(member.contentLinkReceiptIds, "member content-link receipts");
      unique(
        member.admittedClaims.map((claim) => JSON.stringify([claim.runId, claim.claimId])),
        "member admitted claims",
      );
      const officialDomain = member.targetSpaces.some((space) => space !== "source_native_sections");
      if (officialDomain && (member.target.kind === "chunk" || member.admittedClaims.length === 0)) {
        reject("domain projections require a canonical entity/claim/record/summary target and admitted claims");
      }
      if (
        member.target.kind === "chunk" &&
        (member.content.kind !== "chunk" || member.content.id !== member.target.canonicalId)
      ) {
        reject("a chunk projection target must identify the selected chunk");
      }
      if (
        member.content.kind !== "chunk" &&
        member.content.kind !== "node" &&
        (member.target.kind !== member.content.kind || member.target.canonicalId !== member.content.id)
      ) {
        reject("selected canonical content must match its projection target");
      }
      if (
        member.targetSpaces.includes("source_native_sections") &&
        ((member.content.kind !== "chunk" && member.content.kind !== "node") ||
          member.sourceChunks.some(
            (source) =>
              source.representationClass === "semantic_projection" ||
              source.representationClass === "retrieval_projection",
          ))
      ) {
        reject("source-native sections require faithful source content rather than derived projections");
      }
      if (
        member.content.kind === "chunk" &&
        !member.sourceChunks.some(
          (source) => source.chunkId === member.content.id && source.chunkDigest === member.content.digest,
        )
      ) {
        reject("selected chunk bytes must appear in source lineage");
      }
    }
    const excludedSpaces: string[] = [];
    for (const member of selection.excluded)
      for (const space of member.targetSpaces) {
        const key = `${contentKey(member.content)}:${space}`;
        if (selectedSpaces.has(key)) reject("content cannot be selected and excluded from the same space");
        excludedSpaces.push(key);
      }
    unique(excludedSpaces, "excluded content/space pairs");
  });

export type PromotionSelection = z.infer<typeof PromotionSelectionSchema>;

/**
 * Independently registered selection authority. A selection cannot pin its own
 * tenant, run, policy, proposer, reviewer or budget: the server resolves these
 * from retained authority bytes and rejects any selection that disagrees.
 */
export const PromotionSelectionAuthoritySchema = z
  .strictObject({
    schemaVersion: z.literal("promotion-selection-authority.v1"),
    tenantId: UuidSchema,
    runPinDigest: Sha256DigestSchema,
    policyDigest: Sha256DigestSchema,
    proposedBy: Identifier,
    requiredReviewer: Identifier,
    budget: z.strictObject({
      maxMembers: z.int().positive().max(MAX_SELECTION_MEMBERS),
      maxBytes: Count,
      maxTokens: Count,
      maxCostMicros: Count,
      deadline: IsoDateTimeSchema,
    }),
  })
  .superRefine((authority, context) => {
    if (authority.proposedBy === authority.requiredReviewer)
      context.addIssue({ code: "custom", message: "promotion authority requires an independent reviewer" });
  });
export type PromotionSelectionAuthorityDocument = z.infer<typeof PromotionSelectionAuthoritySchema>;

/** Input for the implemented promotion_proposal operation; selection remains independently authenticated. */
export const PromotionProposalInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.promotion-proposal/v1"),
  selection: PromotionSelectionSchema,
  selectionArtifact: z.strictObject({ id: UuidSchema, digest: Sha256DigestSchema }),
  chunkSetId: UuidSchema,
  representationDecisionId: UuidSchema,
  projectionProcedureId: UuidSchema,
  purpose: Reason,
  contextualPrefix: z.literal(""),
  language: NonEmptyStringSchema.max(64).optional(),
  visibility: NonEmptyStringSchema.max(64),
  classification: NonEmptyStringSchema.max(64),
  targetDomains: z.array(VectorSpaceSchema).min(1).max(VectorSpaceSchema.options.length),
  expectedValue: Reason,
  risks: z.array(Reason).max(MAX_SELECTION_MEMBERS),
  exclusions: z.array(Reason).max(MAX_SELECTION_MEMBERS),
  reason: Reason,
});
export type PromotionProposalInput = z.infer<typeof PromotionProposalInputSchema>;
