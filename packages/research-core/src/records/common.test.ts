import { describe, expect, it } from "vitest";
import { DecimalSchema, UsageSchema } from "./common.js";

describe("evaluator usage costs", () => {
  it.each(["0.000001", "0.012345", "10", "100"])("accepts an exact six-place-or-less cost %s", (costUsd) => {
    const usage = { providerCalls: 1, tokens: 123, costUsd };
    expect(UsageSchema.parse(usage)).toEqual(usage);
  });

  it.each(["-0.000001", "1e2", "01", "0.00000125", "0.0123456"])(
    "refuses invalid cost %s at the usage boundary",
    (costUsd) => {
      const result = UsageSchema.safeParse({ providerCalls: 1, tokens: 123, costUsd });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["costUsd"]);
    },
  );
});

describe("research decimal strings", () => {
  it.each(["0", "10", "100", "0.000001", "0.012345", "123.4567891", "-10", "-0.012345"])(
    "preserves the exact signed decimal %s",
    (amount) => {
      expect(DecimalSchema.parse(amount)).toBe(amount);
    },
  );

  it.each(["", "+1", "01", "-01", ".1", "1.", "1.0", "0.010", "1e2", "1E-6", "1\\d", "1\n"])(
    "refuses noncanonical decimal %j",
    (amount) => {
      expect(DecimalSchema.safeParse(amount).success).toBe(false);
    },
  );
});
