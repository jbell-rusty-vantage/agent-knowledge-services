import { describe, expect, it, vi } from "vitest";
import type {
  VerificationArtifactHandle,
  VerificationBenchmarkComparisonProfile,
  VerificationBenchmarkDataset,
  VerificationBenchmarkPublicationManifest,
} from "@aiengineer/knowledge-contracts";
import {
  createVerificationBenchmarkCheckpointPlan,
  freezeVerificationBenchmarkDataset,
  MemoryVerificationBenchmarkCheckpointStore,
  runVerificationBenchmark,
  summarizeVerificationBenchmark,
  verificationBenchmarkDigest,
  type DraftVerificationBenchmarkDataset,
  type VerificationBenchmarkRun,
} from "@aiengineer/knowledge-evaluation";
import { canonicalizeJson, sha256Digest, type TrustedArtifactResolver } from "@aiengineer/knowledge-verification";
import {
  assertPreparedVerificationBenchmarkComparison,
  VerificationBenchmarkComparisonApplicationService,
  VerificationBenchmarkComparisonProfileCatalog,
} from "./verification-benchmark-comparison.js";
import type {
  VerifiedBenchmarkPublicationReadPort,
  VerifiedBenchmarkPublicationReadSnapshot,
} from "./verification-benchmark-reads.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const tenantId = id(1),
  baselineRunId = id(2),
  candidateRunId = id(3),
  now = "2026-09-06T00:00:00.000Z";
const digestA = `sha256:${"a".repeat(64)}` as const;
const encoder = new TextEncoder();

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
    configurationDigest: digestA,
    cachePolicy: "exact_request_only" as const,
    replicas: 1,
  },
];

function draft(clusterEveryCase = false): DraftVerificationBenchmarkDataset {
  return {
    schemaVersion: "verification-benchmark.v1",
    verificationContractVersion: "verification.v1",
    datasetId: "comparison-application-fixture",
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
      inputManifestArtifactId: id(10),
      goldArtifactId: null,
      modality: "html" as const,
      sourceFamily: `source-${clusterEveryCase ? index : Math.floor(index / 10)}`,
      entityFamily: `entity-${index}`,
      reportCluster: `report-${Math.floor(index / 5)}`,
      pairCluster: `pair-${index}`,
      tags: ["fixture"],
      adversarialTransforms: [],
      assertion: `Claim ${index}`,
      evidence: [
        {
          fragmentId: `fragment-${index}`,
          captureId: id(10),
          sourceKey: `source-${index}`,
          sourceClass: "first_party",
          projectionArtifactId: id(10),
          projectionDigest: digestA,
          transformationArtifactId: id(10),
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
        rationale: "Engineering fixture.",
      },
      independentObservation: false,
      humanGoldScoringEligible: false,
      adjudicationId: null,
    })),
  };
}

async function benchmarkRun(
  runId: string,
  dataset: VerificationBenchmarkDataset,
  correctByArm: Readonly<Record<string, number>>,
): Promise<VerificationBenchmarkRun> {
  return runVerificationBenchmark({
    runId,
    dataset,
    experimentDefinitionDigest: digestA,
    arms,
    repetitions: 1,
    randomSeed: 19,
    networkPolicy: "offline",
    checkpoints: new MemoryVerificationBenchmarkCheckpointStore(),
    now: () => now,
    execute: async ({ arm, testCase }) => {
      const agrees = Number(testCase.caseId.slice(-2)) < (correctByArm[arm.armId] ?? 0);
      return {
        schemaValid: true,
        locatorValid: true,
        fieldMechanics: true,
        support: testCase.expectation.support,
        authority: testCase.expectation.authority,
        worldCorrectness: testCase.expectation.worldCorrectness,
        policy: agrees ? testCase.expectation.expectedPolicy : ("review" as const),
        confidence: null,
        confidenceCalibrated: false,
        failureClass: "none" as const,
        callAttributions: [],
      };
    },
  });
}

function handle(artifactId: string, bytes: Uint8Array): VerificationArtifactHandle {
  return {
    artifactId,
    tenantId,
    digest: sha256Digest(bytes),
    mediaType: "application/json",
    byteLength: bytes.byteLength,
    objectKey: `private/${artifactId}`,
    createdAt: now,
    producerActivityId: "comparison-fixture",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted",
    parentArtifactIds: [],
  };
}
function placeholder(value: number): VerificationArtifactHandle {
  return handle(id(value), encoder.encode(`artifact-${value}`));
}

