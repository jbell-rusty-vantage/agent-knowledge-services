import { describe, expect, it } from "vitest";
import type { StoreClass, VectorSpace } from "@aiengineer/knowledge-contracts";
import {
  PROMOTABLE_CLAIM_STATUSES,
  evaluateSelectionEligibility,
  type SelectionCandidate,
  type SelectionCandidateLineageEntry,
  type SelectionEligibilityContext,
} from "./selection-eligibility.js";

const admittedSpaces: readonly VectorSpace[] = ["source_native_sections", "engineering_claims", "entity_profiles"];
const context = (overrides: Partial<SelectionEligibilityContext> = {}): SelectionEligibilityContext => ({
  storeClass: "official_canonical",
  admittedSpaces,
  ...overrides,
});

const lineage = (overrides: Partial<SelectionCandidateLineageEntry> = {}): SelectionCandidateLineageEntry => ({
  chunkId: "chunk-1",
  chunkDigest: "sha256:chunk",
  representationId: "representation-1",
  representationClass: "source_native",
  captureId: "capture-1",
  sourceFamilyId: "family-1",
  ...overrides,
});

const base = (overrides: Partial<SelectionCandidate> = {}): SelectionCandidate => ({
  content: { kind: "chunk", id: "chunk-1", digest: "sha256:chunk" },
  targetSpaces: ["source_native_sections"],
  lineage: [lineage()],
  admittedClaims: [],
  revoked: false,
  estimatedBytes: 100,
  estimatedTokens: 20,
  estimatedCostMicros: 5,
  ...overrides,
});

/** No `ContentReference.kind` value reaches `raw_source_bytes` (see `classifyRepresentation`'s doc comment); this constructs the `default` branch directly by bypassing the type system, as a caller never legitimately could. */
const unrepresentableCapture = (overrides: Partial<SelectionCandidate> = {}): SelectionCandidate =>
  ({
    ...base(overrides),
    content: { kind: "sealed_capture", id: "capture-1", digest: "sha256:capture" },
  }) as unknown as SelectionCandidate;

const faithfulSection = (overrides: Partial<SelectionCandidate> = {}): SelectionCandidate =>
  base({
    content: { kind: "chunk", id: "chunk-1", digest: "sha256:chunk" },
    locators: { reconstructable: true },
    admittedClaims: [
      {
        runId: "run-1",
        claimId: "claim-1",
        claimDigest: "sha256:claim",
        admissionDigest: "sha256:admission",
        status: "directly_supported",
      },
    ],
    targetSpaces: ["source_native_sections"],
    ...overrides,
  });

const atomicProjection = (overrides: Partial<SelectionCandidate> = {}): SelectionCandidate =>
  base({
    content: { kind: "claim", id: "claim-1", digest: "sha256:claim" },
    admittedClaims: [
      {
        runId: "run-1",
        claimId: "claim-1",
        claimDigest: "sha256:claim",
        admissionDigest: "sha256:admission",
        status: "directly_supported",
      },
    ],
    temporalLink: true,
    entityLink: true,
    targetSpaces: ["engineering_claims"],
    ...overrides,
  });

const derivedSummary = (overrides: Partial<SelectionCandidate> = {}): SelectionCandidate =>
  base({
    content: { kind: "summary", id: "summary-1", digest: "sha256:summary" },
    reportAdmission: { admitted: true, dependencies: [{ ref: "chunk-1", eligible: true }] },
    targetSpaces: ["engineering_claims"],
    ...overrides,
  });

const exploratoryDraft = (overrides: Partial<SelectionCandidate> = {}): SelectionCandidate =>
  base({
    content: { kind: "chunk", id: "chunk-2", digest: "sha256:draft" },
    targetSpaces: ["engineering_claims"],
    ...overrides,
  });

describe("evaluateSelectionEligibility: representation classification", () => {
  it("classifies each of the five representation kinds from the candidate shape", () => {
    expect(evaluateSelectionEligibility(faithfulSection(), context()).representationKind).toBe(
      "faithful_source_section",
    );
    expect(
      evaluateSelectionEligibility(exploratoryDraft(), context({ storeClass: "internal_exploratory" }))
        .representationKind,
    ).toBe("exploratory_draft");
    expect(evaluateSelectionEligibility(atomicProjection(), context()).representationKind).toBe("atomic_projection");
    expect(
      evaluateSelectionEligibility(
        { ...atomicProjection(), content: { kind: "entity", id: "entity-1", digest: "sha256:entity" } },
        context(),
      ).representationKind,
    ).toBe("atomic_projection");
    expect(
      evaluateSelectionEligibility(
        { ...atomicProjection(), content: { kind: "record", id: "record-1", digest: "sha256:record" } },
        context(),
      ).representationKind,
    ).toBe("atomic_projection");
    expect(evaluateSelectionEligibility(derivedSummary(), context()).representationKind).toBe("derived_summary");
    expect(evaluateSelectionEligibility(unrepresentableCapture(), context()).representationKind).toBe(
      "raw_source_bytes",
    );
  });
  it("classifies node content identically to chunk content, since PromotionSelectionSchema admits both as faithful source content", () => {
    const nodeSection = faithfulSection({ content: { kind: "node", id: "node-1", digest: "sha256:node" } });
    expect(evaluateSelectionEligibility(nodeSection, context()).representationKind).toBe("faithful_source_section");
    const nodeDraft = exploratoryDraft({ content: { kind: "node", id: "node-2", digest: "sha256:node-draft" } });
    expect(
      evaluateSelectionEligibility(nodeDraft, context({ storeClass: "internal_exploratory" })).representationKind,
    ).toBe("exploratory_draft");
  });
});

