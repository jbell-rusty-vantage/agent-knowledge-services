import { describe, expect, it } from "vitest";
import { semanticRecordedJudgeExample } from "./05-semantic-recorded-judge.js";

describe("example 05: semantic recorded judge", () => {
  it("closes a mechanically failed bundle with MECHANICAL_GATE_CLOSED", async () => {
    const { closed } = await semanticRecordedJudgeExample();
    expect(["locator_error", "unverifiable"]).toContain(closed.verdict);
    expect(closed.reasonCodes).toContain("MECHANICAL_GATE_CLOSED");
  });

  it("never calls the judge when the gate is closed", async () => {
    const { closed } = await semanticRecordedJudgeExample();
    expect(closed.judgeCalls).toBe(0);
  });

  it("returns the recorded directly_supported verdict on the passing bundle", async () => {
    const { supported } = await semanticRecordedJudgeExample();
    expect(supported.verdict).toBe("directly_supported");
    expect(supported.supportingFragmentIds).toEqual(["fragment-evidence-1"]);
  });

  it("calls the judge exactly once for a single-family case", async () => {
    const { supported } = await semanticRecordedJudgeExample();
    expect(supported.judgeCalls).toBe(1);
  });
});
