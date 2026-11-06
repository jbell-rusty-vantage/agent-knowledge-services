import { describe, expect, it } from "vitest";
import type { RetrievalRecord } from "../types.js";
import { exactScore, ftsScore, score, trigramScore } from "./scoring.js";

const record = (overrides: Partial<RetrievalRecord> = {}): RetrievalRecord => ({
  id: "r1",
  tenantId: "t1",
  projectionId: "p1",
  projectionVersionId: "v1",
  space: "engineering_claims",
  targetKind: "engineering_claims",
  targetSchemaVersion: "v1",
  text: "Agents retry with a shared lease budget",
  identifiers: ["agent-loop"],
  fields: {},
  locators: [],
  authority: "exploratory",
  assurance: "high",
  freshnessAt: "2026-08-01T00:00:00.000Z",
  promoted: true,
  sourceId: "source-a",
  ...overrides,
});

describe("exactScore", () => {
  it("scores 1 for an exact identifier match", () => {
    expect(exactScore(record(), "agent-loop")).toBe(1);
  });

  it("scores 0.95 for a text substring match without an identifier hit", () => {
    expect(exactScore(record({ identifiers: [] }), "shared lease budget")).toBe(0.95);
  });

  it("scores 0 when neither identifiers nor text match", () => {
    expect(exactScore(record({ identifiers: [] }), "unrelated query")).toBe(0);
  });
});

describe("ftsScore", () => {
  it("returns 0 for no tokens", () => {
    expect(ftsScore("any text", [])).toBe(0);
  });

  it("returns the fraction of tokens covered by the text", () => {
    expect(ftsScore("agents retry with a lease", ["agents", "lease", "missing"])).toBeCloseTo(2 / 3);
  });
});

describe("trigramScore", () => {
  it("is symmetric", () => {
    expect(trigramScore("agent loop", "agentic loops")).toBe(trigramScore("agentic loops", "agent loop"));
  });

  it("is 0 when one side is empty and shares no trigram with the other", () => {
    expect(trigramScore("", "x")).toBe(0);
  });

  it("is 1 for identical strings", () => {
    expect(trigramScore("agent loop", "agent loop")).toBe(1);
  });
});

describe("score", () => {
  it("keeps only positive scores and sorts by score desc, then id asc", () => {
    const records = [record({ id: "b" }), record({ id: "a" }), record({ id: "c" })];
    const ranked = score(records, (r) => (r.id === "c" ? 0 : 1), "fixture scorer");
    expect(ranked.map((x) => x.record.id)).toEqual(["a", "b"]);
  });
});
