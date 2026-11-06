import {
  CompareBenchmarkRunsRequestSchema,
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationBenchmarkComparisonProfileArtifactReferenceSchema,
  VerificationBenchmarkComparisonProfileSchema,
  VerificationBenchmarkDatasetSchema,
  VerificationBenchmarkPublicationManifestSchema,
  type CompareBenchmarkRunsRequest,
  type VerificationArtifactHandle,
  type VerificationBenchmarkComparisonProfile,
  type VerificationBenchmarkComparisonProfileArtifactReference,
  type VerificationBenchmarkComparisonProfileId,
  type VerificationBenchmarkDataset,
  type VerificationBenchmarkEngineeringMetric,
  type VerificationBenchmarkPublicationManifest,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  compareVerificationBenchmarkRuns,
  createVerificationBenchmarkCheckpointPlan,
  holmAdjustment,
  summarizeVerificationBenchmark,
  verificationBenchmarkDigest,
  type VerificationBenchmarkRun,
} from "@aiengineer/knowledge-evaluation";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import type {
  VerifiedBenchmarkPublicationReadPort,
  VerifiedBenchmarkPublicationReadSnapshot,
} from "./verification-benchmark-reads.js";

type ComparisonResult = ReturnType<typeof compareVerificationBenchmarkRuns>;
type Digest = `sha256:${string}`;
const MAXIMUM_PROFILE_GRANTS = 256;
const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAXIMUM_TOTAL_BYTES = 32 * 1024 * 1024;
const MAXIMUM_TOTAL_STATISTIC_WORK = 5_000_000;

export interface VerificationBenchmarkComparisonProfileGrant {
  readonly tenantId: string;
  readonly profileId: VerificationBenchmarkComparisonProfileId;
  readonly artifact: VerificationBenchmarkComparisonProfileArtifactReference;
}

/** Immutable deployment authority for one exact tenant/profile artifact. */
export class VerificationBenchmarkComparisonProfileCatalog {
  readonly #grants: ReadonlyMap<string, VerificationBenchmarkComparisonProfileGrant>;

  constructor(values: readonly VerificationBenchmarkComparisonProfileGrant[]) {
    if (!Array.isArray(values) || values.length > MAXIMUM_PROFILE_GRANTS)
      throw new Error("BENCHMARK_COMPARISON_PROFILE_CATALOG_BOUND_EXCEEDED");
    const grants = new Map<string, VerificationBenchmarkComparisonProfileGrant>();
    for (const value of values) {
      const grant = parseGrant(value),
        key = profileKey(grant.tenantId, grant.profileId);
      if (grants.has(key)) throw new Error("BENCHMARK_COMPARISON_PROFILE_DUPLICATE_TRUSTED_GRANT");
      grants.set(key, deepFreeze(structuredClone(grant)));
    }
    this.#grants = grants;
    Object.freeze(this);
  }

  resolve(
    tenantId: string,
    profileId: VerificationBenchmarkComparisonProfileId,
  ): VerificationBenchmarkComparisonProfileGrant {
    const grant = this.#grants.get(profileKey(tenantId, profileId));
    if (!grant) throw new Error("BENCHMARK_COMPARISON_PROFILE_TRUSTED_GRANT_REQUIRED");
    return grant;
  }
}

export interface VerificationBenchmarkComparisonApplicationConfig {
  readonly maximumArtifactBytes?: number;
  readonly maximumTotalBytes?: number;
}

export interface VerificationBenchmarkComparisonResultInputBinding {
  readonly runId: string;
  readonly operationId: string;
  readonly publicationArtifact: VerificationBenchmarkComparisonProfileArtifactReference;
  readonly publicationPayloadDigest: Digest;
  readonly datasetArtifact: VerificationBenchmarkComparisonProfileArtifactReference;
  readonly datasetManifestDigest: Digest;
  readonly experimentArtifact: VerificationBenchmarkComparisonProfileArtifactReference;
  readonly runnerArtifact: VerificationBenchmarkComparisonProfileArtifactReference;
  readonly runnerManifestDigest: Digest;
  readonly experimentDefinitionDigest: Digest;
}

interface LoadedRunSnapshot {
  readonly publication: VerifiedBenchmarkPublicationReadSnapshot;
  readonly datasetArtifact: VerificationArtifactHandle;
  readonly dataset: VerificationBenchmarkDataset;
  readonly runnerArtifact: VerificationArtifactHandle;
  readonly run: VerificationBenchmarkRun;
}

