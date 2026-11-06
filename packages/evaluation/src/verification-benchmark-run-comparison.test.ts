import { describe, expect, it } from "vitest";
import {
  freezeVerificationBenchmarkDataset,
  MemoryVerificationBenchmarkCheckpointStore,
  runVerificationBenchmark,
  verificationBenchmarkDigest,
  type DraftVerificationBenchmarkDataset,
  type VerificationBenchmarkRun,
} from "./verification-benchmark.js";
import {
  compareVerificationBenchmarkRuns,
  VerificationBenchmarkRunComparisonError,
  type CompareVerificationBenchmarkRunsInput,
  type VerificationBenchmarkRunComparisonErrorCode,
} from "./verification-benchmark-run-comparison.js";

const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;
const artifactId = "11111111-1111-4111-8111-111111111111";
const baselineRunId = "21111111-1111-4111-8111-111111111111";
const candidateRunId = "31111111-1111-4111-8111-111111111111";
const now = "2026-09-06T00:00:00.000Z";

const arms = [
  {
    armId: "control",
    name: "Control",
    control: true,
    strategy: "baseline" as const,
    extractorProfile: "deterministic",
    parserProfile: "frozen",
    retrieverProfile: "bound",
    judgeProfile: "rules",
    policyVersion: "v1",
    configurationDigest: digestA,
    cachePolicy: "disabled" as const,
    replicas: 1,
  },
  {
    armId: "candidate",
    name: "Candidate",
    control: false,
    strategy: "cascade" as const,
    extractorProfile: "recorded",
    parserProfile: "frozen",
    retrieverProfile: "bound",
    judgeProfile: "rules",
    policyVersion: "v1",
    configurationDigest: digestB,
    cachePolicy: "exact_request_only" as const,
    replicas: 1,
  },
];

function datasetDraft(overrides: Partial<DraftVerificationBenchmarkDataset> = {}): DraftVerificationBenchmarkDataset {
  return {
    schemaVersion: "verification-benchmark.v1",
    verificationContractVersion: "verification.v1",
    datasetId: "comparison-fixture",
    version: 1,
    stage: "pilot",
    frozen: true,
    supersedesManifestDigest: null,
    sourcePreparationDigest: digestA,
    labelProvenance: "engineering_expectations",
    annotationGuidelinesDigest: digestA,
    adjudicationArtifactDigest: null,
    createdAt: now,
    sealedAt: now,
    cases: Array.from({ length: 30 }, (_, index) => ({
      schemaVersion: "verification-benchmark.v1" as const,
      caseId: `case-${index.toString().padStart(2, "0")}`,
      partition: "development" as const,
      inputManifestArtifactId: artifactId,
      goldArtifactId: null,
      modality: "html" as const,
      sourceFamily: `source-${Math.floor(index / 10)}`,
      entityFamily: `entity-${Math.floor(index / 10)}`,
      reportCluster: `report-${Math.floor(index / 5)}`,
      pairCluster: `pair-${Math.floor(index / 5)}`,
      tags: ["comparison-fixture"],
      adversarialTransforms: [],
      assertion: `Claim ${index}`,
      evidence: [
        {
          fragmentId: `fragment-${index}`,
          captureId: artifactId,
          sourceKey: `source-${index}`,
          sourceClass: "first_party",
          projectionArtifactId: artifactId,
          projectionDigest: digestA,
          transformationArtifactId: artifactId,
          selector: { kind: "html" as const, domPath: `1/${index}` },
          selectedContentDigest: digestA,
          excerpt: `Claim ${index}`,
          rights: "restricted fixture",
          providerUploadAuthorized: false,
        },
      ],
      expectation: {
        label: "supported_by_source" as const,
        labelStatus: "engineering_expectation" as const,
        expectedPolicy: "pass_with_warnings" as const,
        expectedLocatorValid: true,
        support: "full" as const,
        authority: "interested_party_only" as const,
        worldCorrectness: "not_established" as const,
        rationale: "Engineering fixture only.",
      },
      independentObservation: false,
      humanGoldScoringEligible: false,
      adjudicationId: null,
    })),
    ...overrides,
  };
}

