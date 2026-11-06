import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { diagnosticsBenchmarkArms } from "./verification-benchmark.js";
import { OfflineBenchmarkInputCatalog, RegisteredBenchmarkInputAdmission } from "./verification-benchmark-inputs.js";
import {
  RegisteredBenchmarkSourceImportAdmission,
  RegisteredBenchmarkSourceImportCatalog,
  type RegisteredBenchmarkSourceImportGrant,
} from "./verification-benchmark-source-import.js";

const benchmarkTenant = "11111111-1111-4111-8111-111111111111",
  now = "2026-09-05T12:00:00.000Z";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf8", { fatal: true });
const catalogDirectory = new URL(
  "../../../../../catalog/verification-benchmarks/diagnostics-companies-pilot-v4/",
  import.meta.url,
);
const sourceDirectory = new URL(
  "../../../../../catalog/verification-assets/50a3552cffc639a78d7789865be929baefd64d2342431e2de958e669c21f163e/",
  import.meta.url,
);

interface RecordValue {
  registration: VerificationArtifactHandle;
  bytes: Uint8Array;
}
interface SourceManifest {
  artifacts: Array<{ file: string; handle: VerificationArtifactHandle }>;
}

async function fixture() {
  let sequence = 1;
  const records = new Map<string, RecordValue>();
  const importedIds = new Set<string>();
  function register(bytes: Uint8Array, mediaType = "application/json"): VerificationArtifactHandle {
    const artifactId = `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
    const registration: VerificationArtifactHandle = {
      artifactId,
      tenantId: benchmarkTenant,
      digest: sha256Digest(bytes),
      mediaType,
      byteLength: bytes.byteLength,
      objectKey: `private/${artifactId}`,
      createdAt: now,
      producerActivityId: "fixture-source-import",
      producerVersion: "v1",
      encryptionClass: "managed",
      retentionClass: "audit",
      dataClassification: "restricted",
      parentArtifactIds: [],
    };
    records.set(artifactId, { registration, bytes });
    importedIds.add(artifactId);
    return registration;
  }
  const datasetBytes = new Uint8Array(await readFile(new URL("dataset.json", catalogDirectory)));
  const dataset = JSON.parse(decoder.decode(datasetBytes));
  const datasetArtifact = register(datasetBytes);
  const experimentBytes = encoder.encode(
    JSON.stringify({
      schemaVersion: "verification-benchmark-experiment.v1",
      verificationContractVersion: "verification.v1",
      experimentId: "00000000-0000-4000-8000-000000009999",
      datasetManifestDigest: dataset.manifestDigest,
      runnerVersion: "verification-benchmark-runner.v1",
      randomSeed: 7,
      repetitions: 1,
      arms: diagnosticsBenchmarkArms(),
      networkPolicy: "offline",
      recordedObservationArtifacts: [],
    }),
  );
  const experimentArtifact = register(experimentBytes);
  const inputGrant = {
    tenantId: benchmarkTenant,
    dataset: { artifactId: datasetArtifact.artifactId, digest: datasetArtifact.digest },
    experiment: { artifactId: experimentArtifact.artifactId, digest: experimentArtifact.digest },
    runnerVersion: "verification-benchmark-runner.v1",
  };
  const resolver = {
    authorizeArtifact: vi.fn(async ({ tenantId, artifactId }: { tenantId: string; artifactId: string }) => {
      if (tenantId !== benchmarkTenant || !records.has(artifactId)) throw new Error("NO_LIVE_SOURCE_FALLBACK");
    }),
    hydrateRegisteredArtifact: vi.fn(async ({ tenantId, artifactId }: { tenantId: string; artifactId: string }) => {
      if (tenantId !== benchmarkTenant || !records.has(artifactId)) throw new Error("NO_LIVE_SOURCE_FALLBACK");
      return records.get(artifactId)!;
    }),
  };
  const admitted = await new RegisteredBenchmarkInputAdmission(
    new OfflineBenchmarkInputCatalog([inputGrant]),
    resolver,
  ).load(
    {
      verificationContractVersion: "verification.v1",
      dataset: inputGrant.dataset,
      experimentDefinition: inputGrant.experiment,
      executionMode: "offline_recorded",
    },
    { tenantId: benchmarkTenant },
  );
  const manifestBytes = new Uint8Array(await readFile(new URL("manifest.json", sourceDirectory)));
  const manifest = JSON.parse(decoder.decode(manifestBytes)) as SourceManifest;
  const manifestArtifact = register(manifestBytes);
  const copies = [] as Array<{ originalArtifactId: string; artifactId: string; digest: string }>;
  for (const item of manifest.artifacts) {
    const copy = register(new Uint8Array(await readFile(new URL(item.file, sourceDirectory))), item.handle.mediaType);
    copies.push({ originalArtifactId: item.handle.artifactId, artifactId: copy.artifactId, digest: copy.digest });
  }
  const grant: RegisteredBenchmarkSourceImportGrant = {
    tenantId: benchmarkTenant,
    dataset: inputGrant.dataset,
    experiment: inputGrant.experiment,
    manifest: { artifactId: manifestArtifact.artifactId, digest: manifestArtifact.digest },
    copies,
  };
  const admission = new RegisteredBenchmarkSourceImportAdmission(
    new RegisteredBenchmarkSourceImportCatalog([grant]),
    resolver,
  );
  resolver.authorizeArtifact.mockClear();
  resolver.hydrateRegisteredArtifact.mockClear();
  return { admitted, resolver, records, importedIds, grant, admission, copies };
}

describe("registered benchmark source import", () => {
  it("prepares retained projections from benchmark-tenant copies without a live original-tenant resolver", async () => {
    const value = await fixture();
    const result = await value.admission.prepare(value.admitted, benchmarkTenant);
    expect(result.importManifest.sourcePreparationDigest).toBe(value.admitted.dataset.sourcePreparationDigest);
    expect(result.mappings).toHaveLength(82);
    expect(Object.keys(result.prepared.byCaseId)).toHaveLength(value.admitted.dataset.cases.length);
    expect(
      value.resolver.authorizeArtifact.mock.calls.every(
        ([input]) => input.tenantId === benchmarkTenant && value.importedIds.has(input.artifactId),
      ),
    ).toBe(true);
    expect(
      value.resolver.hydrateRegisteredArtifact.mock.calls.every(
        ([input]) => input.tenantId === benchmarkTenant && value.importedIds.has(input.artifactId),
      ),
    ).toBe(true);
  }, 60_000);

  it("rejects an absent pair grant before any resolver I/O", async () => {
    const value = await fixture();
    const wrong = { ...value.grant, dataset: { ...value.grant.dataset, digest: sha256Digest("other") } };
    const admission = new RegisteredBenchmarkSourceImportAdmission(
      new RegisteredBenchmarkSourceImportCatalog([wrong]),
      value.resolver,
    );
    await expect(admission.prepare(value.admitted, benchmarkTenant)).rejects.toThrow("TRUSTED_GRANT_REQUIRED");
    expect(value.resolver.authorizeArtifact).not.toHaveBeenCalled();
  });

  it("rejects a changed imported copy and cancellation without any original-ID fallback", async () => {
    const value = await fixture();
    value.records.get(value.copies[0]!.artifactId)!.bytes = encoder.encode("changed");
    await expect(value.admission.prepare(value.admitted, benchmarkTenant)).rejects.toThrow(
      "ARTIFACT_REGISTRATION_MISMATCH",
    );
    expect(
      value.resolver.authorizeArtifact.mock.calls.every(([input]) => value.importedIds.has(input.artifactId)),
    ).toBe(true);

    const cancelled = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("private reason"));
    await expect(cancelled.admission.prepare(cancelled.admitted, benchmarkTenant, controller.signal)).rejects.toThrow(
      /^BENCHMARK_CANCELLED$/,
    );
    expect(cancelled.resolver.authorizeArtifact).not.toHaveBeenCalled();
  });

  it("checks cancellation after awaited authorization and does not hydrate", async () => {
    const value = await fixture(),
      controller = new AbortController();
    value.resolver.authorizeArtifact.mockImplementationOnce(async () => {
      controller.abort("private reason");
    });
    await expect(value.admission.prepare(value.admitted, benchmarkTenant, controller.signal)).rejects.toThrow(
      /^BENCHMARK_CANCELLED$/,
    );
    expect(value.resolver.hydrateRegisteredArtifact).not.toHaveBeenCalled();
  });

  it("rejects a valid registered replacement whose bytes differ from original provenance", async () => {
    const value = await fixture(),
      copy = value.copies[0]!;
    const bytes = encoder.encode("independently registered replacement"),
      digest = sha256Digest(bytes);
    const record = value.records.get(copy.artifactId)!;
    value.records.set(copy.artifactId, {
      registration: { ...record.registration, digest, byteLength: bytes.byteLength },
      bytes,
    });
    const grant = {
      ...value.grant,
      copies: value.grant.copies.map((item) =>
        item.originalArtifactId === copy.originalArtifactId ? { ...item, digest } : item,
      ),
    };
    const admission = new RegisteredBenchmarkSourceImportAdmission(
      new RegisteredBenchmarkSourceImportCatalog([grant]),
      value.resolver,
    );
    await expect(admission.prepare(value.admitted, benchmarkTenant)).rejects.toThrow("COPY_BINDING_INVALID");
  });

  it("requires the complete copy mapping before reading payloads", async () => {
    const value = await fixture();
    const grant = { ...value.grant, copies: value.grant.copies.slice(1) };
    const admission = new RegisteredBenchmarkSourceImportAdmission(
      new RegisteredBenchmarkSourceImportCatalog([grant]),
      value.resolver,
    );
    await expect(admission.prepare(value.admitted, benchmarkTenant)).rejects.toThrow("COPY_GRANT_INCOMPLETE");
    expect(value.resolver.hydrateRegisteredArtifact).toHaveBeenCalledTimes(1);
  });
});