export interface VerificationBenchmarkComparisonApplicationResult {
  readonly schemaVersion: "verification-benchmark-comparison-result.v1";
  readonly verificationContractVersion: "verification.v1";
  readonly tenantId: string;
  readonly requestDigest: Digest;
  readonly profile: {
    readonly profileId: VerificationBenchmarkComparisonProfileId;
    readonly version: number;
    readonly artifact: VerificationBenchmarkComparisonProfileArtifactReference;
  };
  readonly baseline: VerificationBenchmarkComparisonResultInputBinding;
  readonly candidate: VerificationBenchmarkComparisonResultInputBinding;
  readonly pairComparisons: readonly { readonly pairId: string; readonly comparison: ComparisonResult }[];
  readonly globalInference: {
    readonly hypothesisFamily: "registered_profile_pair_metric_tests.v1";
    readonly correction: "holm";
    readonly tests: ReturnType<typeof holmAdjustment>;
  };
  readonly engineeringRegressionGate: {
    readonly outcome: "not_requested" | "pass" | "fail";
    readonly primaryMetric: VerificationBenchmarkEngineeringMetric;
    readonly maximumAllowedObservedDecrease: number | null;
    readonly maximumObservedDecrease: number;
    readonly pairObservations: readonly {
      readonly pairId: string;
      readonly delta: number;
      readonly observedDecrease: number;
    }[];
    readonly interpretation: "observed_engineering_threshold_only";
  };
  readonly claimScope: {
    readonly humanGoldQualityClaim: false;
    readonly populationInferenceClaim: false;
    readonly promotionClaim: false;
    readonly calibrationClaim: false;
    readonly sourceAuthorityAssessmentClaim: false;
    readonly clinicalClaim: false;
    readonly limitation: string;
  };
  readonly resultDigest: Digest;
}

export interface PreparedVerificationBenchmarkComparison {
  readonly input: {
    readonly tenantId: string;
    readonly request: CompareBenchmarkRunsRequest;
    readonly profileArtifact: VerificationArtifactHandle;
    readonly profile: VerificationBenchmarkComparisonProfile;
    readonly baseline: LoadedRunSnapshot;
    readonly candidate: LoadedRunSnapshot;
  };
  readonly result: VerificationBenchmarkComparisonApplicationResult;
}

interface PreparationBrand {
  readonly tenantId: string;
  readonly requestDigest: Digest;
  readonly resultDigest: Digest;
}
const preparationBrands = new WeakMap<object, PreparationBrand>();

/** Requires same-process preparation for the exact tenant and public request. */
export function assertPreparedVerificationBenchmarkComparison(
  value: unknown,
  expected: { readonly tenantId: unknown; readonly request: unknown },
): asserts value is PreparedVerificationBenchmarkComparison {
  if (value === null || typeof value !== "object") throw new Error("BENCHMARK_COMPARISON_PREPARATION_REQUIRED");
  const brand = preparationBrands.get(value),
    tenantId = tenant(expected.tenantId);
  let request: CompareBenchmarkRunsRequest;
  try {
    request = CompareBenchmarkRunsRequestSchema.parse(expected.request);
  } catch {
    throw new Error("BENCHMARK_COMPARISON_PREPARATION_IDENTITY_INVALID");
  }
  const requestDigest = digestCanonicalJson(request);
  const prepared = value as PreparedVerificationBenchmarkComparison;
  if (
    !brand ||
    brand.tenantId !== tenantId ||
    brand.requestDigest !== requestDigest ||
    brand.resultDigest !== prepared.result?.resultDigest ||
    prepared.input?.tenantId !== tenantId ||
    digestCanonicalJson(prepared.input.request) !== requestDigest
  ) {
    throw new Error("BENCHMARK_COMPARISON_PREPARATION_IDENTITY_MISMATCH");
  }
}

export class VerificationBenchmarkComparisonApplicationService {
  readonly #maximumArtifactBytes: number;
  readonly #maximumTotalBytes: number;

