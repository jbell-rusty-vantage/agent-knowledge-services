import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verificationBenchmarkDigest } from "@aiengineer/knowledge-evaluation";
import {
  createDiagnosticsProviderCaseInput,
  loadDiagnosticsProviderGrant,
  loadDiagnosticsV1ProviderGrant,
} from "./verification-diagnostics-provider-grant.js";

const root = resolve(import.meta.dirname, "../../../../catalog/verification-benchmarks");
describe("sealed original diagnostics provider authority", () => {
  it("binds all 40 exact inputs and rejects forged capabilities and changed cases", async () => {
    const { dataset, authority } = await loadDiagnosticsV1ProviderGrant(resolve(root, "diagnostics-companies-v1"));
    expect(authority.authorizedCaseCount).toBe(40);
    for (const testCase of dataset.cases) {
      const input = createDiagnosticsProviderCaseInput(testCase, authority);
      expect(input.assertion).toBe(testCase.assertion);
      expect(input.fragment).toBe(testCase.evidence[0]!.excerpt);
      expect(input.assertion.length + input.fragment.length).toBeLessThanOrEqual(2_000);
    }
    const original = dataset.cases[0]!;
    expect(() => createDiagnosticsProviderCaseInput(original, { ...authority })).toThrow(
      "BENCHMARK_CASE_NOT_AUTHORIZED_FOR_PROVIDER",
    );
    const changed = structuredClone(original);
    changed.assertion += " changed";
    const { caseDigest: _digest, ...content } = changed;
    changed.caseDigest = verificationBenchmarkDigest(content);
    expect(() => createDiagnosticsProviderCaseInput(changed, authority)).toThrow(
      "BENCHMARK_CASE_NOT_AUTHORIZED_FOR_PROVIDER",
    );
    const pilot = await loadDiagnosticsProviderGrant(resolve(root, "diagnostics-companies-pilot-v3"));
    expect(() =>
      createDiagnosticsProviderCaseInput(
        pilot.dataset.cases.find((item) => item.caseId === original.caseId)!,
        authority,
      ),
    ).toThrow("BENCHMARK_CASE_NOT_AUTHORIZED_FOR_PROVIDER");
    expect(() => createDiagnosticsProviderCaseInput(original, pilot.authority)).toThrow(
      "BENCHMARK_CASE_NOT_AUTHORIZED_FOR_PROVIDER",
    );
  });
  it("rejects the other catalog instead of substituting original assertions", async () => {
    await expect(loadDiagnosticsV1ProviderGrant(resolve(root, "diagnostics-companies-pilot-v3"))).rejects.toThrow(
      "DIAGNOSTICS_OFFLINE_CATALOG_SEAL_MISMATCH",
    );
    await expect(loadDiagnosticsProviderGrant(resolve(root, "diagnostics-companies-v1"))).rejects.toThrow(
      "BENCHMARK_CATALOG_SEAL_MISMATCH",
    );
  });
});
