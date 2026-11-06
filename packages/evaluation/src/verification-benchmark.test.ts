import { describe, expect, it, vi } from "vitest";
import {
  MemoryVerificationBenchmarkCheckpointStore,
  admitVerificationBenchmarkHumanGold,
  assertFrozenVerificationBenchmarkDataset,
  buildVerificationAnnotationQueue,
  compareVerificationBenchmarkArms,
  diffVerificationBenchmarkDatasets,
  freezeVerificationBenchmarkDataset,
  runVerificationBenchmark,
  summarizeVerificationBenchmark,
  verificationBenchmarkDigest,
} from "./verification-benchmark.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const uuid = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-06T00:00:00.000Z";
const draft = (version = 1, supersedesManifestDigest: `sha256:${string}` | null = null) => ({
  schemaVersion: "verification-benchmark.v1" as const,
  verificationContractVersion: "verification.v1" as const,
  datasetId: "diagnostics",
  version,
  stage: "pilot" as const,
  frozen: true as const,
  supersedesManifestDigest,
  sourcePreparationDigest: digest,
  labelProvenance: "engineering_expectations" as const,
  annotationGuidelinesDigest: digest,
  adjudicationArtifactDigest: null,
  createdAt: now,
  sealedAt: now,
  cases: Array.from({ length: 30 }, (_, index) => ({
    schemaVersion: "verification-benchmark.v1" as const,
    caseId: `case-${index}`,
    partition: "development" as const,
    inputManifestArtifactId: uuid,
    goldArtifactId: null,
    modality: "html" as const,
    sourceFamily: `source-${index}`,
    entityFamily: `entity-${index}`,
    reportCluster: `report-${index}`,
    pairCluster: `pair-${index}`,
    tags: ["fixture"],
    adversarialTransforms: [],
    assertion: `Claim ${index}`,
    evidence: [
      {
        fragmentId: `fragment-${index}`,
        captureId: uuid,
        sourceKey: `source-${index}`,
        sourceClass: "first_party",
        projectionArtifactId: uuid,
        projectionDigest: digest,
        transformationArtifactId: uuid,
        selector: { kind: "html" as const, domPath: `1/${index}` },
        selectedContentDigest: digest,
        excerpt: `Claim ${index}`,
        rights: "restricted test fixture",
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
      rationale: "Fixture expectation.",
    },
    independentObservation: true,
    humanGoldScoringEligible: false,
    adjudicationId: null,
  })),
});
const arms = [
  {
    armId: "baseline",
    name: "Baseline",
    control: true,
    strategy: "baseline" as const,
    extractorProfile: "deterministic",
    parserProfile: "frozen",
    retrieverProfile: "bound",
    judgeProfile: "rules",
    policyVersion: "v1",
    configurationDigest: digest,
    cachePolicy: "disabled" as const,
    replicas: 1,
  },
  {
    armId: "candidate",
    name: "Candidate",
    control: false,
    strategy: "cascade" as const,
    extractorProfile: "candidate",
    parserProfile: "frozen",
    retrieverProfile: "bound",
    judgeProfile: "rules",
    policyVersion: "v1",
    configurationDigest: digest,
    cachePolicy: "exact_request_only" as const,
    replicas: 1,
  },
];

describe("verification benchmark", () => {
  it("keeps one run manifest across interruption and later clock changes with a durable lifecycle", async () => {
    const dataset = freezeVerificationBenchmarkDataset(draft()),
      store = new MemoryVerificationBenchmarkCheckpointStore();
    let tick = Date.parse(now),
      completion: string | undefined;
    const clock = () => new Date(++tick).toISOString();
    const lifecycle = { startedAt: now, complete: vi.fn(async () => (completion ??= clock())) };
    const controller = new AbortController();
    const execute = vi.fn(async () => ({
      schemaValid: true,
      locatorValid: true,
      fieldMechanics: true,
      support: "full" as const,
      authority: "interested_party_only" as const,
      worldCorrectness: "not_established" as const,
      policy: "abstain" as const,
      confidence: null,
      confidenceCalibrated: false,
      failureClass: "none" as const,
      callAttributions: [],
    }));
    const options = {
      runId: uuid,
      dataset,
      experimentDefinitionDigest: digest,
      arms,
      repetitions: 1,
      randomSeed: 7,
      networkPolicy: "offline" as const,
      execute,
      lifecycle,
      now: clock,
    };
    await expect(
      runVerificationBenchmark({
        ...options,
        signal: controller.signal,
        checkpoints: {
          load: (key) => store.load(key),
          save: async (key, result) => {
            await store.save(key, result);
            controller.abort();
          },
        },
      }),
    ).rejects.toThrow("BENCHMARK_CANCELLED");
    expect(lifecycle.complete).not.toHaveBeenCalled();
    const completed = await runVerificationBenchmark({ ...options, checkpoints: store });
    tick += 60_000;
    const resumed = await runVerificationBenchmark({
      ...options,
      checkpoints: store,
      now: () => {
        throw new Error("REPLAY_MUST_REUSE_RETAINED_TIMES");
      },
    });
    expect(resumed).toEqual(completed);
    expect(resumed.startedAt).toBe(now);
    expect(execute).toHaveBeenCalledTimes(60);
    expect(lifecycle.complete).toHaveBeenCalledTimes(2);
  });

  it.each(["lease-lost", "cancelled", "backwards"])(
    "does not publish a run when lifecycle completion is %s",
    async (mode) => {
      const controller = new AbortController();
      const lifecycle = {
        startedAt: now,
        complete: async () => {
          if (mode === "lease-lost") throw new Error("LEASE_LOST");
          if (mode === "cancelled") controller.abort("private reason");
          return mode === "backwards" ? new Date(Date.parse(now) - 1).toISOString() : now;
        },
      };
      const execute = async () => ({
        schemaValid: true,
        locatorValid: true,
        fieldMechanics: true,
        support: "full" as const,
        authority: "interested_party_only" as const,
        worldCorrectness: "not_established" as const,
        policy: "abstain" as const,
        confidence: null,
        confidenceCalibrated: false,
        failureClass: "none" as const,
        callAttributions: [],
      });
      await expect(
        runVerificationBenchmark({
          runId: uuid,
          dataset: freezeVerificationBenchmarkDataset(draft()),
          experimentDefinitionDigest: digest,
          arms,
          repetitions: 1,
          randomSeed: 7,
          networkPolicy: "offline",
          checkpoints: new MemoryVerificationBenchmarkCheckpointStore(),
          execute,
          now: () => now,
          lifecycle,
          signal: controller.signal,
        }),
      ).rejects.toThrow(
        mode === "lease-lost"
          ? "LEASE_LOST"
          : mode === "cancelled"
            ? "BENCHMARK_CANCELLED"
            : "BENCHMARK_RUN_TIMING_INVALID",
      );
    },
  );

  it.each(["before", "load", "execute", "save"])(
    "propagates cancellation at %s without completing a benchmark",
    async (stage) => {
      const controller = new AbortController();
      const checkpoints = {
        load: vi.fn(async () => {
          if (stage === "load") controller.abort("private reason");
          return undefined;
        }),
        save: vi.fn(async () => {
          if (stage === "save") controller.abort("private reason");
        }),
      };
      const execute = vi.fn(async () => {
        if (stage === "execute") {
          controller.abort("private reason");
          throw new Error("private cancellation detail");
        }
        return {
          schemaValid: true,
          locatorValid: true,
          fieldMechanics: true,
          support: "full" as const,
          authority: "interested_party_only" as const,
          worldCorrectness: "not_established" as const,
          policy: "abstain" as const,
          confidence: null,
          confidenceCalibrated: false,
          failureClass: "none" as const,
          callAttributions: [],
        };
      });
      if (stage === "before") controller.abort("private reason");
      await expect(
        runVerificationBenchmark({
          runId: uuid,
          dataset: freezeVerificationBenchmarkDataset(draft()),
          experimentDefinitionDigest: digest,
          arms,
          repetitions: 1,
          randomSeed: 7,
          networkPolicy: "offline",
          checkpoints,
          execute,
          now: () => now,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/^BENCHMARK_CANCELLED$/);
      if (stage === "before") expect(checkpoints.load).not.toHaveBeenCalled();
      if (stage === "before" || stage === "load") expect(execute).not.toHaveBeenCalled();
      if (stage !== "save") expect(checkpoints.save).not.toHaveBeenCalled();
      else {
        expect(checkpoints.save).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("seals case and manifest digests and detects mutation", () => {
    const dataset = freezeVerificationBenchmarkDataset(draft());
    assertFrozenVerificationBenchmarkDataset(dataset);
    expect(dataset.cases).toHaveLength(30);
    expect(() =>
      assertFrozenVerificationBenchmarkDataset({
        ...dataset,
        cases: [{ ...dataset.cases[0]!, assertion: "changed" }, ...dataset.cases.slice(1)],
      }),
    ).toThrow("BENCHMARK_CASE_DIGEST_MISMATCH");
  });

  it("rejects group leakage and exposes a concrete human review queue", () => {
    const input: any = draft();
    input.cases[1] = { ...input.cases[1]!, sourceFamily: input.cases[0]!.sourceFamily, partition: "locked_test" };
    expect(() => freezeVerificationBenchmarkDataset(input)).toThrow();
    const queue = buildVerificationAnnotationQueue(freezeVerificationBenchmarkDataset(draft()), [], []);
    expect(queue).toHaveLength(30);
    expect(queue.every((item) => item.status === "awaiting_human_annotations")).toBe(true);
  });

  it("runs resumably and keeps metric dimensions and human-gold eligibility separate", async () => {
    const dataset = freezeVerificationBenchmarkDataset(draft()),
      checkpoints = new MemoryVerificationBenchmarkCheckpointStore();
    let executions = 0;
    const execute = async ({ testCase }: { testCase: (typeof dataset.cases)[number] }) => {
      executions++;
      return {
        schemaValid: true,
        locatorValid: true,
        fieldMechanics: true,
        support: testCase.expectation.support,
        authority: testCase.expectation.authority,
        worldCorrectness: testCase.expectation.worldCorrectness,
        policy: testCase.expectation.expectedPolicy,
        confidence: null,
        confidenceCalibrated: false,
        failureClass: "none" as const,
        callAttributions: [],
      };
    };
    const options = {
      runId: uuid,
      dataset,
      experimentDefinitionDigest: digest,
      arms,
      repetitions: 1,
      randomSeed: 7,
      networkPolicy: "offline" as const,
      checkpoints,
      execute,
      now: () => now,
    };
    const first = await runVerificationBenchmark(options);
    await runVerificationBenchmark(options);
    expect(executions).toBe(60);
    expect(first.results).toHaveLength(60);
    const summary = summarizeVerificationBenchmark(dataset, first);
    expect(summary[0]).toMatchObject({ total: 30, humanGoldDenominator: 0, qualityClaimEligible: false });
    expect(summary[0]!.locatorResolutionValidity.estimate).toBe(1);
    expect(summary[0]!.locatorExpectationAgreement.estimate).toBe(1);
    expect(summary[0]!.supportAgreement.estimate).toBe(1);
    const comparison = compareVerificationBenchmarkArms(dataset, first, "baseline", "candidate", {
      seed: 3,
      resamples: 100,
    });
    expect(comparison.humanGoldEligible).toBe(false);
    expect(comparison.mcnemar.pValue).toBe(1);
    expect(comparison).toMatchObject({
      repetitionCount: 1,
      mcnemarInference: {
        status: "nominal_exploratory",
        independenceAssumption: "unfulfilled_source_correlated_cases",
      },
      clusterBootstrapEstimand: "case_weighted_mean_accuracy_difference_with_source_cluster_resampling",
      pairedClusterSignFlipEstimand: "equal_source_cluster_weighted_mean_accuracy_difference",
    });
  });

  it("diffs immutable successor versions without mutating the predecessor", () => {
    const first = freezeVerificationBenchmarkDataset(draft());
    const nextInput = draft(2, first.manifestDigest as `sha256:${string}`);
    nextInput.cases[0] = { ...nextInput.cases[0]!, assertion: "Revised claim" };
    const second = freezeVerificationBenchmarkDataset(nextInput),
      difference = diffVerificationBenchmarkDatasets(first, second);
    expect(difference.changed).toEqual(["case-0"]);
    expect(first.cases[0]!.assertion).toBe("Claim 0");
    expect(verificationBenchmarkDigest(first)).toMatch(/^sha256:/);
  });

  it("requires authenticated adjudication bytes and source-successor binding for human-gold promotion", () => {
    const source = freezeVerificationBenchmarkDataset(draft());
    const annotations = [
      {
        schemaVersion: "verification-benchmark.v1",
        annotationId: "21111111-1111-4111-8111-111111111111",
        datasetManifestDigest: source.manifestDigest,
        caseId: "case-0",
        annotatorIdentity: "human-a",
        annotatorRole: "human_annotator",
        blindedToOtherAnnotations: true,
        label: "contradicted",
        rationale: "First independent review corrects the coarse label.",
        evidenceFragmentIds: ["fragment-0"],
        createdAt: now,
      },
      {
        schemaVersion: "verification-benchmark.v1",
        annotationId: "31111111-1111-4111-8111-111111111111",
        datasetManifestDigest: source.manifestDigest,
        caseId: "case-0",
        annotatorIdentity: "human-b",
        annotatorRole: "human_annotator",
        blindedToOtherAnnotations: true,
        label: "contradicted",
        rationale: "Second independent review corrects the coarse label.",
        evidenceFragmentIds: ["fragment-0"],
        createdAt: now,
      },
    ];
    const adjudication = {
      schemaVersion: "verification-benchmark.v1",
      adjudicationId: "41111111-1111-4111-8111-111111111111",
      datasetManifestDigest: source.manifestDigest,
      caseId: "case-0",
      expertIdentity: "expert-c",
      annotationIds: annotations.map((item) => item.annotationId),
      finalLabel: "contradicted",
      rationale: "Expert adjudication after two blinded reviews corrects the coarse label.",
      createdAt: now,
    };
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: "verification-benchmark-adjudication-artifact.v1",
        sourceDatasetManifestDigest: source.manifestDigest,
        annotations,
        adjudications: [adjudication],
      }),
    );
    const admission = admitVerificationBenchmarkHumanGold({ sourceDataset: source, adjudicationArtifactBytes: bytes });
    const successor: any = draft(2, source.manifestDigest as `sha256:${string}`);
    successor.labelProvenance = "expert_adjudicated";
    successor.adjudicationArtifactDigest = admission.adjudicationArtifactDigest;
    successor.cases[0] = {
      ...successor.cases[0],
      goldArtifactId: "51111111-1111-4111-8111-111111111111",
      expectation: { ...successor.cases[0].expectation, label: "contradicted", labelStatus: "expert_adjudicated" },
      humanGoldScoringEligible: true,
      humanGoldDimensions: ["label"],
      adjudicationId: adjudication.adjudicationId,
    };
    expect(freezeVerificationBenchmarkDataset(successor, admission).cases[0]).toMatchObject({
      humanGoldScoringEligible: true,
      humanGoldDimensions: ["label"],
      expectation: { label: "contradicted" },
      adjudicationId: adjudication.adjudicationId,
    });
    expect(() =>
      freezeVerificationBenchmarkDataset(successor, {
        adjudicationId: adjudication.adjudicationId,
        caseId: "case-0",
      } as any),
    ).toThrow("BENCHMARK_HUMAN_GOLD_ADMISSION_REQUIRED");
    expect(() =>
      freezeVerificationBenchmarkDataset({ ...successor, supersedesManifestDigest: digest }, admission),
    ).toThrow("BENCHMARK_HUMAN_GOLD_SUCCESSOR_BINDING_INVALID");
  });
});
