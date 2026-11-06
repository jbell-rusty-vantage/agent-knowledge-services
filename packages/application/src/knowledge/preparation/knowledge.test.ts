import { describe, expect, it } from "vitest";
import { DeterministicFakeEmbeddingAdapter } from "@aiengineer/knowledge-retrieval";
import { loadEmbeddingBundles } from "@aiengineer/knowledge-testkit";
import { AgenticKnowledgeService } from "./knowledge.js";

describe("agentic knowledge Gates 3-5", () => {
  it("embeds, indexes, retrieves and evaluates all 41 claims from the three real bundles", async () => {
    const loaded = await loadEmbeddingBundles();
    const service = new AgenticKnowledgeService(new DeterministicFakeEmbeddingAdapter());
    const index = await service.buildExploratoryIndex(loaded.map((x) => x.bundle));
    expect(index.records).toHaveLength(41);
    expect(index.backend.count(index.tenantId, index.vectorSpaceVersionId)).toBe(41);
    expect(index.embeddingReceiptDigests).toHaveLength(3);
    const packet = await service.retrieve(index, index.records[0]!.text);
    expect(packet.abstention.recommended).toBe(false);
    expect(packet.members[0]!.recordId).toBe(index.records[0]!.id);
    expect(packet.members[0]!.locators.length).toBeGreaterThan(0);
    const report = await service.evaluate(index);
    expect(report.cases).toHaveLength(41);
    expect(report.overall.recallAtK).toBeGreaterThanOrEqual(0.9);
    expect(report.overall.ndcgAtK).toBeGreaterThanOrEqual(0.8);
    expect(report.overall.mrr).toBeGreaterThanOrEqual(0.75);
    expect(report.overall.citationCorrectness).toBeGreaterThanOrEqual(0.98);
    expect(report.overall.falseAcceptanceCount).toBe(0);
  }, 30_000);
});
