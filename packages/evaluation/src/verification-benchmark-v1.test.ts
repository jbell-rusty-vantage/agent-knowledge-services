import { describe, expect, it } from "vitest";
import {
  assessVerificationBenchmarkV1Readiness,
  buildVerificationBenchmarkV1CurationQueue,
  importVerificationBenchmarkV1CandidatePool,
  planVerificationBenchmarkV1Splits,
} from "./verification-benchmark-v1.js";
import { freezeVerificationBenchmarkDataset } from "./verification-benchmark.js";

const digest = (value: number) => `sha256:${value.toString(16).padStart(64, "0")}` as const;
const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const candidatePool = () => ({
  schemaVersion: "verification-benchmark-v1-candidate-pool.v1" as const,
  status: "unlabeled_unfrozen_candidates" as const,
  sourcePreparationDigest: digest(999),
  count: 150,
  independentObservationCount: 0 as const,
  limitation: "Unlabeled candidates require atomization and independent human review before scoring.",
  candidates: Array.from({ length: 150 }, (_, index) => ({
    candidateId: `candidate-${index}`,
    fragmentId: digest(index + 1),
    sourceKey: `source-${index % 6}`,
    sourceClass: index % 2 === 0 ? "first_party" : "publication",
    captureId: uuid(index + 1),
    projectionArtifactId: uuid(index + 201),
    projectionDigest: digest(index + 301),
    selector: { kind: "html" as const, domPath: `1/${index}` },
    selectedContentDigest: digest(index + 501),
    labelStatus: "annotation_pending" as const,
    independentObservation: false as const,
  })),
});

const groupings = (pool: ReturnType<typeof importVerificationBenchmarkV1CandidatePool>) =>
  pool.pool.candidates.map((candidate, index) => {
    const component = index % 6;
    return {
      candidateId: candidate.candidateId,
      sourceFamily: `source-family-${component}`,
      entityFamily: `entity-family-${component}`,
      reportCluster: `report-cluster-${component}`,
      pairCluster: `pair-cluster-${component}`,
    };
  });
const datasetFor = (
  imported: ReturnType<typeof importVerificationBenchmarkV1CandidatePool>,
  alterFirstEvidence = false,
) =>
  freezeVerificationBenchmarkDataset({
    schemaVersion: "verification-benchmark.v1",
    verificationContractVersion: "verification.v1",
    datasetId: "benchmark-v1-readiness-fixture",
    version: 1,
    stage: "benchmark_v1",
    frozen: true,
    supersedesManifestDigest: null,
    sourcePreparationDigest: imported.pool.sourcePreparationDigest,
    labelProvenance: "engineering_expectations",
    annotationGuidelinesDigest: digest(990),
    adjudicationArtifactDigest: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    sealedAt: "2026-09-05T00:00:00.000Z",
    cases: imported.pool.candidates.map((candidate, index) => ({
      schemaVersion: "verification-benchmark.v1" as const,
      caseId: `benchmark-case-${index}`,
      partition: "development" as const,
      inputManifestArtifactId: uuid(index + 501),
      goldArtifactId: null,
      modality: "html" as const,
      sourceFamily: candidate.sourceKey,
      entityFamily: candidate.sourceKey,
      reportCluster: candidate.sourceKey,
      pairCluster: candidate.fragmentId,
      tags: ["candidate"],
      adversarialTransforms: [],
      assertion: `Candidate assertion ${index}`,
      evidence: [
        {
          fragmentId: candidate.fragmentId,
          captureId: alterFirstEvidence && index === 0 ? uuid(999) : candidate.captureId,
          sourceKey: candidate.sourceKey,
          sourceClass: candidate.sourceClass,
          projectionArtifactId: candidate.projectionArtifactId,
          projectionDigest: candidate.projectionDigest,
          transformationArtifactId: uuid(index + 701),
          selector: candidate.selector,
          selectedContentDigest: alterFirstEvidence && index === 0 ? digest(998) : candidate.selectedContentDigest,
          excerpt: `Candidate evidence ${index}`,
          rights: "restricted review fixture",
          providerUploadAuthorized: false,
        },
      ],
      expectation: {
        label: "unsupported" as const,
        labelStatus: "engineering_expectation" as const,
        expectedPolicy: "review" as const,
        expectedLocatorValid: true,
        support: "none" as const,
        authority: "insufficient" as const,
        worldCorrectness: "unknown" as const,
        rationale: "Engineering-only readiness fixture.",
      },
      independentObservation: false,
      humanGoldScoringEligible: false,
      adjudicationId: null,
    })),
  });

