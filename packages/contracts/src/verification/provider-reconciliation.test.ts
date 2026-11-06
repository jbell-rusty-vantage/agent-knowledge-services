import { describe, it, expect } from "vitest";
import { VerificationProviderReconciliationSchema } from "./provider-reconciliation.js";
describe("reconciliation contract boundaries", () => {
  it("rejects malformed and noncanonical issuance times as schema errors", () => {
    for (const value of ["invalid", "2026-99-99T00:00:00.000Z", "2026-09-06T00:00:00Z"]) {
      expect(VerificationProviderReconciliationSchema.shape.issuedAt.safeParse(value).success).toBe(false);
    }
    expect(VerificationProviderReconciliationSchema.shape.issuedAt.safeParse("2026-09-06T00:00:00.000Z").success).toBe(
      true,
    );
  });
});
