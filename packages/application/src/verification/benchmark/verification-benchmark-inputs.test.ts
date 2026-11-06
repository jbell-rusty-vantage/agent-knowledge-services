import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { freezeVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import { sha256Digest, type TrustedArtifactResolver } from "@aiengineer/knowledge-verification";
import { describe, expect, it, vi } from "vitest";
import { OfflineBenchmarkInputCatalog, RegisteredBenchmarkInputAdmission } from "./verification-benchmark-inputs.js";

const ids = {
  tenant: "11111111-1111-4111-8111-111111111111",
  otherTenant: "22222222-2222-4222-8222-222222222222",
  dataset: "33333333-3333-4333-8333-333333333333",
  experiment: "44444444-4444-4444-8444-444444444444",
  observation: "55555555-5555-4555-8555-555555555555",
  source: "66666666-6666-4666-8666-666666666666",
};
const now = "2026-09-05T12:00:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function sealedDataset() {
  return freezeVerificationBenchmarkDataset({
    schemaVersion: "verification-benchmark.v1",
    verificationContractVersion: "verification.v1",
    datasetId: "diagnostics",
    version: 1,
    stage: "pilot",
    frozen: true,
    supersedesManifestDigest: null,
    sourcePreparationDigest: digest("a"),
    labelProvenance: "engineering_expectations",
    annotationGuidelinesDigest: digest("b"),
    adjudicationArtifactDigest: null,
    createdAt: now,
    sealedAt: now,
    cases: Array.from({ length: 30 }, (_, index) => ({
      schemaVersion: "verification-benchmark.v1",
      caseId: `case-${index}`,
      partition: "development",
      inputManifestArtifactId: ids.source,
      goldArtifactId: null,
      modality: "html",
      sourceFamily: `source-${index}`,
      entityFamily: `entity-${index}`,
      reportCluster: `report-${index}`,
      pairCluster: `pair-${index}`,
      tags: ["fixture"],
      adversarialTransforms: [],
      assertion: `Claim ${index}`,
      evidence: [
        {
          fragmentId: `fragment-${index}`,
          captureId: ids.source,
          sourceKey: `source-${index}`,
          sourceClass: "first_party",
          projectionArtifactId: ids.source,
          projectionDigest: digest("c"),
          transformationArtifactId: ids.source,
          selector: { kind: "html", domPath: `1/${index}` },
          selectedContentDigest: digest("d"),
          excerpt: `Claim ${index}`,
          rights: "restricted fixture",
          providerUploadAuthorized: false,
        },
      ],
      expectation: {
        label: "supported_by_source",
        labelStatus: "engineering_expectation",
        expectedPolicy: "pass_with_warnings",
        expectedLocatorValid: true,
        support: "full",
        authority: "interested_party_only",
        worldCorrectness: "not_established",
        rationale: "Fixture expectation.",
      },
      independentObservation: true,
      humanGoldScoringEligible: false,
      adjudicationId: null,
    })),
  });
}