describe("evaluateSelectionEligibility: node-content source-native section (regression)", () => {
  it("admits a node-content candidate targeting source_native_sections with reconstructable locators and admitted relevance, exactly like a chunk-content one", () => {
    const result = evaluateSelectionEligibility(
      faithfulSection({ content: { kind: "node", id: "node-1", digest: "sha256:node" } }),
      context(),
    );
    expect(result.representationKind).toBe("faithful_source_section");
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("evaluateSelectionEligibility: raw source bytes", () => {
  it("keeps RAW_BYTES_STORED_NOT_EMBEDDED implemented via the defensive default branch, even though no ContentReference.kind value reaches it today", () => {
    const result = evaluateSelectionEligibility(unrepresentableCapture(), context());
    expect(result.representationKind).toBe("raw_source_bytes");
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("RAW_BYTES_STORED_NOT_EMBEDDED");
  });
});

describe("evaluateSelectionEligibility: faithful source section", () => {
  it("requires reconstructable locators", () => {
    const result = evaluateSelectionEligibility(faithfulSection({ locators: { reconstructable: false } }), context());
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("SECTION_LOCATOR_NOT_RECONSTRUCTABLE");
  });
  it("requires admitted relevance", () => {
    const result = evaluateSelectionEligibility(faithfulSection({ admittedClaims: [] }), context());
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("SECTION_RELEVANCE_NOT_ADMITTED");
  });
  it("rejects an official space and admits source_native_sections", () => {
    const official = evaluateSelectionEligibility(faithfulSection({ targetSpaces: ["engineering_claims"] }), context());
    expect(official.eligible).toBe(false);
    expect(official.reasons).toContain("SECTION_NOT_ELIGIBLE_FOR_OFFICIAL_SPACE");
    const native = evaluateSelectionEligibility(
      faithfulSection({ targetSpaces: ["source_native_sections"] }),
      context(),
    );
    expect(native.eligible).toBe(true);
    expect(native.reasons).toEqual([]);
  });
});

describe("evaluateSelectionEligibility: atomic projection", () => {
  it("requires at least one admitted claim", () => {
    const result = evaluateSelectionEligibility(atomicProjection({ admittedClaims: [] }), context());
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("PROJECTION_CLAIM_NOT_ADMITTED");
  });
  it("does not promote on status verified alone (T2 settlement is an admission outcome, not a promotion input)", () => {
    const result = evaluateSelectionEligibility(
      atomicProjection({
        admittedClaims: [
          {
            runId: "run-1",
            claimId: "claim-1",
            claimDigest: "sha256:claim",
            admissionDigest: "sha256:admission",
            status: "verified",
          },
        ],
      }),
      context(),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("PROJECTION_CLAIM_STATUS_NOT_PROMOTABLE");
    expect(result.reasons).not.toContain("PROJECTION_CLAIM_NOT_ADMITTED");
  });
  it("requires a temporal link", () => {
    const result = evaluateSelectionEligibility(atomicProjection({ temporalLink: false }), context());
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["PROJECTION_TEMPORAL_LINK_MISSING"]);
  });
  it("requires an entity link", () => {
    const result = evaluateSelectionEligibility(atomicProjection({ entityLink: false }), context());
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["PROJECTION_ENTITY_LINK_MISSING"]);
  });
  it.each(PROMOTABLE_CLAIM_STATUSES)("promotes a claim with status %s", (status) => {
    const result = evaluateSelectionEligibility(
      atomicProjection({
        admittedClaims: [
          {
            runId: "run-1",
            claimId: "claim-1",
            claimDigest: "sha256:claim",
            admissionDigest: "sha256:admission",
            status,
          },
        ],
      }),
      context(),
    );
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("evaluateSelectionEligibility: derived summary", () => {
  it("requires the report to be admitted", () => {
    const result = evaluateSelectionEligibility(
      derivedSummary({ reportAdmission: { admitted: false, dependencies: [] } }),
      context(),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("SUMMARY_REPORT_NOT_ADMITTED");
  });
  it("requires every material dependency to be eligible", () => {
    const result = evaluateSelectionEligibility(
      derivedSummary({
        reportAdmission: {
          admitted: true,
          dependencies: [
            { ref: "chunk-1", eligible: true },
            { ref: "chunk-2", eligible: false },
          ],
        },
      }),
      context(),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("SUMMARY_DEPENDENCY_INELIGIBLE");
  });
  it("shares its diversity group with a supporting chunk from the same capture, so it cannot crowd out independent evidence", () => {
    const sharedLineage = [lineage({ sourceFamilyId: "family-shared", captureId: "capture-shared" })];
    const summary = evaluateSelectionEligibility(derivedSummary({ lineage: sharedLineage }), context());
    const supportingChunk = evaluateSelectionEligibility(faithfulSection({ lineage: sharedLineage }), context());
    expect(summary.diversityGroup).toBe(supportingChunk.diversityGroup);
    expect(summary.diversityGroup).toBe("lineage:family-shared:capture-shared");
  });
});

describe("evaluateSelectionEligibility: exploratory draft", () => {
  it("is admitted only under internal_exploratory and denied under official_canonical", () => {
    const admitted = evaluateSelectionEligibility(exploratoryDraft(), context({ storeClass: "internal_exploratory" }));
    expect(admitted.eligible).toBe(true);
    expect(admitted.reasons).toEqual([]);
    const denied = evaluateSelectionEligibility(
      exploratoryDraft(),
      context({ storeClass: "official_canonical" as StoreClass }),
    );
    expect(denied.eligible).toBe(false);
    expect(denied.reasons).toEqual(["DRAFT_OFFICIAL_SPACE_DENIED"]);
  });
});

describe("evaluateSelectionEligibility: cross-cutting rules", () => {
  it("treats revocation as terminal regardless of everything else", () => {
    const result = evaluateSelectionEligibility(atomicProjection({ revoked: true }), context());
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("REVOKED");
  });
  it("rejects a target space outside the admitted set", () => {
    const result = evaluateSelectionEligibility(atomicProjection({ targetSpaces: ["tool_capabilities"] }), context());
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["SPACE_NOT_ADMITTED"]);
  });
  it("requires lineage and reports lineage:unknown when absent", () => {
    const result = evaluateSelectionEligibility(atomicProjection({ lineage: [] }), context());
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("LINEAGE_MISSING");
    expect(result.diversityGroup).toBe("lineage:unknown");
  });
  it("accumulates multiple failures instead of short-circuiting on the first", () => {
    const result = evaluateSelectionEligibility(
      atomicProjection({ revoked: true, lineage: [], targetSpaces: ["tool_capabilities"] }),
      context(),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toHaveLength(3);
    expect(result.reasons).toEqual(expect.arrayContaining(["REVOKED", "LINEAGE_MISSING", "SPACE_NOT_ADMITTED"]));
  });
  it("honors a caller-supplied promotable-status override", () => {
    const claim = {
      runId: "run-1",
      claimId: "claim-1",
      claimDigest: "sha256:claim",
      admissionDigest: "sha256:admission",
      status: "custom_status",
    };
    const rejected = evaluateSelectionEligibility(atomicProjection({ admittedClaims: [claim] }), context());
    expect(rejected.reasons).toContain("PROJECTION_CLAIM_STATUS_NOT_PROMOTABLE");
    const accepted = evaluateSelectionEligibility(
      atomicProjection({ admittedClaims: [claim] }),
      context({ promotableClaimStatuses: ["custom_status"] }),
    );
    expect(accepted.eligible).toBe(true);
  });
});

describe("evaluateSelectionEligibility: space budget effect", () => {
  it("reports one entry per target space and never rejects for size", () => {
    const result = evaluateSelectionEligibility(
      atomicProjection({
        targetSpaces: ["engineering_claims", "entity_profiles"],
        estimatedBytes: 1,
        estimatedTokens: 2,
        estimatedCostMicros: 3,
      }),
      context(),
    );
    expect(result.spaceBudgetEffect).toEqual([
      { space: "engineering_claims", members: 1, bytes: 1, tokens: 2, costMicros: 3 },
      { space: "entity_profiles", members: 1, bytes: 1, tokens: 2, costMicros: 3 },
    ]);
  });
  it("still returns eligible: true with an enormous cost when the rules pass, proving this function does not enforce budget", () => {
    const result = evaluateSelectionEligibility(
      atomicProjection({ estimatedCostMicros: Number.MAX_SAFE_INTEGER }),
      context(),
    );
    expect(result.eligible).toBe(true);
    expect(result.spaceBudgetEffect[0]!.costMicros).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("evaluateSelectionEligibility: determinism and immutability", () => {
  it("is deterministic and returns a frozen result", () => {
    const candidate = atomicProjection();
    const first = evaluateSelectionEligibility(candidate, context());
    const second = evaluateSelectionEligibility(candidate, context());
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reasons)).toBe(true);
    expect(Object.isFrozen(first.spaceBudgetEffect)).toBe(true);
  });
});
