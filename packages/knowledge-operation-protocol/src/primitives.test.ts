import { describe, expect, it } from "vitest";
import { UsdSchema } from "./primitives.js";

describe("USD decimal strings", () => {
  it.each(["0", "0.000001", "0.012345", "1", "10", "100", "123456789.123456", "1.000000"])(
    "preserves the exact valid amount %s",
    (amount) => {
      expect(UsdSchema.parse(amount)).toBe(amount);
    },
  );

  it.each([
    "",
    "-1",
    "-0.000001",
    "+1",
    "01",
    "00.1",
    ".1",
    "1.",
    "1e2",
    "1E-6",
    "0.0000001",
    "0.0123456",
    " 1",
    "1 ",
    "1\n",
    "1,000",
    "NaN",
    "Infinity",
    "1\\d",
  ])("refuses the malformed or overprecision amount %j", (amount) => {
    expect(UsdSchema.safeParse(amount).success).toBe(false);
  });

  it.each([0, 0.012345, null, undefined])("refuses non-string money %j", (amount) => {
    expect(UsdSchema.safeParse(amount).success).toBe(false);
  });
});
