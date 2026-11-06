import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseBenchmarkReadPublicKeys,
  createVerificationBenchmarkReads,
} from "./verification-benchmark-reads-runtime.js";

describe("benchmark read signing trust", () => {
  const pair = generateKeyPairSync("ed25519"),
    publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  it("retains an immutable operator keyring and permits rotation", () => {
    const keys = parseBenchmarkReadPublicKeys(
      JSON.stringify([
        { keyId: "old", publicKeyPem },
        { keyId: "new", publicKeyPem },
      ]),
    );
    expect(Object.keys(keys)).toEqual(["old", "new"]);
    expect(Object.isFrozen(keys)).toBe(true);
  });
  it("rejects duplicates, private material, other algorithms and unbounded or ambiguous input", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    for (const value of [
      [],
      [
        { keyId: "one", publicKeyPem },
        { keyId: "one", publicKeyPem },
      ],
      [{ keyId: "one", publicKeyPem, trust: true }],
      [{ keyId: "one", publicKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString() }],
      [{ keyId: "one", publicKeyPem: ec.publicKey.export({ format: "pem", type: "spki" }).toString() }],
    ])
      expect(() => parseBenchmarkReadPublicKeys(JSON.stringify(value))).toThrow(
        "INVALID_VERIFICATION_BENCHMARK_READ_PUBLIC_KEYS",
      );
    expect(() => parseBenchmarkReadPublicKeys(" ".repeat(131073))).toThrow(
      "INVALID_VERIFICATION_BENCHMARK_READ_PUBLIC_KEYS",
    );
  });
  it("stays unavailable without a trusted keyring and fails configured incomplete custody", () => {
    expect(createVerificationBenchmarkReads(undefined, {})).toBeUndefined();
    expect(() =>
      createVerificationBenchmarkReads(undefined, {
        VERIFICATION_BENCHMARK_READ_PUBLIC_KEYS_JSON: JSON.stringify([{ keyId: "one", publicKeyPem }]),
      }),
    ).toThrow("VERIFICATION_BENCHMARK_READS_STORAGE_REQUIRED");
  });
});
