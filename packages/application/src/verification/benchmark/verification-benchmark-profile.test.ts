import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  admitDiagnosticsExtractionExperimentFiles,
  createDiagnosticsExtractionProviderInput,
  loadDiagnosticsExtractionExperiment,
} from "./verification-benchmark.js";

const directory = resolve(
  import.meta.dirname,
  "../../../../../catalog/verification-benchmarks/diagnostics-companies-pilot-v4",
);
async function fixture() {
  const manifestBytes = await readFile(resolve(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { files: Array<{ name: string }> };
  const names = new Set([
    "dataset.json",
    "derived-input-grant.json",
    "case-artifact-registry.json",
    "experiments/extraction-v1/manifest.json",
    "experiments/extraction-v1/output-schema.json",
    ...manifest.files.map((item) => item.name),
  ]);
  const files = new Map<string, Uint8Array>([["manifest.json", manifestBytes]]);
  for (const name of names) files.set(name, await readFile(resolve(directory, name)));
  return files;
}

describe("sealed diagnostics profile bytes", () => {
  it("reconstructs identical profile authority without a filesystem port and snapshots its bytes", async () => {
    const files = await fixture(),
      admitted = admitDiagnosticsExtractionExperimentFiles(files);
    const prior = await loadDiagnosticsExtractionExperiment(directory);
    expect(admitted.authority).toEqual(prior.authority);
    const plan = admitted.experiment.casePlan.find((item) => item.execution === "fresh_dispatch")!;
    const testCase = admitted.dataset.cases.find((item) => item.caseId === plan.caseId)!;
    const expected = createDiagnosticsExtractionProviderInput(testCase, admitted.authority);
    for (const bytes of files.values()) bytes.fill(0);
    files.clear();
    expect(createDiagnosticsExtractionProviderInput(testCase, admitted.authority)).toEqual(expected);
  });

  it("rejects missing profile files and modified retained bytes", async () => {
    const files = await fixture();
    const schema = files.get("experiments/extraction-v1/output-schema.json")!;
    files.delete("experiments/extraction-v1/output-schema.json");
    expect(() => admitDiagnosticsExtractionExperimentFiles(files)).toThrow(
      "BENCHMARK_EXTRACTION_PROFILE_FILE_REQUIRED",
    );
    files.set("experiments/extraction-v1/output-schema.json", schema);
    files.set("derived-input-grant.json", new TextEncoder().encode("{}"));
    expect(() => admitDiagnosticsExtractionExperimentFiles(files)).toThrow(
      "BENCHMARK_EXTRACTION_CATALOG_SEAL_MISMATCH",
    );
  });
});
