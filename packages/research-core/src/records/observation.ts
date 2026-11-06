import {
  DigestSchema,
  EvaluatorIdentitySchema,
  IdSchema,
  InstantSchema,
  type RefKind,
  SafeIntSchema,
  refOf,
  refOfAny,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { LongTextSchema, ShortTextSchema, UsageSchema, identityShape } from "./common.js";
import { CensusExplanationSchema, UnitExplanationSchema } from "./occurrence.js";

export const OBSERVATION_SCHEMA_VERSION = "research-core.observation.v2" as const;

const FragmentRefs = z.array(refOf("fragment"));

/** L0 mechanics. A broken pointer is an integrity failure, never a semantic contradiction. */
export const INTEGRITY_FAILURE_CODES = [
  "capture_digest_mismatch",
  "representation_digest_mismatch",
  "selector_unresolved",
  "locator_error",
  "parser_error",
  "identity_mismatch",
  "type_mismatch",
  "unit_mismatch",
  "time_mismatch",
  "arithmetic_error",
  "provenance_missing",
  "source_unavailable",
  /** An explicit correction/revocation of the source or fragment (SV-07 `recordCorrection` closure recheck). */
  "source_corrected",
] as const;
export const IntegrityOutcomeSchema = z.discriminatedUnion("result", [
  z.strictObject({ result: z.literal("pass") }),
  z.strictObject({ result: z.literal("fail"), failureCodes: z.array(z.enum(INTEGRITY_FAILURE_CODES)).min(1) }),
  z.strictObject({
    result: z.literal("unable_to_assess"),
    reason: z.enum(["unsupported_media", "parser_unavailable", "budget_exhausted", "provider_denied"]),
  }),
]);

/**
 * Support verdicts (VERIFICATION.md §4 shared semantic rubric). Mapping from the accepted lattice in
 * `packages/contracts/src/verification/model.ts` (`SemanticVerdictSchema`), copied, not imported:
 *  directly_supported -> full_support; supported_with_qualification -> qualified_support;
 *  partially_supported | context_only -> partial_or_context_only; contradicted -> contradiction;
 *  mixed_or_conflicting -> conflict; insufficient_evidence | not_supported -> insufficient_evidence;
 *  unverifiable -> unable_to_assess. locator_error, parser_error and source_unavailable are integrity failure codes;
 *  derived_verified/derived_failed are support-algebra results; pending_semantic_review is the absence of an observation.
 */
export const SUPPORT_VERDICTS = [
  "full_support",
  "qualified_support",
  "partial_or_context_only",
  "contradiction",
  "conflict",
  "insufficient_evidence",
  "unable_to_assess",
] as const;
export const SupportVerdictSchema = z.enum(SUPPORT_VERDICTS);
export type SupportVerdict = z.infer<typeof SupportVerdictSchema>;

export const SUPPORT_FACETS = [
  "entity",
  "coreference",
  "quantity",
  "denominator",
  "unit",
  "population",
  "time",
  "baseline",
  "negation",
  "modality",
  "causal_wording",
  "attribution",
  "comparison",
  "jurisdiction",
] as const;

export const SupportOutcomeSchema = z
  .strictObject({
    verdict: SupportVerdictSchema,
    /** The premise judged; `null` means the complete assertion against the whole set. */
    premise: IdSchema.nullable(),
    citedFragments: FragmentRefs,
    contradictingFragments: FragmentRefs,
    unsupportedFacets: z.array(z.enum(SUPPORT_FACETS)),
    qualification: ShortTextSchema.nullable(),
  })
  .superRefine((outcome, context) => {
    const accepting = outcome.verdict === "full_support" || outcome.verdict === "qualified_support";
    if (accepting && outcome.citedFragments.length === 0) {
      context.addIssue({ code: "custom", path: ["citedFragments"], message: "support cites admitted fragments" });
    }
    if (
      outcome.verdict === "full_support" &&
      (outcome.unsupportedFacets.length > 0 || outcome.qualification !== null)
    ) {
      context.addIssue({ code: "custom", path: ["verdict"], message: "full support has no unsupported facet" });
    }
    if (outcome.verdict === "qualified_support" && outcome.qualification === null) {
      context.addIssue({
        code: "custom",
        path: ["qualification"],
        message: "qualified support states its qualification",
      });
    }
    if (outcome.verdict === "contradiction" && outcome.contradictingFragments.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["contradictingFragments"],
        message: "a contradiction names fragments",
      });
    }
  });
export type SupportOutcome = z.infer<typeof SupportOutcomeSchema>;

export const REVISION_STATUSES = ["current", "corrected", "retracted", "withdrawn", "unknown"] as const;

/**
 * Source fitness and credibility (design §3.1 judgment 2). Origin families: `proposed` are the families the producer
 * or fragments declared, `family` is the family the authority resolver verified (`null` = unknown, never guessed);
 * three reports of one study are one verified family, so `distinctOrigins` counts verified families only. Fitness and
 * applicability come from the pinned K08 rules named by `rules` (digest); the revision frontier records what was
 * checked on demand (retractions, corrections), what was not, and when.
 */
