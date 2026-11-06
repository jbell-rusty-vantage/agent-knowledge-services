import { describe, expect, it } from "vitest";
import { abstainAndOmitExample } from "./03-abstain-and-omit.js";

describe("example 03: abstain and omit", () => {
  it("recommends abstention with a coverage reason when nothing satisfies the query", async () => {
    const { coverageAbstention } = await abstainAndOmitExample();
    expect(coverageAbstention.recommended).toBe(true);
    expect(coverageAbstention.reason).toContain("coverage");
  });

  it("records tenant, promotion, visibility and retraction omissions by reason", async () => {
    const { omittedReasons } = await abstainAndOmitExample();
    expect(omittedReasons).toEqual(
      expect.arrayContaining(["tenant_mismatch", "not_eligible", "visibility_not_authorized", "retracted"]),
    );
  });
});