async function run(
  runId: string,
  dataset = freezeVerificationBenchmarkDataset(datasetDraft()),
  correctCandidateCases = 0,
  repetitions = 1,
  networkPolicy: "offline" | "allow_listed_providers" = "offline",
) {
  return runVerificationBenchmark({
    runId,
    dataset,
    experimentDefinitionDigest: digestA,
    arms,
    repetitions,
    randomSeed: 17,
    networkPolicy,
    checkpoints: new MemoryVerificationBenchmarkCheckpointStore(),
    now: () => now,
    execute: async ({ arm, testCase }) => {
      const index = Number(testCase.caseId.slice(-2));
      const agrees = arm.armId === "candidate" && index < correctCandidateCases;
      return {
        schemaValid: true,
        locatorValid: true,
        fieldMechanics: index % 2 === 0,
        support: testCase.expectation.support,
        authority: testCase.expectation.authority,
        worldCorrectness: testCase.expectation.worldCorrectness,
        policy: agrees ? testCase.expectation.expectedPolicy : ("review" as const),
        confidence: null,
        confidenceCalibrated: false,
        failureClass: "none" as const,
        callAttributions: [
          {
            callId: `call-${arm.armId}-${testCase.caseId}`,
            armId: arm.armId,
            caseId: testCase.caseId,
            provider: "recorded-provider",
            model: "recorded-model",
            requestDigest: digestA,
            responseDigest: digestB,
            cacheDisposition: "exact_cache_shared" as const,
            sharedWithArmIds: ["control", "candidate"],
            costState: "actual" as const,
            actualCostMicros: 1,
            reservationCostMicros: 0,
            latencyMs: 1,
            failureClass: "none" as const,
          },
        ],
      };
    },
  });
}

function comparisonInput(
  dataset: ReturnType<typeof freezeVerificationBenchmarkDataset>,
  baseline: VerificationBenchmarkRun,
  candidate: VerificationBenchmarkRun,
  overrides: Partial<CompareVerificationBenchmarkRunsInput> = {},
): CompareVerificationBenchmarkRunsInput {
  return {
    baseline: { dataset, run: baseline, armId: "candidate" },
    candidate: { dataset, run: candidate, armId: "candidate" },
    clusterUnit: "source_family",
    seed: 23,
    resamples: 100,
    correction: "holm",
    ...overrides,
  };
}

function expectCode(
  action: () => unknown,
  code: VerificationBenchmarkRunComparisonErrorCode,
  side?: "baseline" | "candidate",
) {
  try {
    action();
    throw new Error("EXPECTED_COMPARISON_ERROR");
  } catch (error) {
    expect(error).toBeInstanceOf(VerificationBenchmarkRunComparisonError);
    expect(error).toMatchObject({ code, side });
  }
}

