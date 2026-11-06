import {
  UuidSchema,
  VerificationArtifactHandleSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  assertFrozenVerificationBenchmarkDataset,
  verificationBenchmarkDigest,
} from "@aiengineer/knowledge-evaluation";
import { sha256Digest, type TrustedArtifactResolver } from "@aiengineer/knowledge-verification";
import {
  admitDiagnosticsExtractionExperimentFiles,
  DIAGNOSTICS_PILOT_V4_SEAL,
  type DiagnosticsExtractionAuthority,
} from "./verification-benchmark.js";
import type { AdmittedOfflineBenchmarkInputs } from "./verification-benchmark-inputs.js";

export interface RegisteredBenchmarkProfileArtifactReference {
  readonly name: string;
  readonly artifactId: string;
  readonly digest: string;
}
export interface RegisteredBenchmarkProfileGrant {
  readonly tenantId: string;
  readonly dataset: { readonly artifactId: string; readonly digest: string };
  readonly experiment: { readonly artifactId: string; readonly digest: string };
  readonly profileFiles: readonly RegisteredBenchmarkProfileArtifactReference[];
}

const essentialProfileNames = [
  "manifest.json",
  "dataset.json",
  "derived-input-grant.json",
  "case-artifact-registry.json",
  "experiments/extraction-v1/manifest.json",
  "experiments/extraction-v1/output-schema.json",
] as const;
const maximumFiles = 128,
  maximumFileBytes = 8 * 1024 * 1024,
  maximumTotalBytes = 32 * 1024 * 1024;
type ArtifactReference = { readonly artifactId: string; readonly digest: string };

/** Runtime-owned mapping from a public offline benchmark pair to V4 profile bytes. */
export class RegisteredBenchmarkProfileCatalog {
  readonly #grants: ReadonlyMap<string, RegisteredBenchmarkProfileGrant>;

  constructor(grants: readonly RegisteredBenchmarkProfileGrant[]) {
    if (grants.length > 256) throw new Error("BENCHMARK_PROFILE_GRANT_BOUND_EXCEEDED");
    const byPair = new Map<string, RegisteredBenchmarkProfileGrant>();
    for (const raw of grants) {
      const grant = parseGrant(raw),
        key = pairKey(grant.tenantId, grant.dataset, grant.experiment);
      if (byPair.has(key)) throw new Error("BENCHMARK_PROFILE_DUPLICATE_TRUSTED_GRANT");
      byPair.set(key, grant);
    }
    this.#grants = byPair;
    Object.freeze(this);
  }

  resolve(
    tenantId: string,
    dataset: ArtifactReference,
    experiment: ArtifactReference,
  ): RegisteredBenchmarkProfileGrant {
    const grant = this.#grants.get(pairKey(tenantId, dataset, experiment));
    if (!grant) throw new Error("BENCHMARK_PROFILE_TRUSTED_GRANT_REQUIRED");
    return grant;
  }
}

export interface AdmittedRegisteredBenchmarkProfile {
  readonly authority: DiagnosticsExtractionAuthority;
  readonly sealedExperiment: ReturnType<typeof admitDiagnosticsExtractionExperimentFiles>["experiment"];
  readonly profileFiles: readonly RegisteredBenchmarkProfileArtifactReference[];
}

/**
 * Admits only registered V4 profile bytes. It never turns profile files into a
 * filesystem path or returns their contents.
 */
export class RegisteredBenchmarkProfileAdmission {
  constructor(
    private readonly catalog: RegisteredBenchmarkProfileCatalog,
    private readonly resolver: TrustedArtifactResolver,
  ) {}