export const AuthorityOutcomeSchema = z
  .strictObject({
    originFamilies: z.array(
      z.strictObject({ family: IdSchema.nullable(), proposed: z.array(IdSchema), fragments: FragmentRefs.min(1) }),
    ),
    distinctOrigins: SafeIntSchema,
    unknownOriginFrontier: z.array(ShortTextSchema),
    applicability: z.enum(["applicable", "partially_applicable", "not_applicable", "unknown"]),
    directness: z.enum(["direct", "indirect", "unknown"]),
    freshness: z.enum(["current", "stale", "superseded", "unknown"]),
    fitness: z.enum(["fit", "fit_with_limitations", "unfit", "unknown"]),
    fitnessRule: IdSchema.nullable(),
    rules: z.strictObject({ id: IdSchema, version: z.string().min(1).max(40), digest: DigestSchema }),
    revisionFrontier: z.strictObject({
      status: z.enum(REVISION_STATUSES),
      checkedAt: InstantSchema.nullable(),
      notices: FragmentRefs,
      checked: z.array(
        z.strictObject({
          identifier: ShortTextSchema,
          status: z.enum(REVISION_STATUSES),
          noticeIdentifiers: z.array(ShortTextSchema),
        }),
      ),
      unchecked: z.array(ShortTextSchema),
    }),
  })
  .superRefine((outcome, context) => {
    const verified = new Set(outcome.originFamilies.flatMap((entry) => (entry.family === null ? [] : [entry.family])));
    if (outcome.distinctOrigins !== verified.size) {
      context.addIssue({
        code: "custom",
        path: ["distinctOrigins"],
        message: "distinctOrigins counts verified families",
      });
    }
  });
export type AuthorityOutcome = z.infer<typeof AuthorityOutcomeSchema>;

/** An authority judgment that refutes use (unfit, not applicable, superseded, retracted or withdrawn). */
export function authorityAdverse(outcome: AuthorityOutcome): boolean {
  return (
    outcome.fitness === "unfit" ||
    outcome.applicability === "not_applicable" ||
    outcome.freshness === "superseded" ||
    outcome.revisionFrontier.status === "retracted" ||
    outcome.revisionFrontier.status === "withdrawn"
  );
}

/** Authority not established: any decisive field still unknown (unknown stays unknown; it never counts as fit). */
export function authorityUnknown(outcome: AuthorityOutcome): boolean {
  return (
    outcome.fitness === "unknown" ||
    outcome.applicability === "unknown" ||
    outcome.revisionFrontier.status === "unknown"
  );
}

export const AttributionOutcomeSchema = z.strictObject({
  result: z.enum(["correct", "misattributed", "missing", "not_applicable"]),
  attributedTo: ShortTextSchema.nullable(),
  expectedAttribution: ShortTextSchema.nullable(),
});

/**
 * Screening flags: an occurrence's quoted polarity/modality disagrees with its assertion's qualifiers (OQ3), or (for
 * high/critical tasks) the deterministic cues cannot screen the quote at all because it is not detectably English.
 */
export const SCREENING_FLAGS = ["negation_mismatch", "question_as_assertion", "unable_to_screen"] as const;
export type ScreeningFlag = (typeof SCREENING_FLAGS)[number];

/**
 * Final census (design §3.2), recorded by the independent auditor as one `census` observation on the report. It binds
 * the exact body digest, the producer inventory (the ledger artifact) and the auditor's discovered inventory artifact;
 * `inputDigest` of the observation is `censusInputDigest` over those three. Structural coverage, reconciliation and
 * screening are recorded separately; recall is a separate measured label, never folded into structural coverage.
 * Whether the census holds required coverage is derived from these fields (`censusHoldReasons`), never stored.
 */
export const CensusOutcomeSchema = z.strictObject({
  bodyDigest: DigestSchema,
  producerInventory: refOf("artifact"),
  auditorInventory: refOf("artifact"),
  discoveredOccurrences: z.array(IdSchema),
  structuralCoverage: z.strictObject({
    totalUnits: SafeIntSchema,
    factualUnits: SafeIntSchema,
    coveredFactualUnits: SafeIntSchema,
    uncoveredFactual: z.array(IdSchema),
    excluded: z.array(z.strictObject({ path: IdSchema, reason: ShortTextSchema })),
    /** Producer occurrences whose quote no longer matches or whose span falls outside their declared unit. */
    misplaced: z.array(IdSchema),
    /** Auditor explanations for uncovered factual units (for example, a heading restating a covered finding). */
    explainedUnits: z.array(UnitExplanationSchema),
  }),
  reconciliation: z.strictObject({
    matched: SafeIntSchema,
    unexplainedProducerOnly: z.array(IdSchema),
    unexplainedAuditorOnly: z.array(IdSchema),
    assertionDisagreements: z.array(IdSchema),
    explained: z.array(CensusExplanationSchema),
  }),
  /** Producer occurrences flagged by deterministic screening or by the auditor's polarity/modality reading. */
  screening: z.array(
    z.strictObject({
      occurrenceId: IdSchema,
      flags: z.array(z.enum(SCREENING_FLAGS)).min(1),
      explained: ShortTextSchema.nullable(),
    }),
  ),
  recall: z.discriminatedUnion("label", [
    z.strictObject({
      label: z.literal("measured"),
      numerator: SafeIntSchema,
      denominator: SafeIntSchema.min(1),
      calibration: refOf("artifact"),
    }),
    z.strictObject({ label: z.literal("unmeasured"), reason: ShortTextSchema }),
  ]),
});
export type CensusOutcome = z.infer<typeof CensusOutcomeSchema>;

