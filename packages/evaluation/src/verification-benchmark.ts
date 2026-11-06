import type {
  VerificationBenchmarkAdjudication,
  VerificationBenchmarkAnnotation,
  VerificationBenchmarkArm,
  VerificationBenchmarkCase,
  VerificationBenchmarkCaseResult,
  VerificationBenchmarkDataset,
} from "@aiengineer/knowledge-contracts";
import {
  VerificationBenchmarkAdjudicationSchema,
  VerificationBenchmarkAnnotationSchema,
  VerificationBenchmarkCaseResultSchema,
  VerificationBenchmarkDatasetSchema,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { digestCanonicalJson, sha256Digest } from "@aiengineer/knowledge-verification";
import {
  holmAdjustment,
  mcnemarExact,
  pairedClusterBootstrap,
  pairedSignFlipTest,
  wilson95,
} from "./verification-statistics.js";

export const VERIFICATION_BENCHMARK_RUNNER_VERSION = "verification-benchmark-runner.v1" as const;
type Digest = `sha256:${string}`;

export const verificationBenchmarkDigest = (value: unknown): Digest => digestCanonicalJson(value);
const without = <T extends object>(value: T, key: keyof T): Record<string, unknown> => {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[key as string];
  return copy;
};

export type DraftVerificationBenchmarkCase = Omit<VerificationBenchmarkCase, "caseDigest">;
export type DraftVerificationBenchmarkDataset = Omit<VerificationBenchmarkDataset, "manifestDigest" | "cases"> & {
  readonly cases: readonly DraftVerificationBenchmarkCase[];
};

export interface VerificationBenchmarkHumanGoldAdmission {
  readonly sourceDatasetManifestDigest: Digest;
  readonly adjudicationArtifactDigest: Digest;
  readonly admittedCaseCount: number;
}
interface HumanGoldAdmissionRecord {
  readonly sourceDataset: VerificationBenchmarkDataset;
  readonly adjudicationArtifactDigest: Digest;
  readonly adjudicationsByCase: ReadonlyMap<string, VerificationBenchmarkAdjudication>;
}
const humanGoldAdmissions = new WeakMap<object, HumanGoldAdmissionRecord>();

/** Authenticates the exact annotation/adjudication artifact bytes against a frozen source dataset. */
export function admitVerificationBenchmarkHumanGold(input: {
  readonly sourceDataset: VerificationBenchmarkDataset;
  readonly adjudicationArtifactBytes: Uint8Array;
}): VerificationBenchmarkHumanGoldAdmission {
  const sourceSnapshot = deepFreeze(structuredClone(input.sourceDataset));
  assertFrozenVerificationBenchmarkDataset(sourceSnapshot);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(input.adjudicationArtifactBytes));
  } catch {
    throw new Error("BENCHMARK_ADJUDICATION_ARTIFACT_INVALID");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("BENCHMARK_ADJUDICATION_ARTIFACT_INVALID");
  const artifact = decoded as Record<string, unknown>,
    keys = Object.keys(artifact);
  if (
    keys.length !== 4 ||
    !["schemaVersion", "sourceDatasetManifestDigest", "annotations", "adjudications"].every((key) => key in artifact) ||
    artifact.schemaVersion !== "verification-benchmark-adjudication-artifact.v1" ||
    artifact.sourceDatasetManifestDigest !== sourceSnapshot.manifestDigest ||
    !Array.isArray(artifact.annotations) ||
    !Array.isArray(artifact.adjudications)
  )
    throw new Error("BENCHMARK_ADJUDICATION_ARTIFACT_INVALID");
  const annotations = artifact.annotations.map((item) => VerificationBenchmarkAnnotationSchema.parse(item));
  const adjudications = artifact.adjudications.map((item) => VerificationBenchmarkAdjudicationSchema.parse(item));
  const byCase = new Map<string, VerificationBenchmarkAdjudication>();
  for (const adjudication of adjudications) {
    validateVerificationAdjudication(sourceSnapshot, annotations, adjudication);
    if (byCase.has(adjudication.caseId))
      throw new Error(`BENCHMARK_ADJUDICATION_DUPLICATE_CASE:${adjudication.caseId}`);
    byCase.set(adjudication.caseId, adjudication);
  }
  if (!byCase.size) throw new Error("BENCHMARK_ADJUDICATION_ARTIFACT_EMPTY");
  const adjudicationArtifactDigest = sha256Digest(input.adjudicationArtifactBytes);
  const admission = deepFreeze({
    sourceDatasetManifestDigest: sourceSnapshot.manifestDigest as Digest,
    adjudicationArtifactDigest,
    admittedCaseCount: byCase.size,
  });
  humanGoldAdmissions.set(admission, {
    sourceDataset: sourceSnapshot,
    adjudicationArtifactDigest,
    adjudicationsByCase: new Map(byCase),
  });
  return admission;
}