  async load(
    admitted: AdmittedOfflineBenchmarkInputs,
    tenantValue: unknown,
    signal?: AbortSignal,
  ): Promise<AdmittedRegisteredBenchmarkProfile> {
    const tenantId = parseTenant(tenantValue);
    assertActive(signal);
    const pair = admittedPair(admitted, tenantId);
    const grant = this.catalog.resolve(tenantId, pair.dataset, pair.experiment);
    const fileByName = new Map(grant.profileFiles.map((reference) => [reference.name, reference]));
    const manifestReference = fileByName.get("manifest.json");
    if (!manifestReference) throw new Error("BENCHMARK_PROFILE_MANIFEST_GRANT_REQUIRED");
    const manifest = await this.#hydrateExact(tenantId, manifestReference, signal);
    const expectedNames = expectedProfileNames(manifest.bytes);
    if (
      expectedNames.size > maximumFiles ||
      fileByName.size !== expectedNames.size ||
      [...expectedNames].some((name) => !fileByName.has(name))
    ) {
      throw new Error("BENCHMARK_PROFILE_FILE_GRANT_BINDING_INVALID");
    }
    const files = new Map<string, Uint8Array>([["manifest.json", manifest.bytes]]);
    let totalBytes = manifest.bytes.byteLength;
    for (const name of [...expectedNames].sort()) {
      if (name === "manifest.json") continue;
      const reference = fileByName.get(name)!;
      const hydrated = await this.#hydrateExact(tenantId, reference, signal);
      totalBytes += hydrated.bytes.byteLength;
      if (totalBytes > maximumTotalBytes) throw new Error("BENCHMARK_PROFILE_TOTAL_BYTE_BOUND_EXCEEDED");
      files.set(name, hydrated.bytes);
    }
    assertActive(signal);
    const sealed = admitDiagnosticsExtractionExperimentFiles(files);
    if (
      sealed.dataset.manifestDigest !== admitted.dataset.manifestDigest ||
      admitted.experiment.networkPolicy !== "offline"
    ) {
      throw new Error("BENCHMARK_PROFILE_ADMITTED_BINDING_INVALID");
    }
    return deepFreeze({
      authority: sealed.authority,
      sealedExperiment: sealed.experiment,
      profileFiles: grant.profileFiles.map((reference) => ({ ...reference })),
    }) as AdmittedRegisteredBenchmarkProfile;
  }

  async #hydrateExact(
    tenantId: string,
    reference: RegisteredBenchmarkProfileArtifactReference,
    signal?: AbortSignal,
  ): Promise<{ readonly registration: VerificationArtifactHandle; readonly bytes: Uint8Array }> {
    assertActive(signal);
    await this.resolver.authorizeArtifact({
      tenantId,
      artifactId: reference.artifactId,
      purpose: "verification_admission",
    });
    assertActive(signal);
    const hydrated = await this.resolver.hydrateRegisteredArtifact({ tenantId, artifactId: reference.artifactId });
    assertActive(signal);
    const registration = VerificationArtifactHandleSchema.parse(hydrated.registration);
    if (
      hydrated.bytes.byteLength > maximumFileBytes ||
      registration.tenantId !== tenantId ||
      registration.artifactId !== reference.artifactId ||
      registration.digest !== reference.digest ||
      registration.byteLength !== hydrated.bytes.byteLength ||
      sha256Digest(hydrated.bytes) !== registration.digest
    ) {
      throw new Error("BENCHMARK_PROFILE_ARTIFACT_REGISTRATION_MISMATCH");
    }
    return { registration, bytes: hydrated.bytes.slice() };
  }
}

function admittedPair(
  admitted: AdmittedOfflineBenchmarkInputs,
  tenantId: string,
): { readonly dataset: ArtifactReference; readonly experiment: ArtifactReference } {
  try {
    assertFrozenVerificationBenchmarkDataset(admitted.dataset);
  } catch {
    throw new Error("BENCHMARK_PROFILE_ADMITTED_BINDING_INVALID");
  }
  const dataset = artifactReference(admitted?.datasetArtifact, "ADMITTED_DATASET");
  const experiment = artifactReference(admitted?.experimentArtifact, "ADMITTED_EXPERIMENT");
  if (
    admitted.grant.tenantId !== tenantId ||
    admitted.datasetArtifact.tenantId !== tenantId ||
    admitted.experimentArtifact.tenantId !== tenantId ||
    admitted.request.dataset.artifactId !== dataset.artifactId ||
    admitted.request.dataset.digest !== dataset.digest ||
    admitted.request.experimentDefinition.artifactId !== experiment.artifactId ||
    admitted.request.experimentDefinition.digest !== experiment.digest ||
    admitted.grant.dataset.artifactId !== dataset.artifactId ||
    admitted.grant.dataset.digest !== dataset.digest ||
    admitted.grant.experiment.artifactId !== experiment.artifactId ||
    admitted.grant.experiment.digest !== experiment.digest ||
    admitted.experiment.datasetManifestDigest !== admitted.dataset.manifestDigest ||
    admitted.experiment.networkPolicy !== "offline"
  )
    throw new Error("BENCHMARK_PROFILE_ADMITTED_BINDING_INVALID");
  return { dataset, experiment };
}

