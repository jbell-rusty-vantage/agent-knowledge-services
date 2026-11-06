import { describe, expect, it } from "vitest";
import { qaFailureNextProfileExample } from "./03-qa-failure-next-profile.js";

describe("example 03: QA failure, next admitted profile", () => {
  it("fails the claims profile on a run-on turn", () => {
    const [first] = qaFailureNextProfileExample().attempts;
    expect(first?.profile).toBe("atomic-claims-v1@1.0.0");
    expect(first?.valid).toBe(false);
    expect(first?.issues.some((issue) => issue.endsWith("exceeds maximum source tokens"))).toBe(true);
  });

  it("accepts the next profile admitted for the same space and node kinds", () => {
    const result = qaFailureNextProfileExample();
    expect(result.attempts.map(({ profile }) => profile)).toEqual([
      "atomic-claims-v1@1.0.0",
      "transcript-topics-v1@1.0.0",
    ]);
    expect(result.attempts[1]?.valid).toBe(true);
    expect(result.accepted).toBe("transcript-topics-v1@1.0.0");
  });
});
