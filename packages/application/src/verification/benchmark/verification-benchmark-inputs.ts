import {
  RunBenchmarkRequestSchema,
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationBenchmarkDatasetSchema,
  VerificationBenchmarkExperimentDefinitionSchema,
  type RunBenchmarkRequest,
  type VerificationArtifactHandle,
  type VerificationBenchmarkDataset,
  type VerificationBenchmarkExperimentDefinition,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { assertFrozenVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import { sha256Digest, type TrustedArtifactResolver } from "@aiengineer/knowledge-verification";

type ArtifactReference = { readonly artifactId: string; readonly digest: string };

export interface OfflineBenchmarkInputGrant {
  readonly tenantId: string;
  readonly dataset: ArtifactReference;
  readonly experiment: ArtifactReference;
  readonly runnerVersion: string;
}

export interface OfflineBenchmarkInputAdmissionConfig {
  readonly maximumArtifactBytes?: number;
  readonly maximumExecutions?: number;
}

/**
 * The public request has no profile field. This is the only authority for the
 * dataset/experiment pair and its runner, supplied by trusted runtime config.
 */
export class OfflineBenchmarkInputCatalog {
  readonly #grants: ReadonlyMap<string, OfflineBenchmarkInputGrant>;

  constructor(grants: readonly OfflineBenchmarkInputGrant[]) {
    const byKey = new Map<string, OfflineBenchmarkInputGrant>();
    for (const value of grants) {
      const grant = parseGrant(value);
      const key = grantKey(grant.tenantId, grant.dataset, grant.experiment);
      if (byKey.has(key)) throw new Error("BENCHMARK_INPUT_DUPLICATE_TRUSTED_GRANT");
      byKey.set(
        key,
        Object.freeze({
          ...grant,
          dataset: Object.freeze({ ...grant.dataset }),
          experiment: Object.freeze({ ...grant.experiment }),
        }),
      );
    }
    this.#grants = byKey;
    Object.freeze(this);
  }

  resolve(tenantId: string, request: RunBenchmarkRequest): OfflineBenchmarkInputGrant {
    const grant = this.#grants.get(grantKey(tenantId, request.dataset, request.experimentDefinition));
    if (!grant) throw new Error("BENCHMARK_INPUT_TRUSTED_GRANT_REQUIRED");
    return grant;
  }
}

/** Inputs are runnable only after the worker hydrates and validates recorded observations. */
export interface AdmittedOfflineBenchmarkInputs {
  readonly request: RunBenchmarkRequest;
  readonly grant: OfflineBenchmarkInputGrant;
  readonly dataset: VerificationBenchmarkDataset;
  readonly datasetArtifact: VerificationArtifactHandle;
  readonly experiment: VerificationBenchmarkExperimentDefinition;
  readonly experimentArtifact: VerificationArtifactHandle;
}

/**
 * Authenticates the frozen dataset and the separate offline-only experiment
 * definition. It does not hydrate recorded observations; that belongs to the
 * bounded worker executor which consumes this typed admission.
 */
export class RegisteredBenchmarkInputAdmission {
  readonly #maximumArtifactBytes: number;
  readonly #maximumExecutions: number;

  constructor(
    private readonly catalog: OfflineBenchmarkInputCatalog,
    private readonly artifactResolver: TrustedArtifactResolver,
    config: OfflineBenchmarkInputAdmissionConfig = {},
  ) {
    const maximumArtifactBytes = config.maximumArtifactBytes ?? 4 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maximumArtifactBytes) ||
      maximumArtifactBytes < 1 ||
      maximumArtifactBytes > 16 * 1024 * 1024
    ) {
      throw new Error("BENCHMARK_INPUT_ARTIFACT_LIMIT_INVALID");
    }
    this.#maximumArtifactBytes = maximumArtifactBytes;
    const maximumExecutions = config.maximumExecutions ?? 4_000;
    if (!Number.isSafeInteger(maximumExecutions) || maximumExecutions < 1 || maximumExecutions > 160_000) {
      throw new Error("BENCHMARK_INPUT_EXECUTION_LIMIT_INVALID");
    }
    this.#maximumExecutions = maximumExecutions;
  }

  async load(
    requestValue: unknown,
    contextValue: { readonly tenantId: unknown },
  ): Promise<AdmittedOfflineBenchmarkInputs> {
    const request = RunBenchmarkRequestSchema.parse(requestValue);
    const tenantId = tenant(contextValue?.tenantId);
    const grant = this.catalog.resolve(tenantId, request);
    const datasetHydration = await this.#hydrateExact(tenantId, request.dataset);
    const dataset = VerificationBenchmarkDatasetSchema.parse(
      decodeJson(datasetHydration.bytes, "BENCHMARK_INPUT_DATASET_JSON_INVALID"),
    );
    assertFrozenVerificationBenchmarkDataset(dataset);
    const experimentHydration = await this.#hydrateExact(tenantId, request.experimentDefinition);
    const experiment = VerificationBenchmarkExperimentDefinitionSchema.parse(
      decodeJson(experimentHydration.bytes, "BENCHMARK_INPUT_EXPERIMENT_JSON_INVALID"),
    );
    if (
      experiment.datasetManifestDigest !== dataset.manifestDigest ||
      experiment.runnerVersion !== grant.runnerVersion
    ) {
      throw new Error("BENCHMARK_INPUT_EXPERIMENT_BINDING_MISMATCH");
    }
    if (dataset.cases.length * experiment.arms.length * experiment.repetitions > this.#maximumExecutions) {
      throw new Error("BENCHMARK_INPUT_EXECUTION_LIMIT_EXCEEDED");
    }
    return deepFreeze({
      request,
      grant,
      dataset,
      datasetArtifact: datasetHydration.registration,
      experiment,
      experimentArtifact: experimentHydration.registration,
    }) as AdmittedOfflineBenchmarkInputs;
  }

  async #hydrateExact(
    tenantId: string,
    expected: ArtifactReference,
  ): Promise<{ readonly registration: VerificationArtifactHandle; readonly bytes: Uint8Array }> {
    await this.artifactResolver.authorizeArtifact({
      tenantId,
      artifactId: expected.artifactId,
      purpose: "verification_admission",
    });
    const hydrated = await this.artifactResolver.hydrateRegisteredArtifact({
      tenantId,
      artifactId: expected.artifactId,
    });
    const registration = VerificationArtifactHandleSchema.parse(hydrated.registration);
    if (
      hydrated.bytes.byteLength > this.#maximumArtifactBytes ||
      registration.tenantId !== tenantId ||
      registration.artifactId !== expected.artifactId ||
      registration.digest !== expected.digest ||
      registration.byteLength !== hydrated.bytes.byteLength ||
      sha256Digest(hydrated.bytes) !== registration.digest
    ) {
      throw new Error("BENCHMARK_INPUT_ARTIFACT_REGISTRATION_MISMATCH");
    }
    return { registration, bytes: hydrated.bytes.slice() };
  }
}