  constructor(
    private readonly ports: {
      readonly publications: VerifiedBenchmarkPublicationReadPort;
      readonly createResolver: () => TrustedArtifactResolver;
      readonly catalog: VerificationBenchmarkComparisonProfileCatalog;
    },
    config: VerificationBenchmarkComparisonApplicationConfig = {},
  ) {
    this.#maximumArtifactBytes = boundedBytes(
      config.maximumArtifactBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES,
      "ARTIFACT",
    );
    this.#maximumTotalBytes = boundedBytes(config.maximumTotalBytes ?? DEFAULT_MAXIMUM_TOTAL_BYTES, "TOTAL");
    if (this.#maximumTotalBytes < this.#maximumArtifactBytes)
      throw new Error("BENCHMARK_COMPARISON_TOTAL_BYTE_LIMIT_INVALID");
  }

  async prepare(input: {
    readonly tenantId: unknown;
    readonly request: unknown;
    readonly signal?: AbortSignal;
  }): Promise<PreparedVerificationBenchmarkComparison> {
    const tenantId = tenant(input.tenantId);
    let request: CompareBenchmarkRunsRequest;
    try {
      request = CompareBenchmarkRunsRequestSchema.parse(input.request);
    } catch {
      throw new Error("BENCHMARK_COMPARISON_REQUEST_INVALID");
    }
    const assertActive = () => {
      if (input.signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
    };
    assertActive();
    const grant = this.ports.catalog.resolve(tenantId, request.comparisonProfile);
    const bytes = { total: 0 };
    const profileHydration = await this.#hydrate(
      tenantId,
      grant.artifact,
      "PROFILE",
      "verification_admission",
      bytes,
      assertActive,
    );
    const profile = parseProfile(profileHydration.bytes, tenantId, request.comparisonProfile);
    const baselinePublication = await this.ports.publications.loadVerifiedBenchmarkPublication(
      tenantId,
      request.baselineRunId,
    );
    assertActive();
    const candidatePublication = await this.ports.publications.loadVerifiedBenchmarkPublication(
      tenantId,
      request.candidateRunId,
    );
    assertActive();
    const baseline = await this.#loadRun(
      tenantId,
      request.baselineRunId,
      baselinePublication,
      "BASELINE",
      bytes,
      assertActive,
    );
    const candidate = await this.#loadRun(
      tenantId,
      request.candidateRunId,
      candidatePublication,
      "CANDIDATE",
      bytes,
      assertActive,
    );

    for (const pair of profile.armPairs) {
      if (
        !baseline.run.arms.some((arm) => arm.armId === pair.baselineArmId) ||
        !candidate.run.arms.some((arm) => arm.armId === pair.candidateArmId)
      )
        throw new Error(`BENCHMARK_COMPARISON_PROFILE_ARM_BINDING_INVALID:${pair.pairId}`);
    }
    const clusterCount = new Set(
      baseline.dataset.cases.map((testCase) =>
        profile.clusterUnit === "source_family" ? testCase.sourceFamily : testCase.reportCluster,
      ),
    ).size;
    const signFlipAssignments = clusterCount <= 16 ? 2 ** clusterCount : profile.bootstrapReplicates;
    const statisticWork =
      profile.armPairs.length * 9 * clusterCount * (profile.bootstrapReplicates + signFlipAssignments);
    if (!Number.isSafeInteger(statisticWork) || statisticWork > MAXIMUM_TOTAL_STATISTIC_WORK)
      throw new Error("BENCHMARK_COMPARISON_STATISTIC_WORK_BOUND_EXCEEDED");

    const pairComparisons: { pairId: string; comparison: ComparisonResult }[] = [];
    for (const pair of profile.armPairs) {
      assertActive();
      pairComparisons.push({
        pairId: pair.pairId,
        comparison: compareVerificationBenchmarkRuns({
          baseline: { dataset: baseline.dataset, run: baseline.run, armId: pair.baselineArmId },
          candidate: { dataset: candidate.dataset, run: candidate.run, armId: pair.candidateArmId },
          clusterUnit: profile.clusterUnit,
          seed: profile.seed,
          resamples: profile.bootstrapReplicates,
          correction: "none",
        }),
      });
    }
    const rawFamily = pairComparisons.flatMap(({ pairId, comparison }) =>
      comparison.inference.tests.map((test) => ({ id: `${pairId}:${test.id}`, pValue: test.pValue })),
    );
    const tests = holmAdjustment(rawFamily);
    const pairObservations = pairComparisons.map(({ pairId, comparison }) => {
      const delta = comparison.metrics[profile.primaryMetric].delta;
      return { pairId, delta, observedDecrease: Math.max(0, -delta) };
    });
    const maximumObservedDecrease = Math.max(0, ...pairObservations.map((item) => item.observedDecrease));
    const threshold = profile.regressionGate?.maximumAllowedObservedDecrease ?? null;
    const outcome =
      threshold === null
        ? ("not_requested" as const)
        : maximumObservedDecrease <= threshold
          ? ("pass" as const)
          : ("fail" as const);
    const requestDigest = digestCanonicalJson(request);
    const material = {
      schemaVersion: "verification-benchmark-comparison-result.v1" as const,
      verificationContractVersion: "verification.v1" as const,
      tenantId,
      requestDigest,
      profile: { profileId: profile.profileId, version: profile.version, artifact: grant.artifact },
      baseline: resultInputBinding(baseline),
      candidate: resultInputBinding(candidate),
      pairComparisons,
      globalInference: {
        hypothesisFamily: "registered_profile_pair_metric_tests.v1" as const,
        correction: "holm" as const,
        tests,
      },
      engineeringRegressionGate: {
        outcome,
        primaryMetric: profile.primaryMetric,
        maximumAllowedObservedDecrease: threshold,
        maximumObservedDecrease,
        pairObservations,
        interpretation: "observed_engineering_threshold_only" as const,
      },
      claimScope: {
        humanGoldQualityClaim: false as const,
        populationInferenceClaim: false as const,
        promotionClaim: false as const,
        calibrationClaim: false as const,
        sourceAuthorityAssessmentClaim: false as const,
        clinicalClaim: false as const,
        limitation:
          "The registered threshold gates observed paired engineering expectation changes only; it does not establish model quality, population inference, calibration, source authority, clinical correctness, causality, or promotion eligibility.",
      },
    };
    const result = deepFreeze({
      ...material,
      resultDigest: verificationBenchmarkDigest(material),
    }) as VerificationBenchmarkComparisonApplicationResult;
    const prepared = deepFreeze({
      input: { tenantId, request, profileArtifact: profileHydration.registration, profile, baseline, candidate },
      result,
    }) as PreparedVerificationBenchmarkComparison;
    preparationBrands.set(prepared, { tenantId, requestDigest, resultDigest: result.resultDigest });
    return prepared;
  }

  async #loadRun(
    tenantId: string,
    runId: string,
    rawPublication: VerifiedBenchmarkPublicationReadSnapshot,
    side: "BASELINE" | "CANDIDATE",
    bytes: { total: number },
    assertActive: () => void,
  ): Promise<LoadedRunSnapshot> {
    const publication = parsePublication(rawPublication, tenantId, runId, side);
    const datasetHydration = await this.#hydrate(
      tenantId,
      publication.manifest.dataset.artifact,
      `${side}_DATASET`,
      "verification_replay",
      bytes,
      assertActive,
      true,
    );
    let dataset: VerificationBenchmarkDataset;
    try {
      dataset = VerificationBenchmarkDatasetSchema.parse(
        decodeJson(datasetHydration.bytes, `BENCHMARK_COMPARISON_${side}_DATASET_JSON_INVALID`),
      );
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("_JSON_INVALID")) throw error;
      throw new Error(`BENCHMARK_COMPARISON_${side}_DATASET_INVALID`);
    }
    const runnerHydration = await this.#hydrate(
      tenantId,
      publication.manifest.runnerPayload,
      `${side}_RUNNER`,
      "verification_replay",
      bytes,
      assertActive,
      true,
    );
    const run = parseRun(
      decodeJson(runnerHydration.bytes, `BENCHMARK_COMPARISON_${side}_RUNNER_JSON_INVALID`),
      dataset,
      side,
    );
    assertPublicationBindings(publication.manifest, dataset, run, side);
    return deepFreeze({
      publication,
      datasetArtifact: datasetHydration.registration,
      dataset,
      runnerArtifact: runnerHydration.registration,
      run,
    }) as LoadedRunSnapshot;
  }

  async #hydrate(
    tenantId: string,
    expected: VerificationBenchmarkComparisonProfileArtifactReference | VerificationArtifactHandle,
    role: string,
    purpose: "verification_replay" | "verification_admission",
    total: { total: number },
    assertActive: () => void,
    compareFullHandle = false,
  ) {
    assertActive();
    const resolver = this.ports.createResolver();
    await resolver.authorizeArtifact({ tenantId, artifactId: expected.artifactId, purpose });
    assertActive();
    const hydrated = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId });
    assertActive();
    let registration: VerificationArtifactHandle;
    try {
      registration = VerificationArtifactHandleSchema.parse(hydrated.registration);
    } catch {
      throw new Error(`BENCHMARK_COMPARISON_${role}_ARTIFACT_REGISTRATION_INVALID`);
    }
    total.total += hydrated.bytes.byteLength;
    if (
      hydrated.bytes.byteLength > this.#maximumArtifactBytes ||
      total.total > this.#maximumTotalBytes ||
      registration.tenantId !== tenantId ||
      registration.artifactId !== expected.artifactId ||
      registration.digest !== expected.digest ||
      registration.byteLength !== hydrated.bytes.byteLength ||
      sha256Digest(hydrated.bytes) !== registration.digest ||
      (compareFullHandle && canonicalizeJson(registration) !== canonicalizeJson(expected))
    ) {
      throw new Error(`BENCHMARK_COMPARISON_${role}_ARTIFACT_BINDING_INVALID`);
    }
    return { registration, bytes: hydrated.bytes.slice() };
  }
}

