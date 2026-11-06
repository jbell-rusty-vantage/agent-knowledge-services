import { describe, expect, it } from "vitest";
import { LiteralExtractionPolicySchema } from "./semantic-policy.js";

describe("literal extraction policy contract", () => {
  it("requires explicit assertion IDs and only the bounded materialization use", () => {
    expect(
      LiteralExtractionPolicySchema.safeParse({
        assertionIds: ["claim-1"],
        downstreamUses: ["knowledge_ingestion:claim.materialize"],
      }).success,
    ).toBe(true);
    expect(
      LiteralExtractionPolicySchema.safeParse({
        assertionIds: [],
        downstreamUses: ["knowledge_ingestion:claim.materialize"],
      }).success,
    ).toBe(false);
    expect(
      LiteralExtractionPolicySchema.safeParse({ assertionIds: ["claim-1"], downstreamUses: ["publication"] }).success,
    ).toBe(false);
    expect(
      LiteralExtractionPolicySchema.safeParse({
        assertionIds: ["claim-1"],
        downstreamUses: ["knowledge_ingestion:claim.materialize"],
        waiveHumanReview: true,
      }).success,
    ).toBe(false);
  });
});
