import { describe, expect, it } from "vitest";
import { SourceFragmentSchema } from "./model.js";

describe("SourceFragment selector and display separation", () => {
  const base = {
    fragmentId: "fragment-1",
    captureId: "capture-1",
    representationArtifactId: "11111111-1111-4111-8111-111111111111",
    selector: { kind: "text_quote", quote: "Exact source statement.", normalization: "none" },
  };

  it("retains an ellipsized display excerpt as presentation-only while requiring an exact machine selector", () => {
    const parsed = SourceFragmentSchema.parse({ ...base, displayExcerpt: "Exact source …" });
    expect(parsed.selector).toEqual(base.selector);
    expect(parsed.displayExcerpt).toBe("Exact source …");
    expect(
      SourceFragmentSchema.safeParse({ ...base, selector: undefined, displayExcerpt: "Exact source statement." })
        .success,
    ).toBe(false);
  });
});
