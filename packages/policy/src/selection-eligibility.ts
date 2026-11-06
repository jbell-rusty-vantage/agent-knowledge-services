import type { StoreClass, VectorSpace } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";

/**
 * `evidence.claim.status = verified` means policy-admitted official knowledge
 * (`IMPLEMENTATION_PLAN.md` §1.2, "Settlement"). It is therefore an admission
 * *outcome*, never a promotion *input* — a claim can only reach `verified` by
 * first being admitted through one of the statuses below. Do not add
 * `"verified"` to this list; a claim that carries only `"verified"` and no
 * promotable status must not promote (see the `PROJECTION_CLAIM_STATUS_NOT_PROMOTABLE`
 * test for exactly this case).
 */
export const PROMOTABLE_CLAIM_STATUSES = [
  "directly_supported",
  "supported_with_qualification",
  "derived_verified",
  "literal_extraction_verified",
] as const;

export type PromotableClaimStatus = (typeof PROMOTABLE_CLAIM_STATUSES)[number];

/** One row of `SPECIFICATION.md` §5.1's representation-eligibility table. */
export type RepresentationKind =
  | "raw_source_bytes"
  | "faithful_source_section"
  | "atomic_projection"
  | "derived_summary"
  | "exploratory_draft";

export type EligibilityReason =
  | "RAW_BYTES_STORED_NOT_EMBEDDED"
  | "SECTION_RELEVANCE_NOT_ADMITTED"
  | "SECTION_LOCATOR_NOT_RECONSTRUCTABLE"
  | "SECTION_NOT_ELIGIBLE_FOR_OFFICIAL_SPACE"
  | "PROJECTION_CLAIM_NOT_ADMITTED"
  | "PROJECTION_CLAIM_STATUS_NOT_PROMOTABLE"
  | "PROJECTION_TEMPORAL_LINK_MISSING"
  | "PROJECTION_ENTITY_LINK_MISSING"
  | "SUMMARY_REPORT_NOT_ADMITTED"
  | "SUMMARY_DEPENDENCY_INELIGIBLE"
  | "DRAFT_OFFICIAL_SPACE_DENIED"
  | "REVOKED"
  | "SPACE_NOT_ADMITTED"
  | "LINEAGE_MISSING";

export interface SelectionCandidateLineageEntry {
  readonly chunkId: string;
  readonly chunkDigest: string;
  readonly representationId: string;
  readonly representationClass: string;
  readonly captureId: string;
  readonly sourceFamilyId: string;
}

/** `status` is the evidence claim status; compare against `PROMOTABLE_CLAIM_STATUSES`. */
export interface SelectionCandidateAdmittedClaim {
  readonly runId: string;
  readonly claimId: string;
  readonly claimDigest: string;
  readonly admissionDigest: string;
  readonly status: string;
}

export interface SelectionCandidateReportDependency {
  readonly ref: string;
  readonly eligible: boolean;
}

/**
 * The caller's view of one proposed member, deliberately narrower than
 * `PromotionSelection["selected"][number]` (`packages/contracts/src/promotion-selection.ts`).
 * `representationKind` is not an input: it is classified from this shape by
 * `evaluateSelectionEligibility` itself (see that function's doc comment for
 * the exact classification reading).
 */
export interface SelectionCandidate {
  readonly content: {
    readonly kind: "node" | "chunk" | "claim" | "entity" | "record" | "summary";
    readonly id: string;
    readonly digest: string;
  };
  readonly targetSpaces: readonly VectorSpace[];
  readonly lineage: readonly SelectionCandidateLineageEntry[];
  readonly admittedClaims: readonly SelectionCandidateAdmittedClaim[];
  /** Present only for a section candidate asserting reconstructable source locators. */
  readonly locators?: { readonly reconstructable: boolean };
  /** Present only for an atomic-projection candidate. */
  readonly temporalLink?: boolean;
  /** Present only for an atomic-projection candidate. */
  readonly entityLink?: boolean;
  /** Present only for a derived-summary candidate. */
  readonly reportAdmission?: {
    readonly admitted: boolean;
    readonly dependencies: readonly SelectionCandidateReportDependency[];
  };
  readonly revoked: boolean;
  readonly estimatedBytes: number;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
}

