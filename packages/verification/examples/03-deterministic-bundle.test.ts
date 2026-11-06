import { describe, expect, it } from "vitest";
import { deterministicBundleExample } from "./03-deterministic-bundle.js";

describe("example 03: deterministic bundle", () => {
  it("passes the minimal bundle and opens semantic eligibility", () => {
    const { passing } = deterministicBundleExample();
    expect(passing.status).toBe("passed");
    expect(passing.semanticEligibility).toBe(true);
  });

  it("fails CAPTURE_DIGEST_MATCH on a same-length byte corruption", () => {
    const { corrupted } = deterministicBundleExample();
    expect(corrupted.summary.failedCheckCodes).toContain("CAPTURE_DIGEST_MATCH");
  });

  it("closes semantic eligibility once a capture fails", () => {
    const { corrupted } = deterministicBundleExample();
    expect(corrupted.semanticEligibility).toBe(false);
  });
});
