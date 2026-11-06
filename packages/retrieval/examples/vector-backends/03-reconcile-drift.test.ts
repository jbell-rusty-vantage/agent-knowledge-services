import { describe, expect, it } from "vitest";
import { reconcileDriftExample } from "./03-reconcile-drift.js";

describe("example 03: reconcile drift", () => {
  it("classifies an evaluation regression as review_required", async () => {
    const result = await reconcileDriftExample();
    expect(result.evaluationRegression).toContainEqual(["EVALUATION_REGRESSION", "review_required"]);
  });

  it("classifies a manifest mismatch as security_critical", async () => {
    const result = await reconcileDriftExample();
    expect(result.manifestMismatch).toContainEqual(["EMBEDDING_MANIFEST_MISMATCH", "security_critical"]);
  });

  it("classifies an orphan active pointer as security_critical", async () => {
    const result = await reconcileDriftExample();
    expect(result.orphanPointer).toEqual([["ORPHAN_ACTIVE_POINTER", "security_critical"]]);
  });
});
