import { describe, expect, it } from "vitest";
import { VerificationBenchmarkExperimentDefinitionSchema } from "./benchmark.js";

const digest = `sha256:${"a".repeat(64)}`;
const artifactId = "11111111-1111-4111-8111-111111111111";
const arm = {
  armId: "control",
  name: "Control",
  control: true,
  strategy: "baseline",
  extractorProfile: "recorded",
  parserProfile: "frozen",
  retrieverProfile: "bound",
  judgeProfile: "recorded",
  policyVersion: "v1",
  configurationDigest: digest,
  cachePolicy: "disabled",
  replicas: 1,
};
const definition = {
  schemaVersion: "verification-benchmark-experiment.v1",
  verificationContractVersion: "verification.v1",
  experimentId: "offline-fixture",
  datasetManifestDigest: digest,
  runnerVersion: "verification-benchmark-runner.v1",
  randomSeed: 1,
  repetitions: 1,
  arms: [arm, { ...arm, armId: "candidate", control: false }],
  networkPolicy: "offline",
  recordedObservationArtifacts: [{ artifactId, digest }],
};

describe("registered offline experiment definition", () => {
  it("accepts a context-free immutable definition", () => {
    expect(VerificationBenchmarkExperimentDefinitionSchema.parse(definition)).toEqual(definition);
  });
  it("rejects runtime authority, live dispatch and incompatible runner fields", () => {
    for (const mutation of [
      { networkPolicy: "allow_listed_providers" },
      { runnerVersion: "unknown-runner" },
      { context: { tenantId: artifactId } },
      { providerEndpoint: "https://provider.invalid" },
    ]) {
      expect(VerificationBenchmarkExperimentDefinitionSchema.safeParse({ ...definition, ...mutation }).success).toBe(
        false,
      );
    }
  });
  it("rejects ambiguous arm and recorded artifact bindings", () => {
    for (const mutation of [
      { arms: [arm, arm] },
      {
        arms: [
          { ...arm, control: false },
          { ...arm, armId: "candidate", control: false },
        ],
      },
      {
        recordedObservationArtifacts: [
          { artifactId, digest },
          { artifactId, digest },
        ],
      },
    ]) {
      expect(VerificationBenchmarkExperimentDefinitionSchema.safeParse({ ...definition, ...mutation }).success).toBe(
        false,
      );
    }
  });
});
