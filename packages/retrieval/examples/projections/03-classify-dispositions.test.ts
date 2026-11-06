import { describe, expect, it } from "vitest";
import { classifyDispositionsExample } from "./03-classify-dispositions.js";

describe("example 03: classify dispositions", () => {
  it("maps admitted dispositions to their vector spaces", () => {
    expect(classifyDispositionsExample().resolvedSpaces).toEqual(["engineering_claims", "source_native_sections"]);
  });

  it("classifies not_ingestible alone as no spaces", () => {
    expect(classifyDispositionsExample().notIngestibleSpaces).toEqual([]);
  });

  it("refuses a canonical disposition with an unresolved identity", () => {
    expect(classifyDispositionsExample().unresolvedRejection).toMatch(/resolved entity/);
  });
});
