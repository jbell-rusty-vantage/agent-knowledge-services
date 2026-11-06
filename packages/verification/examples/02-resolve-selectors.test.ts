import { describe, expect, it } from "vitest";
import { resolveExample, selectorExamples } from "./02-resolve-selectors.js";

describe("runnable selector capability examples", () => {
  it.each(selectorExamples)("resolves $name from preserved fixture bytes", (example) => {
    const result = resolveExample(example);
    expect(result?.resolution.status).toBe("resolved");
    expect(new TextDecoder().decode(result?.selectedContent)).toContain(example.expectedText);
  });

  it("requires more context instead of picking the first repeated quote", () => {
    const repeated = {
      name: "repeated value",
      content: "Panel A: 42. Panel B: 42.",
      selector: {
        kind: "text_quote",
        quote: "42",
        normalization: "none",
      } as const,
      expectedText: "42",
    };
    expect(resolveExample(repeated)?.resolution.status).toBe("ambiguous");
    expect(
      resolveExample({
        ...repeated,
        selector: { ...repeated.selector, prefix: "Panel B: " },
      })?.resolution.status,
    ).toBe("resolved");
  });

  it("reports the declared code-point coordinates after a non-BMP character", () => {
    const example = selectorExamples.find((item) => item.selector.kind === "character_position")!;
    expect(resolveExample(example)?.resolution.resolvedRanges).toEqual([
      { start: 2, end: 4, coordinateSpace: "unicode_code_points" },
    ]);
  });
});
