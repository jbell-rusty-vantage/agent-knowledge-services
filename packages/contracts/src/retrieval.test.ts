import { describe, expect, it } from "vitest";
import {
  MAX_RETRIEVAL_ENTITY_ANCHORS,
  RetrievalCitationReplaySchema,
  RetrievalMemberSupportSchema,
  RetrievalPlanSchema,
  RetrievalSupportPathSchema,
  RetrievalUnsupportedResponseSchema,
  RetrievalWorldScopeSchema,
} from "./retrieval.js";

const id = "00000000-0000-4000-8000-000000000001";
const plan = {
  policyVersion: id,
  query: "preview availability",
  intents: ["knowledge_evidence"],
  subqueries: [{ id: "preview", text: "preview availability", coverageRole: "required" }],
  spaces: ["engineering_claims"],
  anchors: { entities: [id], concepts: [], useCases: [] },
  hardFilters: [],
  softBoosts: [],
  temporalScope: {},
  candidateK: 10,
  finalK: 5,
  graph: { maxDepth: 0, allowedEdges: [] },
  abstention: { minimumCoverage: 1 },
};

describe("explicit retrieval world and knowledge clocks", () => {
  it("retains independent world, K and existing freshness inputs", () => {
    const input = {
      ...plan,
      temporalScope: { effectiveAfter: "2026-01-01T00:00:00Z" },
      worldScope: { kind: "at", at: "2025-01-01T00:00:00.000001Z" },
      knowledgeScope: { atKnowledgeSeq: 0 },
    };
    expect(RetrievalPlanSchema.parse(input)).toEqual(input);
  });
  it("admits an exact one-microsecond half-open overlap interval", () => {
    expect(
      RetrievalWorldScopeSchema.parse({
        kind: "overlap",
        from: "2026-01-01T00:00:00.000001Z",
        to: "2026-01-01T00:00:00.000002Z",
      }).kind,
    ).toBe("overlap");
  });
  it.each([
    ["2026-01-01T00:00:00.000001Z", "2026-01-01T00:00:00.000001Z"],
    ["2026-01-01T00:00:00.000002Z", "2026-01-01T00:00:00.000001Z"],
    ["2026-01-01T01:00:00.000001+01:00", "2026-01-01T00:00:00.000001Z"],
  ])("rejects empty or reversed interval %s / %s", (from, to) => {
    expect(RetrievalWorldScopeSchema.safeParse({ kind: "overlap", from, to }).success).toBe(false);
  });
  it.each(["2026-01-01T00:00:00.0000001Z", "2026-02-30T00:00:00Z", "2026-01-01T00:00:00"])(
    "rejects unsupported world instant %s",
    (at) => {
      expect(RetrievalWorldScopeSchema.safeParse({ kind: "at", at }).success).toBe(false);
    },
  );
  it.each([-1, 1.2, Number.MAX_SAFE_INTEGER + 1])("rejects invalid knowledge clock %s", (atKnowledgeSeq) => {
    expect(RetrievalPlanSchema.safeParse({ ...plan, knowledgeScope: { atKnowledgeSeq } }).success).toBe(false);
  });
  it("bounds and deduplicates canonical entity anchors", () => {
    expect(RetrievalPlanSchema.safeParse({ ...plan, anchors: { ...plan.anchors, entities: [id, id] } }).success).toBe(
      false,
    );
  });
  it("requires explicit distinct optional capabilities", () => {
    expect(RetrievalPlanSchema.parse({ ...plan, optionalCapabilities: ["graph"] }).optionalCapabilities).toEqual([
      "graph",
    ]);
    expect(RetrievalPlanSchema.safeParse({ ...plan, optionalCapabilities: ["graph", "graph"] }).success).toBe(false);
  });
});