function grantKey(tenantId: string, dataset: ArtifactReference, experiment: ArtifactReference): string {
  return `${tenantId}:${dataset.artifactId}:${dataset.digest}:${experiment.artifactId}:${experiment.digest}`;
}

function tenant(value: unknown): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error("BENCHMARK_INPUT_CONTEXT_TENANT_INVALID");
  return parsed.data;
}

function parseGrant(value: OfflineBenchmarkInputGrant): OfflineBenchmarkInputGrant {
  const tenantId = tenant(value?.tenantId);
  const dataset = artifactReference(value?.dataset, "dataset");
  const experiment = artifactReference(value?.experiment, "experiment");
  if (typeof value?.runnerVersion !== "string" || value.runnerVersion.length < 1 || value.runnerVersion.length > 255) {
    throw new Error("BENCHMARK_INPUT_TRUSTED_GRANT_INVALID");
  }
  return { tenantId, dataset, experiment, runnerVersion: value.runnerVersion };
}

function artifactReference(value: unknown, field: string): ArtifactReference {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`BENCHMARK_INPUT_TRUSTED_GRANT_${field.toUpperCase()}_INVALID`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.artifactId !== "string" || typeof record.digest !== "string")
    throw new Error(`BENCHMARK_INPUT_TRUSTED_GRANT_${field.toUpperCase()}_INVALID`);
  const artifactId = UuidSchema.safeParse(record.artifactId);
  if (!artifactId.success || !/^sha256:[a-f0-9]{64}$/u.test(record.digest))
    throw new Error(`BENCHMARK_INPUT_TRUSTED_GRANT_${field.toUpperCase()}_INVALID`);
  return { artifactId: artifactId.data, digest: record.digest };
}

function decodeJson(bytes: Uint8Array, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(code);
  }
}
