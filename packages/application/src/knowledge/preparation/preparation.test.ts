import { describe, expect, it } from "vitest";
import { loadEmbeddingBundles } from "@aiengineer/knowledge-testkit";
import { KnowledgePreparationService } from "./preparation.js";

describe("knowledge preparation previews", () => {
  it("vets and deterministically prepares all three actual embedding bundles", async () => {
    const loaded = await loadEmbeddingBundles();
    const summaries = [];
    for (const { bundle } of loaded) {
      const first = await new KnowledgePreparationService().preparePreview(bundle);
      const second = await new KnowledgePreparationService().preparePreview(bundle);
      expect(first.operationState).toBe("succeeded");
      expect(first.publicationState).toBe("not_requested");
      expect(first.embeddingState).toBe("not_implemented");
      expect(first.documents.length).toBe(bundle.selected_documents.length);
      expect(first.engineeringClaimProjections.length).toBe(bundle.engineering_claims.length);
      expect(first.documents.every((item) => item.chunking.qa.valid)).toBe(true);
      expect(first.bundleDigest).toBe(second.bundleDigest);
      expect(first.documents.map((item) => item.representation.digest)).toEqual(
        second.documents.map((item) => item.representation.digest),
      );
      expect(first.engineeringClaimProjections.map((item) => item.projectionId)).toEqual(
        second.engineeringClaimProjections.map((item) => item.projectionId),
      );
      summaries.push(first);
    }
    expect(summaries.reduce((sum, item) => sum + item.engineeringClaimProjections.length, 0)).toBe(41);
  });
  it("stops at append-only review proposals", async () => {
    const loaded = await loadEmbeddingBundles();
    const bundle = loaded[0]?.bundle;
    if (!bundle) throw new Error("Expected fixture bundle");
    const result = await new KnowledgePreparationService().preparePreview(bundle);
    expect(
      result.proposals.every((item) => item.state === "submitted" && item.requestedAuthority === "reviewer_decision"),
    ).toBe(true);
    expect(result.proposals.at(-1)?.payload).toMatchObject({
      requestedAction: "review_prepared_candidates",
      prohibitedActions: ["publish", "embed", "canonical_write"],
    });
  });
});
