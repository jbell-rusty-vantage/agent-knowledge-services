import type {
  VerificationBenchmarkArm,
  VerificationBenchmarkCase,
  VerificationBenchmarkCaseResult,
  VerificationBenchmarkDataset,
} from "@aiengineer/knowledge-contracts";
import { VerificationBenchmarkArmSchema } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  assertFrozenVerificationBenchmarkDataset,
  summarizeVerificationBenchmark,
  verificationBenchmarkDigest,
  type VerificationBenchmarkRun,
} from "./verification-benchmark.js";
import {
  holmAdjustment,
  mcnemarExact,
  pairedClusterBootstrap,
  pairedSignFlipTest,
  wilson95,
} from "./verification-statistics.js";

type Digest = `sha256:${string}`;
export type VerificationBenchmarkComparisonSide = "baseline" | "candidate";
export type VerificationBenchmarkComparisonClusterUnit = "source_family" | "report_cluster";
export type VerificationBenchmarkComparisonCorrection = "none" | "holm";

export type VerificationBenchmarkRunComparisonErrorCode =
  | "BENCHMARK_COMPARISON_OPTIONS_INVALID"
  | "BENCHMARK_COMPARISON_DATASET_INVALID"
  | "BENCHMARK_COMPARISON_RUN_MANIFEST_INVALID"
  | "BENCHMARK_COMPARISON_RUN_ARMS_INVALID"
  | "BENCHMARK_COMPARISON_RUN_CHECKPOINT_INVALID"
  | "BENCHMARK_COMPARISON_RUN_CHECKPOINT_CONTEXT_INVALID"
  | "BENCHMARK_COMPARISON_RUN_RESULT_MATRIX_INVALID"
  | "BENCHMARK_COMPARISON_RUN_TIMING_INVALID"
  | "BENCHMARK_COMPARISON_OFFLINE_RUN_REQUIRED"
  | "BENCHMARK_COMPARISON_ARM_NOT_FOUND"
  | "BENCHMARK_COMPARISON_SELF_COMPARISON"
  | "BENCHMARK_COMPARISON_CASE_DIGEST_MATRIX_MISMATCH"
  | "BENCHMARK_COMPARISON_DATASET_SEMANTIC_DIGEST_MISMATCH"
  | "BENCHMARK_COMPARISON_REPETITION_ONE_REQUIRED"
  | "BENCHMARK_COMPARISON_SELECTED_CASE_MATRIX_MISMATCH";

export class VerificationBenchmarkRunComparisonError extends Error {
  readonly code: VerificationBenchmarkRunComparisonErrorCode;
  readonly side: VerificationBenchmarkComparisonSide | undefined;
  readonly limitation: string | undefined;

  constructor(code: VerificationBenchmarkRunComparisonErrorCode, side?: VerificationBenchmarkComparisonSide) {
    const limitation =
      code === "BENCHMARK_COMPARISON_REPETITION_ONE_REQUIRED"
        ? "Only repetition zero is supported; nested case/repetition/cluster inference is not implemented."
        : undefined;
    super([code, side, limitation].filter((part) => part !== undefined).join(":"));
    this.name = "VerificationBenchmarkRunComparisonError";
    this.code = code;
    this.side = side;
    this.limitation = limitation;
  }
}

export interface VerificationBenchmarkRunComparisonOperand {
  readonly dataset: VerificationBenchmarkDataset;
  readonly run: VerificationBenchmarkRun;
  readonly armId: string;
}

export interface CompareVerificationBenchmarkRunsInput {
  readonly baseline: VerificationBenchmarkRunComparisonOperand;
  readonly candidate: VerificationBenchmarkRunComparisonOperand;
  readonly clusterUnit: VerificationBenchmarkComparisonClusterUnit;
  readonly seed: number;
  readonly resamples: number;
  readonly correction: VerificationBenchmarkComparisonCorrection;
}

export type VerificationBenchmarkEngineeringMetric =
  | "schema_validity"
  | "locator_resolution_validity"
  | "locator_expectation_agreement"
  | "field_mechanics"
  | "support_agreement"
  | "authority_agreement"
  | "world_correctness_agreement"
  | "policy_agreement"
  | "engineering_expectation_agreement";

interface ValidatedOperand {
  readonly dataset: VerificationBenchmarkDataset;
  readonly run: VerificationBenchmarkRun;
  readonly arm: VerificationBenchmarkArm;
  readonly results: readonly VerificationBenchmarkCaseResult[];
}

