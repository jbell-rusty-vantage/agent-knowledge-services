import { describe, expect, it } from "vitest";
import { sourceNativeFidelityExample } from "./02-source-native-fidelity.js";

describe("example 02: source-native fidelity", () => {
  it("accepts faithful text that equals the ordered evidence", () => {
    const result = sourceNativeFidelityExample();
    expect(result.faithfulValid).toBe(true);
    expect(result.faithfulProjectionSpace).toBe("source_native_sections");
  });

  it("rejects text that does not match the ordered evidence", () => {
    expect(sourceNativeFidelityExample().rewrittenIssues).toContain(
      "source-native text does not exactly match ordered evidence text",
    );
  });

  it("rejects derived assertions on a source-native section", () => {
    expect(sourceNativeFidelityExample().derivedIssues).toContain(
      "source-native sections must remain faithful rather than carry derived assertions",
    );
  });
});
