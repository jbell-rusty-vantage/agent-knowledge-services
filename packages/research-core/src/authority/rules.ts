import {
  type Digest,
  IdSchema,
  type JsonValue,
  NameSchema,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { STUDY_DESIGNS } from "../profiles/scientific.js";
import type { AssertionVersion } from "../records/assertion.js";
import { RISK_CLASSES, type RiskClass, ShortTextSchema } from "../records/common.js";
import type { VerificationTaskContract } from "../records/task.js";

/**
 * K08 source authority and use classes as pinned data (design §2 K08, §3.1 judgment 2; OQ4). Source fitness and
 * applicability are decided by rule documents (`catalog/research/source-authority/<profile>.json`), never by code
 * branches; which use/audience strings are official or consequential is the use-class registry
 * (`catalog/research/use-classes.json`, K08 data shared by research and the ingestion executor). Unknown stays
 * unknown: no rule match yields `unknown`.
 */
export const SOURCE_AUTHORITY_SCHEMA_VERSION = "research-source-authority.v1" as const;
export const USE_CLASSES_SCHEMA_VERSION = "research-use-classes.v1" as const;

const SemverSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
/** Qualifier field names are camelCase identifiers (`softwareVersion`, `species`). */
const QualifierNameSchema = z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/);
export const FITNESS_VALUES = ["fit", "fit_with_limitations", "unfit", "unknown"] as const;
export const APPLICABILITY_VALUES = ["applicable", "partially_applicable", "not_applicable", "unknown"] as const;

const FitnessRuleSchema = z.strictObject({
  id: IdSchema,
  /** Every listed condition must hold; an omitted condition matches anything. */
  when: z.strictObject({
    claimClasses: z.array(z.enum(["source_report", "generalized"])).optional(),
    causalClaims: z.array(z.enum(["association", "causal", "none", "unknown"])).optional(),
    studyDesigns: z.array(z.enum(STUDY_DESIGNS)).optional(),
    sourceKinds: z.array(NameSchema).optional(),
    assertionKinds: z
      .array(z.enum(["source_report", "world_fact", "derivation", "recommendation", "forecast"]))
      .optional(),
  }),
  fitness: z.enum(FITNESS_VALUES),
  rationale: ShortTextSchema,
});

export const SourceAuthorityRulesSchema = z.strictObject({
  schemaVersion: z.literal(SOURCE_AUTHORITY_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
  version: SemverSchema,
  /** Qualifier profile id the rules apply to (`AssertionVersion.qualifiers.profile`). */
  profile: z.enum(["engineering.v2", "scientific.v2", "education.v2"]),
  /** First matching rule wins; no match -> `defaultFitness` (normally `unknown`). */
  fitness: z.array(FitnessRuleSchema),
  defaultFitness: z.enum(FITNESS_VALUES),
  applicability: z.strictObject({
    /** Assertion qualifier names compared with the verified source description's qualifiers. */
    matchQualifiers: z.array(QualifierNameSchema).min(1),
    onMatch: z.enum(APPLICABILITY_VALUES),
    onPartial: z.enum(APPLICABILITY_VALUES),
    onMismatch: z.enum(APPLICABILITY_VALUES),
    onUnknown: z.enum(APPLICABILITY_VALUES),
  }),
  /** Whether the revision frontier (retractions, corrections) must be checked for an authority observation to count. */
  revisionFrontierRequired: z.boolean(),
});
export type SourceAuthorityRules = z.infer<typeof SourceAuthorityRulesSchema>;

export const USE_CLASS_VALUES = ["official", "consequential", "internal", "draft"] as const;
export type UseClass = (typeof USE_CLASS_VALUES)[number];

export const UseClassRegistrySchema = z.strictObject({
  schemaVersion: z.literal(USE_CLASSES_SCHEMA_VERSION),
  id: z.literal("use-classes"),
  version: SemverSchema,
  /** First matching entry wins; `uses` entries ending in `*` match by prefix. No match -> `defaultClass`. */
  classes: z.array(
    z.strictObject({
      class: z.enum(USE_CLASS_VALUES),
      audiences: z.array(NameSchema),
      uses: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,119}\*?$/)),
      /** Human review (a qualified reviewer adjudication) is a condition of admission at these task risks. */
      reviewAtRisk: z.array(z.enum(RISK_CLASSES)),
    }),
  ),
  defaultClass: z.enum(USE_CLASS_VALUES),
});
export type UseClassRegistry = z.infer<typeof UseClassRegistrySchema>;

export function loadSourceAuthorityRules(json: unknown): SourceAuthorityRules {
  return SourceAuthorityRulesSchema.parse(json);
}

export function loadUseClassRegistry(json: unknown): UseClassRegistry {
  return UseClassRegistrySchema.parse(json);
}

export function rulesDigest(rules: SourceAuthorityRules | UseClassRegistry): Digest {
  return digestCanonical(rules as unknown as JsonValue);
}