function publication(
  run: VerificationBenchmarkRun,
  dataset: VerificationBenchmarkDataset,
  datasetArtifact: VerificationArtifactHandle,
  runnerArtifact: VerificationArtifactHandle,
  offset: number,
): VerifiedBenchmarkPublicationReadSnapshot {
  const summaries = summarizeVerificationBenchmark(dataset, run);
  const plan = createVerificationBenchmarkCheckpointPlan({ ...run, dataset, repetitions: 1 });
  const manifest: VerificationBenchmarkPublicationManifest = {
    schemaVersion: "verification-benchmark-publication.v1",
    verificationContractVersion: "verification.v1",
    tenantId,
    runId: run.runId,
    operationId: id(offset),
    dataset: {
      artifact: datasetArtifact,
      datasetId: id(offset + 1),
      datasetVersionId: id(offset + 2),
      version: dataset.version,
      caseCount: dataset.cases.length,
      manifestDigest: dataset.manifestDigest,
      labelProvenance: "engineering_expectations",
    },
    experiment: {
      artifact: { ...placeholder(offset + 3), digest: digestA },
      experimentId: id(offset + 4),
      runnerVersion: "verification-benchmark-runner.v1",
      randomSeed: run.randomSeed,
      repetitions: 1,
    },
    runnerPayload: runnerArtifact,
    runnerManifestDigest: run.manifestDigest,
    checkpointPlanDigest: plan.planDigest,
    summaryArtifact: placeholder(offset + 5),
    provenanceArtifact: placeholder(offset + 6),
    arms: run.arms.map((arm, index) => ({
      armId: arm.armId,
      experimentArmId: id(offset + 10 + index * 4),
      evalRunId: id(offset + 11 + index * 4),
      configurationArtifact: placeholder(offset + 12 + index * 4),
      policyArtifact: placeholder(offset + 13 + index * 4),
      isControl: arm.control,
      terminalStatus: "review" as const,
      dispositionBasis: "source_authority_unassessed" as const,
      summaryDigest: verificationBenchmarkDigest(summaries.find((summary) => summary.armId === arm.armId)!),
    })),
    runtime: {
      deploymentId: "fixture",
      attemptId: id(offset + 30),
      capabilityVersion: "v1",
      targetCodeRef: "fixture",
      gitSha: "fixture",
      dirty: false,
    },
    execution: { mode: "offline_recorded", externalProviderRequests: 0 },
    qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    seal: {
      payloadDigest: digestA,
      signature: { algorithm: "Ed25519", keyId: "fixture-key", signatureBase64: `${"A".repeat(86)}==` },
    },
  };
  return { publicationArtifact: placeholder(offset + 40), manifest, signatureStatus: "verified" };
}

function comparisonProfile(
  profileId: "paired_default" | "regression_gate" = "regression_gate",
  overrides: Partial<VerificationBenchmarkComparisonProfile> = {},
): VerificationBenchmarkComparisonProfile {
  return {
    schemaVersion: "verification-benchmark-comparison-profile.v1",
    verificationContractVersion: "verification.v1",
    tenantId,
    profileId,
    version: 1,
    armPairs: [
      { pairId: "control", baselineArmId: "control", candidateArmId: "control" },
      { pairId: "candidate", baselineArmId: "candidate", candidateArmId: "candidate" },
    ],
    clusterUnit: "source_family",
    seed: 29,
    bootstrapReplicates: 100,
    correction: "holm",
    primaryMetric: "engineering_expectation_agreement",
    regressionGate: profileId === "regression_gate" ? { maximumAllowedObservedDecrease: 0.1 } : null,
    ...overrides,
  };
}

