import { describe, expect, it } from "vitest";
import { chunkAndReconstructExample } from "./02-chunk-and-reconstruct.js";

describe("example 02: chunk and reconstruct", () => {
  it("replays every chunk from its spans", () => {
    const result = chunkAndReconstructExample();
    expect(result.everySpanReconstructs).toBe(true);
    expect(result.qa.valid).toBe(true);
  });

  it("omits repeated boilerplate instead of embedding it", () => {
    const result = chunkAndReconstructExample();
    expect(result.omittedNodeCount).toBe(3);
    expect(result.chunks.some(({ sourceText }) => sourceText.includes("Company confidential"))).toBe(false);
  });

  it("prefixes the nearest heading and keeps the digest stable", () => {
    const result = chunkAndReconstructExample();
    expect(result.chunks[0]?.contextualPrefix).toBe("Durable retries\n\n");
    expect(result.deterministic).toBe(true);
  });
});