function parsePublication(
  raw: VerifiedBenchmarkPublicationReadSnapshot,
  tenantId: string,
  runId: string,
  side: "BASELINE" | "CANDIDATE",
): VerifiedBenchmarkPublicationReadSnapshot {
  let manifest: VerificationBenchmarkPublicationManifest, publicationArtifact: VerificationArtifactHandle;
  try {
    manifest = VerificationBenchmarkPublicationManifestSchema.parse(raw?.manifest);
    publicationArtifact = VerificationArtifactHandleSchema.parse(raw?.publicationArtifact);
  } catch {
    throw new Error(`BENCHMARK_COMPARISON_${side}_PUBLICATION_INVALID`);
  }
  if (
    raw.signatureStatus !== "verified" ||
    manifest.tenantId !== tenantId ||
    manifest.runId !== runId ||
    !manifest.seal.signature ||
    publicationArtifact.tenantId !== tenantId
  )
    throw new Error(`BENCHMARK_COMPARISON_${side}_PUBLICATION_BINDING_INVALID`);
  return deepFreeze({ manifest, publicationArtifact, signatureStatus: "verified" as const });
}

function parseProfile(
  bytes: Uint8Array,
  tenantId: string,
  profileId: VerificationBenchmarkComparisonProfileId,
): VerificationBenchmarkComparisonProfile {
  let profile: VerificationBenchmarkComparisonProfile;
  try {
    profile = VerificationBenchmarkComparisonProfileSchema.parse(
      decodeJson(bytes, "BENCHMARK_COMPARISON_PROFILE_JSON_INVALID"),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "BENCHMARK_COMPARISON_PROFILE_JSON_INVALID") throw error;
    throw new Error("BENCHMARK_COMPARISON_PROFILE_SCHEMA_INVALID");
  }
  if (profile.tenantId !== tenantId || profile.profileId !== profileId)
    throw new Error("BENCHMARK_COMPARISON_PROFILE_IDENTITY_MISMATCH");
  return deepFreeze(profile);
}