export interface SelectionEligibilityContext {
  readonly storeClass: StoreClass;
  readonly admittedSpaces: readonly VectorSpace[];
  /** Overrides `PROMOTABLE_CLAIM_STATUSES` when supplied. */
  readonly promotableClaimStatuses?: readonly string[];
}

/**
 * The per-space cost of admitting this one candidate. This reports; it never
 * enforces. Membership and budget rejection stay server-side, in one
 * transaction, in `packages/persistence/src/promotion-selection.ts`
 * (`PROMOTION_SELECTION_BUDGET_EXCEEDED`); this shape never rejects a
 * candidate for being large, however large `bytes`/`tokens`/`costMicros` are.
 */
export interface SelectionSpaceBudgetEffect {
  readonly space: VectorSpace;
  readonly members: 1;
  readonly bytes: number;
  readonly tokens: number;
  readonly costMicros: number;
}

export interface SelectionEligibility {
  readonly eligible: boolean;
  /** Always populated when `eligible` is false; always empty when `eligible` is true. */
  readonly reasons: readonly EligibilityReason[];
  readonly representationKind: RepresentationKind;
  readonly diversityGroup: string;
  readonly spaceBudgetEffect: readonly SelectionSpaceBudgetEffect[];
}

/**
 * Classify the candidate's representation kind from its shape alone.
 *
 * `PromotionSelectionSchema`'s `ContentReference.kind` enum
 * (`packages/contracts/src/promotion-selection.ts`) has six values —
 * `node | chunk | claim | entity | record | summary` — for the five §5.1
 * rows, so one value is necessarily shared by two rows.
 *
 * `"node"` and `"chunk"` classify identically, because the contract itself
 * treats them as equally faithful source content, not as raw bytes versus
 * something else: `PromotionSelectionSchema`'s `superRefine` exempts both
 * `"chunk"` and `"node"` from the canonical-target identity match ("selected
 * canonical content must match its projection target" only applies to the
 * other four kinds), and it requires a `source_native_sections` member to be
 * `"chunk"` or `"node"` ("source-native sections require faithful source
 * content rather than derived projections"). A `node`-content candidate is
 * exactly what `packages/application/src/knowledge/preparation/preparation.ts` builds
 * for a source-native section today, so reporting it as terminally
 * ineligible would mislead the S2 executor host this function exists to
 * inform. A candidate (of either kind) that supplies `locators` is
 * asserting reconstructable-locator fidelity — the faithful-section claim —
 * so it is classified `faithful_source_section`; one with no `locators` at
 * all is not making that claim and is classified `exploratory_draft`, the
 * agent's own working context.
 *
 * `raw_source_bytes` therefore has no `ContentReference.kind` value that
 * reaches it: a sealed capture is never itself a selection candidate (it is
 * what a faithful section or projection cites, not what gets proposed). The
 * kind stays in `RepresentationKind`, and `RAW_BYTES_STORED_NOT_EMBEDDED`
 * stays implemented below and reachable through the `default` branch,
 * purely to mirror `SPECIFICATION.md` §5.1 row 1 one-for-one and to fail
 * closed defensively if a future contract change, or a caller that bypasses
 * the type system, ever constructs a candidate whose `content.kind` is none
 * of the six known values. No candidate field was invented to make this
 * reachable through ordinary, well-typed use.
 */
function classifyRepresentation(candidate: SelectionCandidate): RepresentationKind {
  switch (candidate.content.kind) {
    case "summary":
      return "derived_summary";
    case "claim":
    case "entity":
    case "record":
      return "atomic_projection";
    case "chunk":
    case "node":
      return candidate.locators !== undefined ? "faithful_source_section" : "exploratory_draft";
    default:
      return "raw_source_bytes";
  }
}

/**
 * `lineage:<sourceFamilyId>:<captureId>` from the first lineage entry in
 * deterministic order (sort by sourceFamilyId, then captureId, then
 * chunkId). A summary that lists its dependencies' lineage entries lands in
 * the same group as those dependencies by construction, which is the §5.3
 * rule that a summary is not independent corroboration of its own sources.
 */
