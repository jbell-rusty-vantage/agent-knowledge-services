import { describe, expect, it } from "vitest";
import type { RetrievalRecord, StageContribution } from "../types.js";
import { compareCandidate, rrfContribution, sum } from "./fuse.js";

const candidate = (overrides: Partial<RetrievalRecord> & { score: number }) => {
  const { score, ...recordOverrides } = overrides;
  const record: RetrievalRecord = {
    id: "r1",
    tenantId: "t1",
    projectionId: "p1",
    projectionVersionId: "v1",
    space: "engineering_claims",
    targetKind: "engineering_claims",
    targetSchemaVersion: "v1",
    text: "text",
    fields: {},
    locators: [],
    authority: "exploratory",
    assurance: "high",
    freshnessAt: "2026-08-01T00:00:00.000Z",
    promoted: true,
    sourceId: "source-a",
    ...recordOverrides,
  };
  return { score, record };
};

describe("sum", () => {
  it("adds up rrfContribution across contributions", () => {
    const items: StageContribution[] = [
      { channel: "exact", rank: 1, rawScore: 1, rrfContribution: 0.1, explanation: "" },
      { channel: "fts", rank: 2, rawScore: 0.5, rrfContribution: 0.05, explanation: "" },
    ];
    expect(sum(items)).toBeCloseTo(0.15);
  });

  it("is 0 for no contributions", () => {
    expect(sum([])).toBe(0);
  });
});

describe("rrfContribution", () => {
  it("uses the policy's channel weight when present", () => {
    expect(rrfContribution({ exact: 2 }, 60, "exact", 1)).toBeCloseTo(2 / 61);
  });

  it("defaults to weight 1 for a channel the policy does not mention", () => {
    expect(rrfContribution({}, 60, "semantic", 3)).toBeCloseTo(1 / 63);
  });
});

describe("compareCandidate tie-break order: score, then assurance, then freshness, then id", () => {
  it("ranks the higher score first", () => {
    const a = candidate({ score: 2 });
    const b = candidate({ score: 1 });
    expect(compareCandidate(a, b)).toBeLessThan(0);
  });

  it("breaks an equal score by localeCompare on the raw assurance string (not a severity order — an existing quirk kept as-is)", () => {
    const high = candidate({ score: 1, assurance: "high" });
    const medium = candidate({ score: 1, assurance: "medium" });
    const low = candidate({ score: 1, assurance: "low" });
    expect(compareCandidate(medium, low)).toBeLessThan(0);
    expect(compareCandidate(low, high)).toBeLessThan(0);
  });

  it("breaks an equal score and assurance by fresher freshnessAt first", () => {
    const a = candidate({ score: 1, freshnessAt: "2026-09-01T00:00:00.000Z" });
    const b = candidate({ score: 1, freshnessAt: "2026-08-01T00:00:00.000Z" });
    expect(compareCandidate(a, b)).toBeLessThan(0);
  });

  it("breaks a full tie by ascending record id", () => {
    const a = candidate({ score: 1, id: "a" });
    const b = candidate({ score: 1, id: "b" });
    expect(compareCandidate(a, b)).toBeLessThan(0);
  });
});