const promotionMaterial = (item: DraftVerificationBenchmarkCase | VerificationBenchmarkCase) => ({
  schemaVersion: item.schemaVersion,
  caseId: item.caseId,
  partition: item.partition,
  inputManifestArtifactId: item.inputManifestArtifactId,
  modality: item.modality,
  sourceFamily: item.sourceFamily,
  entityFamily: item.entityFamily,
  reportCluster: item.reportCluster,
  pairCluster: item.pairCluster,
  tags: item.tags,
  adversarialTransforms: item.adversarialTransforms,
  assertion: item.assertion,
  evidence: item.evidence,
  independentObservation: item.independentObservation,
});

export function freezeVerificationBenchmarkDataset(
  input: DraftVerificationBenchmarkDataset,
  admission?: VerificationBenchmarkHumanGoldAdmission,
): VerificationBenchmarkDataset {
  if (input.cases.some((item) => item.humanGoldScoringEligible)) {
    if (input.adjudicationArtifactDigest == null)
      throw new Error("BENCHMARK_HUMAN_GOLD_ADJUDICATION_ARTIFACT_REQUIRED");
    const admitted = admission && typeof admission === "object" ? humanGoldAdmissions.get(admission) : undefined;
    if (
      !admitted ||
      admitted.adjudicationArtifactDigest !== input.adjudicationArtifactDigest ||
      admission!.adjudicationArtifactDigest !== input.adjudicationArtifactDigest
    )
      throw new Error("BENCHMARK_HUMAN_GOLD_ADMISSION_REQUIRED");
    const source = admitted.sourceDataset;
    if (
      input.datasetId !== source.datasetId ||
      input.version <= source.version ||
      input.supersedesManifestDigest !== source.manifestDigest ||
      admission!.sourceDatasetManifestDigest !== source.manifestDigest
    )
      throw new Error("BENCHMARK_HUMAN_GOLD_SUCCESSOR_BINDING_INVALID");
    for (const testCase of input.cases.filter((item) => item.humanGoldScoringEligible)) {
      const adjudication = admitted.adjudicationsByCase.get(testCase.caseId),
        sourceCase = source.cases.find((item) => item.caseId === testCase.caseId);
      if (
        !adjudication ||
        !sourceCase ||
        adjudication.adjudicationId !== testCase.adjudicationId ||
        adjudication.finalLabel !== testCase.expectation.label ||
        testCase.expectation.labelStatus !== "expert_adjudicated" ||
        testCase.goldArtifactId === null
      )
        throw new Error(`BENCHMARK_HUMAN_GOLD_ADJUDICATION_MISSING:${testCase.caseId}`);
      if (
        verificationBenchmarkDigest(promotionMaterial(testCase)) !==
        verificationBenchmarkDigest(promotionMaterial(sourceCase))
      )
        throw new Error(`BENCHMARK_HUMAN_GOLD_CASE_BINDING_INVALID:${testCase.caseId}`);
      const reviewed = {
        support: testCase.expectation.support,
        authority: testCase.expectation.authority,
        worldCorrectness: testCase.expectation.worldCorrectness,
        policy: testCase.expectation.expectedPolicy,
        locatorValid: testCase.expectation.expectedLocatorValid,
      };
      const sourceDimensions = {
        support: sourceCase.expectation.support,
        authority: sourceCase.expectation.authority,
        worldCorrectness: sourceCase.expectation.worldCorrectness,
        policy: sourceCase.expectation.expectedPolicy,
        locatorValid: sourceCase.expectation.expectedLocatorValid,
      };
      if (verificationBenchmarkDigest(reviewed) !== verificationBenchmarkDigest(sourceDimensions))
        throw new Error(`BENCHMARK_HUMAN_GOLD_UNREVIEWED_DIMENSION_CHANGED:${testCase.caseId}`);
      if (
        !testCase.humanGoldDimensions ||
        testCase.humanGoldDimensions.length !== 1 ||
        testCase.humanGoldDimensions[0] !== "label"
      )
        throw new Error(`BENCHMARK_HUMAN_GOLD_DIMENSION_SCOPE_INVALID:${testCase.caseId}`);
    }
  }
  const cases = input.cases.map((item) =>
    deepFreeze({ ...item, caseDigest: verificationBenchmarkDigest(item) }),
  ) as readonly VerificationBenchmarkCase[];
  const material = { ...input, cases };
  const dataset = {
    ...material,
    manifestDigest: verificationBenchmarkDigest(material),
  } as VerificationBenchmarkDataset;
  return deepFreeze(VerificationBenchmarkDatasetSchema.parse(dataset));
}

