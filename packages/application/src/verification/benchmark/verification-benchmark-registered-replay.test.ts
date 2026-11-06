import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import {
  MemoryVerificationBenchmarkCheckpointStore,
  runVerificationBenchmark,
  verificationBenchmarkDigest,
} from "@aiengineer/knowledge-evaluation";
import { RegisteredBenchmarkPublicationBuilder } from "./verification-benchmark-publication.js";
import { VerificationSealPolicyCatalog } from "../admission/verification-seal-policy.js";
import { diagnosticsBenchmarkArms } from "./verification-benchmark.js";
import { OfflineBenchmarkInputCatalog, RegisteredBenchmarkInputAdmission } from "./verification-benchmark-inputs.js";
import {
  RegisteredBenchmarkProfileAdmission,
  RegisteredBenchmarkProfileCatalog,
  type RegisteredBenchmarkProfileGrant,
} from "./verification-benchmark-registered-profile.js";
import {
  RegisteredBenchmarkReplayAdmission,
  RegisteredBenchmarkReplayCatalog,
  type RegisteredBenchmarkReplayGrant,
} from "./verification-benchmark-registered-replay.js";
import { RegisteredDiagnosticsOfflineBenchmark } from "./verification-benchmark-offline-executor.js";
import type { RegisteredBenchmarkSourceImportResult } from "./verification-benchmark-source-import.js";

const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf8", { fatal: true });
const profileDirectory = new URL(
  "../../../../../catalog/verification-benchmarks/diagnostics-companies-pilot-v4/",
  import.meta.url,
);
const replayDirectory = new URL(
  "../../../../../catalog/verification-benchmarks/diagnostics-companies-pilot-v4-extraction-replay-v1/",
  import.meta.url,
);
const checkpointPath = new URL("records/38-gl-interested-comparison-source-luna_extractor.json", replayDirectory);
const failedCheckpointNames = [
  "13-tru-omic-mutated-interfaze_extractor-failure.json",
  "15-tru-pace-mutated-interfaze_extractor-failure.json",
  "20-gl-same-page-footer-source-interfaze_extractor-failure.json",
  "25-gl-repeatability-mutated-haiku_judge-failure.json",
  "25-gl-repeatability-mutated-interfaze_extractor-failure.json",
  "29-gl-consultation-mutated-interfaze_extractor-failure.json",
  "39-gl-interested-comparison-mutated-interfaze_extractor-failure.json",
] as const;
const failedCheckpointUrl = (name: string) => new URL(`records/${name}`, replayDirectory);