describe("verification benchmark run comparison", () => {
  it("compares the same arm identity across distinct sealed runs and reports paired engineering observations", async () => {
    const dataset = freezeVerificationBenchmarkDataset(datasetDraft());
    const baseline = await run(baselineRunId, dataset, 10);
    const candidate = await run(candidateRunId, dataset, 20);
    const input = comparisonInput(dataset, baseline, candidate);
    const first = compareVerificationBenchmarkRuns(input);
    const second = compareVerificationBenchmarkRuns(input);

    expect(first).toEqual(second);
    expect(first.baseline.armId).toBe(first.candidate.armId);
    expect(first.metrics.engineering_expectation_agreement).toMatchObject({
      denominator: 30,
      baseline: { successes: 10, denominator: 30 },
      candidate: { successes: 20, denominator: 30 },
      delta: 0.333333333333,
      regressionObservation: "observed_improvement",
      clusterBootstrap: { clusters: 3, cases: 30, resamples: 100, seed: 23 },
    });
    expect(first.metrics.field_mechanics).toMatchObject({
      denominator: 30,
      baseline: { successes: 15 },
      candidate: { successes: 15 },
      delta: 0,
    });
    expect(first.pairing).toMatchObject({
      clusterUnit: "source_family",
      clusterCount: 3,
      clusterIndependenceAssessed: false,
      repetitionCount: 1,
    });
    expect(first.inference).toMatchObject({
      correction: "holm",
      hypothesisFamily: "paired_engineering_expectation_dimensions.v1",
      configuredResamples: 100,
      wilsonIntervalStatus: "nominal_descriptive",
      wilsonIndependenceAssumption: "unverified_clustered_replay_observations",
    });
    expect(first.inference.tests).toHaveLength(18);
    expect(first.recordedObservations).toMatchObject({
      baselineUniqueCount: 1,
      candidateUniqueCount: 1,
      sharedCount: 1,
      independenceClaim: false,
    });
    expect(first.claimScope).toMatchObject({
      humanGoldCaseCount: 0,
      humanGoldQualityClaim: false,
      populationInferenceClaim: false,
      promotionClaim: false,
      calibrationClaim: false,
    });
    expect(first.comparisonDigest).toBe(
      verificationBenchmarkDigest(
        Object.fromEntries(Object.entries(first).filter(([key]) => key !== "comparisonDigest")),
      ),
    );
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("allows distinct identical replay runs to produce a zero engineering change", async () => {
    const dataset = freezeVerificationBenchmarkDataset(datasetDraft());
    const baseline = await run(baselineRunId, dataset, 12);
    const candidate = await run(candidateRunId, dataset, 12);
    const result = compareVerificationBenchmarkRuns(
      comparisonInput(dataset, baseline, candidate, { correction: "none", clusterUnit: "report_cluster" }),
    );
    expect(result.metrics.engineering_expectation_agreement).toMatchObject({
      delta: 0,
      regressionObservation: "no_observed_change",
    });
    expect(result.pairing).toMatchObject({
      clusterUnit: "report_cluster",
      clusterCount: 6,
      clusterIndependenceAssessed: false,
    });
    expect(result.inference.tests.every((test) => test.adjustedPValue === test.pValue)).toBe(true);
  });

  it("uses code-unit cluster ordering so Unicode labels cannot make seeded output locale-dependent", async () => {
    const base = datasetDraft();
    const cases = base.cases.map((testCase, index) => ({
      ...testCase,
      sourceFamily: index < 15 ? "ä-source" : "z-source",
    }));
    const dataset = freezeVerificationBenchmarkDataset(datasetDraft({ cases }));
    const baseline = await run(baselineRunId, dataset, 10);
    const candidate = await run(candidateRunId, dataset, 20);
    const result = compareVerificationBenchmarkRuns(comparisonInput(dataset, baseline, candidate));
    expect(result.pairing.clusters.map((cluster) => cluster.clusterId)).toEqual(["z-source", "ä-source"]);
  });

  it("rejects the exact same run identity instead of manufacturing a cross-run composite", async () => {
    const dataset = freezeVerificationBenchmarkDataset(datasetDraft());
    const value = await run(baselineRunId, dataset, 10);
    expectCode(
      () => compareVerificationBenchmarkRuns(comparisonInput(dataset, value, value)),
      "BENCHMARK_COMPARISON_SELF_COMPARISON",
    );
  });

  it("distinguishes full case digest drift from dataset-level semantic drift", async () => {
    const baselineDataset = freezeVerificationBenchmarkDataset(datasetDraft());
    const changedCases = datasetDraft().cases.map((testCase, index) =>
      index === 0 ? { ...testCase, assertion: "Changed assertion" } : testCase,
    );
    const caseDriftDataset = freezeVerificationBenchmarkDataset(datasetDraft({ cases: changedCases }));
    const metadataDriftDataset = freezeVerificationBenchmarkDataset(datasetDraft({ sourcePreparationDigest: digestB }));
    const baseline = await run(baselineRunId, baselineDataset, 10);
    const caseDrift = await run(candidateRunId, caseDriftDataset, 10);
    const metadataDrift = await run(candidateRunId, metadataDriftDataset, 10);

    expectCode(
      () =>
        compareVerificationBenchmarkRuns({
          ...comparisonInput(baselineDataset, baseline, caseDrift),
          candidate: { dataset: caseDriftDataset, run: caseDrift, armId: "candidate" },
        }),
      "BENCHMARK_COMPARISON_CASE_DIGEST_MATRIX_MISMATCH",
    );
    expectCode(
      () =>
        compareVerificationBenchmarkRuns({
          ...comparisonInput(baselineDataset, baseline, metadataDrift),
          candidate: { dataset: metadataDriftDataset, run: metadataDrift, armId: "candidate" },
        }),
      "BENCHMARK_COMPARISON_DATASET_SEMANTIC_DIGEST_MISMATCH",
    );
  });

  it("attributes checkpoint mutation to the candidate payload before calculation", async () => {
    const dataset = freezeVerificationBenchmarkDataset(datasetDraft());
    const baseline = await run(baselineRunId, dataset, 10);
    const original = await run(candidateRunId, dataset, 20);
    const { manifestDigest: _ignored, ...originalMaterial } = original;
    const material = {
      ...originalMaterial,
      results: [{ ...original.results[0]!, policy: "fail" as const }, ...original.results.slice(1)],
    };
    const candidate: VerificationBenchmarkRun = { ...material, manifestDigest: verificationBenchmarkDigest(material) };
    expectCode(
      () => compareVerificationBenchmarkRuns(comparisonInput(dataset, baseline, candidate)),
      "BENCHMARK_COMPARISON_RUN_CHECKPOINT_INVALID",
      "candidate",
    );
  });

  it("distinguishes a correctly rehashed checkpoint with the wrong run context", async () => {
    const dataset = freezeVerificationBenchmarkDataset(datasetDraft());
    const baseline = await run(baselineRunId, dataset, 10);
    const original = await run(candidateRunId, dataset, 20);
    const { checkpointDigest: _checkpointDigest, ...originalCheckpoint } = original.results[0]!;
    const checkpointMaterial = { ...originalCheckpoint, checkpointContextDigest: digestB };
    const changedCheckpoint = {
      ...checkpointMaterial,
      checkpointDigest: verificationBenchmarkDigest(checkpointMaterial),
    };
    const { manifestDigest: _manifestDigest, ...originalMaterial } = original;
    const runMaterial = { ...originalMaterial, results: [changedCheckpoint, ...original.results.slice(1)] };
    const candidate: VerificationBenchmarkRun = {
      ...runMaterial,
      manifestDigest: verificationBenchmarkDigest(runMaterial),
    };
    expectCode(
      () => compareVerificationBenchmarkRuns(comparisonInput(dataset, baseline, candidate)),
      "BENCHMARK_COMPARISON_RUN_CHECKPOINT_CONTEXT_INVALID",
      "candidate",
    );
  });

  it("rejects repeated runs with an explicit typed inference limitation", async () => {
    const dataset = freezeVerificationBenchmarkDataset(datasetDraft());
    const baseline = await run(baselineRunId, dataset, 10, 2);
    const candidate = await run(candidateRunId, dataset, 20, 2);
    try {
      compareVerificationBenchmarkRuns(comparisonInput(dataset, baseline, candidate));
      throw new Error("EXPECTED_COMPARISON_ERROR");
    } catch (error) {
      expect(error).toMatchObject({
        code: "BENCHMARK_COMPARISON_REPETITION_ONE_REQUIRED",
        limitation: expect.stringContaining("nested case/repetition/cluster inference"),
      });
    }
  });

  it("rejects online payloads and missing selected arm IDs with side attribution", async () => {
    const dataset = freezeVerificationBenchmarkDataset(datasetDraft());
    const baseline = await run(baselineRunId, dataset, 10);
    const onlineCandidate = await run(candidateRunId, dataset, 20, 1, "allow_listed_providers");
    expectCode(
      () => compareVerificationBenchmarkRuns(comparisonInput(dataset, baseline, onlineCandidate)),
      "BENCHMARK_COMPARISON_OFFLINE_RUN_REQUIRED",
      "candidate",
    );
    const offlineCandidate = await run(candidateRunId, dataset, 20);
    expectCode(
      () =>
        compareVerificationBenchmarkRuns({
          ...comparisonInput(dataset, baseline, offlineCandidate),
          candidate: { dataset, run: offlineCandidate, armId: "absent" },
        }),
      "BENCHMARK_COMPARISON_ARM_NOT_FOUND",
      "candidate",
    );
  });
});
