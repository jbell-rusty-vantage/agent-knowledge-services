import { describe, expect, it } from "vitest";
import { auditDatasetPartitions, createEvaluationReviewArtifact } from "@aiengineer/knowledge-evaluation";
import {
  BROAD_DOMAINS,
  BROAD_QUERY_CLASSES,
  createBroadEvaluationCandidate,
  createBroadEvaluationCorpus,
  planBroadRetrievalQuery,
  runBroadEvaluation,
  runBroadHybridControlOutputs,
} from "./broad-evaluation-corpus.js";

const PROVISIONAL_REVIEWER = "provisional-test-reviewer-not-a-release-approval";
async function createProvisionalCorpus() {
  const candidate = await createBroadEvaluationCandidate();
  const artifact = createEvaluationReviewArtifact(candidate.datasetInput, {
    authorIdentity: "codex-corpus-author:v2",
    reviewerIdentity: PROVISIONAL_REVIEWER,
    decision: "accept",
    reviewedAt: "2026-09-03T00:00:00.000Z",
    rationale: "Unit-test-only artifact; not release approval.",
  });
  return createBroadEvaluationCorpus(artifact);
}

describe("broad retrieval evaluation corpus", () => {
  it("has balanced, leakage-resistant coverage with substantive qrels", async () => {
    const corpus = await createProvisionalCorpus();
    expect(corpus.dataset.cases).toHaveLength(96);
    expect(new Set(corpus.dataset.cases.map(({ domain }) => domain))).toEqual(new Set(BROAD_DOMAINS));
    expect(new Set(corpus.dataset.cases.map(({ queryClass }) => queryClass))).toEqual(new Set(BROAD_QUERY_CLASSES));
    expect(corpus.dataset.reviewArtifact?.reviewerIdentity).toBe(PROVISIONAL_REVIEWER);
    expect(auditDatasetPartitions(corpus.dataset)).toMatchObject({
      valid: true,
      counts: { dev: 32, calibration: 32, heldout: 32 },
    });
    expect(
      corpus.dataset.cases.every(
        (item) => item.expectedAbstain || item.relevanceJudgments.some(({ grade }) => grade > 0),
      ),
    ).toBe(true);
    expect(
      corpus.dataset.cases
        .filter(({ queryClass }) => queryClass === "constraint" || queryClass === "filtered")
        .every(({ expectedFilters }) => expectedFilters.length > 0),
    ).toBe(true);
  }, 30_000);

  it("plans filters and multi-hop spaces from the public query contract without reading qrels or expected filters", async () => {
    const corpus = await createProvisionalCorpus();
    for (const testCase of corpus.dataset.cases) {
      const request = corpus.publicRequests[testCase.id]!;
      const planned = planBroadRetrievalQuery(request);
      for (const expected of testCase.expectedFilters)
        expect(planned.hardFilters).toContainEqual({ field: expected.field, op: "eq", value: expected.value });
      if (testCase.queryClass === "multi_hop")
        expect(new Set(planned.spaces)).toEqual(new Set(testCase.requiredResultTypes));
    }
    const baseline = await runBroadHybridControlOutputs(corpus);
    const poisonedCorpus = {
      ...corpus,
      dataset: {
        ...corpus.dataset,
        cases: corpus.dataset.cases.map((testCase) => ({
          ...testCase,
          domain: "engineering_claims" as const,
          queryClass: "adversarial" as const,
          expectedFilters: [{ field: "language", value: "poison" }],
          relevanceJudgments: [],
          requiredResultTypes: [],
        })),
      },
    };
    const poisoned = await runBroadHybridControlOutputs(poisonedCorpus);
    expect(
      poisoned.map(({ evidencePacket, output }) => ({
        digest: evidencePacket.digest,
        ids: output.items.map(({ recordId }) => recordId),
      })),
    ).toEqual(
      baseline.map(({ evidencePacket, output }) => ({
        digest: evidencePacket.digest,
        ids: output.items.map(({ recordId }) => recordId),
      })),
    );
  }, 30_000);

  it("runs every experiment arm and enforces the hard control gate", async () => {
    const result = await runBroadEvaluation(await createProvisionalCorpus());
    expect(result.experiment.arms.map(({ arm }) => arm.id)).toEqual([
      "hybrid-control",
      "lexical-only",
      "vector-only",
      "unfiltered-hybrid",
      "graph-hybrid",
      "reranked-hybrid",
    ]);
    expect(result.falseAcceptanceCases).toEqual([]);
    expect(result.controlGate.passed, JSON.stringify(result.controlGate)).toBe(true);
    expect(result.regressionGate.passed).toBe(true);
    expect(result.rollbackProof.passed).toBe(true);
  }, 30_000);
});