export function assertFrozenVerificationBenchmarkDataset(
  input: unknown,
): asserts input is VerificationBenchmarkDataset {
  const dataset = VerificationBenchmarkDatasetSchema.parse(input);
  for (const item of dataset.cases)
    if (verificationBenchmarkDigest(without(item, "caseDigest")) !== item.caseDigest)
      throw new Error(`BENCHMARK_CASE_DIGEST_MISMATCH:${item.caseId}`);
  if (verificationBenchmarkDigest(without(dataset, "manifestDigest")) !== dataset.manifestDigest)
    throw new Error("BENCHMARK_MANIFEST_DIGEST_MISMATCH");
}

export interface VerificationAnnotationQueueItem {
  readonly caseId: string;
  readonly datasetManifestDigest: Digest;
  readonly requiredHumanAnnotations: 2;
  readonly expertAdjudicationRequired: boolean;
  readonly status: "awaiting_human_annotations" | "awaiting_expert_adjudication" | "complete";
  readonly annotationIds: readonly string[];
}

export function buildVerificationAnnotationQueue(
  dataset: VerificationBenchmarkDataset,
  annotations: readonly VerificationBenchmarkAnnotation[],
  adjudications: readonly VerificationBenchmarkAdjudication[],
): readonly VerificationAnnotationQueueItem[] {
  assertFrozenVerificationBenchmarkDataset(dataset);
  const valid = annotations
    .map((item) => VerificationBenchmarkAnnotationSchema.parse(item))
    .filter((item) => item.datasetManifestDigest === dataset.manifestDigest);
  return deepFreeze(
    dataset.cases.map((testCase) => {
      const caseAnnotations = valid.filter(
        (item) => item.caseId === testCase.caseId && item.annotatorRole === "human_annotator",
      );
      const identities = new Set(caseAnnotations.map((item) => item.annotatorIdentity));
      const adjudication = adjudications.find(
        (item) => item.datasetManifestDigest === dataset.manifestDigest && item.caseId === testCase.caseId,
      );
      let complete = false;
      if (adjudication) {
        const parsed = VerificationBenchmarkAdjudicationSchema.parse(adjudication);
        validateVerificationAdjudication(dataset, valid, parsed);
        complete = true;
      }
      return {
        caseId: testCase.caseId,
        datasetManifestDigest: dataset.manifestDigest as Digest,
        requiredHumanAnnotations: 2 as const,
        expertAdjudicationRequired: true,
        status: complete
          ? ("complete" as const)
          : identities.size >= 2
            ? ("awaiting_expert_adjudication" as const)
            : ("awaiting_human_annotations" as const),
        annotationIds: caseAnnotations.map((item) => item.annotationId).sort(),
      };
    }),
  );
}

export function validateVerificationAdjudication(
  dataset: VerificationBenchmarkDataset,
  annotations: readonly VerificationBenchmarkAnnotation[],
  adjudication: VerificationBenchmarkAdjudication,
): void {
  assertFrozenVerificationBenchmarkDataset(dataset);
  const parsedAdjudication = VerificationBenchmarkAdjudicationSchema.parse(adjudication),
    parsedAnnotations = annotations.map((item) => VerificationBenchmarkAnnotationSchema.parse(item));
  if (
    parsedAdjudication.datasetManifestDigest !== dataset.manifestDigest ||
    !dataset.cases.some((item) => item.caseId === parsedAdjudication.caseId)
  )
    throw new Error("BENCHMARK_ADJUDICATION_DATASET_MISMATCH");
  const selected = parsedAnnotations.filter((item) => parsedAdjudication.annotationIds.includes(item.annotationId));
  if (
    selected.length !== parsedAdjudication.annotationIds.length ||
    selected.length < 2 ||
    selected.some(
      (item) =>
        item.caseId !== parsedAdjudication.caseId ||
        item.datasetManifestDigest !== dataset.manifestDigest ||
        item.annotatorRole !== "human_annotator" ||
        !item.blindedToOtherAnnotations,
    )
  )
    throw new Error("BENCHMARK_ADJUDICATION_ANNOTATIONS_INVALID");
  if (
    new Set(selected.map((item) => item.annotatorIdentity)).size < 2 ||
    selected.some((item) => item.annotatorIdentity === parsedAdjudication.expertIdentity)
  )
    throw new Error("BENCHMARK_ADJUDICATION_INDEPENDENCE_REQUIRED");
}