async function fixture(
  options: {
    profile?: VerificationBenchmarkComparisonProfile;
    clusterEveryCase?: boolean;
    baselineScores?: Readonly<Record<string, number>>;
    candidateScores?: Readonly<Record<string, number>>;
  } = {},
) {
  const dataset = freezeVerificationBenchmarkDataset(draft(options.clusterEveryCase));
  const baselineRun = await benchmarkRun(
    baselineRunId,
    dataset,
    options.baselineScores ?? { control: 15, candidate: 20 },
  );
  const candidateRun = await benchmarkRun(
    candidateRunId,
    dataset,
    options.candidateScores ?? { control: 15, candidate: 10 },
  );
  const datasetBytes = encoder.encode(canonicalizeJson(dataset)),
    baselineBytes = encoder.encode(canonicalizeJson(baselineRun)),
    candidateBytes = encoder.encode(canonicalizeJson(candidateRun));
  const datasetArtifact = handle(id(100), datasetBytes),
    baselineArtifact = handle(id(101), baselineBytes),
    candidateArtifact = handle(id(102), candidateBytes);
  const profile = options.profile ?? comparisonProfile(),
    profileBytes = encoder.encode(canonicalizeJson(profile)),
    profileArtifact = handle(id(103), profileBytes);
  const baselinePublication = publication(baselineRun, dataset, datasetArtifact, baselineArtifact, 200),
    candidatePublication = publication(candidateRun, dataset, datasetArtifact, candidateArtifact, 300);
  const artifacts = new Map([
    [profileArtifact.artifactId, { registration: profileArtifact, bytes: profileBytes }],
    [datasetArtifact.artifactId, { registration: datasetArtifact, bytes: datasetBytes }],
    [baselineArtifact.artifactId, { registration: baselineArtifact, bytes: baselineBytes }],
    [candidateArtifact.artifactId, { registration: candidateArtifact, bytes: candidateBytes }],
  ]);
  const hydrationIds: string[] = [];
  const createResolver = (): TrustedArtifactResolver => {
    let ticket: string | undefined;
    return {
      authorizeArtifact: vi.fn(async ({ tenantId: requestedTenant, artifactId }) => {
        if (requestedTenant !== tenantId || !artifacts.has(artifactId)) throw new Error("DENIED");
        ticket = artifactId;
      }),
      hydrateRegisteredArtifact: vi.fn(async ({ tenantId: requestedTenant, artifactId }) => {
        if (requestedTenant !== tenantId || ticket !== artifactId) throw new Error("NO_TICKET");
        hydrationIds.push(artifactId);
        return structuredClone(artifacts.get(artifactId)!);
      }),
    };
  };
  const publications: VerifiedBenchmarkPublicationReadPort = {
    loadVerifiedBenchmarkPublication: vi.fn(async (_tenant, runId) =>
      runId === baselineRunId
        ? structuredClone(baselinePublication)
        : runId === candidateRunId
          ? structuredClone(candidatePublication)
          : Promise.reject(new Error("NOT_FOUND")),
    ),
  };
  const catalog = new VerificationBenchmarkComparisonProfileCatalog([
    {
      tenantId,
      profileId: profile.profileId,
      artifact: { artifactId: profileArtifact.artifactId, digest: profileArtifact.digest },
    },
  ]);
  const service = new VerificationBenchmarkComparisonApplicationService({ publications, createResolver, catalog });
  const request = {
    verificationContractVersion: "verification.v1",
    baselineRunId,
    candidateRunId,
    comparisonProfile: profile.profileId,
  };
  return {
    service,
    request,
    publications,
    artifacts,
    hydrationIds,
    profile,
    profileArtifact,
    baselinePublication,
    candidatePublication,
  };
}