function parseRun(
  value: unknown,
  dataset: VerificationBenchmarkDataset,
  side: "BASELINE" | "CANDIDATE",
): VerificationBenchmarkRun {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`BENCHMARK_COMPARISON_${side}_RUNNER_PAYLOAD_INVALID`);
  try {
    summarizeVerificationBenchmark(dataset, value as VerificationBenchmarkRun);
  } catch {
    throw new Error(`BENCHMARK_COMPARISON_${side}_RUNNER_PAYLOAD_INVALID`);
  }
  return value as VerificationBenchmarkRun;
}

function assertPublicationBindings(
  manifest: VerificationBenchmarkPublicationManifest,
  dataset: VerificationBenchmarkDataset,
  run: VerificationBenchmarkRun,
  side: "BASELINE" | "CANDIDATE",
): void {
  const summaries = summarizeVerificationBenchmark(dataset, run);
  const repetitions = run.results.length / (run.arms.length * dataset.cases.length);
  const startedAt = Date.parse(run.startedAt),
    completedAt = Date.parse(run.completedAt);
  if (
    dataset.manifestDigest !== manifest.dataset.manifestDigest ||
    dataset.version !== manifest.dataset.version ||
    dataset.cases.length !== manifest.dataset.caseCount ||
    dataset.labelProvenance !== manifest.dataset.labelProvenance ||
    run.runId !== manifest.runId ||
    run.datasetManifestDigest !== dataset.manifestDigest ||
    run.experimentDefinitionDigest !== manifest.experiment.artifact.digest ||
    run.runnerVersion !== manifest.experiment.runnerVersion ||
    run.randomSeed !== manifest.experiment.randomSeed ||
    repetitions !== manifest.experiment.repetitions ||
    run.startedAt !== manifest.startedAt ||
    run.completedAt !== manifest.completedAt ||
    run.results.some(
      (result) => Date.parse(result.completedAt) < startedAt || Date.parse(result.completedAt) > completedAt,
    ) ||
    run.manifestDigest !== manifest.runnerManifestDigest ||
    run.networkPolicy !== "offline"
  ) {
    throw new Error(`BENCHMARK_COMPARISON_${side}_PUBLICATION_RUN_BINDING_INVALID`);
  }
  const plan = createVerificationBenchmarkCheckpointPlan({
    ...run,
    dataset,
    repetitions: manifest.experiment.repetitions,
  });
  if (plan.planDigest !== manifest.checkpointPlanDigest || run.arms.length !== manifest.arms.length)
    throw new Error(`BENCHMARK_COMPARISON_${side}_CHECKPOINT_PLAN_BINDING_INVALID`);
  for (const arm of run.arms) {
    const published = manifest.arms.find((item) => item.armId === arm.armId),
      summary = summaries.find((item) => item.armId === arm.armId);
    if (
      !published ||
      !summary ||
      published.isControl !== arm.control ||
      published.summaryDigest !== verificationBenchmarkDigest(summary)
    )
      throw new Error(`BENCHMARK_COMPARISON_${side}_ARM_BINDING_INVALID`);
  }
}