describe("required versus optional capability declarations", () => {
  it("admits temporal upper bounds as explicitly optional capabilities", () => {
    expect(
      RetrievalPlanSchema.parse({ ...plan, optionalCapabilities: ["freshness_upper_bound", "observed_upper_bound"] })
        .optionalCapabilities,
    ).toEqual(["freshness_upper_bound", "observed_upper_bound"]);
  });
  it("bounds entity anchors to the canonical historical search limit", () => {
    const anchors = Array.from(
      { length: MAX_RETRIEVAL_ENTITY_ANCHORS + 1 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(RetrievalPlanSchema.safeParse({ ...plan, anchors: { ...plan.anchors, entities: anchors } }).success).toBe(
      false,
    );
    expect(
      RetrievalPlanSchema.safeParse({ ...plan, anchors: { ...plan.anchors, entities: anchors.slice(1) } }).success,
    ).toBe(true);
  });
  it.each([
    [{ effectiveAfter: "2026-02-01T00:00:00Z", effectiveBefore: "2026-01-01T00:00:00Z" }],
    [{ effectiveAfter: "2026-02-01T00:00:00Z", observedBefore: "2026-02-01T00:00:00Z" }],
    [{ effectiveAfter: "2026-01-01T00:00:00.0000001Z" }],
  ])("rejects an incoherent observed-time scope %s", (temporalScope) => {
    expect(RetrievalPlanSchema.safeParse({ ...plan, temporalScope }).success).toBe(false);
  });
  it("types the unsupported-capability answer instead of a generic error", () => {
    expect(
      RetrievalUnsupportedResponseSchema.parse({
        schemaVersion: "knowledge.retrieval-unsupported/v1",
        code: "RETRIEVAL_CAPABILITY_UNSUPPORTED",
        unsupported: [{ capability: "graph", reason: "not_implemented" }],
      }).unsupported,
    ).toHaveLength(1);
    expect(
      RetrievalUnsupportedResponseSchema.safeParse({
        schemaVersion: "knowledge.retrieval-unsupported/v1",
        code: "RETRIEVAL_CAPABILITY_UNSUPPORTED",
        unsupported: [],
      }).success,
    ).toBe(false);
  });
});

describe("packet replay provenance", () => {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const path = {
    claimId: id,
    claimStatus: "verified",
    verificationRunId: id,
    assessmentVerdict: "directly_supported",
    admissionDigest: digest,
    locatorId: id,
    selectorDigest: digest,
    selectedContentDigest: digest,
    captureId: id,
    sourceFamilyId: id,
    representationId: id,
    qualifiers: ["in preview"],
    captureArtifact: { artifactId: id, tenantId: id, digest, mediaType: "text/plain" },
  };
  const support = {
    target: { kind: "record", canonicalId: id, projectionTargetId: id },
    sourceFamilyIds: [id],
    paths: [path],
    truncated: false,
  };
  it("retains the exact canonical support path a fresh consumer must replay", () => {
    expect(RetrievalMemberSupportSchema.parse(support)).toEqual(support);
  });
  it.each(["paths", "sourceFamilyIds"])("requires a non-empty %s", (field) => {
    expect(RetrievalMemberSupportSchema.safeParse({ ...support, [field]: [] }).success).toBe(false);
  });
  it("rejects a support path whose assessment verdict is not admissible", () => {
    expect(RetrievalSupportPathSchema.safeParse({ ...path, assessmentVerdict: "context_only" }).success).toBe(false);
  });
  it("bounds a replay answer to the citation limit", () => {
    expect(
      RetrievalCitationReplaySchema.safeParse({
        schemaVersion: "knowledge.retrieval-citation-replay/v1",
        evidencePacketId: id,
        retrievalRunId: id,
        packetDigest: digest,
        replayedAt: "2026-01-01T00:00:00Z",
        citations: Array.from({ length: 129 }, () => ({
          memberId: id,
          locatorId: id,
          captureId: id,
          sourceFamilyId: id,
          representationArtifactId: id,
          captureArtifactId: id,
          representationDigest: digest,
          captureDigest: digest,
          selectorDigest: digest,
          selectedContentDigest: digest,
          selectedText: "x",
          selectedSizeBytes: 1,
        })),
        failures: [],
      }).success,
    ).toBe(false);
  });
});