async function fixture(path: URL | readonly URL[] = checkpointPath) {
  const paths = Array.isArray(path) ? path : [path];
  const replayManifest = JSON.parse(await readFile(new URL("manifest.json", replayDirectory), "utf8")) as {
    entries: Array<{ recordFile: string; recordSha256: string; recordBytes: number }>;
  };
  const checkpointBytesList = await Promise.all(
    paths.map(async (item) => {
      const recordFile = decodeURIComponent(item.href.slice(replayDirectory.href.length));
      const entry = replayManifest.entries.find((candidate) => candidate.recordFile === recordFile);
      if (!entry) throw new Error(`SEALED_CHECKPOINT_MISSING:${recordFile}`);
      const bytes = new Uint8Array(await readFile(new URL(entry.recordFile, replayDirectory)));
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (bytes.byteLength !== entry.recordBytes || digest !== entry.recordSha256)
        throw new Error(`SEALED_CHECKPOINT_MISMATCH:${recordFile}`);
      return bytes;
    }),
  );
  const checkpoints = checkpointBytesList.map((bytes) => JSON.parse(decoder.decode(bytes)));
  const checkpoint = checkpoints[0]!;
  const tenantId = checkpoint.artifacts[0].handle.tenantId as string;
  let sequence = 1;
  const records = new Map<string, { registration: VerificationArtifactHandle; bytes: Uint8Array }>();
  function id() {
    return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
  }
  function register(bytes: Uint8Array) {
    const artifactId = id();
    const registration: VerificationArtifactHandle = {
      artifactId,
      tenantId,
      digest: sha256Digest(bytes),
      mediaType: "application/json",
      byteLength: bytes.byteLength,
      objectKey: `private/${artifactId}`,
      createdAt: "2026-09-05T12:00:00.000Z",
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
  const manifest = JSON.parse(await readFile(new URL("manifest.json", profileDirectory), "utf8")) as {
    files: Array<{ name: string }>;
  };
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
    const handle = register(new Uint8Array(await readFile(new URL(name, profileDirectory))));
    profileFiles.push({ name, artifactId: handle.artifactId, digest: handle.digest });
  }
  const datasetBytes = records.get(profileFiles.find((item) => item.name === "dataset.json")!.artifactId)!.bytes,
    dataset = JSON.parse(decoder.decode(datasetBytes));
  const registry = JSON.parse(await readFile(new URL("case-artifact-registry.json", profileDirectory), "utf8")) as {
    artifacts: Array<{ caseId: string; role: string; file: string; handle: VerificationArtifactHandle }>;
  };
  for (const value of checkpoints) {
    const source = registry.artifacts.find((item) => item.caseId === value.caseId && item.role === "case_input")!;
    records.set(value.sourceBinding.inputManifestArtifact.artifactId, {
      registration: value.sourceBinding.inputManifestArtifact,
      bytes: new Uint8Array(await readFile(new URL(source.file, profileDirectory))),
    });
  }
  const datasetHandle = register(datasetBytes);
  const recordedObservationArtifacts = checkpoints.flatMap((value) => {
    const observation = value.artifacts.find((item: { role: string }) => item.role === "observation");
    return observation ? [{ artifactId: observation.handle.artifactId, digest: observation.handle.digest }] : [];
  });
  const experimentHandle = register(
    encoder.encode(
      JSON.stringify({
        schemaVersion: "verification-benchmark-experiment.v1",
        verificationContractVersion: "verification.v1",
        experimentId: id(),
        datasetManifestDigest: dataset.manifestDigest,
        runnerVersion: "verification-benchmark-runner.v1",
        randomSeed: 4,
        repetitions: 1,
        arms: diagnosticsBenchmarkArms(),
        networkPolicy: "offline",
        recordedObservationArtifacts,
      }),
    ),
  );
  for (const value of checkpoints)
    for (const packed of value.artifacts)
      records.set(packed.handle.artifactId, {
        registration: packed.handle,
        bytes: new Uint8Array(Buffer.from(packed.bytesBase64, "base64")),
      });
  const wrappers = checkpointBytesList.map((bytes) => register(bytes)),
    wrapper = wrappers[0]!;
  const resolver = {
    authorizeArtifact: vi.fn(async ({ tenantId: supplied, artifactId }: { tenantId: string; artifactId: string }) => {
      if (supplied !== tenantId || !records.has(artifactId)) throw new Error("FORBIDDEN");
    }),
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
  const profile = await new RegisteredBenchmarkProfileAdmission(
    new RegisteredBenchmarkProfileCatalog([profileGrant]),
    resolver,
  ).load(admitted, tenantId);
  const replayGrant = (): RegisteredBenchmarkReplayGrant => ({
    tenantId,
    dataset: inputGrant.dataset,
    experiment: inputGrant.experiment,
    checkpoints: wrappers.map((item, index) => ({
      artifactId: item.artifactId,
      digest: item.digest,
      runIdentityDigest: checkpoints[index]!.runIdentityDigest,
    })),
  });
  return { tenantId, records, checkpoint, checkpoints, wrapper, wrappers, replayGrant, admitted, profile, resolver };
}

function rebindCheckpoint(value: Awaited<ReturnType<typeof fixture>>, changed: Record<string, unknown>) {
  const checkpoint = structuredClone(value.checkpoint);
  Object.assign(checkpoint, changed);
  const { checkpointDigest: _ignored, ...material } = checkpoint;
  checkpoint.checkpointDigest = verificationBenchmarkDigest(material);
  const bytes = encoder.encode(canonicalizeJson(checkpoint)),
    registration = { ...value.wrapper, digest: sha256Digest(bytes), byteLength: bytes.byteLength };
  value.records.set(value.wrapper.artifactId, { registration, bytes });
  const grant = value.replayGrant(),
    replayGrant = {
      ...grant,
      checkpoints: grant.checkpoints.map((item) => ({ ...item, digest: registration.digest })),
    };
  return new RegisteredBenchmarkReplayAdmission(new RegisteredBenchmarkReplayCatalog([replayGrant]), value.resolver);
}

// Synthetic projection-port responses isolate composition guards here. Actual
// native projection/import custody is exercised by the registered local proof.
async function executorFixture(path?: URL) {
  const value = await fixture(path ?? checkpointPath);
  const sources: RegisteredBenchmarkSourceImportResult = {
    prepared: {
      byCaseId: Object.fromEntries(
        value.admitted.dataset.cases.map((testCase) => [
          testCase.caseId,
          {
            caseId: testCase.caseId,
            byFragmentId: Object.fromEntries(
              testCase.evidence.map((edge) => [
                edge.fragmentId,
                {
                  fragmentId: edge.fragmentId,
                  captureId: edge.captureId,
                  projectionArtifactId: edge.projectionArtifactId,
                  projectionDigest: edge.projectionDigest as `sha256:${string}`,
                  locatorValid: true,
                  selectorStatus: "resolved" as const,
                },
              ]),
            ),
          },
        ]),
      ),
    },
    importManifest: {
      artifactId: value.wrapper.artifactId,
      digest: value.wrapper.digest,
      sourcePreparationDigest: value.admitted.dataset.sourcePreparationDigest,
      originalTenantId: value.tenantId,
    },
    mappings: [],
  };
  const ports = {
    inputs: { load: vi.fn(async () => value.admitted) },
    profiles: { load: vi.fn(async () => value.profile) },
    sources: { prepare: vi.fn(async () => sources) },
    replays: new RegisteredBenchmarkReplayAdmission(
      new RegisteredBenchmarkReplayCatalog([value.replayGrant()]),
      value.resolver,
    ),
  };
  const controller = new AbortController(),
    runId = "f1111111-1111-4111-8111-111111111111";
  const service = new RegisteredDiagnosticsOfflineBenchmark(ports);
  const context = { tenantId: value.tenantId, runId, signal: controller.signal };
  return { value, sources, ports, controller, service, context };
}

describe("registered offline executor composition", () => {
  it("rejects altered arm configuration before profile or replay access", async () => {
    const f = await executorFixture();
    f.ports.inputs.load.mockResolvedValueOnce({
      ...f.value.admitted,
      experiment: {
        ...f.value.admitted.experiment,
        arms: f.value.admitted.experiment.arms.map((arm) => ({ ...arm, policyVersion: "unregistered" })),
      },
    });
    await expect(f.service.prepare(f.value.admitted.request, f.context)).rejects.toThrow("PROFILE_MISMATCH");
    expect(f.ports.profiles.load).not.toHaveBeenCalled();
    expect(f.ports.sources.prepare).not.toHaveBeenCalled();
  });

  it("rejects a projection matrix with substituted evidence identity", async () => {
    const f = await executorFixture(),
      testCase = f.value.admitted.dataset.cases[0]!;
    const changed = structuredClone(f.sources);
    const fragment = changed.prepared.byCaseId[testCase.caseId]!.byFragmentId[testCase.evidence[0]!.fragmentId]!;
    Object.assign(fragment, { projectionArtifactId: f.context.runId });
    f.ports.sources.prepare.mockResolvedValueOnce(changed);
    await expect(f.service.prepare(f.value.admitted.request, f.context)).rejects.toThrow("PROJECTION_MATRIX_INVALID");
  });

  it("binds execution identity and stops after cancellation without fresh replay charges", async () => {
    const f = await executorFixture(),
      prepared = await f.service.prepare(f.value.admitted.request, f.context);
    expect("replayedFailureCount" in prepared.provenance).toBe(false);
    expect("failedCheckpoints" in prepared.provenance).toBe(false);
    const testCase = f.value.admitted.dataset.cases.find((item) => item.caseId === f.value.checkpoint.caseId)!;
    const execution = {
      runId: f.context.runId,
      datasetManifestDigest: f.value.admitted.dataset.manifestDigest as `sha256:${string}`,
      arm: f.value.admitted.experiment.arms[0]!,
      testCase,
      repetition: 0,
      networkPolicy: "offline" as const,
    };
    const result = await prepared.execute(execution);
    expect(result.schemaValid).toBe(true);
    expect(result.callAttributions).toHaveLength(1);
    expect(result.callAttributions[0]).toMatchObject({
      cacheDisposition: "exact_cache_shared",
      reservationCostMicros: 0,
      latencyMs: null,
    });
    expect(
      result.callAttributions[0]!.actualCostMicros === 0 || result.callAttributions[0]!.actualCostMicros === null,
    ).toBe(true);
    await expect(prepared.execute({ ...execution, runId: f.value.wrapper.artifactId })).rejects.toThrow(
      "EXECUTION_BINDING_INVALID",
    );
    await expect(prepared.execute({ ...execution, repetition: 1 })).rejects.toThrow("EXECUTION_BINDING_INVALID");
    await expect(prepared.execute({ ...execution, networkPolicy: "allow_listed_providers" })).rejects.toThrow(
      "EXECUTION_BINDING_INVALID",
    );
    f.controller.abort("private cancellation");
    await expect(prepared.execute(execution)).rejects.toThrow(/^BENCHMARK_CANCELLED$/);
  });

  it("does not continue admission after an awaited input load cancels", async () => {
    const f = await executorFixture();
    f.ports.inputs.load.mockImplementationOnce(async () => {
      f.controller.abort();
      return f.value.admitted;
    });
    await expect(f.service.prepare(f.value.admitted.request, f.context)).rejects.toThrow("BENCHMARK_CANCELLED");
    expect(f.ports.profiles.load).not.toHaveBeenCalled();
  });

  it("retains captured failure provenance without composing a fabricated observation", async () => {
    const f = await executorFixture(failedCheckpointUrl(failedCheckpointNames[0]));
    const prepared = await f.service.prepare(f.value.admitted.request, f.context);
    expect(prepared.provenance.checkpoints).toHaveLength(1);
    expect(prepared.provenance.replayedObservationCount).toBe(0);
    expect(prepared.provenance.replayedFailureCount).toBe(1);
    expect(prepared.provenance.failedCheckpoints).toMatchObject([
      {
        caseId: f.value.checkpoint.caseId,
        role: "interfaze_extractor",
        replay: { memoryFetches: 1, externalRequests: 0 },
        failure: { automaticRetry: false },
      },
    ]);
    const testCase = f.value.admitted.dataset.cases.find((item) => item.caseId === f.value.checkpoint.caseId)!;
    const result = await prepared.execute({
      runId: f.context.runId,
      datasetManifestDigest: f.value.admitted.dataset.manifestDigest as `sha256:${string}`,
      arm: f.value.admitted.experiment.arms[0]!,
      testCase,
      repetition: 0,
      networkPolicy: "offline",
    });
    expect(result.callAttributions).toHaveLength(0);
  });
});

describe("registered benchmark publication boundary", () => {
  async function publicationFixture() {
    const f = await executorFixture(),
      prepared = await f.service.prepare(f.value.admitted.request, f.context);
    const run = await runVerificationBenchmark({
      runId: f.context.runId,
      dataset: prepared.admitted.dataset,
      experimentDefinitionDigest: prepared.admitted.experimentArtifact.digest as `sha256:${string}`,
      arms: prepared.admitted.experiment.arms,
      repetitions: 1,
      randomSeed: prepared.admitted.experiment.randomSeed,
      networkPolicy: "offline",
      checkpoints: new MemoryVerificationBenchmarkCheckpointStore(),
      execute: prepared.execute,
      now: () => "2026-09-05T12:00:00.000Z",
    });
    const policyBytes = encoder.encode(
      canonicalizeJson({
        schemaVersion: "verification-policy.v1",
        policyVersion: "diagnostics-policy.v1",
        definitionId: "publication-boundary-fixture",
        criticalDownstreamUses: ["publication"],
        requireCrossFamilyForRisk: ["critical"],
        requireIndependentAuthorityForScopes: ["clinical_utility"],
        mixedEvidenceOutcome: "review",
        unknownCriticalOutcome: "abstain",
        authorityWithheldOutcome: "review",
        reviewAvailable: true,
      }),
    );
    const policy = {
      ...f.value.wrapper,
      artifactId: "e1111111-1111-4111-8111-111111111111",
      digest: sha256Digest(policyBytes),
      byteLength: policyBytes.byteLength,
    };
    f.value.records.set(policy.artifactId, { registration: policy, bytes: policyBytes });
    const policies = new VerificationSealPolicyCatalog([
      {
        tenantId: f.value.tenantId,
        policyVersion: "diagnostics-policy.v1",
        policyArtifact: { artifactId: policy.artifactId, digest: policy.digest },
      },
    ]);
    let sequence = 1;
    const register = vi.fn(
      async (input: {
        tenantId: string;
        bytes: Uint8Array;
        createdAt: string;
        parentArtifactIds: readonly string[];
        transformationSignature: `sha256:${string}`;
      }) => ({
        ...f.value.wrapper,
        artifactId: `e2222222-2222-4222-8222-${String(sequence++).padStart(12, "0")}`,
        tenantId: input.tenantId,
        digest: sha256Digest(input.bytes),
        byteLength: input.bytes.byteLength,
        createdAt: input.createdAt,
        parentArtifactIds: [...input.parentArtifactIds],
        transformationSignature: input.transformationSignature,
      }),
    );
    const ports = { artifacts: { register }, policies, resolver: f.value.resolver };
    const input = {
      tenantId: f.value.tenantId,
      operationId: "e3333333-3333-4333-8333-333333333333",
      prepared,
      run,
      runtime: {
        deploymentId: "fixture",
        attemptId: "e4444444-4444-4444-8444-444444444444",
        capabilityVersion: "verification.v1",
        targetCodeRef: "fixture",
        gitSha: "fixture",
        dirty: true,
      },
      signal: f.controller.signal,
    };
    return { f, ports, input, builder: new RegisteredBenchmarkPublicationBuilder(ports) };
  }

  it("rejects structural preparation forgery before any artifact registration", async () => {
    const p = await publicationFixture();
    await expect(p.builder.prepare({ ...p.input, prepared: { ...p.input.prepared } })).rejects.toThrow(
      "REGISTERED_PREPARATION_REQUIRED",
    );
    expect(p.ports.artifacts.register).not.toHaveBeenCalled();
  });

  it("requires the registered policy and honors cancellation after hydration before writing", async () => {
    const p = await publicationFixture();
    await expect(
      new RegisteredBenchmarkPublicationBuilder({
        ...p.ports,
        policies: new VerificationSealPolicyCatalog([]),
      }).prepare(p.input),
    ).rejects.toThrow("POLICY_GRANT_REQUIRED");
    p.ports.resolver.hydrateRegisteredArtifact.mockImplementationOnce(async ({ artifactId }) => {
      p.f.controller.abort();
      return p.f.value.records.get(artifactId)!;
    });
    await expect(p.builder.prepare(p.input)).rejects.toThrow("BENCHMARK_CANCELLED");
    expect(p.ports.artifacts.register).not.toHaveBeenCalled();
  });

  it("rejects changed results and independently rehashed fresh-call accounting", async () => {
    const p = await publicationFixture();
    const changed = structuredClone(p.input.run),
      row = changed.results.find((result) => result.callAttributions.length > 0)!;
    Object.assign(row.callAttributions[0]!, { cacheDisposition: "fresh" });
    await expect(p.builder.prepare({ ...p.input, run: changed })).rejects.toThrow("RUN_MANIFEST_INVALID");
    const { checkpointDigest: _checkpoint, ...checkpointMaterial } = row;
    Object.assign(row, { checkpointDigest: verificationBenchmarkDigest(checkpointMaterial) });
    const { manifestDigest: _manifest, ...runMaterial } = changed;
    Object.assign(changed, { manifestDigest: verificationBenchmarkDigest(runMaterial) });
    await expect(p.builder.prepare({ ...p.input, run: changed })).rejects.toThrow("OFFLINE_ACCOUNTING_INVALID");
    expect(p.ports.artifacts.register).not.toHaveBeenCalled();
  });

  it("rejects altered artifact custody returned by the registration port", async () => {
    const p = await publicationFixture(),
      original = p.ports.artifacts.register.getMockImplementation()!;
    p.ports.artifacts.register.mockImplementationOnce(async (input) => ({
      ...(await original(input)),
      digest: sha256Digest("substituted"),
    }));
    await expect(p.builder.prepare(p.input)).rejects.toThrow("REGISTERED_ARTIFACT_MISMATCH");
    expect(p.ports.artifacts.register).toHaveBeenCalledTimes(1);
  });

  it("derives per-arm review disposition from the hydrated policy without human-gold claims", async () => {
    const p = await publicationFixture(),
      result = await p.builder.prepare(p.input);
    expect(result.manifest.arms).toHaveLength(4);
    expect(new Set(result.manifest.arms.map((arm) => arm.evalRunId)).size).toBe(4);
    expect(
      result.manifest.arms.every(
        (arm) => arm.terminalStatus === "review" && arm.dispositionBasis === "source_authority_unassessed",
      ),
    ).toBe(true);
    expect(result.manifest.qualityClaims).toEqual({
      humanGoldValidated: false,
      sourceAuthorityAssessed: false,
      calibrated: false,
    });
    expect(Object.isFrozen(result.input.arms[0])).toBe(true);
  });
});

describe("registered benchmark replay", () => {
  it("replays all seven actual captured schema failures exactly once in memory", async () => {
    for (const name of failedCheckpointNames) {
      const value = await fixture(failedCheckpointUrl(name));
      const admission = new RegisteredBenchmarkReplayAdmission(
        new RegisteredBenchmarkReplayCatalog([value.replayGrant()]),
        value.resolver,
      );
      const result = await admission.loadWithFailures(value.admitted, value.profile, value.tenantId);
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]).toMatchObject({
        outcome: "failed",
        failure: {
          caseId: value.checkpoint.caseId,
          role: value.checkpoint.role,
          provider: value.checkpoint.provider,
          model: value.checkpoint.model,
          failure: {
            failureClass: "schema",
            failureCode: "PROVIDER_OUTPUT_SCHEMA_INVALID_CAPTURED",
            adapterFailureCode: "PROVIDER_RESPONSE_SCHEMA_INVALID",
            providerHttpStatus: 200,
            automaticRetry: false,
          },
          historical: {
            attemptId: value.checkpoint.attemptId,
            accounting: value.checkpoint.accounting,
            latencyMs: value.checkpoint.latencyMs,
            completedAt: value.checkpoint.completedAt,
          },
          replay: { memoryFetches: 1, externalRequests: 0 },
          requiresCurrentProjectionPreparation: true,
        },
      });
      expect(Object.isFrozen(result.outcomes[0])).toBe(true);
      await expect(admission.load(value.admitted, value.profile, value.tenantId)).rejects.toThrow(
        "FAILURE_AWARE_LOAD_REQUIRED",
      );
    }
  });

  it.each([
    ["response-envelope-content", "BENCHMARK_REPLAY_RESPONSE_ENVELOPE_BINDING_INVALID"],
    ["response-envelope-parent", "BENCHMARK_REPLAY_RESPONSE_ENVELOPE_BINDING_INVALID"],
    ["packed-digest", "BENCHMARK_REPLAY_PACKED_ARTIFACT_BYTES_MISMATCH"],
    ["captured-status", "BENCHMARK_REPLAY_FAILED_ADAPTER_REPLAY_INVALID"],
    ["profile-role", "BENCHMARK_REPLAY_CHECKPOINT_ADMITTED_BINDING_INVALID"],
    ["failure-attribution", "BENCHMARK_REPLAY_FAILED_CHECKPOINT_ATTRIBUTION_INVALID"],
    ["grant-run", "BENCHMARK_REPLAY_CHECKPOINT_BINDING_INVALID"],
    ["grant-digest", "BENCHMARK_REPLAY_CHECKPOINT_REGISTRATION_MISMATCH"],
  ] as const)("rejects failed replay with adverse %s custody", async (kind, code) => {
    const value = await fixture(failedCheckpointUrl(failedCheckpointNames[0]));
    let admission: RegisteredBenchmarkReplayAdmission;
    if (kind === "grant-run" || kind === "grant-digest") {
      const grant = value.replayGrant();
      admission = new RegisteredBenchmarkReplayAdmission(
        new RegisteredBenchmarkReplayCatalog([
          {
            ...grant,
            checkpoints: grant.checkpoints.map((item) =>
              kind === "grant-run"
                ? { ...item, runIdentityDigest: sha256Digest("wrong-run") }
                : { ...item, digest: sha256Digest("wrong-checkpoint") },
            ),
          },
        ]),
        value.resolver,
      );
    } else {
      const changed = structuredClone(value.checkpoint);
      if (kind === "response-envelope-content") {
        const packed = changed.artifacts.find((item: { role: string }) => item.role === "response_envelope")!;
        const envelope = JSON.parse(decoder.decode(Buffer.from(packed.bytesBase64, "base64")));
        envelope.untrusted = true;
        const bytes = encoder.encode(canonicalizeJson(envelope));
        packed.handle = { ...packed.handle, digest: sha256Digest(bytes), byteLength: bytes.byteLength };
        packed.bytesBase64 = Buffer.from(bytes).toString("base64");
        value.records.set(packed.handle.artifactId, { registration: packed.handle, bytes });
      } else if (kind === "response-envelope-parent") {
        const packed = changed.artifacts.find((item: { role: string }) => item.role === "response_envelope")!;
        packed.handle = { ...packed.handle, parentArtifactIds: [...packed.handle.parentArtifactIds].reverse() };
        value.records.set(packed.handle.artifactId, {
          registration: packed.handle,
          bytes: new Uint8Array(Buffer.from(packed.bytesBase64, "base64")),
        });
      } else if (kind === "packed-digest") {
        const packed = changed.artifacts.find((item: { role: string }) => item.role === "raw_response")!;
        packed.bytesBase64 = Buffer.from("changed retained bytes").toString("base64");
      } else if (kind === "captured-status") changed.providerHttpStatus = 204;
      else if (kind === "failure-attribution") changed.failureClass = "provider";
      else Object.assign(changed, { role: "luna_extractor", provider: "interfaze", model: "interfaze-beta" });
      admission = rebindCheckpoint(value, { ...changed });
    }
    await expect(admission.loadWithFailures(value.admitted, value.profile, value.tenantId)).rejects.toThrow(code);
  });

  it("deduplicates successful and failed checkpoints across the same case and role", async () => {
    const success = new URL("records/13-tru-omic-mutated-luna_extractor.json", replayDirectory);
    const value = await fixture([success, failedCheckpointUrl(failedCheckpointNames[0])]);
    const changed = structuredClone(value.checkpoints[1]);
    Object.assign(changed, { role: "luna_extractor", provider: "gateway", model: "openai/gpt-5.6-luna" });
    const { checkpointDigest: _ignored, ...material } = changed;
    changed.checkpointDigest = verificationBenchmarkDigest(material);
    const bytes = encoder.encode(canonicalizeJson(changed));
    const wrapper = { ...value.wrappers[1]!, digest: sha256Digest(bytes), byteLength: bytes.byteLength };
    value.records.set(wrapper.artifactId, { registration: wrapper, bytes });
    const grant = value.replayGrant();
    const checkpoints = grant.checkpoints.map((item, index) =>
      index === 1 ? { ...item, digest: wrapper.digest } : item,
    );
    const admission = new RegisteredBenchmarkReplayAdmission(
      new RegisteredBenchmarkReplayCatalog([{ ...grant, checkpoints }]),
      value.resolver,
    );
    await expect(admission.loadWithFailures(value.admitted, value.profile, value.tenantId)).rejects.toThrow(
      "BENCHMARK_REPLAY_CHECKPOINT_DUPLICATE_CASE_ROLE",
    );
  });

  it("requires exact source binding across successful and failed roles for one case", async () => {
    const success = new URL("records/13-tru-omic-mutated-luna_extractor.json", replayDirectory);
    const value = await fixture([success, failedCheckpointUrl(failedCheckpointNames[0])]);
    const changed = structuredClone(value.checkpoints[1]);
    changed.sourceBinding = { ...changed.sourceBinding, locatorValid: !changed.sourceBinding.locatorValid };
    const { checkpointDigest: _ignored, ...material } = changed;
    changed.checkpointDigest = verificationBenchmarkDigest(material);
    const bytes = encoder.encode(canonicalizeJson(changed));
    const wrapper = { ...value.wrappers[1]!, digest: sha256Digest(bytes), byteLength: bytes.byteLength };
    value.records.set(wrapper.artifactId, { registration: wrapper, bytes });
    const grant = value.replayGrant(),
      checkpoints = grant.checkpoints.map((item, index) => (index === 1 ? { ...item, digest: wrapper.digest } : item));
    const admission = new RegisteredBenchmarkReplayAdmission(
      new RegisteredBenchmarkReplayCatalog([{ ...grant, checkpoints }]),
      value.resolver,
    );
    await expect(admission.loadWithFailures(value.admitted, value.profile, value.tenantId)).rejects.toThrow(
      "BENCHMARK_REPLAY_SOURCE_BINDING_CROSS_CHECKPOINT_MISMATCH",
    );
  });

  it("fails closed for rejected responses with retained precontext until the adapter exposes it", async () => {
    const value = await fixture(failedCheckpointUrl(failedCheckpointNames[0]));
    const changed = structuredClone(value.checkpoint);
    const responseEnvelope = changed.artifacts.find((item: { role: string }) => item.role === "response_envelope")!;
    const precontextBytes = encoder.encode("retained precontext"),
      precontext = {
        ...responseEnvelope.handle,
        artifactId: "00000000-0000-4000-8000-000000006661",
        digest: sha256Digest(precontextBytes),
        byteLength: precontextBytes.byteLength,
        objectKey: "private/precontext",
        parentArtifactIds: [],
      };
    const envelopeValue = {
      schemaVersion: "verification-provider-precontext-envelope.v1",
      requestDigest: JSON.parse(decoder.decode(Buffer.from(responseEnvelope.bytesBase64, "base64"))).requestDigest,
      responseEnvelopeArtifactId: responseEnvelope.handle.artifactId,
      precontextArtifactId: precontext.artifactId,
      precontextDigest: precontext.digest,
    };
    const envelopeBytes = encoder.encode(canonicalizeJson(envelopeValue)),
      envelope = {
        ...responseEnvelope.handle,
        artifactId: "00000000-0000-4000-8000-000000006662",
        digest: sha256Digest(envelopeBytes),
        byteLength: envelopeBytes.byteLength,
        objectKey: "private/precontext-envelope",
        parentArtifactIds: [responseEnvelope.handle.artifactId, precontext.artifactId],
        transformationSignature: sha256Digest("placeholder"),
      };
    changed.artifacts.push(
      { role: "provider_precontext", handle: precontext, bytesBase64: Buffer.from(precontextBytes).toString("base64") },
      { role: "precontext_envelope", handle: envelope, bytesBase64: Buffer.from(envelopeBytes).toString("base64") },
    );
    value.records.set(precontext.artifactId, { registration: precontext, bytes: precontextBytes });
    value.records.set(envelope.artifactId, { registration: envelope, bytes: envelopeBytes });
    const admission = rebindCheckpoint(value, { ...changed });
    await expect(admission.loadWithFailures(value.admitted, value.profile, value.tenantId)).rejects.toThrow(
      "BENCHMARK_REPLAY_FAILED_PRECONTEXT_REPLAY_UNSUPPORTED",
    );
  });

  it("checks cancellation after a failed checkpoint authorization await", async () => {
    const value = await fixture(failedCheckpointUrl(failedCheckpointNames[0]));
    const controller = new AbortController();
    value.resolver.authorizeArtifact.mockClear();
    value.resolver.hydrateRegisteredArtifact.mockClear();
    value.resolver.authorizeArtifact.mockImplementationOnce(async () => {
      controller.abort("private reason");
    });
    const admission = new RegisteredBenchmarkReplayAdmission(
      new RegisteredBenchmarkReplayCatalog([value.replayGrant()]),
      value.resolver,
    );
    await expect(
      admission.loadWithFailures(value.admitted, value.profile, value.tenantId, controller.signal),
    ).rejects.toThrow(/^BENCHMARK_CANCELLED$/u);
    expect(value.resolver.hydrateRegisteredArtifact).not.toHaveBeenCalled();
  });

  it("rejects a tampered admitted grant before checkpoint authorization", async () => {
    const value = await fixture();
    value.resolver.authorizeArtifact.mockClear();
    const altered = {
      ...value.admitted,
      grant: {
        ...value.admitted.grant,
        dataset: { ...value.admitted.grant.dataset, digest: sha256Digest("wrong-grant") },
      },
    };
    const admission = new RegisteredBenchmarkReplayAdmission(
      new RegisteredBenchmarkReplayCatalog([value.replayGrant()]),
      value.resolver,
    );
    await expect(admission.load(altered, value.profile, value.tenantId)).rejects.toThrow("ADMITTED_BINDING_INVALID");
    expect(value.resolver.authorizeArtifact).not.toHaveBeenCalled();
  });

  it("replays a real retained checkpoint and rejects an independently valid packed wrong chain", async () => {
    const value = await fixture();
    const admission = new RegisteredBenchmarkReplayAdmission(
      new RegisteredBenchmarkReplayCatalog([value.replayGrant()]),
      value.resolver,
    );
    await expect(admission.load(value.admitted, value.profile, value.tenantId)).resolves.toMatchObject([
      { replay: { memoryFetches: 1, externalRequests: 0 }, requiresCurrentProjectionPreparation: true },
    ]);

    const changed = structuredClone(value.checkpoint),
      original = changed.artifacts.find((item: { role: string }) => item.role === "request")!;
    const wrongId = "00000000-0000-4000-8000-000000008888";
    const wrongHandle = { ...original.handle, artifactId: wrongId, objectKey: `private/${wrongId}` };
    value.records.set(wrongId, {
      registration: wrongHandle,
      bytes: new Uint8Array(Buffer.from(original.bytesBase64, "base64")),
    });
    original.handle = wrongHandle;
    changed.accounting.requestArtifactId = wrongId;
    const drifted = rebindCheckpoint(value, changed);
    await expect(drifted.load(value.admitted, value.profile, value.tenantId)).rejects.toThrow(
      "PACKED_CUSTODY_CHAIN_MISMATCH",
    );
  });

  it.each(["http-status", "field-ledger", "source-input"])(
    "rejects a rewrapped checkpoint with invalid %s replay custody",
    async (kind) => {
      const value = await fixture();
      let changed: Record<string, unknown>;
      if (kind === "http-status") changed = { providerHttpStatus: 204 };
      else if (kind === "field-ledger") changed = { fieldLedger: { forged: true } };
      else {
        const original = value.checkpoint.sourceBinding.inputManifestArtifact,
          artifactId = "00000000-0000-4000-8000-000000007777";
        const alternative = { ...original, artifactId, objectKey: `private/${artifactId}` };
        value.records.set(artifactId, {
          registration: alternative,
          bytes: value.records.get(original.artifactId)!.bytes.slice(),
        });
        changed = { sourceBinding: { ...value.checkpoint.sourceBinding, inputManifestArtifact: alternative } };
      }
      const admission = rebindCheckpoint(value, changed);
      await expect(admission.load(value.admitted, value.profile, value.tenantId)).rejects.toThrow();
    },
  );

  it("checks cancellation immediately after checkpoint hydration", async () => {
    const value = await fixture();
    value.resolver.authorizeArtifact.mockClear();
    value.resolver.hydrateRegisteredArtifact.mockClear();
    const controller = new AbortController();
    value.resolver.hydrateRegisteredArtifact.mockImplementationOnce(async ({ artifactId }: { artifactId: string }) => {
      controller.abort("private reason");
      return value.records.get(artifactId)!;
    });
    const admission = new RegisteredBenchmarkReplayAdmission(
      new RegisteredBenchmarkReplayCatalog([value.replayGrant()]),
      value.resolver,
    );
    await expect(admission.load(value.admitted, value.profile, value.tenantId, controller.signal)).rejects.toThrow(
      /^BENCHMARK_CANCELLED$/,
    );
  });
});
