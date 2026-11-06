import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { diagnosticsBenchmarkArms } from "./verification-benchmark.js";
import { OfflineBenchmarkInputCatalog, RegisteredBenchmarkInputAdmission } from "./verification-benchmark-inputs.js";
import {
  RegisteredBenchmarkProfileAdmission,
  RegisteredBenchmarkProfileCatalog,
  type RegisteredBenchmarkProfileGrant,
} from "./verification-benchmark-registered-profile.js";

const tenantId = "11111111-1111-4111-8111-111111111111",
  now = "2026-09-05T12:00:00.000Z";
const decoder = new TextDecoder("utf8", { fatal: true }),
  encoder = new TextEncoder();
const directory = new URL(
  "../../../../../catalog/verification-benchmarks/diagnostics-companies-pilot-v4/",
  import.meta.url,
);

async function fixture() {
  let sequence = 1;
  const records = new Map<string, { registration: VerificationArtifactHandle; bytes: Uint8Array }>();
  function register(bytes: Uint8Array) {
    const artifactId = `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
    const registration: VerificationArtifactHandle = {
      artifactId,
      tenantId,
      digest: sha256Digest(bytes),
      mediaType: "application/json",
      byteLength: bytes.byteLength,
      objectKey: `private/${artifactId}`,
      createdAt: now,
      producerActivityId: "fixture",
      producerVersion: "v1",
      encryptionClass: "managed",
      retentionClass: "audit",
      dataClassification: "restricted",
      parentArtifactIds: [],
    };
    records.set(artifactId, { registration, bytes });
    return registration;
  }
  const manifestBytes = new Uint8Array(await readFile(new URL("manifest.json", directory)));
  const manifest = JSON.parse(decoder.decode(manifestBytes)) as { files: Array<{ name: string }> };
  const names = new Set([
    "manifest.json",
    "dataset.json",
    "derived-input-grant.json",
    "case-artifact-registry.json",
    "experiments/extraction-v1/manifest.json",
    "experiments/extraction-v1/output-schema.json",
    ...manifest.files.map((item) => item.name),
  ]);
  const profileFiles = [] as Array<{ name: string; artifactId: string; digest: string }>;
  for (const name of [...names].sort()) {
    const handle = register(new Uint8Array(await readFile(new URL(name, directory))));
    profileFiles.push({ name, artifactId: handle.artifactId, digest: handle.digest });
  }
  const datasetBytes = records.get(profileFiles.find((file) => file.name === "dataset.json")!.artifactId)!.bytes;
  const datasetHandle = register(datasetBytes);
  const dataset = JSON.parse(decoder.decode(datasetBytes));
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
  const experimentHandle = register(experimentBytes);
  const resolver = {
    authorizeArtifact: vi.fn(
      async ({ tenantId: suppliedTenant, artifactId }: { tenantId: string; artifactId: string }) => {
        if (suppliedTenant !== tenantId || !records.has(artifactId)) throw new Error("FORBIDDEN");
      },
    ),
    hydrateRegisteredArtifact: vi.fn(async ({ artifactId }: { artifactId: string }) => records.get(artifactId)!),
  };
  const inputGrant = {
    tenantId,
    dataset: { artifactId: datasetHandle.artifactId, digest: datasetHandle.digest },
    experiment: { artifactId: experimentHandle.artifactId, digest: experimentHandle.digest },
    runnerVersion: "verification-benchmark-runner.v1",
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
    { tenantId },
  );
  const profileGrant: RegisteredBenchmarkProfileGrant = {
    tenantId,
    dataset: inputGrant.dataset,
    experiment: inputGrant.experiment,
    profileFiles,
  };
  const profileAdmission = new RegisteredBenchmarkProfileAdmission(
    new RegisteredBenchmarkProfileCatalog([profileGrant]),
    resolver,
  );
  resolver.authorizeArtifact.mockClear();
  resolver.hydrateRegisteredArtifact.mockClear();
  return { admitted, resolver, records, profileGrant, profileAdmission, profileFiles };
}

describe("registered sealed benchmark profile admission", () => {
  it("hydrates exact registered V4 file bytes into private authority without returning bytes", async () => {
    const value = await fixture();
    const result = await value.profileAdmission.load(value.admitted, tenantId);
    expect(result.authority.datasetManifestDigest).toBe(value.admitted.dataset.manifestDigest);
    expect(result.sealedExperiment.networkPolicy).toBe("allow_listed_providers");
    expect(result.profileFiles).toHaveLength(value.profileFiles.length);
    expect(result.profileFiles[0]).not.toHaveProperty("bytes");
    expect(Object.isFrozen(result.profileFiles)).toBe(true);
    expect(value.resolver.hydrateRegisteredArtifact).toHaveBeenCalledTimes(value.profileFiles.length);
  });

  it("rejects a missing pair grant before artifact I/O", async () => {
    const value = await fixture();
    const wrongGrant = {
      ...value.profileGrant,
      dataset: { ...value.profileGrant.dataset, digest: sha256Digest("other") },
    };
    const admission = new RegisteredBenchmarkProfileAdmission(
      new RegisteredBenchmarkProfileCatalog([wrongGrant]),
      value.resolver,
    );
    await expect(admission.load(value.admitted, tenantId)).rejects.toThrow("TRUSTED_GRANT_REQUIRED");
    expect(value.resolver.authorizeArtifact).not.toHaveBeenCalled();
  });

  it("rejects tampered admitted dataset or offline-experiment bindings before artifact I/O", async () => {
    const value = await fixture();
    const altered = structuredClone(value.admitted);
    altered.experiment.datasetManifestDigest = sha256Digest("wrong-dataset-manifest");
    await expect(value.profileAdmission.load(altered, tenantId)).rejects.toThrow("ADMITTED_BINDING_INVALID");
    expect(value.resolver.authorizeArtifact).not.toHaveBeenCalled();
  });

  it("rejects altered registered profile bytes and cancellation", async () => {
    const value = await fixture();
    const target = value.profileFiles.find((file) => file.name === "experiments/extraction-v1/output-schema.json")!;
    value.records.get(target.artifactId)!.bytes = encoder.encode("{}");
    await expect(value.profileAdmission.load(value.admitted, tenantId)).rejects.toThrow(
      "ARTIFACT_REGISTRATION_MISMATCH",
    );
    const cancelled = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("private reason"));
    await expect(cancelled.profileAdmission.load(cancelled.admitted, tenantId, controller.signal)).rejects.toThrow(
      /^BENCHMARK_CANCELLED$/,
    );
    expect(cancelled.resolver.authorizeArtifact).not.toHaveBeenCalled();
  });

  it("checks cancellation after each awaited authorization and hydration", async () => {
    const afterAuthorize = await fixture();
    const authorizationAbort = new AbortController();
    afterAuthorize.resolver.authorizeArtifact.mockImplementationOnce(async () => {
      authorizationAbort.abort("private reason");
    });
    await expect(
      afterAuthorize.profileAdmission.load(afterAuthorize.admitted, tenantId, authorizationAbort.signal),
    ).rejects.toThrow(/^BENCHMARK_CANCELLED$/);
    expect(afterAuthorize.resolver.hydrateRegisteredArtifact).not.toHaveBeenCalled();

    const afterHydrate = await fixture();
    const hydrationAbort = new AbortController();
    afterHydrate.resolver.hydrateRegisteredArtifact.mockImplementationOnce(
      async ({ artifactId }: { artifactId: string }) => {
        hydrationAbort.abort("private reason");
        return afterHydrate.records.get(artifactId)!;
      },
    );
    await expect(
      afterHydrate.profileAdmission.load(afterHydrate.admitted, tenantId, hydrationAbort.signal),
    ).rejects.toThrow(/^BENCHMARK_CANCELLED$/);
  });

  it("copies nested trusted grant references before admission", async () => {
    const value = await fixture();
    (value.profileGrant.profileFiles[0] as { digest: string }).digest = sha256Digest("mutated-after-construction");
    await expect(value.profileAdmission.load(value.admitted, tenantId)).resolves.toMatchObject({
      authority: { datasetManifestDigest: value.admitted.dataset.manifestDigest },
    });
  });
});
