import { readFile } from "node:fs/promises";
import type {
  VerificationBenchmarkArm,
  VerificationBenchmarkCase,
  VerificationBenchmarkDataset,
} from "@aiengineer/knowledge-contracts";
import {
  MemoryVerificationBenchmarkCheckpointStore,
  runVerificationBenchmark,
  verificationBenchmarkDigest,
  type VerificationBenchmarkRun,
} from "@aiengineer/knowledge-evaluation";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { describe, expect, it } from "vitest";
import type { DiagnosticsAdversarialObservation } from "./verification-diagnostics-adversarial.js";
import { buildDiagnosticsMutationReport } from "./verification-diagnostics-mutation-report.js";

const id = "00000000-0000-4000-8000-000000000001";
const digest = (value: string): `sha256:${string}` => sha256Digest(value);
const arms: readonly VerificationBenchmarkArm[] = ["baseline", "luna", "interfaze", "cascade"].map((armId, index) => ({
  armId,
  name: armId,
  control: index === 0,
  strategy: index === 0 ? "baseline" : index === 1 ? "interfaze" : index === 2 ? "cascade" : "consensus_abstention",
  extractorProfile: "fixture",
  parserProfile: "fixture",
  retrieverProfile: "fixture",
  judgeProfile: "fixture",
  policyVersion: "fixture",
  configurationDigest: digest(armId),
  cachePolicy: "disabled",
  replicas: 1,
}));

async function fixture(): Promise<{
  dataset: VerificationBenchmarkDataset;
  run: VerificationBenchmarkRun;
  observations: readonly DiagnosticsAdversarialObservation[];
}> {
  const bytes = await readFile(
    new URL("../../../../catalog/verification-benchmarks/diagnostics-companies-pilot-v3/dataset.json", import.meta.url),
  );
  const dataset = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as VerificationBenchmarkDataset;
  const run = await runVerificationBenchmark({
    runId: id,
    dataset,
    experimentDefinitionDigest: digest("experiment"),
    arms,
    repetitions: 1,
    randomSeed: 1,
    networkPolicy: "offline",
    checkpoints: new MemoryVerificationBenchmarkCheckpointStore(),
    now: () => "2026-09-08T00:00:00.000Z",
    execute: async ({ testCase, arm }) => ({
      schemaValid: true,
      locatorValid: testCase.caseId !== "tru-pdf-graph-text-abstention",
      fieldMechanics: !testCase.adversarialTransforms.length,
      support:
        testCase.caseId === "tru-pdf-graph-text-abstention"
          ? "not_applicable"
          : testCase.adversarialTransforms.length
            ? "none"
            : "full",
      authority: "insufficient",
      worldCorrectness: "unknown",
      policy: testCase.adversarialTransforms.length ? "review" : "pass",
      confidence: null,
      confidenceCalibrated: false,
      failureClass: arm.armId === "luna" ? "provider" : "none",
      callAttributions: [],
    }),
  });
  const observations = dataset.cases
    .filter((item) => item.pairCluster !== "tru-pdf-graph-text-abstention")
    .map(
      (testCase) =>
        ({
          caseId: testCase.caseId,
          transforms: testCase.adversarialTransforms,
          exactSource: { evaluated: true, valid: true, failedCheckCodes: [] },
          corruptedLocator: {
            evaluated: true,
            valid: false,
            failedCheckCodes: ["SELECTOR_NOT_FOUND"],
            selector: { kind: "html", domPath: "999999" },
          },
          selectedDigestTamper: { evaluated: true, valid: false, failedCheckCodes: ["DIGEST_MISMATCH"] },
          assertionTextReplay: { evaluated: true, valid: !testCase.adversarialTransforms.length, failedCheckCodes: [] },
          unsupportedSemanticPaths: [],
        }) satisfies DiagnosticsAdversarialObservation,
    );
  return { dataset, run, observations };
}

describe("diagnostics adversarial mutation report", () => {
  it("validates the full frozen run, retains pilot-v3 unpaired cases as gaps, and never uses labels", async () => {
    const value = await fixture();
    const report = buildDiagnosticsMutationReport(value);
    expect(report.counts).toEqual({ cases: 43, pairs: 20, arms: 4, observations: 42 });
    expect(report.unpairedClusters).toHaveLength(3);
    expect(report.missingObservationCaseIds).toHaveLength(1);
    expect(report.pairs[0]!.arms.find((item) => item.armId === "baseline")!.comparison).toMatchObject({
      support: "strict_degradation",
      policy: "strict_degradation",
      fieldMechanics: "strict_degradation",
    });
    expect(report.pairs[0]!.arms.find((item) => item.armId === "luna")!.comparison.reason).toBe(
      "original_or_mutated_failure",
    );
    expect(report.familyCoverage.find((item) => item.family === "algorithms")!.covered).toBe(true);
    expect(report.rawTransformCoverage.find((item) => item.rawTransform === "sample_type_swap")!.families).toEqual([]);
    expect(report.rawTransformCoverage.find((item) => item.rawTransform === "study_design_swap")!.families).toEqual([]);
    expect(report.citationMechanics).toHaveLength(42);
    expect(report.limitations).toContain(
      "The recorded baseline is lexical mechanics only; no semantic judgment is inferred.",
    );
    expect(report).not.toHaveProperty("expectedPolicy");
  });

  it("rejects a resealed foreign checkpoint and unknown or detached observations", async () => {
    const value = await fixture();
    const cloned = structuredClone(value.run) as VerificationBenchmarkRun;
    const alteredResults = cloned.results.map((item, index) =>
      index === 0 ? { ...item, checkpointContextDigest: digest("foreign") } : item,
    );
    const { manifestDigest: _ignored, ...foreignMaterial } = { ...cloned, results: alteredResults };
    const foreign = {
      ...foreignMaterial,
      manifestDigest: verificationBenchmarkDigest(foreignMaterial),
    } as VerificationBenchmarkRun;
    await expect(() => buildDiagnosticsMutationReport({ ...value, run: foreign })).toThrow(
      "BENCHMARK_RUN_RESULT_INVALID",
    );
    await expect(() =>
      buildDiagnosticsMutationReport({ ...value, observations: [{ ...value.observations[0]!, caseId: "unknown" }] }),
    ).toThrow("DIAGNOSTICS_MUTATION_REPORT_OBSERVATION_BINDING_INVALID");
    await expect(() =>
      buildDiagnosticsMutationReport({
        ...value,
        observations: [{ ...value.observations[0]!, transforms: ["invented"] }, ...value.observations.slice(1)],
      }),
    ).toThrow("DIAGNOSTICS_MUTATION_REPORT_OBSERVATION_BINDING_INVALID");
  });
});
