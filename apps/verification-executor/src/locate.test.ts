import { describe, expect, it } from "vitest";
import { countOccurrences, searchContent } from "./locate.js";

describe("capture search coordinates", () => {
  it("preserves exact bytes and offsets after a Unicode character that expands when lowercased", () => {
    const content = "İ Panel: VALUE [42].";
    const [hit] = searchContent(content, "value [42]");
    expect(hit?.offset).toBe(content.indexOf("VALUE"));
    expect(hit?.exact).toBe("VALUE [42]");
    expect(content.slice(hit!.offset, hit!.offset + hit!.exact.length)).toBe(hit!.exact);
  });

  it("treats regex punctuation as literal search text", () => {
    expect(searchContent("a+b (42)?", "a+b (42)?")[0]?.exact).toBe("a+b (42)?");
  });

  it("counts overlapping occurrences like the deterministic quote resolver", () => {
    expect(countOccurrences("banana", "ana")).toBe(2);
    expect(countOccurrences("anything", "")).toBe(0);
  });
});
