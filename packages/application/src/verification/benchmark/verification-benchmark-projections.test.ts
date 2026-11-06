import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { freezeVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { describe, expect, it, vi } from "vitest";
import type { AdmittedOfflineBenchmarkInputs } from "./verification-benchmark-inputs.js";
import { prepareRegisteredBenchmarkProjections } from "./verification-benchmark-projections.js";

const ids = {
  tenant: "11111111-1111-4111-8111-111111111111",
  dataset: "22222222-2222-4222-8222-222222222222",
  experiment: "33333333-3333-4333-8333-333333333333",
  source: "44444444-4444-4444-8444-444444444444",
  projection: "55555555-5555-4555-8555-555555555555",
  transformation: "66666666-6666-4666-8666-666666666666",
};
const now = "2026-09-05T12:00:00.000Z";
const bytes = new TextEncoder().encode(
  canonicalizeJson({
    kind: "html_dom",
    document: { tag: "html", children: [{ tag: "span", text: "Exact evidence" }] },
    canonicalText: "Exact evidence",
  }),
);
const projectionDigest = sha256Digest(bytes);
const wrongDigest = sha256Digest("wrong selected bytes");
const handle = (
  artifactId: string,
  digest: `sha256:${string}`,
  byteLength = bytes.byteLength,
): VerificationArtifactHandle => ({
  artifactId,
  tenantId: ids.tenant,
  digest,
  mediaType: "application/json",
  byteLength,
  objectKey: `private/${artifactId}`,
  createdAt: now,
  producerActivityId: "fixture",
  producerVersion: "v1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});
const source = handle(ids.source, sha256Digest("source"), 6);
const projection = handle(ids.projection, projectionDigest);

function admitted(options: { firstCaseId?: string; firstFragmentId?: string } = {}): AdmittedOfflineBenchmarkInputs {
  const evidence = (index: number, suffix = "") => ({
    fragmentId: index === 0 && suffix === "" ? (options.firstFragmentId ?? "fragment-0") : `fragment-${index}${suffix}`,
    captureId: ids.source,
    sourceKey: "source",
    sourceClass: "first_party",
    projectionArtifactId: ids.projection,
    projectionDigest,
    transformationArtifactId: ids.transformation,
    selector: { kind: "html" as const, domPath: "0" },
    selectedContentDigest: index === 0 && suffix === "-invalid" ? wrongDigest : sha256Digest("Exact evidence"),
    excerpt: "Exact evidence",
    rights: "fixture",
    providerUploadAuthorized: false,
  });
  const dataset = freezeVerificationBenchmarkDataset({
    schemaVersion: "verification-benchmark.v1",
    verificationContractVersion: "verification.v1",
    datasetId: "fixture",
    version: 1,
    stage: "pilot",
    frozen: true,
    supersedesManifestDigest: null,
    sourcePreparationDigest: sha256Digest("source-prep"),
    labelProvenance: "engineering_expectations",
    annotationGuidelinesDigest: sha256Digest("guidelines"),
    adjudicationArtifactDigest: null,
    createdAt: now,
    sealedAt: now,
    cases: Array.from({ length: 30 }, (_, index) => ({
      schemaVersion: "verification-benchmark.v1",
      caseId: index === 0 ? (options.firstCaseId ?? "case-0") : `case-${index}`,
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
      evidence: index === 0 ? [evidence(index), evidence(index, "-invalid")] : [evidence(index)],
      expectation: {
        label: "supported_by_source",
        labelStatus: "engineering_expectation",
        expectedPolicy: "pass_with_warnings",
        expectedLocatorValid: true,
        support: "full",
        authority: "interested_party_only",
        worldCorrectness: "not_established",
        rationale: "Fixture.",
      },
      independentObservation: true,
      humanGoldScoringEligible: false,
      adjudicationId: null,
    })),
  });
  const datasetArtifact = handle(ids.dataset, sha256Digest("dataset"), 7),
    experimentArtifact = handle(ids.experiment, sha256Digest("experiment"), 10);
  return deepFreeze({
    request: {
      verificationContractVersion: "verification.v1",
      dataset: { artifactId: ids.dataset, digest: datasetArtifact.digest },
      experimentDefinition: { artifactId: ids.experiment, digest: experimentArtifact.digest },
      executionMode: "offline_recorded",
    },
    grant: {
      tenantId: ids.tenant,
      dataset: { artifactId: ids.dataset, digest: datasetArtifact.digest },
      experiment: { artifactId: ids.experiment, digest: experimentArtifact.digest },
      runnerVersion: "verification-benchmark-runner.v1",
    },
    dataset,
    datasetArtifact,
    experiment: {
      schemaVersion: "verification-benchmark-experiment.v1",
      verificationContractVersion: "verification.v1",
      experimentId: "fixture",
      datasetManifestDigest: dataset.manifestDigest,
      runnerVersion: "verification-benchmark-runner.v1",
      randomSeed: 7,
      repetitions: 1,
      arms: [
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
          configurationDigest: sha256Digest("arm"),
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
          configurationDigest: sha256Digest("arm2"),
          cachePolicy: "exact_request_only",
          replicas: 1,
        },
      ],
      networkPolicy: "offline",
      recordedObservationArtifacts: [],
    },
    experimentArtifact,
  }) as AdmittedOfflineBenchmarkInputs;
}

function ports(options: { foreignSource?: boolean; corruptProjectionBytes?: boolean; abort?: AbortController } = {}) {
  const captures = {
    getRegisteredCapture: vi.fn(async () => {
      options.abort?.abort(new Error("STOP_NOW"));
      return {
        source: {
          sourceId: ids.source,
          kind: "web_page" as const,
          canonicalUri: "https://example.test",
          logicalIdentity: "fixture",
        },
        capture: {
          captureId: ids.source,
          sourceId: ids.source,
          capturedAt: now,
          captureMethod: "fixture",
          captureMethodVersion: "v1",
          contentArtifact: options.foreignSource
            ? { ...source, tenantId: "99999999-9999-4999-8999-999999999999" }
            : source,
        },
      };
    }),
  };
  const admission = {
    hydrateAdmittedProjection: vi.fn(
      async ({ captureId, projectionArtifactId }: { captureId: string; projectionArtifactId: string }) => ({
        receipt: {
          captureId,
          sourceArtifact: source,
          projectionArtifact: { ...projection, artifactId: projectionArtifactId },
        },
        content: options.corruptProjectionBytes ? new TextEncoder().encode("corrupt") : bytes.slice(),
      }),
    ),
  };
  return { captures, admission };
}

describe("prepareRegisteredBenchmarkProjections", () => {
  it("hydrates every edge and keeps selector mismatch as locator mechanics", async () => {
    const test = ports(),
      output = await prepareRegisteredBenchmarkProjections(admitted(), { tenantId: ids.tenant }, test);
    const first = output.byCaseId["case-0"]!.byFragmentId;
    expect(Object.keys(first)).toEqual(["fragment-0", "fragment-0-invalid"]);
    expect(first["fragment-0"]).toMatchObject({
      locatorValid: true,
      selectedText: "Exact evidence",
      selectorStatus: "resolved",
    });
    expect(first["fragment-0-invalid"]).toMatchObject({ locatorValid: false, selectorStatus: "resolved" });
    expect(first["fragment-0-invalid"]!.selectedText).toBeUndefined();
    expect(test.admission.hydrateAdmittedProjection).toHaveBeenCalledTimes(31);
  });

  it("keeps capture and projection custody failures terminal", async () => {
    const test = ports({ foreignSource: true });
    await expect(prepareRegisteredBenchmarkProjections(admitted(), { tenantId: ids.tenant }, test)).rejects.toThrow(
      "BENCHMARK_PROJECTION_CAPTURE_BINDING_MISMATCH",
    );
    expect(test.admission.hydrateAdmittedProjection).not.toHaveBeenCalled();
    await expect(
      prepareRegisteredBenchmarkProjections(
        admitted(),
        { tenantId: ids.tenant },
        ports({ corruptProjectionBytes: true }),
      ),
    ).rejects.toThrow("BENCHMARK_PROJECTION_CUSTODY_BINDING_MISMATCH");
  });

  it("propagates cancellation after an awaited capture without a mechanical result", async () => {
    const controller = new AbortController(),
      test = ports({ abort: controller });
    await expect(
      prepareRegisteredBenchmarkProjections(admitted(), { tenantId: ids.tenant, signal: controller.signal }, test),
    ).rejects.toThrow("BENCHMARK_CANCELLED");
    expect(test.admission.hydrateAdmittedProjection).not.toHaveBeenCalled();
  });

  it("returns a deeply immutable, byte-free compact projection map", async () => {
    const output = await prepareRegisteredBenchmarkProjections(admitted(), { tenantId: ids.tenant }, ports());
    expect(Object.isFrozen(output.byCaseId["case-0"]!.byFragmentId)).toBe(true);
    expect(() => {
      (output.byCaseId["case-0"]!.byFragmentId["fragment-0"] as { locatorValid: boolean }).locatorValid = false;
    }).toThrow();
    expect(JSON.stringify(output)).not.toContain("Uint8Array");
  });

  it("preserves adversarial case and fragment IDs without prototype lookup", async () => {
    const output = await prepareRegisteredBenchmarkProjections(
      admitted({ firstCaseId: "__proto__", firstFragmentId: "constructor" }),
      { tenantId: ids.tenant },
      ports(),
    );
    expect(Object.getPrototypeOf(output.byCaseId)).toBeNull();
    expect(Object.getPrototypeOf(output.byCaseId["__proto__"]!.byFragmentId)).toBeNull();
    expect(output.byCaseId["__proto__"]!.byFragmentId["constructor"]).toMatchObject({
      fragmentId: "constructor",
      locatorValid: true,
    });
  });
});