function computeDiversityGroup(lineage: readonly SelectionCandidateLineageEntry[]): string {
  if (lineage.length === 0) return "lineage:unknown";
  const [first] = [...lineage].sort(
    (a, b) =>
      a.sourceFamilyId.localeCompare(b.sourceFamilyId) ||
      a.captureId.localeCompare(b.captureId) ||
      a.chunkId.localeCompare(b.chunkId),
  );
  return `lineage:${first!.sourceFamilyId}:${first!.captureId}`;
}

/**
 * Pure selection-eligibility policy (`SPECIFICATION.md` §5.1, §5.3). Turns
 * the representation-eligibility table into a function a caller can run
 * before proposing. It performs no I/O, reads no clock, and never enforces
 * membership, budget, digest, or authority — those remain exclusively
 * `packages/persistence/src/promotion-selection.ts`'s job, inside its one
 * validating transaction. Every applicable reason is collected; the
 * function never short-circuits on the first failure.
 */
export function evaluateSelectionEligibility(
  candidate: SelectionCandidate,
  context: SelectionEligibilityContext,
): SelectionEligibility {
  const representationKind = classifyRepresentation(candidate);
  const diversityGroup = computeDiversityGroup(candidate.lineage);
  const promotableStatuses = new Set(context.promotableClaimStatuses ?? PROMOTABLE_CLAIM_STATUSES);
  const reasons: EligibilityReason[] = [];

  if (candidate.revoked) reasons.push("REVOKED");
  if (candidate.lineage.length === 0) reasons.push("LINEAGE_MISSING");
  if (candidate.targetSpaces.some((space) => !context.admittedSpaces.includes(space)))
    reasons.push("SPACE_NOT_ADMITTED");

  switch (representationKind) {
    case "raw_source_bytes": {
      reasons.push("RAW_BYTES_STORED_NOT_EMBEDDED");
      break;
    }
    case "faithful_source_section": {
      if (candidate.admittedClaims.length === 0) reasons.push("SECTION_RELEVANCE_NOT_ADMITTED");
      if (candidate.locators?.reconstructable !== true) reasons.push("SECTION_LOCATOR_NOT_RECONSTRUCTABLE");
      if (candidate.targetSpaces.some((space) => space !== "source_native_sections"))
        reasons.push("SECTION_NOT_ELIGIBLE_FOR_OFFICIAL_SPACE");
      break;
    }
    case "atomic_projection": {
      if (candidate.admittedClaims.length === 0) reasons.push("PROJECTION_CLAIM_NOT_ADMITTED");
      else if (!candidate.admittedClaims.some((claim) => promotableStatuses.has(claim.status)))
        reasons.push("PROJECTION_CLAIM_STATUS_NOT_PROMOTABLE");
      if (candidate.temporalLink !== true) reasons.push("PROJECTION_TEMPORAL_LINK_MISSING");
      if (candidate.entityLink !== true) reasons.push("PROJECTION_ENTITY_LINK_MISSING");
      break;
    }
    case "derived_summary": {
      if (candidate.reportAdmission?.admitted !== true) reasons.push("SUMMARY_REPORT_NOT_ADMITTED");
      if (candidate.reportAdmission?.dependencies.some((dependency) => !dependency.eligible))
        reasons.push("SUMMARY_DEPENDENCY_INELIGIBLE");
      break;
    }
    case "exploratory_draft": {
      if (context.storeClass !== "internal_exploratory") reasons.push("DRAFT_OFFICIAL_SPACE_DENIED");
      break;
    }
  }

  const spaceBudgetEffect: SelectionSpaceBudgetEffect[] = candidate.targetSpaces.map((space) => ({
    space,
    members: 1,
    bytes: candidate.estimatedBytes,
    tokens: candidate.estimatedTokens,
    costMicros: candidate.estimatedCostMicros,
  }));

  return deepFreeze({
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    representationKind,
    diversityGroup,
    spaceBudgetEffect,
  });
}