const usesMatch = (patterns: readonly string[], use: string) =>
  patterns.some((pattern) => (pattern.endsWith("*") ? use.startsWith(pattern.slice(0, -1)) : pattern === use));

export interface UseClassResolution {
  readonly useClass: UseClass;
  readonly reviewRequired: boolean;
}

function entryFor(registry: UseClassRegistry, input: { use: string; audience: string }) {
  return registry.classes.find(
    (candidate) =>
      (candidate.audiences.length === 0 || candidate.audiences.includes(input.audience)) &&
      (candidate.uses.length === 0 || usesMatch(candidate.uses, input.use)),
  );
}

/** The use class of a (use, audience) pair and whether review is required at the given risk. */
export function useClassOf(
  registry: UseClassRegistry | null,
  input: { use: string; audience: string; risk: RiskClass },
): UseClassResolution {
  if (registry === null) return { useClass: "internal", reviewRequired: false };
  const entry = entryFor(registry, input);
  if (entry === undefined) return { useClass: registry.defaultClass, reviewRequired: false };
  return { useClass: entry.class, reviewRequired: entry.reviewAtRisk.includes(input.risk) };
}

/**
 * The registry as the ingestion executor's use-class policy (R1 F9): the executor refuses an official or consequential
 * intent that carries no exact-use binding. One authority: the same registry and match rule as `useClassOf`; an
 * intent that declares no use takes the registry's default class.
 */
export interface UseClassPolicy {
  readonly registry: { readonly id: string; readonly version: string; readonly digest: Digest };
  classOf(declared: { readonly use: string; readonly audience: string } | null): UseClass;
}

export function useClassPolicy(registry: UseClassRegistry): UseClassPolicy {
  return {
    registry: { id: registry.id, version: registry.version, digest: rulesDigest(registry) },
    classOf: (declared) =>
      declared === null ? registry.defaultClass : (entryFor(registry, declared)?.class ?? registry.defaultClass),
  };
}

/**
 * Design §3.1 / SV-07: authority AND bounded challenge observations from authoritative roles are required for every
 * covering assertion when the task is critical, or the profile is scientific and the use is official/consequential.
 */
export function authorityGateRequired(task: VerificationTaskContract, useClass: UseClass): boolean {
  if (task.minimumRisk === "critical") return true;
  return task.domain === "scientific" && (useClass === "official" || useClass === "consequential");
}

/**
 * Whether a use is official for coverage purposes (critical risk, or an official/consequential use class). A
 * non-entailed assertion (forecast, recommendation) covers an obligation for such a use only through an admitting
 * {@link JudgmentPolicy} (Sprint OC WI-03, OC-D112): its typed judgment basis, independent assessment and a required
 * review. Without one it holds `non_entailed`, as before (OQ4).
 */
export function officialUse(task: VerificationTaskContract, useClass: UseClass): boolean {
  return task.minimumRisk === "critical" || useClass === "official" || useClass === "consequential";
}

export const JUDGMENT_POLICIES_SCHEMA_VERSION = "research-judgment-policies.v1" as const;

/**
 * Use-specific judgment policies as pinned K08 data (`catalog/research/judgment-policies.json`, Sprint OC WI-03,
 * OC-D112/113). A policy names the non-entailed kinds it governs, the uses/audiences/use classes it applies to, and
 * the minimum typed basis it requires. Every admitted judgment carries `review_required`: a policy can tighten (more
 * assumptions, a horizon) but cannot waive review, and approval is never fact entailment. First match wins; no match
 * keeps the OQ4 exclusion.
 */
export const JudgmentPolicySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  version: SemverSchema,
  kinds: z.array(z.enum(["recommendation", "forecast"])).min(1),
  /** `uses` entries ending in `*` match by prefix; an empty list matches every use. */
  uses: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,119}\*?$/)),
  audiences: z.array(NameSchema),
  useClasses: z.array(z.enum(USE_CLASS_VALUES)).min(1),
  minimumAssumptions: z.number().int().min(1).max(32),
  /** Forecasts always state a horizon; a policy may also require one for recommendations. */
  horizonRequired: z.boolean(),
  /** The stated uncertainty levels this policy accepts (`unknown` is accepted only when listed). */
  uncertaintyLevels: z.array(z.enum(["low", "medium", "high", "unknown"])).min(1),
});
export type JudgmentPolicy = z.infer<typeof JudgmentPolicySchema>;

export const JudgmentPolicyRegistrySchema = z.strictObject({
  schemaVersion: z.literal(JUDGMENT_POLICIES_SCHEMA_VERSION),
  id: z.literal("judgment-policies"),
  version: SemverSchema,
  policies: z.array(JudgmentPolicySchema),
});
export type JudgmentPolicyRegistry = z.infer<typeof JudgmentPolicyRegistrySchema>;

export function loadJudgmentPolicyRegistry(json: unknown): JudgmentPolicyRegistry {
  return JudgmentPolicyRegistrySchema.parse(json);
}

