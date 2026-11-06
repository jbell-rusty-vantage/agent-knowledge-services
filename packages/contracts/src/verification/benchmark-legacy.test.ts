import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VerificationBenchmarkDatasetSchema } from "./benchmark.js";

const legacy = async () =>
  JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "../../../../catalog/verification-benchmarks/diagnostics-companies-v1/dataset.json"),
      "utf8",
    ),
  );
describe("frozen engineering-only v1 compatibility", () => {
  it("preserves the complete original material without inserting adjudication fields", async () => {
    const original = await legacy();
    expect(VerificationBenchmarkDatasetSchema.parse(original)).toEqual(original);
    expect(original).not.toHaveProperty("adjudicationArtifactDigest");
    expect(original.cases[0]).not.toHaveProperty("adjudicationId");
  });
  it("requires an adjudication identity before a legacy case can claim human gold", async () => {
    const input = await legacy();
    input.cases[0].humanGoldScoringEligible = true;
    input.cases[0].humanGoldDimensions = ["label"];
    input.cases[0].expectation.labelStatus = "expert_adjudicated";
    const result = VerificationBenchmarkDatasetSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message.includes("bound expert adjudication"))).toBe(true);
  });
  it("still requires the dataset adjudication artifact when a case has an identity", async () => {
    const input = await legacy();
    Object.assign(input.cases[0], {
      humanGoldScoringEligible: true,
      humanGoldDimensions: ["label"],
      adjudicationId: "11111111-1111-4111-8111-111111111111",
    });
    input.cases[0].expectation.labelStatus = "expert_adjudicated";
    const result = VerificationBenchmarkDatasetSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.some((issue) => issue.message === "human gold requires an adjudication artifact"),
      ).toBe(true);
  });
});
