import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConfiguredVerificationBenchmarkComparisonHandler } from "./verification-benchmark-comparison-runtime.js";
const tenantId = "00000000-0000-4000-8000-000000000001";
function input() {
  const key = generateKeyPairSync("ed25519"),
    config = {
      schemaVersion: "verification-benchmark-comparison-runtime.v1",
      tenantId,
      profiles: [
        {
          profileId: "paired_default",
          artifact: { artifactId: "00000000-0000-4000-8000-000000000002", digest: `sha256:${"a".repeat(64)}` },
        },
      ],
      inputPublicKeys: [
        { keyId: "input", publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString() },
      ],
      runtime: {
        deploymentId: "test",
        capabilityVersion: "verification.v1",
        targetCodeRef: "fixture",
        gitSha: "a".repeat(40),
        dirty: false,
      },
    };
  return {
    database: {} as never,
    tenantId,
    projectUrl: "http://127.0.0.1:54321",
    serviceRoleKey: "local-test-key",
    maximumArtifactBytes: 8 * 1024 * 1024,
    environment: {
      VERIFICATION_BENCHMARK_COMPARISON_CONFIG_JSON: JSON.stringify(config),
      VERIFICATION_BENCHMARK_COMPARISON_SIGNING_PRIVATE_KEY_PEM: key.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      VERIFICATION_BENCHMARK_COMPARISON_SIGNING_KEY_ID: "comparison",
    },
  };
}
describe("configured comparison runtime", () => {
  it("constructs only with operator profile configuration and matching tenant/signing identity", () => {
    const value = input();
    expect(createConfiguredVerificationBenchmarkComparisonHandler({ ...value, environment: {} })).toBeUndefined();
    expect(() =>
      createConfiguredVerificationBenchmarkComparisonHandler({
        ...value,
        tenantId: "00000000-0000-4000-8000-000000000099",
      }),
    ).toThrow("TENANT_MISMATCH");
    expect(() =>
      createConfiguredVerificationBenchmarkComparisonHandler({
        ...value,
        environment: {
          VERIFICATION_BENCHMARK_COMPARISON_CONFIG_JSON:
            value.environment.VERIFICATION_BENCHMARK_COMPARISON_CONFIG_JSON,
        },
      }),
    ).toThrow("SIGNING_KEY_REQUIRED");
    expect(createConfiguredVerificationBenchmarkComparisonHandler(value)).toMatchObject({
      operationKind: "verification_benchmark_compare",
      stepName: "compare_registered_and_publish",
    });
  });
});