describe("registered verification benchmark comparison application", () => {
  it("hydrates trusted inputs, applies one global Holm family and returns a branded engineering-only failed gate", async () => {
    const value = await fixture();
    const prepared = await value.service.prepare({ tenantId, request: value.request });
    expect(prepared.result.pairComparisons).toHaveLength(2);
    expect(prepared.result.pairComparisons.every((pair) => pair.comparison.inference.correction === "none")).toBe(true);
    expect(prepared.result.globalInference).toMatchObject({
      correction: "holm",
      hypothesisFamily: "registered_profile_pair_metric_tests.v1",
    });
    expect(prepared.result.globalInference.tests).toHaveLength(36);
    expect(prepared.result.engineeringRegressionGate).toMatchObject({
      outcome: "fail",
      primaryMetric: "engineering_expectation_agreement",
      maximumAllowedObservedDecrease: 0.1,
      maximumObservedDecrease: 0.333333333333,
      interpretation: "observed_engineering_threshold_only",
    });
    expect(prepared.result.claimScope).toMatchObject({
      humanGoldQualityClaim: false,
      populationInferenceClaim: false,
      promotionClaim: false,
      calibrationClaim: false,
      sourceAuthorityAssessmentClaim: false,
      clinicalClaim: false,
    });
    expect(prepared.result.resultDigest).toBe(
      verificationBenchmarkDigest(
        Object.fromEntries(Object.entries(prepared.result).filter(([key]) => key !== "resultDigest")),
      ),
    );
    expect(value.hydrationIds).toEqual([value.profileArtifact.artifactId, id(100), id(101), id(100), id(102)]);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(() =>
      assertPreparedVerificationBenchmarkComparison(prepared, { tenantId, request: value.request }),
    ).not.toThrow();
    expect(() =>
      assertPreparedVerificationBenchmarkComparison(structuredClone(prepared), { tenantId, request: value.request }),
    ).toThrow("BENCHMARK_COMPARISON_PREPARATION_IDENTITY_MISMATCH");
    expect(() =>
      assertPreparedVerificationBenchmarkComparison(prepared, {
        tenantId,
        request: { ...value.request, comparisonProfile: "paired_default" },
      }),
    ).toThrow("BENCHMARK_COMPARISON_PREPARATION_IDENTITY_MISMATCH");
  });

  it("returns not_requested for the registered paired profile even when an observed decrease exists", async () => {
    const value = await fixture({ profile: comparisonProfile("paired_default") });
    const prepared = await value.service.prepare({ tenantId, request: value.request });
    expect(prepared.result.engineeringRegressionGate).toMatchObject({
      outcome: "not_requested",
      maximumAllowedObservedDecrease: null,
      maximumObservedDecrease: 0.333333333333,
    });
  });

  it("passes only the registered observed engineering threshold without creating a promotion claim", async () => {
    const value = await fixture({
      profile: comparisonProfile("regression_gate", { regressionGate: { maximumAllowedObservedDecrease: 0.34 } }),
    });
    const prepared = await value.service.prepare({ tenantId, request: value.request });
    expect(prepared.result.engineeringRegressionGate).toMatchObject({
      outcome: "pass",
      maximumAllowedObservedDecrease: 0.34,
      maximumObservedDecrease: 0.333333333333,
    });
    expect(prepared.result.claimScope.promotionClaim).toBe(false);
  });

  it("does not treat an unregistered public profile name as authority", async () => {
    const value = await fixture({ profile: comparisonProfile("paired_default") });
    await expect(
      value.service.prepare({ tenantId, request: { ...value.request, comparisonProfile: "regression_gate" } }),
    ).rejects.toThrow("BENCHMARK_COMPARISON_PROFILE_TRUSTED_GRANT_REQUIRED");
    expect(value.publications.loadVerifiedBenchmarkPublication).not.toHaveBeenCalled();
  });

  it("rejects changed profile bytes under the trusted artifact identity before publication reads", async () => {
    const value = await fixture();
    value.artifacts.get(value.profileArtifact.artifactId)!.bytes = encoder.encode("{}");
    await expect(value.service.prepare({ tenantId, request: value.request })).rejects.toThrow(
      "BENCHMARK_COMPARISON_PROFILE_ARTIFACT_BINDING_INVALID",
    );
    expect(value.publications.loadVerifiedBenchmarkPublication).not.toHaveBeenCalled();
  });

  it("rejects changed dataset bytes under the signed publication handle before parsing", async () => {
    const value = await fixture();
    value.artifacts.get(id(100))!.bytes = encoder.encode("{}");
    await expect(value.service.prepare({ tenantId, request: value.request })).rejects.toThrow(
      "BENCHMARK_COMPARISON_BASELINE_DATASET_ARTIFACT_BINDING_INVALID",
    );
  });

  it("rejects signed-publication checkpoint-plan drift before invoking the kernel", async () => {
    const value = await fixture();
    const drifted = structuredClone(value.candidatePublication);
    drifted.manifest.checkpointPlanDigest = sha256Digest("changed-plan");
    vi.mocked(value.publications.loadVerifiedBenchmarkPublication).mockImplementation(async (_tenant, runId) =>
      runId === baselineRunId ? value.baselinePublication : drifted,
    );
    await expect(value.service.prepare({ tenantId, request: value.request })).rejects.toThrow(
      "BENCHMARK_COMPARISON_CANDIDATE_CHECKPOINT_PLAN_BINDING_INVALID",
    );
  });

  it("rejects profile arm drift with the exact declared pair", async () => {
    const profile = comparisonProfile("paired_default", {
      armPairs: [{ pairId: "missing-pair", baselineArmId: "candidate", candidateArmId: "missing" }],
    });
    const value = await fixture({ profile });
    await expect(value.service.prepare({ tenantId, request: value.request })).rejects.toThrow(
      "BENCHMARK_COMPARISON_PROFILE_ARM_BINDING_INVALID:missing-pair",
    );
  });

  it("bounds aggregate bootstrap and sign-flip work across all declared pairs before calculation", async () => {
    const profile = comparisonProfile("paired_default", {
      bootstrapReplicates: 10_000,
      armPairs: [
        { pairId: "cc", baselineArmId: "control", candidateArmId: "control" },
        { pairId: "ca", baselineArmId: "control", candidateArmId: "candidate" },
        { pairId: "ac", baselineArmId: "candidate", candidateArmId: "control" },
        { pairId: "aa", baselineArmId: "candidate", candidateArmId: "candidate" },
      ],
    });
    const value = await fixture({ profile, clusterEveryCase: true });
    await expect(value.service.prepare({ tenantId, request: value.request })).rejects.toThrow(
      "BENCHMARK_COMPARISON_STATISTIC_WORK_BOUND_EXCEEDED",
    );
  });

  it("checks cancellation after publication I/O before loading candidate state", async () => {
    const value = await fixture(),
      controller = new AbortController();
    vi.mocked(value.publications.loadVerifiedBenchmarkPublication).mockImplementation(async (_tenant, runId) => {
      if (runId === baselineRunId) controller.abort();
      return runId === baselineRunId ? value.baselinePublication : value.candidatePublication;
    });
    await expect(
      value.service.prepare({ tenantId, request: value.request, signal: controller.signal }),
    ).rejects.toThrow("BENCHMARK_CANCELLED");
    expect(value.publications.loadVerifiedBenchmarkPublication).toHaveBeenCalledTimes(1);
  });
});
