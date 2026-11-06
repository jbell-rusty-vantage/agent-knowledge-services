import { z } from "zod";
import { A2AOperationBindingSchema } from "./a2a.js";
import { AuthorizationDecisionSchema } from "./identity.js";
import {
  ArtifactReferenceSchema,
  CanonicalRecordReferenceSchema,
  ImmutableResourceSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  SourceLocatorSchema,
  UuidSchema,
} from "./primitives.js";
import { VectorSpaceSchema } from "./spaces.js";

export const RetrievalIntentSchema = z.enum([
  "entity_discovery",
  "knowledge_evidence",
  "decision_support",
  "implementation_support",
  "tool_selection",
  "implementation_lookup",
]);
const FilterSchema = z.strictObject({
  field: NonEmptyStringSchema,
  op: z.enum(["eq", "neq", "in", "contains", "gte", "lte"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]),
});
/**
 * Retrieval reads three independent clocks and never substitutes one for another.
 *
 * - World time: when the asserted fact holds. Expressed as `worldScope`, a point or a
 *   half-open interval, and matched against canonical temporal ranges.
 * - Knowledge sequence K: what the tenant believed. Expressed as `knowledgeScope`, and
 *   matched against canonical belief windows `k_from <= K < k_to`.
 * - Observed/capture time: when the corpus saw the material. Expressed as `temporalScope`,
 *   a hard filter over capture and index freshness only.
 *
 * A freshness bound is never evidence that a fact held, and K is never evidence of world time.
 */
const RetrievalInstantSchema = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => (/\.(\d+)/.exec(value)?.[1]?.length ?? 0) <= 6,
    "PostgreSQL retrieval instants support at most six fractional digits",
  );

/** Canonical historical search accepts at most this many entity anchors per query. */
export const MAX_RETRIEVAL_ENTITY_ANCHORS = 64;
export const RetrievalWorldScopeSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("at"), at: RetrievalInstantSchema }),
    z.strictObject({ kind: z.literal("overlap"), from: RetrievalInstantSchema, to: RetrievalInstantSchema }),
  ])
  .superRefine((scope, context) => {
    if (scope.kind === "overlap" && compareRetrievalInstants(scope.from, scope.to) >= 0)
      context.addIssue({ code: "custom", message: "world interval requires from < to", path: ["to"] });
  });
export type RetrievalWorldScope = z.infer<typeof RetrievalWorldScopeSchema>;
export const RetrievalOptionalCapabilitySchema = z.enum([
  "graph",
  "concept_anchors",
  "use_case_anchors",
  "soft_boosts",
  "context",
  "freshness_upper_bound",
  "observed_upper_bound",
]);
export type RetrievalOptionalCapability = z.infer<typeof RetrievalOptionalCapabilitySchema>;
export const RetrievalUnsupportedCapabilitySchema = z.strictObject({
  capability: RetrievalOptionalCapabilitySchema,
  reason: z.literal("not_implemented"),
});
export type RetrievalUnsupportedCapability = z.infer<typeof RetrievalUnsupportedCapabilitySchema>;

/**
 * Typed body of the 422 answer to a plan that requires a capability this deployment does
 * not implement. A required capability is never silently dropped and never reaches a
 * provider; declaring the same capability in `optionalCapabilities` turns it into a
 * recorded omission instead.
 */
export const RetrievalUnsupportedResponseSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.retrieval-unsupported/v1"),
  code: z.literal("RETRIEVAL_CAPABILITY_UNSUPPORTED"),
  unsupported: z.array(RetrievalUnsupportedCapabilitySchema).min(1).max(7),
});
export type RetrievalUnsupportedResponse = z.infer<typeof RetrievalUnsupportedResponseSchema>;