describe("Benchmark V1 preparation", () => {
  it("imports an unlabeled 150-row pool and emits a concrete review queue without gold claims", () => {
    const imported = importVerificationBenchmarkV1CandidatePool(candidatePool());
    const queue = buildVerificationBenchmarkV1CurationQueue(imported);
    expect(imported).toMatchObject({ sourceKeyCount: 6, sourceClassCount: 2 });
    expect(queue).toHaveLength(150);
    expect(queue.every((item) => item.status === "awaiting_case_atomization_and_human_review")).toBe(true);
    expect(assessVerificationBenchmarkV1Readiness({ imported })).toMatchObject({
      structurallyRunnable: false,
      humanGoldPromotionReady: false,
      boundCaseCount: 0,
    });
  });

  it("rejects duplicate source fragments", () => {
    const pool = candidatePool();
    pool.candidates[1] = { ...pool.candidates[1]!, fragmentId: pool.candidates[0]!.fragmentId };
    expect(() => importVerificationBenchmarkV1CandidatePool(pool)).toThrow();
  });

  it("requires an exact one-to-one grouping row for every imported candidate", () => {
    const imported = importVerificationBenchmarkV1CandidatePool(candidatePool());
    expect(() =>
      planVerificationBenchmarkV1Splits({ imported, groupings: groupings(imported).slice(1), seed: 1 }),
    ).toThrow("BENCHMARK_V1_SPLIT_CARDINALITY_INVALID");
  });

  it("requires full candidate evidence identity rather than fragment membership alone", () => {
    const imported = importVerificationBenchmarkV1CandidatePool(candidatePool());
    expect(assessVerificationBenchmarkV1Readiness({ imported, dataset: datasetFor(imported) })).toMatchObject({
      structurallyRunnable: true,
      humanGoldPromotionReady: false,
    });
    expect(assessVerificationBenchmarkV1Readiness({ imported, dataset: datasetFor(imported, true) })).toMatchObject({
      structurallyRunnable: false,
      blockers: expect.arrayContaining(["candidate_pool_evidence_binding_incomplete"]),
    });
  });

  it("assigns complete provenance components deterministically without split leakage", () => {
    const imported = importVerificationBenchmarkV1CandidatePool(candidatePool());
    const first = planVerificationBenchmarkV1Splits({ imported, groupings: groupings(imported), seed: 20260905 });
    const second = planVerificationBenchmarkV1Splits({
      imported,
      groupings: [...groupings(imported)].reverse(),
      seed: 20260905,
    });
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.componentCount).toBe(6);
    expect(first.counts.development + first.counts.calibration + first.counts.locked_test).toBe(150);
    for (const family of new Set(first.assignments.map((item) => item.sourceFamily))) {
      expect(
        new Set(first.assignments.filter((item) => item.sourceFamily === family).map((item) => item.partition)).size,
      ).toBe(1);
    }
  });

  it("requires at least three separable provenance components", () => {
    const imported = importVerificationBenchmarkV1CandidatePool(candidatePool());
    const inseparable = groupings(imported).map((item) => ({ ...item, sourceFamily: "one-source-family" }));
    expect(() => planVerificationBenchmarkV1Splits({ imported, groupings: inseparable, seed: 1 })).toThrow(
      "BENCHMARK_V1_SPLIT_REQUIRES_THREE_PROVENANCE_COMPONENTS",
    );
  });
});
