import { describe, expect, it } from "vitest";
import { deterministicBatchExample } from "./01-deterministic-batch.js";

describe("example 01: deterministic batch", () => {
  it("keeps the caller's input order", async () => {
    expect((await deterministicBatchExample()).order).toEqual(["alpha", "beta"]);
  });

  it("produces an identical output manifest digest across two runs", async () => {
    expect((await deterministicBatchExample()).identicalAcrossRuns).toBe(true);
  });
});