interface PairedMetricRow {
  readonly caseId: string;
  readonly clusterId: string;
  readonly baseline: number;
  readonly candidate: number;
}

const metricPredicates: Readonly<
  Record<
    VerificationBenchmarkEngineeringMetric,
    (testCase: VerificationBenchmarkCase, result: VerificationBenchmarkCaseResult) => boolean
  >
> = {
  schema_validity: (_testCase, result) => result.schemaValid,
  locator_resolution_validity: (_testCase, result) => result.locatorValid,
  locator_expectation_agreement: (testCase, result) =>
    result.locatorValid === testCase.expectation.expectedLocatorValid,
  field_mechanics: (_testCase, result) => result.fieldMechanics,
  support_agreement: (testCase, result) => result.support === testCase.expectation.support,
  authority_agreement: (testCase, result) => result.authority === testCase.expectation.authority,
  world_correctness_agreement: (testCase, result) => result.worldCorrectness === testCase.expectation.worldCorrectness,
  policy_agreement: (testCase, result) => result.policy === testCase.expectation.expectedPolicy,
  engineering_expectation_agreement: (testCase, result) =>
    result.failureClass === "none" &&
    result.schemaValid &&
    result.locatorValid === testCase.expectation.expectedLocatorValid &&
    result.support === testCase.expectation.support &&
    result.authority === testCase.expectation.authority &&
    result.worldCorrectness === testCase.expectation.worldCorrectness &&
    result.policy === testCase.expectation.expectedPolicy,
};

const metricIds = Object.keys(metricPredicates) as VerificationBenchmarkEngineeringMetric[];
const round = (value: number): number => Number(value.toFixed(12));
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const rate = (successes: number, denominator: number) => ({
  successes,
  denominator,
  ...wilson95(successes, denominator),
  intervalStatus: "nominal_descriptive" as const,
  independenceAssumption: "unverified_clustered_replay_observations" as const,
});
const clusterId = (testCase: VerificationBenchmarkCase, unit: VerificationBenchmarkComparisonClusterUnit): string =>
  unit === "source_family" ? testCase.sourceFamily : testCase.reportCluster;

function fail(code: VerificationBenchmarkRunComparisonErrorCode, side?: VerificationBenchmarkComparisonSide): never {
  throw new VerificationBenchmarkRunComparisonError(code, side);
}

function mapRunValidationError(error: unknown, side: VerificationBenchmarkComparisonSide): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("BENCHMARK_RUN_MANIFEST_INVALID")) fail("BENCHMARK_COMPARISON_RUN_MANIFEST_INVALID", side);
  if (message.includes("BENCHMARK_RUN_ARMS_INVALID")) fail("BENCHMARK_COMPARISON_RUN_ARMS_INVALID", side);
  if (message.includes("BENCHMARK_RUN_RESULT_CONTEXT_INVALID"))
    fail("BENCHMARK_COMPARISON_RUN_CHECKPOINT_CONTEXT_INVALID", side);
  if (message.includes("BENCHMARK_RUN_RESULT_MATRIX_INCOMPLETE"))
    fail("BENCHMARK_COMPARISON_RUN_RESULT_MATRIX_INVALID", side);
  if (message.includes("BENCHMARK_RUN_RESULT_INVALID") || message.includes("Invalid input"))
    fail("BENCHMARK_COMPARISON_RUN_CHECKPOINT_INVALID", side);
  fail("BENCHMARK_COMPARISON_RUN_MANIFEST_INVALID", side);
}