/** Bounded counterevidence search. A completed search that found nothing is not the same as not searching. */
export const ChallengeOutcomeSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("searched"),
      /** The exact bounded queries run (the search frontier), in order. */
      queries: z.array(ShortTextSchema).min(1),
      /** Contrary fragments found; retained by the support algebra (`contraryRetained`) whatever set is selected. */
      counterevidence: FragmentRefs,
      /** The counterevidence materially conflicts with the assertion: holds until a later challenge resolves it. */
      materialConflict: z.boolean(),
      frontier: z.strictObject({
        exhausted: z.boolean(),
        searchedScopes: z.array(ShortTextSchema),
        limits: z.array(ShortTextSchema),
        unsearchedScopes: z.array(ShortTextSchema),
      }),
    }),
    z.strictObject({ status: z.literal("not_searched"), reason: ShortTextSchema }),
  ])
  .superRefine((outcome, context) => {
    if (outcome.status === "searched" && outcome.materialConflict && outcome.counterevidence.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["counterevidence"],
        message: "a material conflict names its counterevidence",
      });
    }
  });
export type ChallengeOutcome = z.infer<typeof ChallengeOutcomeSchema>;

const observationBase = {
  ...identityShape(OBSERVATION_SCHEMA_VERSION),
  target: refOfAny(["assertion", "support_set", "report"]),
  inputDigest: DigestSchema,
  /** Qualifiers the judgment was made against; a different digest means the observation cannot be reused. */
  qualifiersDigest: DigestSchema.nullable(),
  method: refOf("method"),
  evaluator: EvaluatorIdentitySchema,
  rationale: LongTextSchema,
  limitations: z.array(ShortTextSchema),
  evidence: FragmentRefs,
  rawResponse: refOf("artifact").nullable(),
  usage: UsageSchema,
  recordedAt: InstantSchema,
};

export const OBSERVATION_PROPERTIES = [
  "integrity",
  "support",
  "authority",
  "attribution",
  "census",
  "challenge",
] as const;
export type ObservationProperty = (typeof OBSERVATION_PROPERTIES)[number];

const PERMITTED_TARGETS: Record<ObservationProperty, readonly RefKind[]> = {
  integrity: ["assertion", "support_set", "report"],
  support: ["support_set"],
  authority: ["assertion", "support_set"],
  attribution: ["assertion", "report"],
  census: ["report"],
  challenge: ["assertion"],
};

/** `VerificationObservation` (design §3): append-only; `outcome` is strictly typed per `property`. */
export const VerificationObservationSchema = z
  .discriminatedUnion("property", [
    z.strictObject({ ...observationBase, property: z.literal("integrity"), outcome: IntegrityOutcomeSchema }),
    z.strictObject({ ...observationBase, property: z.literal("support"), outcome: SupportOutcomeSchema }),
    z.strictObject({ ...observationBase, property: z.literal("authority"), outcome: AuthorityOutcomeSchema }),
    z.strictObject({ ...observationBase, property: z.literal("attribution"), outcome: AttributionOutcomeSchema }),
    z.strictObject({ ...observationBase, property: z.literal("census"), outcome: CensusOutcomeSchema }),
    z.strictObject({ ...observationBase, property: z.literal("challenge"), outcome: ChallengeOutcomeSchema }),
  ])
  .superRefine((observation, context) => {
    if (!PERMITTED_TARGETS[observation.property].includes(observation.target.kind)) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: `${observation.property} observations do not target ${observation.target.kind}`,
      });
    }
    if (observation.property === "support" && observation.qualifiersDigest === null) {
      context.addIssue({ code: "custom", path: ["qualifiersDigest"], message: "support binds exact qualifiers" });
    }
  });
export type VerificationObservation = z.infer<typeof VerificationObservationSchema>;
export type SupportObservation = Extract<VerificationObservation, { property: "support" }>;
export type AuthorityObservation = Extract<VerificationObservation, { property: "authority" }>;
export type ChallengeObservation = Extract<VerificationObservation, { property: "challenge" }>;
export type IntegrityObservation = Extract<VerificationObservation, { property: "integrity" }>;