function resultInputBinding(value: LoadedRunSnapshot) {
  return {
    runId: value.run.runId,
    operationId: value.publication.manifest.operationId,
    publicationArtifact: {
      artifactId: value.publication.publicationArtifact.artifactId,
      digest: value.publication.publicationArtifact.digest,
    },
    publicationPayloadDigest: value.publication.manifest.seal.payloadDigest,
    datasetArtifact: { artifactId: value.datasetArtifact.artifactId, digest: value.datasetArtifact.digest },
    datasetManifestDigest: value.dataset.manifestDigest,
    experimentArtifact: {
      artifactId: value.publication.manifest.experiment.artifact.artifactId,
      digest: value.publication.manifest.experiment.artifact.digest,
    },
    runnerArtifact: { artifactId: value.runnerArtifact.artifactId, digest: value.runnerArtifact.digest },
    runnerManifestDigest: value.run.manifestDigest,
    experimentDefinitionDigest: value.run.experimentDefinitionDigest,
  };
}

function parseGrant(value: VerificationBenchmarkComparisonProfileGrant): VerificationBenchmarkComparisonProfileGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3)
    throw new Error("BENCHMARK_COMPARISON_PROFILE_TRUSTED_GRANT_INVALID");
  const tenantId = tenant(value?.tenantId);
  let profileId: VerificationBenchmarkComparisonProfileId,
    artifact: VerificationBenchmarkComparisonProfileArtifactReference;
  try {
    profileId = VerificationBenchmarkComparisonProfileSchema.shape.profileId.parse(value?.profileId);
    artifact = VerificationBenchmarkComparisonProfileArtifactReferenceSchema.parse(value?.artifact);
  } catch {
    throw new Error("BENCHMARK_COMPARISON_PROFILE_TRUSTED_GRANT_INVALID");
  }
  return { tenantId, profileId, artifact };
}

function profileKey(tenantId: string, profileId: VerificationBenchmarkComparisonProfileId): string {
  return `${tenantId}:${profileId}`;
}
function tenant(value: unknown): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error("BENCHMARK_COMPARISON_CONTEXT_TENANT_INVALID");
  return parsed.data;
}
function boundedBytes(value: number, role: "ARTIFACT" | "TOTAL"): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024)
    throw new Error(`BENCHMARK_COMPARISON_${role}_BYTE_LIMIT_INVALID`);
  return value;
}
function decodeJson(bytes: Uint8Array, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(code);
  }
}