/** The first judgment policy that governs this (use, audience, use class) and assertion kind, or `null`. */
export function judgmentPolicyFor(
  registry: JudgmentPolicyRegistry | null,
  input: { use: string; audience: string; useClass: UseClass; kind: AssertionVersion["kind"] },
): JudgmentPolicy | null {
  if (registry === null) return null;
  return (
    registry.policies.find(
      (policy) =>
        (policy.kinds as readonly string[]).includes(input.kind) &&
        policy.useClasses.includes(input.useClass) &&
        (policy.audiences.length === 0 || policy.audiences.includes(input.audience)) &&
        (policy.uses.length === 0 || usesMatch(policy.uses, input.use)),
    ) ?? null
  );
}

/**
 * Why a judgment basis does not meet its policy (empty = it does). Missing basis, too few assumptions, an unaccepted
 * uncertainty level or a missing required horizon each hold the assertion; none of them is a contradiction.
 */
export function judgmentBasisGaps(policy: JudgmentPolicy, assertion: AssertionVersion): string[] {
  const basis = assertion.judgment;
  if (basis === undefined) return ["judgment_basis_missing"];
  const gaps: string[] = [];
  if (assertion.premises.length === 0) gaps.push("judgment_premises_missing");
  if (basis.assumptions.length < policy.minimumAssumptions) gaps.push("judgment_assumptions_insufficient");
  if (!policy.uncertaintyLevels.includes(basis.uncertainty.level)) gaps.push("judgment_uncertainty_unaccepted");
  if ((policy.horizonRequired || assertion.kind === "forecast") && basis.horizon === null) {
    gaps.push("judgment_horizon_missing");
  }
  return gaps;
}

/** What an authority resolver verified about one source fragment; it never guesses an origin family. */
export const SourceDescriptionSchema = z.strictObject({
  /** Verified underlying origin (study, dataset, repository); `null` = unknown, never inferred. */
  verifiedOriginFamily: IdSchema.nullable(),
  /** Scholarly identifier for the revision frontier (`10.x/...`), when the source has one. */
  doi: z
    .string()
    .regex(/^10\.\d{4,9}\/\S{1,300}$/)
    .nullable(),
  sourceKind: NameSchema.nullable(),
  studyDesign: z.enum(STUDY_DESIGNS).nullable(),
  directness: z.enum(["direct", "indirect", "unknown"]),
  freshness: z.enum(["current", "stale", "superseded", "unknown"]),
  /** Qualifier values the source itself reports (for applicability), keyed by qualifier name; `null` = not reported. */
  qualifiers: z.record(QualifierNameSchema, ShortTextSchema.nullable()),
});
export type SourceDescription = z.infer<typeof SourceDescriptionSchema>;

export interface SourceAppraisal {
  readonly fitness: (typeof FITNESS_VALUES)[number];
  readonly fitnessRule: string | null;
  readonly applicability: (typeof APPLICABILITY_VALUES)[number];
}

function qualifierValue(assertion: AssertionVersion, name: string): string | null | undefined {
  const value = (assertion.qualifiers as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Pure K08 appraisal of one source for one assertion: first matching fitness rule, qualifier-wise applicability. */
export function appraiseSource(
  rules: SourceAuthorityRules,
  assertion: AssertionVersion,
  description: SourceDescription,
): SourceAppraisal {
  const q = assertion.qualifiers;
  const scientific = q.profile === "scientific.v2" ? q : null;
  const rule = rules.fitness.find((candidate) => {
    const when = candidate.when;
    if (when.claimClasses && (scientific === null || !when.claimClasses.includes(scientific.claimClass))) return false;
    if (when.causalClaims && (scientific === null || !when.causalClaims.includes(scientific.causalClaim))) return false;
    if (when.studyDesigns && (description.studyDesign === null || !when.studyDesigns.includes(description.studyDesign)))
      return false;
    if (when.sourceKinds && (description.sourceKind === null || !when.sourceKinds.includes(description.sourceKind)))
      return false;
    if (when.assertionKinds && !when.assertionKinds.includes(assertion.kind)) return false;
    return true;
  });
  let matched = 0;
  let mismatched = 0;
  let unknown = 0;
  for (const name of rules.applicability.matchQualifiers) {
    const claimed = qualifierValue(assertion, name);
    const reported = description.qualifiers[name];
    if (claimed === undefined || claimed === null) continue; // the assertion does not qualify on it
    if (reported === undefined || reported === null) unknown += 1;
    else if (reported.trim().toLowerCase() === claimed.trim().toLowerCase()) matched += 1;
    else mismatched += 1;
  }
  const a = rules.applicability;
  const applicability =
    mismatched > 0 && matched === 0
      ? a.onMismatch
      : mismatched > 0
        ? a.onPartial
        : unknown > 0 && matched === 0
          ? a.onUnknown
          : unknown > 0
            ? a.onPartial
            : a.onMatch;
  return { fitness: rule?.fitness ?? rules.defaultFitness, fitnessRule: rule?.id ?? null, applicability };
}