function canonicalTime(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function validateOperand(
  operand: VerificationBenchmarkRunComparisonOperand,
  side: VerificationBenchmarkComparisonSide,
): ValidatedOperand {
  try {
    assertFrozenVerificationBenchmarkDataset(operand.dataset);
  } catch {
    fail("BENCHMARK_COMPARISON_DATASET_INVALID", side);
  }
  try {
    summarizeVerificationBenchmark(operand.dataset, operand.run);
  } catch (error) {
    mapRunValidationError(error, side);
  }
  try {
    for (const arm of operand.run.arms) VerificationBenchmarkArmSchema.parse(arm);
  } catch {
    fail("BENCHMARK_COMPARISON_RUN_ARMS_INVALID", side);
  }
  if (operand.run.networkPolicy !== "offline") fail("BENCHMARK_COMPARISON_OFFLINE_RUN_REQUIRED", side);
  const startedAt = canonicalTime(operand.run.startedAt),
    completedAt = canonicalTime(operand.run.completedAt);
  if (
    startedAt === null ||
    completedAt === null ||
    completedAt < startedAt ||
    operand.run.results.some((result) => {
      const resultTime = canonicalTime(result.completedAt);
      return resultTime === null || resultTime < startedAt || resultTime > completedAt;
    })
  )
    fail("BENCHMARK_COMPARISON_RUN_TIMING_INVALID", side);
  const arm = operand.run.arms.find((item) => item.armId === operand.armId);
  if (!arm) fail("BENCHMARK_COMPARISON_ARM_NOT_FOUND", side);
  return {
    dataset: operand.dataset,
    run: operand.run,
    arm,
    results: operand.run.results.filter((result) => result.armId === arm.armId),
  };
}

function assertOptions(input: CompareVerificationBenchmarkRunsInput): void {
  if (
    !Number.isSafeInteger(input.seed) ||
    input.seed < 0 ||
    input.seed > 0xffffffff ||
    !Number.isSafeInteger(input.resamples) ||
    input.resamples < 100 ||
    input.resamples > 10_000 ||
    !["source_family", "report_cluster"].includes(input.clusterUnit) ||
    !["none", "holm"].includes(input.correction)
  )
    fail("BENCHMARK_COMPARISON_OPTIONS_INVALID");
}

function caseDigestMatrix(dataset: VerificationBenchmarkDataset) {
  return [...dataset.cases]
    .map((testCase) => ({ caseId: testCase.caseId, caseDigest: testCase.caseDigest }))
    .sort((left, right) => compareText(left.caseId, right.caseId));
}

function selectedCaseMatrix(operand: ValidatedOperand): readonly string[] {
  return operand.results.map((result) => `${result.caseId}:${result.repetition}`).sort();
}

function repetitionCount(operand: ValidatedOperand): number {
  return new Set(operand.results.map((result) => result.repetition)).size;
}

function observationKeys(results: readonly VerificationBenchmarkCaseResult[]): Set<Digest> {
  return new Set(
    results.flatMap((result) =>
      result.callAttributions
        .filter((call) => call.responseDigest !== null)
        .map((call) =>
          verificationBenchmarkDigest({
            provider: call.provider,
            model: call.model,
            requestDigest: call.requestDigest,
            responseDigest: call.responseDigest,
          }),
        ),
    ),
  );
}

/**
 * Compares selected arms from two complete, immutable offline replay runs.
 * Authentication, tenant checks, canonical-operation status and signature trust
 * belong to the service boundary that supplies these already verified payloads.
 */
export function compareVerificationBenchmarkRuns(input: CompareVerificationBenchmarkRunsInput) {
  assertOptions(input);
  const baseline = validateOperand(input.baseline, "baseline");
  const candidate = validateOperand(input.candidate, "candidate");
  if (baseline.run.runId === candidate.run.runId) fail("BENCHMARK_COMPARISON_SELF_COMPARISON");

  const baselineCases = caseDigestMatrix(baseline.dataset),
    candidateCases = caseDigestMatrix(candidate.dataset);
  if (verificationBenchmarkDigest(baselineCases) !== verificationBenchmarkDigest(candidateCases))
    fail("BENCHMARK_COMPARISON_CASE_DIGEST_MATRIX_MISMATCH");
  if (baseline.dataset.manifestDigest !== candidate.dataset.manifestDigest)
    fail("BENCHMARK_COMPARISON_DATASET_SEMANTIC_DIGEST_MISMATCH");

  const baselineRepetitions = repetitionCount(baseline),
    candidateRepetitions = repetitionCount(candidate);
  if (
    baselineRepetitions !== 1 ||
    candidateRepetitions !== 1 ||
    baseline.results.some((result) => result.repetition !== 0) ||
    candidate.results.some((result) => result.repetition !== 0)
  )
    fail("BENCHMARK_COMPARISON_REPETITION_ONE_REQUIRED");
  if (
    verificationBenchmarkDigest(selectedCaseMatrix(baseline)) !==
    verificationBenchmarkDigest(selectedCaseMatrix(candidate))
  )
    fail("BENCHMARK_COMPARISON_SELECTED_CASE_MATRIX_MISMATCH");

  const configuredClusterCount = new Set(
    baseline.dataset.cases.map((testCase) => clusterId(testCase, input.clusterUnit)),
  ).size;
  if (configuredClusterCount * input.resamples > 5_000_000) fail("BENCHMARK_COMPARISON_OPTIONS_INVALID");

  const baselineByCase = new Map(baseline.results.map((result) => [result.caseId, result]));
  const candidateByCase = new Map(candidate.results.map((result) => [result.caseId, result]));
  const pairedRows = new Map<VerificationBenchmarkEngineeringMetric, readonly PairedMetricRow[]>();
  for (const metric of metricIds) {
    const predicate = metricPredicates[metric];
    pairedRows.set(
      metric,
      baseline.dataset.cases.map((testCase) => ({
        caseId: testCase.caseId,
        clusterId: clusterId(testCase, input.clusterUnit),
        baseline: Number(predicate(testCase, baselineByCase.get(testCase.caseId)!)),
        candidate: Number(predicate(testCase, candidateByCase.get(testCase.caseId)!)),
      })),
    );
  }

  const metrics = Object.fromEntries(
    metricIds.map((metric) => {
      const rows = pairedRows.get(metric)!;
      const baselineSuccesses = rows.reduce((sum, row) => sum + row.baseline, 0);
      const candidateSuccesses = rows.reduce((sum, row) => sum + row.candidate, 0);
      const baselineOnly = rows.filter((row) => row.baseline === 1 && row.candidate === 0).length;
      const candidateOnly = rows.filter((row) => row.baseline === 0 && row.candidate === 1).length;
      const clusters = Map.groupBy(rows, (row) => row.clusterId);
      const clusterDifferences = [...clusters.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([, items]) => items.reduce((sum, row) => sum + row.candidate - row.baseline, 0) / items.length);
      const delta = round((candidateSuccesses - baselineSuccesses) / rows.length);
      return [
        metric,
        {
          denominator: rows.length,
          baseline: rate(baselineSuccesses, rows.length),
          candidate: rate(candidateSuccesses, rows.length),
          delta,
          regressionObservation:
            delta < 0
              ? ("observed_regression" as const)
              : delta > 0
                ? ("observed_improvement" as const)
                : ("no_observed_change" as const),
          discordantPairs: { baselineOnlyCorrect: baselineOnly, candidateOnlyCorrect: candidateOnly },
          clusterBootstrap: pairedClusterBootstrap(rows, { seed: input.seed, resamples: input.resamples }),
          mcnemar: mcnemarExact(baselineOnly, candidateOnly),
          pairedClusterSignFlip: pairedSignFlipTest(clusterDifferences, {
            seed: input.seed,
            permutations: input.resamples,
          }),
        },
      ];
    }),
  ) as Record<
    VerificationBenchmarkEngineeringMetric,
    {
      readonly denominator: number;
      readonly baseline: ReturnType<typeof rate>;
      readonly candidate: ReturnType<typeof rate>;
      readonly delta: number;
      readonly regressionObservation: "observed_regression" | "observed_improvement" | "no_observed_change";
      readonly discordantPairs: { readonly baselineOnlyCorrect: number; readonly candidateOnlyCorrect: number };
      readonly clusterBootstrap: ReturnType<typeof pairedClusterBootstrap>;
      readonly mcnemar: ReturnType<typeof mcnemarExact>;
      readonly pairedClusterSignFlip: ReturnType<typeof pairedSignFlipTest>;
    }
  >;

  const rawFamily = metricIds.flatMap((metric) => [
    { id: `${metric}:mcnemar`, pValue: metrics[metric].mcnemar.pValue },
    { id: `${metric}:cluster_sign_flip`, pValue: metrics[metric].pairedClusterSignFlip.pValue },
  ]);
  const adjusted =
    input.correction === "holm"
      ? holmAdjustment(rawFamily)
      : rawFamily.map((test) => ({ ...test, adjustedPValue: test.pValue }));

  const engineeringRows = pairedRows.get("engineering_expectation_agreement")!;
  const clusters = [...Map.groupBy(engineeringRows, (row) => row.clusterId).entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, rows]) => {
      const baselineSuccesses = rows.reduce((sum, row) => sum + row.baseline, 0);
      const candidateSuccesses = rows.reduce((sum, row) => sum + row.candidate, 0);
      return {
        clusterId: id,
        denominator: rows.length,
        baselineSuccesses,
        candidateSuccesses,
        delta: round((candidateSuccesses - baselineSuccesses) / rows.length),
      };
    });
  const baselineObservationKeys = observationKeys(baseline.results),
    candidateObservationKeys = observationKeys(candidate.results);
  const sharedRecordedObservationCount = [...baselineObservationKeys].filter((key) =>
    candidateObservationKeys.has(key),
  ).length;

  const material = {
    schemaVersion: "verification-benchmark-run-comparison.v1" as const,
    dataset: {
      datasetId: baseline.dataset.datasetId,
      version: baseline.dataset.version,
      manifestDigest: baseline.dataset.manifestDigest as Digest,
      caseCount: baselineCases.length,
      caseDigestMatrixDigest: verificationBenchmarkDigest(baselineCases),
      labelProvenance: baseline.dataset.labelProvenance,
    },
    baseline: {
      runId: baseline.run.runId,
      runManifestDigest: baseline.run.manifestDigest,
      experimentDefinitionDigest: baseline.run.experimentDefinitionDigest,
      armId: baseline.arm.armId,
      armConfigurationDigest: baseline.arm.configurationDigest,
    },
    candidate: {
      runId: candidate.run.runId,
      runManifestDigest: candidate.run.manifestDigest,
      experimentDefinitionDigest: candidate.run.experimentDefinitionDigest,
      armId: candidate.arm.armId,
      armConfigurationDigest: candidate.arm.configurationDigest,
    },
    pairing: {
      paired: true as const,
      repetitionCount: 1 as const,
      caseCount: baselineCases.length,
      clusterUnit: input.clusterUnit,
      clusterCount: clusters.length,
      clusterIndependenceAssessed: false as const,
      clusters,
    },
    metrics,
    inference: {
      confidenceLevel: 0.95 as const,
      seed: input.seed,
      configuredResamples: input.resamples,
      configuredResampleBounds: { minimum: 100 as const, maximum: 10_000 as const },
      wilsonIntervalStatus: "nominal_descriptive" as const,
      wilsonIndependenceAssumption: "unverified_clustered_replay_observations" as const,
      clusterBootstrapIntervalStatus: "descriptive_resampling_interval" as const,
      clusterSignFlipStatus: "exploratory_cluster_independence_unverified" as const,
      clusterBootstrapEstimand: `case_weighted_mean_candidate_minus_baseline_difference_with_${input.clusterUnit}_resampling`,
      pairedClusterSignFlipEstimand: `equal_${input.clusterUnit}_weighted_mean_candidate_minus_baseline_difference`,
      mcnemarStatus: "nominal_exploratory" as const,
      mcnemarEstimand: "case_weighted_discordant_pair_difference" as const,
      hypothesisFamily: "paired_engineering_expectation_dimensions.v1" as const,
      correction: input.correction,
      tests: adjusted,
    },
    recordedObservations: {
      baselineUniqueCount: baselineObservationKeys.size,
      candidateUniqueCount: candidateObservationKeys.size,
      sharedCount: sharedRecordedObservationCount,
      independenceClaim: false as const,
      interpretation:
        "Recorded observations reused across runs are replay engineering observations, not independent fresh calls." as const,
    },
    claimScope: {
      engineeringCorrectnessPredicate:
        "failureClass === none AND schemaValid AND locatorValid === expectedLocatorValid AND support === expected support AND authority === expected authority AND worldCorrectness === expected world correctness AND policy === expected policy" as const,
      engineeringExpectationCaseCount: baselineCases.length,
      humanGoldCaseCount: baseline.dataset.cases.filter((testCase) => testCase.humanGoldScoringEligible).length,
      humanGoldQualityClaim: false as const,
      populationInferenceClaim: false as const,
      promotionClaim: false as const,
      calibrationClaim: false as const,
      sourceAuthorityAssessmentClaim: false as const,
      clinicalClaim: false as const,
      limitation:
        "This result is a deterministic paired engineering observation. It does not establish human-gold model quality, calibration, source authority, clinical correctness, population inference, causality, or promotion eligibility." as const,
    },
  };
  return deepFreeze({ ...material, comparisonDigest: verificationBenchmarkDigest(material) });
}