function expectedProfileNames(manifestBytes: Uint8Array): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("BENCHMARK_PROFILE_MANIFEST_JSON_INVALID");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).files)
  )
    throw new Error("BENCHMARK_PROFILE_MANIFEST_SCHEMA_INVALID");
  const manifest = parsed as Record<string, unknown>;
  const { manifestDigest, ...material } = manifest;
  if (
    manifestDigest !== DIAGNOSTICS_PILOT_V4_SEAL.catalogManifestDigest ||
    verificationBenchmarkDigest(material) !== manifestDigest
  )
    throw new Error("BENCHMARK_PROFILE_CATALOG_SEAL_MISMATCH");
  const names = new Set<string>(essentialProfileNames);
  for (const raw of (parsed as { files: unknown[] }).files) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      typeof (raw as Record<string, unknown>).name !== "string"
    )
      throw new Error("BENCHMARK_PROFILE_MANIFEST_SCHEMA_INVALID");
    const name = (raw as { name: string }).name;
    if (!name.length || name.length > 255 || names.has(name)) {
      if (names.has(name) && essentialProfileNames.includes(name as (typeof essentialProfileNames)[number])) continue;
      throw new Error("BENCHMARK_PROFILE_MANIFEST_SCHEMA_INVALID");
    }
    names.add(name);
  }
  return names;
}

function parseGrant(value: RegisteredBenchmarkProfileGrant): RegisteredBenchmarkProfileGrant {
  const tenantId = parseTenant(value?.tenantId),
    dataset = artifactReference(value?.dataset, "GRANT_DATASET"),
    experiment = artifactReference(value?.experiment, "GRANT_EXPERIMENT");
  if (
    !Array.isArray(value?.profileFiles) ||
    value.profileFiles.length < essentialProfileNames.length ||
    value.profileFiles.length > maximumFiles
  )
    throw new Error("BENCHMARK_PROFILE_TRUSTED_GRANT_INVALID");
  const names = new Set<string>();
  const profileFiles = value.profileFiles.map((raw) => {
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 3 ||
      typeof raw.name !== "string" ||
      !raw.name.length ||
      raw.name.length > 255 ||
      names.has(raw.name)
    )
      throw new Error("BENCHMARK_PROFILE_TRUSTED_GRANT_INVALID");
    names.add(raw.name);
    return Object.freeze({ name: raw.name, ...artifactReference(raw, "GRANT_PROFILE_FILE") });
  });
  if (essentialProfileNames.some((name) => !names.has(name)))
    throw new Error("BENCHMARK_PROFILE_ESSENTIAL_FILE_GRANT_REQUIRED");
  return Object.freeze({
    tenantId,
    dataset: Object.freeze(dataset),
    experiment: Object.freeze(experiment),
    profileFiles: Object.freeze(profileFiles),
  });
}

function artifactReference(value: unknown, code: string): ArtifactReference {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).artifactId !== "string" ||
    typeof (value as Record<string, unknown>).digest !== "string"
  )
    throw new Error(`BENCHMARK_PROFILE_${code}_INVALID`);
  const artifactId = UuidSchema.safeParse((value as { artifactId: string }).artifactId),
    digest = (value as { digest: string }).digest;
  if (!artifactId.success || !/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new Error(`BENCHMARK_PROFILE_${code}_INVALID`);
  return { artifactId: artifactId.data, digest };
}

function parseTenant(value: unknown): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error("BENCHMARK_PROFILE_CONTEXT_TENANT_INVALID");
  return parsed.data;
}

function pairKey(tenantId: string, dataset: ArtifactReference, experiment: ArtifactReference): string {
  return `${tenantId}:${dataset.artifactId}:${dataset.digest}:${experiment.artifactId}:${experiment.digest}`;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
}
