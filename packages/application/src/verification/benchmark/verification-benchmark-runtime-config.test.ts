import { describe, expect, it } from "vitest";
import { parseVerificationBenchmarkRuntimeConfig } from "./verification-benchmark-runtime-config.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reference = (n: number) => ({ artifactId: id(n), digest: `sha256:${"1".repeat(64)}` });
function fixture() {
  const pair = { tenantId: id(1), dataset: reference(2), experiment: reference(3) };
  return {
    schemaVersion: "verification-benchmark-runtime.v1",
    tenantId: pair.tenantId,
    inputs: [{ ...pair, runnerVersion: "verification-benchmark-runner.v1" }],
    profiles: [
      {
        ...pair,
        profileFiles: [
          "manifest.json",
          "dataset.json",
          "derived-input-grant.json",
          "case-artifact-registry.json",
          "experiments/extraction-v1/manifest.json",
          "experiments/extraction-v1/output-schema.json",
        ].map((name, index) => ({ name, ...reference(10 + index) })),
      },
    ],
    sources: [{ ...pair, manifest: reference(20), copies: [{ originalArtifactId: id(21), ...reference(22) }] }],
    replays: [{ ...pair, checkpoints: [{ ...reference(30), runIdentityDigest: reference(31).digest }] }],
    policies: [{ tenantId: pair.tenantId, policyVersion: "diagnostics-policy.v1", policyArtifact: reference(40) }],
    runtime: {
      deploymentId: "fixture",
      capabilityVersion: "verification.v1",
      targetCodeRef: "fixture",
      gitSha: "fixture",
      dirty: false,
    },
  };
}
describe("benchmark runtime configuration", () => {
  it("creates immutable complete catalogs without claiming live artifact readiness", () => {
    const value = fixture(),
      config = parseVerificationBenchmarkRuntimeConfig(JSON.stringify(value));
    value.inputs[0]!.dataset.artifactId = id(99);
    expect(
      config.inputs.resolve(id(1), {
        verificationContractVersion: "verification.v1",
        dataset: reference(2),
        experimentDefinition: reference(3),
        executionMode: "offline_recorded",
      }),
    ).toMatchObject({ dataset: reference(2) });
    expect(Object.isFrozen(config.runtime)).toBe(true);
  });
  it.each(["tenant", "pair", "policy", "dirty", "empty"])("rejects incomplete or mismatched %s config", (kind) => {
    const value = fixture();
    if (kind === "tenant") value.replays[0]!.tenantId = id(99);
    if (kind === "pair") value.sources[0]!.experiment = reference(99);
    if (kind === "policy") value.policies[0]!.policyVersion = "unregistered-policy";
    if (kind === "dirty") value.runtime.dirty = true;
    if (kind === "empty") value.profiles = [];
    expect(() => parseVerificationBenchmarkRuntimeConfig(JSON.stringify(value))).toThrow();
  });
  it("rejects oversized or unknown configuration fields", () => {
    expect(() => parseVerificationBenchmarkRuntimeConfig(" ".repeat(1_048_577))).toThrow("CONFIG_TOO_LARGE");
    expect(() =>
      parseVerificationBenchmarkRuntimeConfig(JSON.stringify({ ...fixture(), providerApiKey: "not-a-key" })),
    ).toThrow();
  });
});