/** ISO input is schema-validated before comparison; preserve fractions that Date truncates. */
function compareRetrievalInstants(left: string, right: string): number {
  const key = (value: string) =>
    BigInt(Date.parse(value.replace(/\.\d+/, ""))) * 1_000_000n +
    BigInt((/\.(\d+)/.exec(value)?.[1] ?? "").padEnd(9, "0").slice(0, 9));
  const a = key(left),
    b = key(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
export const RetrievalPlanSchema = z
  .strictObject({
    policyVersion: UuidSchema,
    query: z.string().trim().min(1).max(4_000),
    intents: z.array(RetrievalIntentSchema).min(1),
    subqueries: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
          text: z.string().trim().min(1).max(2_000),
          coverageRole: z.enum(["required", "supporting", "optional"]),
        }),
      )
      .min(1)
      .max(16),
    spaces: z.array(VectorSpaceSchema).min(1),
    anchors: z.strictObject({
      entities: z.array(UuidSchema),
      concepts: z.array(UuidSchema),
      useCases: z.array(NonEmptyStringSchema),
    }),
    hardFilters: z.array(FilterSchema).max(32),
    softBoosts: z.array(FilterSchema).max(32),
    /** Observed/capture freshness only. Never world validity and never a knowledge sequence. */
    temporalScope: z.strictObject({
      effectiveAfter: RetrievalInstantSchema.optional(),
      effectiveBefore: RetrievalInstantSchema.optional(),
      observedBefore: RetrievalInstantSchema.optional(),
    }),
    /** World time the asserted fact must hold at, or overlap with. */
    worldScope: RetrievalWorldScopeSchema.optional(),
    /** Tenant belief clock. Omitted means the current sealed head at execution time. */
    knowledgeScope: z
      .strictObject({ atKnowledgeSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
      .optional(),
    /** Capabilities the caller accepts as best-effort; anything else requested is required. */
    optionalCapabilities: z.array(RetrievalOptionalCapabilitySchema).max(7).optional(),
    candidateK: z.int().min(1).max(1_000),
    finalK: z.int().min(1).max(100),
    graph: z.strictObject({
      maxDepth: z.int().min(0).max(3),
      allowedEdges: z.array(NonEmptyStringSchema).max(32),
    }),
    rerankerVersion: UuidSchema.optional(),
    abstention: z.strictObject({ minimumCoverage: z.number().min(0).max(1) }),
  })
  .superRefine((plan, context) => {
    if (
      new Set(plan.anchors.entities).size !== plan.anchors.entities.length ||
      plan.anchors.entities.length > MAX_RETRIEVAL_ENTITY_ANCHORS
    )
      context.addIssue({
        code: "custom",
        message: `entity anchors must be distinct and bounded to ${MAX_RETRIEVAL_ENTITY_ANCHORS}`,
        path: ["anchors", "entities"],
      });
    const { effectiveAfter, effectiveBefore, observedBefore } = plan.temporalScope;
    if (effectiveAfter && effectiveBefore && compareRetrievalInstants(effectiveAfter, effectiveBefore) >= 0)
      context.addIssue({
        code: "custom",
        message: "effectiveAfter must precede effectiveBefore",
        path: ["temporalScope", "effectiveBefore"],
      });
    if (effectiveAfter && observedBefore && compareRetrievalInstants(effectiveAfter, observedBefore) >= 0)
      context.addIssue({
        code: "custom",
        message: "observedBefore must follow effectiveAfter",
        path: ["temporalScope", "observedBefore"],
      });
    if (new Set(plan.optionalCapabilities ?? []).size !== (plan.optionalCapabilities?.length ?? 0))
      context.addIssue({
        code: "custom",
        message: "optional capabilities must be distinct",
        path: ["optionalCapabilities"],
      });
    if (plan.finalK > plan.candidateK)
      context.addIssue({
        code: "custom",
        message: "finalK cannot exceed candidateK",
        path: ["finalK"],
      });
    if (new Set(plan.spaces).size !== plan.spaces.length)
      context.addIssue({
        code: "custom",
        message: "spaces must be unique",
        path: ["spaces"],
      });
    if (new Set(plan.subqueries.map(({ id }) => id)).size !== plan.subqueries.length)
      context.addIssue({
        code: "custom",
        message: "subquery ids must be unique",
        path: ["subqueries"],
      });
  });
export type RetrievalPlan = z.infer<typeof RetrievalPlanSchema>;

/** The only accepted production retrieval mutation input. Query embeddings are generated by the service. */
export const RetrievalRunInputSchema = z.strictObject({
  plan: RetrievalPlanSchema,
  a2a: A2AOperationBindingSchema.optional(),
});
export type RetrievalRunInput = z.infer<typeof RetrievalRunInputSchema>;

export const ScoreComponentsSchema = z.strictObject({
  lexical: z.number().optional(),
  semantic: z.number().optional(),
  fusion: z.number().optional(),
  graph: z.number().optional(),
  reranker: z.number().optional(),
  final: z.number(),
});
export const RetrievalResultSchema = z.strictObject({
  resultType: NonEmptyStringSchema,
  canonicalRecord: CanonicalRecordReferenceSchema,
  searchProjectionId: UuidSchema,
  projectionVersionId: UuidSchema,
  matchExplanation: NonEmptyStringSchema,
  scores: ScoreComponentsSchema,
  matchedConstraints: z.array(NonEmptyStringSchema),
  evidenceLocators: z.array(SourceLocatorSchema).min(1),
  artifactHandles: z.array(ArtifactReferenceSchema),
  authority: z.enum(["canonical", "exploratory", "user_managed"]),
  verification: z.enum(["verified", "supported", "unverified", "contradicted"]),
  freshnessAt: z.iso.datetime({ offset: true }),
  temporalApplicability: NonEmptyStringSchema.optional(),
  flags: z.strictObject({
    contradicted: z.boolean(),
    corrected: z.boolean(),
    retracted: z.boolean(),
    deprecated: z.boolean(),
    superseded: z.boolean(),
  }),
  relatedRecords: z.array(CanonicalRecordReferenceSchema),
  retrievalRunId: UuidSchema,
  evidencePacketId: UuidSchema,
});
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

/**
 * One authenticated canonical support path behind a packet member: the admitted claim,
 * the assessment that admitted it, the exact locator/selector, and the capture bytes a
 * fresh consumer must reconstruct the quote from. Source-family grouping and replay both
 * read these fields; nothing here is derived from a support manifest pointer alone.
 */
export const RetrievalSupportPathSchema = z.strictObject({
  claimId: UuidSchema,
  claimStatus: z.enum(["verified", "superseded"]),
  verificationRunId: UuidSchema,
  assessmentVerdict: z.enum(["directly_supported", "supported_with_qualification", "derived_verified"]),
  admissionDigest: Sha256DigestSchema,
  locatorId: UuidSchema,
  selectorDigest: Sha256DigestSchema,
  selectedContentDigest: Sha256DigestSchema,
  captureId: UuidSchema,
  sourceFamilyId: UuidSchema,
  representationId: UuidSchema,
  captureArtifact: ArtifactReferenceSchema,
  qualifiers: z.array(NonEmptyStringSchema),
});
export type RetrievalSupportPath = z.infer<typeof RetrievalSupportPathSchema>;

/** Bounded canonical support a packet member carries for replay and diversity. */
export const RetrievalMemberSupportSchema = z.strictObject({
  target: z.strictObject({
    kind: z.enum(["entity", "record", "chunk", "claim", "summary"]),
    canonicalId: UuidSchema,
    projectionTargetId: UuidSchema,
  }),
  sourceFamilyIds: z.array(UuidSchema).min(1).max(32),
  paths: z.array(RetrievalSupportPathSchema).min(1).max(32),
  truncated: z.boolean(),
});
export type RetrievalMemberSupport = z.infer<typeof RetrievalMemberSupportSchema>;

/** One replayed citation: bytes fetched from remote custody and re-selected, never cached prose. */
export const RetrievalReplayedCitationSchema = z.strictObject({
  memberId: UuidSchema,
  locatorId: UuidSchema,
  captureId: UuidSchema,
  sourceFamilyId: UuidSchema,
  representationArtifactId: UuidSchema,
  captureArtifactId: UuidSchema,
  representationDigest: Sha256DigestSchema,
  captureDigest: Sha256DigestSchema,
  selectorDigest: Sha256DigestSchema,
  selectedContentDigest: Sha256DigestSchema,
  selectedText: z.string(),
  selectedSizeBytes: z.int().nonnegative(),
});

/** Public replay answer for one persisted packet. Dependency revocation is reported, never hidden. */
export const RetrievalCitationReplaySchema = z.strictObject({
  schemaVersion: z.literal("knowledge.retrieval-citation-replay/v1"),
  evidencePacketId: UuidSchema,
  retrievalRunId: UuidSchema,
  packetDigest: Sha256DigestSchema,
  citations: z.array(RetrievalReplayedCitationSchema).max(128),
  failures: z
    .array(z.strictObject({ memberId: UuidSchema, locatorId: UuidSchema, code: NonEmptyStringSchema }))
    .max(128),
  replayedAt: z.iso.datetime({ offset: true }),
});
export type RetrievalCitationReplay = z.infer<typeof RetrievalCitationReplaySchema>;

export const EvidencePacketMemberSchema = z
  .strictObject({
    memberId: UuidSchema,
    canonicalRecord: CanonicalRecordReferenceSchema.optional(),
    faithfulSectionRepresentationId: UuidSchema.optional(),
    matchedProjectionId: UuidSchema,
    locators: z.array(SourceLocatorSchema).min(1),
    scores: ScoreComponentsSchema,
    channelExplanations: z.array(NonEmptyStringSchema),
    graphPaths: z.array(z.array(NonEmptyStringSchema)),
    authority: z.enum(["canonical", "exploratory", "user_managed"]),
    assurance: z.enum(["high", "medium", "low"]),
    freshAt: z.iso.datetime({ offset: true }),
    contradictionIds: z.array(UuidSchema),
    supersedesIds: z.array(UuidSchema),
    coveredSubqueryIds: z.array(NonEmptyStringSchema),
    artifactReferences: z.array(ArtifactReferenceSchema),
    support: RetrievalMemberSupportSchema.optional(),
  })
  .refine((member) => member.canonicalRecord !== undefined || member.faithfulSectionRepresentationId !== undefined, {
    message: "member requires a canonical record or faithful section",
  });

export const EvidencePacketSchema = ImmutableResourceSchema.extend({
  retrievalRunId: UuidSchema,
  normalizedQuery: NonEmptyStringSchema,
  plan: RetrievalPlanSchema,
  queryClock: z
    .strictObject({
      atKnowledgeSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      worldScope: RetrievalWorldScopeSchema.optional(),
      /** The authorized publications this answer was read from, pinned for replay. */
      publications: z
        .array(
          z.strictObject({
            vectorSpace: VectorSpaceSchema,
            vectorSpaceVersionId: UuidSchema,
            publicationId: UuidSchema,
          }),
        )
        .max(8)
        .optional(),
    })
    .optional(),
  unsupportedCapabilities: z.array(RetrievalUnsupportedCapabilitySchema).max(7).optional(),
  authorization: AuthorizationDecisionSchema,
  procedureVersionIds: z.array(UuidSchema),
  members: z.array(EvidencePacketMemberSchema),
  omittedResults: z.array(
    z.strictObject({
      recordId: UuidSchema.optional(),
      reason: NonEmptyStringSchema,
    }),
  ),
  coverage: z.array(
    z.strictObject({
      subqueryId: NonEmptyStringSchema,
      coverage: z.number().min(0).max(1),
    }),
  ),
  abstention: z.strictObject({
    recommended: z.boolean(),
    reason: NonEmptyStringSchema.optional(),
  }),
  eventIds: z.array(UuidSchema),
  artifactIds: z.array(UuidSchema),
  receiptIds: z.array(UuidSchema),
});
export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;