export interface VerificationBenchmarkCheckpointStore {
  load(key: string): Promise<VerificationBenchmarkCaseResult | undefined>;
  save(key: string, result: VerificationBenchmarkCaseResult): Promise<void>;
}
export class MemoryVerificationBenchmarkCheckpointStore implements VerificationBenchmarkCheckpointStore {
  readonly #items = new Map<string, VerificationBenchmarkCaseResult>();
  async load(key: string) {
    return this.#items.get(key);
  }
  async save(key: string, result: VerificationBenchmarkCaseResult) {
    if (this.#items.has(key)) throw new Error("BENCHMARK_CHECKPOINT_APPEND_ONLY");
    this.#items.set(key, deepFreeze(structuredClone(result)));
  }
}

export interface VerificationBenchmarkExecutionContext {
  readonly runId: string;
  readonly datasetManifestDigest: Digest;
  readonly arm: VerificationBenchmarkArm;
  readonly testCase: VerificationBenchmarkCase;
  readonly repetition: number;
  readonly networkPolicy: "offline" | "allow_listed_providers";
}
export type VerificationBenchmarkExecutor = (
  input: VerificationBenchmarkExecutionContext,
) => Promise<
  Omit<
    VerificationBenchmarkCaseResult,
    | "schemaVersion"
    | "runId"
    | "armId"
    | "caseId"
    | "repetition"
    | "checkpointContextDigest"
    | "checkpointDigest"
    | "completedAt"
  >
>;

export interface VerificationBenchmarkRun {
  readonly schemaVersion: typeof VERIFICATION_BENCHMARK_RUNNER_VERSION;
  readonly runId: string;
  readonly datasetManifestDigest: Digest;
  readonly experimentDefinitionDigest: Digest;
  readonly runnerVersion: typeof VERIFICATION_BENCHMARK_RUNNER_VERSION;
  readonly randomSeed: number;
  readonly networkPolicy: "offline" | "allow_listed_providers";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly arms: readonly VerificationBenchmarkArm[];
  readonly results: readonly VerificationBenchmarkCaseResult[];
  readonly manifestDigest: Digest;
}

/** Durable adapters retain both times under the same run identity and active fence. */
export interface VerificationBenchmarkRunLifecycle {
  readonly startedAt: string;
  /** Atomically retain the first completion time after all checkpoints are durable. */
  complete(): Promise<string>;
}

export interface VerificationBenchmarkPlanInput {
  readonly runId: string;
  readonly dataset: VerificationBenchmarkDataset;
  readonly experimentDefinitionDigest: Digest;
  readonly arms: readonly VerificationBenchmarkArm[];
  readonly repetitions: number;
  readonly randomSeed: number;
  readonly networkPolicy: "offline" | "allow_listed_providers";
}

/** Exact expected matrix, retained before any checkpoint can be accepted. */
export function createVerificationBenchmarkCheckpointPlan(input: VerificationBenchmarkPlanInput) {
  assertFrozenVerificationBenchmarkDataset(input.dataset);
  if (
    input.arms.length < 2 ||
    input.arms.filter((item) => item.control).length !== 1 ||
    new Set(input.arms.map((item) => item.armId)).size !== input.arms.length
  )
    throw new Error("BENCHMARK_ARMS_INVALID");
  if (!Number.isInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 10)
    throw new Error("BENCHMARK_REPETITIONS_INVALID");
  const entries = [...input.dataset.cases]
    .sort((left, right) => left.caseId.localeCompare(right.caseId))
    .flatMap((testCase) =>
      input.arms.flatMap((arm) =>
        Array.from({ length: input.repetitions }, (_, repetition) => ({
          checkpointContextDigest: verificationBenchmarkDigest({
            runnerVersion: VERIFICATION_BENCHMARK_RUNNER_VERSION,
            runId: input.runId,
            datasetManifestDigest: input.dataset.manifestDigest,
            experimentDefinitionDigest: input.experimentDefinitionDigest,
            networkPolicy: input.networkPolicy,
            randomSeed: input.randomSeed,
            arm,
            caseId: testCase.caseId,
            caseDigest: testCase.caseDigest,
            repetition,
          }),
          caseId: testCase.caseId,
          armId: arm.armId,
          repetition,
        })),
      ),
    );
  return deepFreeze({ entries, planDigest: verificationBenchmarkDigest(entries) });
}

export async function runVerificationBenchmark(input: {
  readonly runId: string;
  readonly dataset: VerificationBenchmarkDataset;
  readonly experimentDefinitionDigest: Digest;
  readonly arms: readonly VerificationBenchmarkArm[];
  readonly repetitions: number;
  readonly randomSeed: number;
  readonly networkPolicy: "offline" | "allow_listed_providers";
  readonly checkpoints: VerificationBenchmarkCheckpointStore;
  readonly execute: VerificationBenchmarkExecutor;
  readonly now: () => string;
  readonly signal?: AbortSignal;
  readonly lifecycle?: VerificationBenchmarkRunLifecycle;
}): Promise<VerificationBenchmarkRun> {
  const assertActive = () => {
    if (input.signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
  };
  assertActive();
  const plan = createVerificationBenchmarkCheckpointPlan(input);
  const cases = new Map(input.dataset.cases.map((testCase) => [testCase.caseId, testCase]));
  const arms = new Map(input.arms.map((arm) => [arm.armId, arm]));
  const startedAt = input.lifecycle?.startedAt ?? input.now(),
    results: VerificationBenchmarkCaseResult[] = [];
  if (input.lifecycle) assertRunTimestamp(startedAt);
  for (const entry of plan.entries) {
    assertActive();
    const testCase = cases.get(entry.caseId)!,
      arm = arms.get(entry.armId)!,
      repetition = entry.repetition,
      key = entry.checkpointContextDigest;
    const priorRaw = await input.checkpoints.load(key);
    assertActive();
    if (priorRaw) {
      const prior = VerificationBenchmarkCaseResultSchema.parse(priorRaw);
      const priorMaterial = without(prior, "checkpointDigest");
      if (
        verificationBenchmarkDigest(priorMaterial) !== prior.checkpointDigest ||
        prior.checkpointContextDigest !== key ||
        prior.runId !== input.runId ||
        prior.armId !== arm.armId ||
        prior.caseId !== testCase.caseId ||
        prior.repetition !== repetition
      )
        throw new Error("BENCHMARK_CHECKPOINT_BINDING_INVALID");
      if (input.lifecycle) assertRunTimestamp(prior.completedAt, startedAt);
      results.push(prior);
      continue;
    }
    let execution: Awaited<ReturnType<VerificationBenchmarkExecutor>>;
    try {
      execution = await input.execute({
        runId: input.runId,
        datasetManifestDigest: input.dataset.manifestDigest as Digest,
        arm,
        testCase,
        repetition,
        networkPolicy: input.networkPolicy,
      });
    } catch {
      assertActive();
      execution = {
        schemaValid: false,
        locatorValid: false,
        fieldMechanics: false,
        support: "not_applicable",
        authority: "not_applicable",
        worldCorrectness: "unknown",
        policy: "abstain",
        confidence: null,
        confidenceCalibrated: false,
        failureClass: "local",
        callAttributions: [],
      };
    }
    assertActive();
    const completedAt = input.now();
    if (input.lifecycle) assertRunTimestamp(completedAt, startedAt);
    const base = {
      ...execution,
      schemaVersion: "verification-benchmark.v1" as const,
      runId: input.runId,
      armId: arm.armId,
      caseId: testCase.caseId,
      repetition,
      checkpointContextDigest: key,
      completedAt,
    };
    const result = deepFreeze(
      VerificationBenchmarkCaseResultSchema.parse({ ...base, checkpointDigest: verificationBenchmarkDigest(base) }),
    ) as VerificationBenchmarkCaseResult;
    await input.checkpoints.save(key, result);
    assertActive();
    results.push(result);
  }
  assertActive();
  const completedAt = input.lifecycle ? await input.lifecycle.complete() : input.now();
  assertActive();
  if (input.lifecycle) {
    assertRunTimestamp(completedAt, startedAt);
    if (results.some((result) => Date.parse(result.completedAt) > Date.parse(completedAt)))
      throw new Error("BENCHMARK_RUN_TIMING_INVALID");
  }
  const material = {
    schemaVersion: VERIFICATION_BENCHMARK_RUNNER_VERSION,
    runId: input.runId,
    datasetManifestDigest: input.dataset.manifestDigest as Digest,
    experimentDefinitionDigest: input.experimentDefinitionDigest,
    runnerVersion: VERIFICATION_BENCHMARK_RUNNER_VERSION,
    randomSeed: input.randomSeed,
    networkPolicy: input.networkPolicy,
    startedAt,
    completedAt,
    arms: input.arms,
    results,
  };
  return deepFreeze({ ...material, manifestDigest: verificationBenchmarkDigest(material) });
}

function assertRunTimestamp(value: string, earliest?: string): void {
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error("BENCHMARK_RUN_TIMING_INVALID");
  }
  if (canonical !== value || (earliest !== undefined && Date.parse(value) < Date.parse(earliest)))
    throw new Error("BENCHMARK_RUN_TIMING_INVALID");
}

const correct = (testCase: VerificationBenchmarkCase, result: VerificationBenchmarkCaseResult) =>
  result.failureClass === "none" &&
  result.schemaValid &&
  result.locatorValid === testCase.expectation.expectedLocatorValid &&
  result.support === testCase.expectation.support &&
  result.authority === testCase.expectation.authority &&
  result.worldCorrectness === testCase.expectation.worldCorrectness &&
  result.policy === testCase.expectation.expectedPolicy;
export function assertVerificationBenchmarkRun(
  dataset: VerificationBenchmarkDataset,
  run: VerificationBenchmarkRun,
): void {
  const runKeys = [
    "schemaVersion",
    "runId",
    "datasetManifestDigest",
    "experimentDefinitionDigest",
    "runnerVersion",
    "randomSeed",
    "networkPolicy",
    "startedAt",
    "completedAt",
    "arms",
    "results",
    "manifestDigest",
  ];
  if (
    run === null ||
    typeof run !== "object" ||
    Object.keys(run).length !== runKeys.length ||
    runKeys.some((key) => !(key in run)) ||
    run.schemaVersion !== VERIFICATION_BENCHMARK_RUNNER_VERSION ||
    run.runnerVersion !== VERIFICATION_BENCHMARK_RUNNER_VERSION ||
    run.datasetManifestDigest !== dataset.manifestDigest ||
    verificationBenchmarkDigest(without(run, "manifestDigest")) !== run.manifestDigest
  )
    throw new Error("BENCHMARK_RUN_MANIFEST_INVALID");
  if (
    !Array.isArray(run.arms) ||
    run.arms.length < 2 ||
    run.arms.filter((item) => item.control).length !== 1 ||
    new Set(run.arms.map((item) => item.armId)).size !== run.arms.length
  )
    throw new Error("BENCHMARK_RUN_ARMS_INVALID");
  const armIds = new Set(run.arms.map((item) => item.armId)),
    caseIds = new Set(dataset.cases.map((item) => item.caseId)),
    keys = new Set<string>();
  const repetitions = run.results.length / (run.arms.length * dataset.cases.length);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error("BENCHMARK_RUN_RESULT_MATRIX_INCOMPLETE");
  for (const raw of run.results) {
    const item = VerificationBenchmarkCaseResultSchema.parse(raw),
      key = `${item.armId}:${item.caseId}:${item.repetition}`;
    const arm = run.arms.find((candidate) => candidate.armId === item.armId),
      testCase = dataset.cases.find((candidate) => candidate.caseId === item.caseId);
    if (
      !arm ||
      !testCase ||
      !armIds.has(item.armId) ||
      !caseIds.has(item.caseId) ||
      item.runId !== run.runId ||
      !Number.isInteger(item.repetition) ||
      item.repetition < 0 ||
      item.repetition >= repetitions ||
      keys.has(key) ||
      verificationBenchmarkDigest(without(item, "checkpointDigest")) !== item.checkpointDigest
    )
      throw new Error("BENCHMARK_RUN_RESULT_INVALID");
    const expectedContext = verificationBenchmarkDigest({
      runnerVersion: VERIFICATION_BENCHMARK_RUNNER_VERSION,
      runId: run.runId,
      datasetManifestDigest: dataset.manifestDigest,
      experimentDefinitionDigest: run.experimentDefinitionDigest,
      networkPolicy: run.networkPolicy,
      randomSeed: run.randomSeed,
      arm,
      caseId: testCase.caseId,
      caseDigest: testCase.caseDigest,
      repetition: item.repetition,
    });
    if (item.checkpointContextDigest !== expectedContext) throw new Error("BENCHMARK_RUN_RESULT_CONTEXT_INVALID");
    keys.add(key);
  }
  for (const arm of run.arms)
    for (const testCase of dataset.cases)
      for (let repetition = 0; repetition < repetitions; repetition++)
        if (!keys.has(`${arm.armId}:${testCase.caseId}:${repetition}`))
          throw new Error("BENCHMARK_RUN_RESULT_MATRIX_INCOMPLETE");
}
const rate = (successes: number, total: number) => ({ successes, ...wilson95(successes, total) });
export interface VerificationBenchmarkArmMetrics {
  readonly armId: string;
  readonly total: number;
  readonly humanGoldDenominator: number;
  readonly humanGoldDimensionDenominators: Readonly<
    Record<"label" | "locator" | "field_mechanics" | "support" | "authority" | "world_correctness" | "policy", number>
  >;
  readonly qualityClaimEligible: boolean;
  readonly schemaValidity: ReturnType<typeof rate>;
  readonly locatorResolutionValidity: ReturnType<typeof rate>;
  readonly locatorExpectationAgreement: ReturnType<typeof rate>;
  readonly fieldMechanics: ReturnType<typeof rate>;
  readonly supportAgreement: ReturnType<typeof rate>;
  readonly authorityAgreement: ReturnType<typeof rate>;
  readonly worldCorrectnessAgreement: ReturnType<typeof rate>;
  readonly policyAgreement: ReturnType<typeof rate>;
  readonly engineeringExpectationAgreement: ReturnType<typeof rate>;
  readonly failures: Readonly<Record<string, number>>;
  readonly costs: {
    readonly actualMicros: number;
    readonly reservationMicros: number;
    readonly unknownDispatched: number;
  };
}
export function summarizeVerificationBenchmark(
  dataset: VerificationBenchmarkDataset,
  run: VerificationBenchmarkRun,
): readonly VerificationBenchmarkArmMetrics[] {
  assertFrozenVerificationBenchmarkDataset(dataset);
  assertVerificationBenchmarkRun(dataset, run);
  const byCase = new Map(dataset.cases.map((item) => [item.caseId, item]));
  return deepFreeze(
    run.arms.map((arm) => {
      const rows = run.results.filter((item) => item.armId === arm.armId),
        gold = rows.filter((item) => byCase.get(item.caseId)?.humanGoldScoringEligible);
      const failures: Record<string, number> = {};
      for (const row of rows) failures[row.failureClass] = (failures[row.failureClass] ?? 0) + 1;
      const agreement = (
        predicate: (testCase: VerificationBenchmarkCase, result: VerificationBenchmarkCaseResult) => boolean,
      ) => rate(rows.filter((row) => predicate(byCase.get(row.caseId)!, row)).length, rows.length);
      const calls = rows.flatMap((row) => row.callAttributions);
      const humanGoldDimensionDenominators = Object.fromEntries(
        (["label", "locator", "field_mechanics", "support", "authority", "world_correctness", "policy"] as const).map(
          (dimension) => [
            dimension,
            rows.filter(
              (row) =>
                byCase.get(row.caseId)?.humanGoldScoringEligible &&
                byCase.get(row.caseId)?.humanGoldDimensions?.includes(dimension),
            ).length,
          ],
        ),
      ) as VerificationBenchmarkArmMetrics["humanGoldDimensionDenominators"];
      const fullyReviewed =
        rows.length > 0 &&
        rows.every((row) => {
          const item = byCase.get(row.caseId);
          return (
            item?.humanGoldScoringEligible &&
            ["locator", "field_mechanics", "support", "authority", "world_correctness", "policy"].every((dimension) =>
              item.humanGoldDimensions?.includes(dimension as any),
            )
          );
        });
      return {
        armId: arm.armId,
        total: rows.length,
        humanGoldDenominator: gold.length,
        humanGoldDimensionDenominators,
        qualityClaimEligible: fullyReviewed,
        schemaValidity: rate(rows.filter((row) => row.schemaValid).length, rows.length),
        locatorResolutionValidity: rate(rows.filter((row) => row.locatorValid).length, rows.length),
        locatorExpectationAgreement: agreement(
          (testCase, row) => row.locatorValid === testCase.expectation.expectedLocatorValid,
        ),
        fieldMechanics: rate(rows.filter((row) => row.fieldMechanics).length, rows.length),
        supportAgreement: agreement((testCase, row) => row.support === testCase.expectation.support),
        authorityAgreement: agreement((testCase, row) => row.authority === testCase.expectation.authority),
        worldCorrectnessAgreement: agreement(
          (testCase, row) => row.worldCorrectness === testCase.expectation.worldCorrectness,
        ),
        policyAgreement: agreement((testCase, row) => row.policy === testCase.expectation.expectedPolicy),
        engineeringExpectationAgreement: rate(
          rows.filter((row) => correct(byCase.get(row.caseId)!, row)).length,
          rows.length,
        ),
        failures,
        costs: {
          actualMicros: calls.reduce((sum, item) => sum + (item.actualCostMicros ?? 0), 0),
          reservationMicros: calls.reduce((sum, item) => sum + item.reservationCostMicros, 0),
          unknownDispatched: calls.filter((item) => item.costState === "unknown_dispatched").length,
        },
      };
    }),
  );
}

export function compareVerificationBenchmarkArms(
  dataset: VerificationBenchmarkDataset,
  run: VerificationBenchmarkRun,
  baselineArmId: string,
  candidateArmId: string,
  options: { readonly seed: number; readonly resamples: number },
) {
  assertFrozenVerificationBenchmarkDataset(dataset);
  assertVerificationBenchmarkRun(dataset, run);
  const repetitions = new Set(run.results.map((item) => item.repetition));
  if (repetitions.size !== 1 || !repetitions.has(0)) throw new Error("BENCHMARK_COMPARISON_REPETITION_ONE_REQUIRED");
  const cases = new Map(dataset.cases.map((item) => [item.caseId, item]));
  const baseline = new Map(
    run.results
      .filter((item) => item.armId === baselineArmId && item.repetition === 0)
      .map((item) => [item.caseId, item]),
  );
  const candidate = new Map(
    run.results
      .filter((item) => item.armId === candidateArmId && item.repetition === 0)
      .map((item) => [item.caseId, item]),
  );
  const rows = dataset.cases.map((testCase) => {
    const left = baseline.get(testCase.caseId),
      right = candidate.get(testCase.caseId);
    if (!left || !right) throw new Error(`BENCHMARK_PAIR_MISSING:${testCase.caseId}`);
    return {
      caseId: testCase.caseId,
      clusterId: testCase.sourceFamily,
      baseline: Number(correct(testCase, left)),
      candidate: Number(correct(testCase, right)),
    };
  });
  const baselineOnly = rows.filter((item) => item.baseline === 1 && item.candidate === 0).length,
    candidateOnly = rows.filter((item) => item.baseline === 0 && item.candidate === 1).length;
  const clusterDifferences = [...Map.groupBy(rows, (item) => item.clusterId).values()].map(
    (cluster) => cluster.reduce((sum, item) => sum + item.candidate - item.baseline, 0) / cluster.length,
  );
  return deepFreeze({
    baselineArmId,
    candidateArmId,
    repetitionCount: 1,
    humanGoldEligible: dataset.cases.every((item) => item.humanGoldScoringEligible),
    effectiveCaseCount: rows.length,
    independentClusterCount: clusterDifferences.length,
    mcnemar: mcnemarExact(baselineOnly, candidateOnly),
    mcnemarInference: {
      status: "nominal_exploratory" as const,
      estimand: "case_weighted_discordant_pair_accuracy_difference" as const,
      independenceAssumption: "unfulfilled_source_correlated_cases" as const,
    },
    clusterBootstrap: pairedClusterBootstrap(rows, options),
    clusterBootstrapEstimand: "case_weighted_mean_accuracy_difference_with_source_cluster_resampling" as const,
    pairedClusterSignFlip: pairedSignFlipTest(clusterDifferences, {
      seed: options.seed,
      permutations: options.resamples,
    }),
    pairedClusterSignFlipEstimand: "equal_source_cluster_weighted_mean_accuracy_difference" as const,
    limitation: `Engineering expectations are regression oracles; human-gold model quality, calibration, and population inference remain pending. McNemar is nominal and exploratory because case independence is unfulfilled. The authoritative paired comparison uses ${clusterDifferences.length} source-family clusters; bootstrap and sign-flip target different stated estimands.`,
  });
}

export function compareVerificationBenchmarkExperiment(
  dataset: VerificationBenchmarkDataset,
  run: VerificationBenchmarkRun,
  baselineArmId: string,
  options: { readonly seed: number; readonly resamples: number },
) {
  const comparisons = run.arms
    .filter((arm) => arm.armId !== baselineArmId)
    .map((arm, index) =>
      compareVerificationBenchmarkArms(dataset, run, baselineArmId, arm.armId, {
        seed: options.seed + index,
        resamples: options.resamples,
      }),
    );
  const family = comparisons.flatMap((item) => [
    { id: `${item.candidateArmId}:mcnemar`, pValue: item.mcnemar.pValue },
    { id: `${item.candidateArmId}:cluster_sign_flip`, pValue: item.pairedClusterSignFlip.pValue },
  ]);
  return deepFreeze({
    hypothesisFamily: family.map((item) => item.id),
    comparisons,
    holm: holmAdjustment(family),
    limitation:
      "Holm correction covers every prespecified candidate-arm binary and clustered paired hypothesis in this experiment.",
  });
}

export function diffVerificationBenchmarkDatasets(
  previous: VerificationBenchmarkDataset,
  proposed: VerificationBenchmarkDataset,
) {
  assertFrozenVerificationBenchmarkDataset(previous);
  assertFrozenVerificationBenchmarkDataset(proposed);
  if (
    previous.datasetId !== proposed.datasetId ||
    proposed.version <= previous.version ||
    proposed.supersedesManifestDigest !== previous.manifestDigest
  )
    throw new Error("BENCHMARK_REFRESH_LINEAGE_INVALID");
  const before = new Map(previous.cases.map((item) => [item.caseId, item.caseDigest])),
    after = new Map(proposed.cases.map((item) => [item.caseId, item.caseDigest]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort(),
    removed = [...before.keys()].filter((id) => !after.has(id)).sort(),
    changed = [...after]
      .filter(([id, digest]) => before.has(id) && before.get(id) !== digest)
      .map(([id]) => id)
      .sort();
  return deepFreeze({
    schemaVersion: "verification-benchmark-diff.v1",
    datasetId: previous.datasetId,
    previousVersion: previous.version,
    proposedVersion: proposed.version,
    previousManifestDigest: previous.manifestDigest,
    proposedManifestDigest: proposed.manifestDigest,
    added,
    removed,
    changed,
    digest: verificationBenchmarkDigest({
      added,
      removed,
      changed,
      previous: previous.manifestDigest,
      proposed: proposed.manifestDigest,
    }),
  });
}
