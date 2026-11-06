import {
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationSourceCaptureSchema,
  VerificationSourceSchema,
  type VerificationArtifactHandle,
  type VerificationSource,
  type VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import { VERIFICATION_PARSER_LIMITS, type VerificationParserOutput } from "@aiengineer/knowledge-preparation";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { assertFrozenVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import { sha256Digest, type TrustedArtifactResolver } from "@aiengineer/knowledge-verification";
import { z } from "zod";
import {
  VerificationAdmissionService,
  type VerificationAdmissionRepositoryPort,
} from "../admission/verification-admission.js";
import type { AdmittedOfflineBenchmarkInputs } from "./verification-benchmark-inputs.js";
import {
  prepareBenchmarkProjectionDataset,
  type PreparedRegisteredBenchmarkProjections,
} from "./verification-benchmark-projections.js";

/** Public runtime configuration receives ordinary strings and validates them on catalog construction. */
type Digest = string;
type ArtifactReference = { readonly artifactId: string; readonly digest: Digest };

export interface RegisteredBenchmarkSourceImportCopyReference extends ArtifactReference {
  readonly originalArtifactId: string;
}

export interface RegisteredBenchmarkSourceImportGrant {
  readonly tenantId: string;
  readonly dataset: ArtifactReference;
  readonly experiment: ArtifactReference;
  readonly manifest: ArtifactReference;
  readonly copies: readonly RegisteredBenchmarkSourceImportCopyReference[];
}

export interface RegisteredBenchmarkSourceImportResult {
  readonly prepared: PreparedRegisteredBenchmarkProjections;
  readonly importManifest: {
    readonly artifactId: string;
    readonly digest: Digest;
    readonly sourcePreparationDigest: Digest;
    readonly originalTenantId: string;
  };
  readonly mappings: readonly RegisteredBenchmarkSourceImportCopyReference[];
}

const maximumArtifacts = 128,
  maximumManifestBytes = 1024 * 1024,
  maximumArtifactBytes = 8 * 1024 * 1024,
  maximumTotalBytes = 32 * 1024 * 1024;
const historicalDeployment = {
  parserVersion: "verification-native-parser.v1" as const,
  imageDigest: "sha256:1669a3f9674b2e0a70ba1c8686c1cb3647492b8268bdfa7a9a4452fb0530fb37" as `sha256:${string}`,
  limits: VERIFICATION_PARSER_LIMITS,
};

const manifestSchema = z.strictObject({
  schemaVersion: z.literal("verification-offline-source-preparation.v1"),
  scope: z.literal("restricted local preparation; not a labeled benchmark or approved redistribution"),
  exportedAt: z.string().min(1).max(255),
  artifacts: z
    .array(z.strictObject({ file: z.string().min(1).max(512), handle: VerificationArtifactHandleSchema }))
    .min(1)
    .max(maximumArtifacts),
  captures: z
    .array(
      z.strictObject({
        sourceKey: z.string().min(1).max(255),
        source: VerificationSourceSchema,
        capture: VerificationSourceCaptureSchema,
      }),
    )
    .min(1)
    .max(maximumArtifacts),
  checks: z.strictObject({
    completeParentClosure: z.literal(true),
    noParserInvocation: z.literal(true),
    projectionsReadmitted: z.int().nonnegative(),
    registeredArtifactBytesVerified: z.int().nonnegative(),
    sources: z.int().positive(),
  }),
  registryArtifact: VerificationArtifactHandleSchema,
  registryWrapperDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
type SourceManifest = z.infer<typeof manifestSchema>;

/** Trusted runtime mapping for the only imported source archive a benchmark can use. */
export class RegisteredBenchmarkSourceImportCatalog {
  readonly #grants: ReadonlyMap<string, RegisteredBenchmarkSourceImportGrant>;

  constructor(grants: readonly RegisteredBenchmarkSourceImportGrant[]) {
    if (grants.length > 256) throw new Error("BENCHMARK_SOURCE_IMPORT_GRANT_BOUND_EXCEEDED");
    const byPair = new Map<string, RegisteredBenchmarkSourceImportGrant>();
    for (const raw of grants) {
      const grant = parseGrant(raw),
        key = pairKey(grant.tenantId, grant.dataset, grant.experiment);
      if (byPair.has(key)) throw new Error("BENCHMARK_SOURCE_IMPORT_DUPLICATE_TRUSTED_GRANT");
      byPair.set(key, grant);
    }
    this.#grants = byPair;
    Object.freeze(this);
  }

  resolve(
    tenantId: string,
    dataset: ArtifactReference,
    experiment: ArtifactReference,
  ): RegisteredBenchmarkSourceImportGrant {
    const grant = this.#grants.get(pairKey(tenantId, dataset, experiment));
    if (!grant) throw new Error("BENCHMARK_SOURCE_IMPORT_TRUSTED_GRANT_REQUIRED");
    return grant;
  }
}

/**
 * Authenticates imported copies under the benchmark tenant, then exposes the
 * retained original namespace only to a read-only in-memory admission archive.
 */
export class RegisteredBenchmarkSourceImportAdmission {
  constructor(
    private readonly catalog: RegisteredBenchmarkSourceImportCatalog,
    private readonly resolver: TrustedArtifactResolver,
  ) {}

  async prepare(
    admitted: AdmittedOfflineBenchmarkInputs,
    tenantValue: unknown,
    signal?: AbortSignal,
  ): Promise<RegisteredBenchmarkSourceImportResult> {
    const tenantId = parseTenant(tenantValue);
    assertActive(signal);
    const pair = admittedPair(admitted, tenantId);
    const grant = this.catalog.resolve(tenantId, pair.dataset, pair.experiment);
    const importedManifest = await this.#hydrateExact(tenantId, grant.manifest, signal);
    if (
      importedManifest.bytes.byteLength > maximumManifestBytes ||
      importedManifest.registration.mediaType !== "application/json" ||
      importedManifest.registration.digest !== admitted.dataset.sourcePreparationDigest
    ) {
      throw new Error("BENCHMARK_SOURCE_IMPORT_MANIFEST_BINDING_INVALID");
    }
    const manifest = parseManifest(importedManifest.bytes);
    if (
      sha256Digest(importedManifest.bytes) !== admitted.dataset.sourcePreparationDigest ||
      manifest.checks.registeredArtifactBytesVerified !== manifest.artifacts.length
    ) {
      throw new Error("BENCHMARK_SOURCE_IMPORT_MANIFEST_BINDING_INVALID");
    }
    const originalTenantId = validateManifest(manifest);
    const copies = completeMapping(grant.copies, manifest);
    const archiveArtifacts = new Map<
      string,
      { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }
    >();
    let totalBytes = importedManifest.bytes.byteLength;
    for (const copy of copies) {
      const original = manifest.artifacts.find((entry) => entry.handle.artifactId === copy.originalArtifactId)!;
      const imported = await this.#hydrateExact(tenantId, copy, signal);
      totalBytes += imported.bytes.byteLength;
      if (
        totalBytes > maximumTotalBytes ||
        imported.bytes.byteLength !== original.handle.byteLength ||
        copy.digest !== original.handle.digest ||
        sha256Digest(imported.bytes) !== original.handle.digest
      ) {
        throw new Error("BENCHMARK_SOURCE_IMPORT_COPY_BINDING_INVALID");
      }
      archiveArtifacts.set(original.handle.artifactId, { handle: original.handle, bytes: imported.bytes });
    }
    assertActive(signal);
    const captures = new Map(
      manifest.captures.map((entry) => [entry.capture.captureId, { source: entry.source, capture: entry.capture }]),
    );
    const archive = new SourceImportArchive(originalTenantId, archiveArtifacts, captures, signal);
    const admission = new VerificationAdmissionService(
      archive,
      {
        parse: async (): Promise<VerificationParserOutput> => {
          throw new Error("BENCHMARK_SOURCE_IMPORT_PARSER_DISABLED");
        },
      },
      historicalDeployment,
      {
        storageBucket: "offline-read-only",
        producerVersion: "verification-admission.v1",
        encryptionClass: "supabase-managed",
        retentionClass: "verification-audit",
        now: () => new Date(0).toISOString(),
      },
    );
    const prepared = await prepareBenchmarkProjectionDataset(
      admitted.dataset,
      { tenantId: originalTenantId, ...(signal === undefined ? {} : { signal }) },
      { captures: archive, admission },
    );
    assertActive(signal);
    return deepFreeze({
      prepared,
      importManifest: {
        artifactId: grant.manifest.artifactId,
        digest: grant.manifest.digest,
        sourcePreparationDigest: admitted.dataset.sourcePreparationDigest as Digest,
        originalTenantId,
      },
      mappings: copies.map((copy) => ({ ...copy })),
    }) as RegisteredBenchmarkSourceImportResult;
  }

  async #hydrateExact(
    tenantId: string,
    reference: ArtifactReference,
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
      hydrated.bytes.byteLength > maximumArtifactBytes ||
      registration.tenantId !== tenantId ||
      registration.artifactId !== reference.artifactId ||
      registration.digest !== reference.digest ||
      registration.byteLength !== hydrated.bytes.byteLength ||
      sha256Digest(hydrated.bytes) !== registration.digest
    ) {
      throw new Error("BENCHMARK_SOURCE_IMPORT_ARTIFACT_REGISTRATION_MISMATCH");
    }
    return { registration, bytes: hydrated.bytes.slice() };
  }
}

/** No outside resolver, parser, or write path can reach the historical namespace. */
class SourceImportArchive implements VerificationAdmissionRepositoryPort {
  constructor(
    private readonly originalTenantId: string,
    private readonly artifacts: ReadonlyMap<
      string,
      { readonly handle: VerificationArtifactHandle; readonly bytes: Uint8Array }
    >,
    private readonly captures: ReadonlyMap<
      string,
      { readonly source: VerificationSource; readonly capture: VerificationSourceCapture }
    >,
    private readonly signal?: AbortSignal,
  ) {}

  createTrustedArtifactResolver(): TrustedArtifactResolver {
    const tickets = new Set<string>();
    return {
      authorizeArtifact: async ({ tenantId, artifactId }) => {
        assertActive(this.signal);
        const item = this.artifacts.get(artifactId);
        if (tenantId !== this.originalTenantId || !item || item.handle.tenantId !== this.originalTenantId)
          throw new Error("BENCHMARK_SOURCE_IMPORT_ARCHIVE_NOT_AUTHORIZED");
        tickets.add(artifactId);
      },
      hydrateRegisteredArtifact: async ({ tenantId, artifactId }) => {
        assertActive(this.signal);
        const item = this.artifacts.get(artifactId);
        if (
          tenantId !== this.originalTenantId ||
          !item ||
          item.handle.tenantId !== this.originalTenantId ||
          !tickets.delete(artifactId)
        )
          throw new Error("BENCHMARK_SOURCE_IMPORT_ARCHIVE_MISSING");
        if (item.bytes.byteLength !== item.handle.byteLength || sha256Digest(item.bytes) !== item.handle.digest)
          throw new Error("BENCHMARK_SOURCE_IMPORT_ARCHIVE_DIGEST_MISMATCH");
        return { registration: item.handle, bytes: item.bytes.slice() };
      },
    };
  }

  async getRegisteredCapture(input: {
    readonly tenantId: string;
    readonly captureId: string;
  }): Promise<{ source: VerificationSource; capture: VerificationSourceCapture }> {
    assertActive(this.signal);
    const item = this.captures.get(input.captureId);
    if (
      input.tenantId !== this.originalTenantId ||
      !item ||
      item.capture.contentArtifact.tenantId !== this.originalTenantId ||
      item.source.sourceId !== item.capture.sourceId
    )
      throw new Error("BENCHMARK_SOURCE_IMPORT_ARCHIVE_CAPTURE_MISSING");
    return item;
  }

  async registerContentAddressedArtifact(): Promise<VerificationArtifactHandle> {
    throw new Error("BENCHMARK_SOURCE_IMPORT_ARCHIVE_READ_ONLY");
  }
}

function admittedPair(
  admitted: AdmittedOfflineBenchmarkInputs,
  tenantId: string,
): { readonly dataset: ArtifactReference; readonly experiment: ArtifactReference } {
  try {
    assertFrozenVerificationBenchmarkDataset(admitted.dataset);
  } catch {
    throw new Error("BENCHMARK_SOURCE_IMPORT_ADMITTED_BINDING_INVALID");
  }
  const dataset = reference(admitted?.datasetArtifact, "ADMITTED_DATASET"),
    experiment = reference(admitted?.experimentArtifact, "ADMITTED_EXPERIMENT");
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
    throw new Error("BENCHMARK_SOURCE_IMPORT_ADMITTED_BINDING_INVALID");
  return { dataset, experiment };
}

function parseGrant(raw: RegisteredBenchmarkSourceImportGrant): RegisteredBenchmarkSourceImportGrant {
  const tenantId = parseTenant(raw?.tenantId),
    dataset = reference(raw?.dataset, "GRANT_DATASET"),
    experiment = reference(raw?.experiment, "GRANT_EXPERIMENT"),
    manifest = reference(raw?.manifest, "GRANT_MANIFEST");
  if (!Array.isArray(raw?.copies) || raw.copies.length < 1 || raw.copies.length > maximumArtifacts)
    throw new Error("BENCHMARK_SOURCE_IMPORT_TRUSTED_GRANT_INVALID");
  const originalIds = new Set<string>(),
    importedDigests = new Map<string, string>();
  const copies = raw.copies.map((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      typeof value.originalArtifactId !== "string"
    )
      throw new Error("BENCHMARK_SOURCE_IMPORT_TRUSTED_GRANT_INVALID");
    const originalArtifactId = UuidSchema.safeParse(value.originalArtifactId),
      imported = reference(value, "GRANT_COPY");
    if (
      !originalArtifactId.success ||
      originalIds.has(originalArtifactId.data) ||
      (importedDigests.has(imported.artifactId) && importedDigests.get(imported.artifactId) !== imported.digest)
    )
      throw new Error("BENCHMARK_SOURCE_IMPORT_TRUSTED_GRANT_INVALID");
    originalIds.add(originalArtifactId.data);
    importedDigests.set(imported.artifactId, imported.digest);
    return Object.freeze({ originalArtifactId: originalArtifactId.data, ...imported });
  });
  return Object.freeze({
    tenantId,
    dataset: Object.freeze(dataset),
    experiment: Object.freeze(experiment),
    manifest: Object.freeze(manifest),
    copies: Object.freeze(copies),
  });
}

function parseManifest(bytes: Uint8Array): SourceManifest {
  try {
    return manifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
  } catch {
    throw new Error("BENCHMARK_SOURCE_IMPORT_MANIFEST_SCHEMA_INVALID");
  }
}

function validateManifest(manifest: SourceManifest): string {
  const artifacts = new Set<string>(),
    captures = new Set<string>(),
    sourceTenantIds = new Set<string>();
  for (const item of manifest.artifacts) {
    if (artifacts.has(item.handle.artifactId) || item.handle.byteLength > maximumArtifactBytes)
      throw new Error("BENCHMARK_SOURCE_IMPORT_MANIFEST_SCHEMA_INVALID");
    artifacts.add(item.handle.artifactId);
    sourceTenantIds.add(item.handle.tenantId);
  }
  if (
    !artifacts.has(manifest.registryArtifact.artifactId) ||
    !sameHandle(
      manifest.registryArtifact,
      manifest.artifacts.find((item) => item.handle.artifactId === manifest.registryArtifact.artifactId)!.handle,
    )
  )
    throw new Error("BENCHMARK_SOURCE_IMPORT_MANIFEST_SCHEMA_INVALID");
  for (const item of manifest.artifacts)
    if (item.handle.parentArtifactIds.some((parentId) => !artifacts.has(parentId)))
      throw new Error("BENCHMARK_SOURCE_IMPORT_MANIFEST_PARENT_CLOSURE_INVALID");
  for (const item of manifest.captures) {
    const content = manifest.artifacts.find(
      (artifact) => artifact.handle.artifactId === item.capture.contentArtifact.artifactId,
    )?.handle;
    if (
      captures.has(item.capture.captureId) ||
      item.source.sourceId !== item.capture.sourceId ||
      !content ||
      !sameHandle(content, item.capture.contentArtifact)
    )
      throw new Error("BENCHMARK_SOURCE_IMPORT_MANIFEST_SCHEMA_INVALID");
    captures.add(item.capture.captureId);
    sourceTenantIds.add(item.capture.contentArtifact.tenantId);
  }
  if (sourceTenantIds.size !== 1) throw new Error("BENCHMARK_SOURCE_IMPORT_ORIGINAL_TENANT_INVALID");
  return sourceTenantIds.values().next().value!;
}

function completeMapping(
  raw: readonly RegisteredBenchmarkSourceImportCopyReference[],
  manifest: SourceManifest,
): readonly RegisteredBenchmarkSourceImportCopyReference[] {
  const originalIds = new Set(manifest.artifacts.map((item) => item.handle.artifactId));
  if (raw.length !== originalIds.size || raw.some((copy) => !originalIds.has(copy.originalArtifactId)))
    throw new Error("BENCHMARK_SOURCE_IMPORT_COPY_GRANT_INCOMPLETE");
  return raw;
}

function reference(value: unknown, field: string): ArtifactReference {
  const handle = VerificationArtifactHandleSchema.safeParse(value);
  if (handle.success) return { artifactId: handle.data.artifactId, digest: handle.data.digest };
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).filter((key) => key !== "originalArtifactId").length !== 2 ||
    typeof (value as Record<string, unknown>).artifactId !== "string" ||
    typeof (value as Record<string, unknown>).digest !== "string"
  )
    throw new Error(`BENCHMARK_SOURCE_IMPORT_${field}_INVALID`);
  const artifactId = UuidSchema.safeParse((value as { artifactId: string }).artifactId),
    digest = (value as { digest: string }).digest;
  if (!artifactId.success || !/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new Error(`BENCHMARK_SOURCE_IMPORT_${field}_INVALID`);
  return { artifactId: artifactId.data, digest: digest as Digest };
}

function parseTenant(value: unknown): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error("BENCHMARK_SOURCE_IMPORT_CONTEXT_TENANT_INVALID");
  return parsed.data;
}
function pairKey(tenantId: string, dataset: ArtifactReference, experiment: ArtifactReference): string {
  return `${tenantId}:${dataset.artifactId}:${dataset.digest}:${experiment.artifactId}:${experiment.digest}`;
}
function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
}
function sameHandle(left: VerificationArtifactHandle, right: VerificationArtifactHandle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