const arms = [
  {
    armId: "baseline",
    name: "Baseline",
    control: true,
    strategy: "baseline",
    extractorProfile: "rules",
    parserProfile: "frozen",
    retrieverProfile: "bound",
    judgeProfile: "rules",
    policyVersion: "v1",
    configurationDigest: digest("e"),
    cachePolicy: "disabled",
    replicas: 1,
  },
  {
    armId: "candidate",
    name: "Candidate",
    control: false,
    strategy: "cascade",
    extractorProfile: "recorded",
    parserProfile: "frozen",
    retrieverProfile: "bound",
    judgeProfile: "rules",
    policyVersion: "v1",
    configurationDigest: digest("f"),
    cachePolicy: "exact_request_only",
    replicas: 1,
  },
] as const;
function experiment(datasetManifestDigest: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "verification-benchmark-experiment.v1",
    verificationContractVersion: "verification.v1",
    experimentId: "experiment-fixture",
    datasetManifestDigest,
    runnerVersion: "verification-benchmark-runner.v1",
    randomSeed: 7,
    repetitions: 1,
    arms,
    networkPolicy: "offline",
    recordedObservationArtifacts: [{ artifactId: ids.observation, digest: digest("a") }],
    ...overrides,
  };
}
function handle(artifactId: string, tenantId: string, bytes: Uint8Array): VerificationArtifactHandle {
  return {
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
}

function fixture(
  options: {
    datasetHandle?: Partial<VerificationArtifactHandle>;
    experimentValue?: unknown;
    maximumArtifactBytes?: number;
    maximumExecutions?: number;
  } = {},
) {
  const dataset = sealedDataset(),
    datasetBytes = encode(dataset),
    experimentValue = options.experimentValue ?? experiment(dataset.manifestDigest),
    experimentBytes = encode(experimentValue);
  const datasetHandle = {
    ...handle(ids.dataset, ids.tenant, datasetBytes),
    ...options.datasetHandle,
  } as VerificationArtifactHandle;
  const experimentHandle = handle(ids.experiment, ids.tenant, experimentBytes);
  const records = new Map([
    [ids.dataset, { registration: datasetHandle, bytes: datasetBytes }],
    [ids.experiment, { registration: experimentHandle, bytes: experimentBytes }],
  ]);
  const authorizeArtifact = vi.fn(async ({ tenantId, artifactId }: { tenantId: string; artifactId: string }) => {
    if (tenantId !== ids.tenant || !records.has(artifactId)) throw new Error("FORBIDDEN");
  });
  const hydrateRegisteredArtifact = vi.fn(async ({ artifactId }: { artifactId: string }) => records.get(artifactId)!);
  const resolver: TrustedArtifactResolver = { authorizeArtifact, hydrateRegisteredArtifact };
  const request = {
    verificationContractVersion: "verification.v1",
    dataset: { artifactId: ids.dataset, digest: datasetHandle.digest },
    experimentDefinition: { artifactId: ids.experiment, digest: experimentHandle.digest },
    executionMode: "offline_recorded",
  };
  const catalog = new OfflineBenchmarkInputCatalog([
    {
      tenantId: ids.tenant,
      dataset: request.dataset,
      experiment: request.experimentDefinition,
      runnerVersion: "verification-benchmark-runner.v1",
    },
  ]);
  return {
    admission: new RegisteredBenchmarkInputAdmission(catalog, resolver, {
      ...(options.maximumArtifactBytes === undefined ? {} : { maximumArtifactBytes: options.maximumArtifactBytes }),
      ...(options.maximumExecutions === undefined ? {} : { maximumExecutions: options.maximumExecutions }),
    }),
    request,
    authorizeArtifact,
    hydrateRegisteredArtifact,
    dataset,
  };
}

describe("RegisteredBenchmarkInputAdmission", () => {
  it("admits only the exact trusted offline pair and returns typed recorded references", async () => {
    const test = fixture(),
      admitted = await test.admission.load(test.request, { tenantId: ids.tenant });
    expect(admitted.dataset.manifestDigest).toBe(test.dataset.manifestDigest);
    expect(admitted.experiment).toMatchObject({
      networkPolicy: "offline",
      runnerVersion: "verification-benchmark-runner.v1",
      recordedObservationArtifacts: [{ artifactId: ids.observation }],
    });
    expect(test.authorizeArtifact.mock.calls.map(([input]) => input.artifactId)).toEqual([ids.dataset, ids.experiment]);
  });

  it("deep-freezes every admitted nested input after validation", async () => {
    const test = fixture(),
      admitted = await test.admission.load(test.request, { tenantId: ids.tenant });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.dataset.cases)).toBe(true);
    expect(Object.isFrozen(admitted.dataset.cases[0]!)).toBe(true);
    expect(Object.isFrozen(admitted.experiment.recordedObservationArtifacts[0]!)).toBe(true);
    expect(() => {
      (admitted.dataset.cases[0] as { assertion: string }).assertion = "forged";
    }).toThrow();
    expect(() => {
      (admitted.experiment.recordedObservationArtifacts[0] as { digest: string }).digest = digest("f");
    }).toThrow();
  });

  it("rejects raw extras and ungranted pairs before artifact access", async () => {
    const test = fixture();
    await expect(
      test.admission.load({ ...test.request, rawResponse: "forbidden" }, { tenantId: ids.tenant }),
    ).rejects.toThrow();
    await expect(
      test.admission.load(
        { ...test.request, dataset: { ...test.request.dataset, digest: digest("f") } },
        { tenantId: ids.tenant },
      ),
    ).rejects.toThrow("BENCHMARK_INPUT_TRUSTED_GRANT_REQUIRED");
    expect(test.authorizeArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign tenant", { tenantId: ids.otherTenant }],
    ["wrong byte length", { byteLength: 1 }],
  ])("rejects dataset registration %s", async (_label, datasetHandle) => {
    const test = fixture({ datasetHandle });
    await expect(test.admission.load(test.request, { tenantId: ids.tenant })).rejects.toThrow(
      "BENCHMARK_INPUT_ARTIFACT_REGISTRATION_MISMATCH",
    );
    expect(test.hydrateRegisteredArtifact).toHaveBeenCalledTimes(1);
  });

  it("enforces bounded artifact bytes and total execution matrix", async () => {
    const bytes = fixture({ maximumArtifactBytes: 10 });
    await expect(bytes.admission.load(bytes.request, { tenantId: ids.tenant })).rejects.toThrow(
      "BENCHMARK_INPUT_ARTIFACT_REGISTRATION_MISMATCH",
    );
    const matrix = fixture({ maximumExecutions: 59 });
    await expect(matrix.admission.load(matrix.request, { tenantId: ids.tenant })).rejects.toThrow(
      "BENCHMARK_INPUT_EXECUTION_LIMIT_EXCEEDED",
    );
  });

  it("requires strict experiment dataset and trusted runner bindings", async () => {
    const wrongDataset = fixture({ experimentValue: experiment(digest("f")) });
    await expect(wrongDataset.admission.load(wrongDataset.request, { tenantId: ids.tenant })).rejects.toThrow(
      "BENCHMARK_INPUT_EXPERIMENT_BINDING_MISMATCH",
    );
    const wrongRunner = fixture({
      experimentValue: experiment(sealedDataset().manifestDigest, { runnerVersion: "other-runner" }),
    });
    await expect(wrongRunner.admission.load(wrongRunner.request, { tenantId: ids.tenant })).rejects.toThrow();
  });

  it("rejects caller tenant forgery before grant lookup or hydration", async () => {
    const test = fixture();
    await expect(test.admission.load(test.request, { tenantId: "forged" })).rejects.toThrow(
      "BENCHMARK_INPUT_CONTEXT_TENANT_INVALID",
    );
    expect(test.authorizeArtifact).not.toHaveBeenCalled();
  });
});
