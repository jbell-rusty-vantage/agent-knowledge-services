import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseVerificationBenchmarkComparisonRuntimeConfig } from "./verification-benchmark-comparison-runtime-config.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function config() {
  const pair = generateKeyPairSync("ed25519");
  return {
    schemaVersion: "verification-benchmark-comparison-runtime.v1",
    tenantId: id(1),
    profiles: [{ profileId: "paired_default", artifact: { artifactId: id(2), digest: `sha256:${"a".repeat(64)}` } }],
    inputPublicKeys: [
      { keyId: "input-key", publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() },
    ],
    runtime: {
      deploymentId: "fixture",
      capabilityVersion: "verification-service.v1",
      targetCodeRef: "fixture",
      gitSha: "a".repeat(40),
      dirty: false,
    },
  };
}
describe("comparison runtime grants", () => {
  it("binds exact tenant/profile artifacts and snapshots configured public keys", () => {
    const value = config(),
      parsed = parseVerificationBenchmarkComparisonRuntimeConfig(JSON.stringify(value));
    expect(parsed.catalog.resolve(id(1), "paired_default").artifact.artifactId).toBe(id(2));
    expect(() => parsed.catalog.resolve(id(3), "paired_default")).toThrow("TRUSTED_GRANT_REQUIRED");
    expect(Object.isFrozen(parsed.inputPublicKeys)).toBe(true);
    expect(Object.getPrototypeOf(parsed.inputPublicKeys)).toBeNull();
  });
  it("rejects duplicate profile or key authority, unknown options and uncustodied dirty code", () => {
    const value = config();
    for (const invalid of [
      { ...value, profiles: [...value.profiles, ...value.profiles] },
      { ...value, inputPublicKeys: [...value.inputPublicKeys, ...value.inputPublicKeys] },
      { ...value, callerTrust: true },
      { ...value, runtime: { ...value.runtime, dirty: true } },
    ])
      expect(() => parseVerificationBenchmarkComparisonRuntimeConfig(JSON.stringify(invalid))).toThrow(
        "INVALID_VERIFICATION_BENCHMARK_COMPARISON_RUNTIME_CONFIG",
      );
  });
  it("rejects private or non-Ed25519 signing material and oversized configuration", () => {
    const value = config(),
      rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      ed = generateKeyPairSync("ed25519");
    for (const pem of [
      rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
      ed.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ])
      expect(() =>
        parseVerificationBenchmarkComparisonRuntimeConfig(
          JSON.stringify({ ...value, inputPublicKeys: [{ keyId: "invalid", publicKeyPem: pem }] }),
        ),
      ).toThrow("INVALID_VERIFICATION_BENCHMARK_COMPARISON_RUNTIME_CONFIG");
    expect(() => parseVerificationBenchmarkComparisonRuntimeConfig(" ".repeat(131073))).toThrow(
      "INVALID_VERIFICATION_BENCHMARK_COMPARISON_RUNTIME_CONFIG",
    );
  });
});
