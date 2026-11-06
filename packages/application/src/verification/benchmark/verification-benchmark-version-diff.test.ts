import { describe, expect, it } from "vitest";
import type { VerificationBenchmarkDataset } from "@aiengineer/knowledge-contracts";
import { freezeVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import { prepareVerificationBenchmarkVersionDiff } from "./verification-benchmark-version-diff.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const uuid = "11111111-1111-4111-8111-111111111111";
const captureId = "22222222-2222-4222-8222-222222222222";
const draft = (
  version: number,
  supersedesManifestDigest: `sha256:${string}` | null,
  sourcePreparationDigest = digest("a"),
) => ({
  schemaVersion: "verification-benchmark.v1" as const,
  verificationContractVersion: "verification.v1" as const,
  datasetId: "diagnostics-companies",
  version,
  stage: "pilot" as const,
  frozen: true as const,
  supersedesManifestDigest,
  sourcePreparationDigest,
  labelProvenance: "engineering_expectations" as const,
  annotationGuidelinesDigest: digest("b"),
  adjudicationArtifactDigest: null,
  cases: Array.from({ length: 30 }, (_, index) => ({
    schemaVersion: "verification-benchmark.v1" as const,
    caseId: `case-${index + 1}`,
    partition: "development" as const,
    inputManifestArtifactId: uuid,
    goldArtifactId: null,
    modality: "html" as const,
    sourceFamily: "source",
    entityFamily: "entity",
    reportCluster: "report",
    pairCluster: "pair",
    tags: ["literal"],
    adversarialTransforms: [],
    assertion: "Bounded statement.",
    evidence: [
      {
        fragmentId: digest((index % 10).toString()),
        captureId,
        sourceKey: "source",
        sourceClass: "first_party" as const,
        projectionArtifactId: uuid,
        projectionDigest: digest("d"),
        transformationArtifactId: "33333333-3333-4333-8333-333333333333",
        selector: { kind: "text_quote" as const, quote: "Bounded statement.", normalization: "none" as const },
        selectedContentDigest: digest("e"),
        excerpt: "Bounded statement.",
        rights: "fixture",
        providerUploadAuthorized: false,
      },
    ],
    expectation: {
      label: "supported_by_source" as const,
      labelStatus: "engineering_expectation" as const,
      expectedPolicy: "pass_with_warnings" as const,
      expectedLocatorValid: true,
      support: "full" as const,
      authority: "interested_party_only" as const,
      worldCorrectness: "not_established" as const,
      rationale: "Engineering expectation only.",
    },
    independentObservation: false,
    humanGoldScoringEligible: false,
    adjudicationId: null,
  })),
  createdAt: "2026-09-07T00:00:00.000Z",
  sealedAt: "2026-09-07T00:00:00.000Z",
});
const previous = freezeVerificationBenchmarkDataset(draft(1, null));
const proposed = (changes: Partial<ReturnType<typeof draft>> = {}) =>
  freezeVerificationBenchmarkDataset({
    ...draft(2, previous.manifestDigest as `sha256:${string}`, digest("f")),
    ...changes,
  });
const input = (next = proposed()) => ({
  previousDataset: previous,
  proposedDataset: next,
  previousManifestDigest: previous.manifestDigest,
  proposedManifestDigest: next.manifestDigest,
});

describe("verification benchmark version diff", () => {
  it("binds sealed successors and adds source-preparation and pending-review deltas without human approval", () => {
    const result = prepareVerificationBenchmarkVersionDiff(input());
    expect(result).toMatchObject({
      lineage: {
        valid: true,
        previousVersion: 1,
        proposedVersion: 2,
        proposedSupersedesManifestDigest: previous.manifestDigest,
      },
      sourcePreparation: { changed: true, previousDigest: digest("a"), proposedDigest: digest("f") },
      reviewState: {
        previousPendingReviewCaseCount: 30,
        proposedPendingReviewCaseCount: 30,
        previousHumanGoldEligibleCaseCount: 0,
        proposedHumanGoldEligibleCaseCount: 0,
        humanApprovalGranted: false,
      },
    });
    expect(result.resultDigest).toMatch(/^sha256:/);
  });

  it("retains the underlying case additions/removals/changes", () => {
    const changed = structuredClone(proposed()) as VerificationBenchmarkDataset;
    const mutable = structuredClone(changed) as any;
    mutable.cases[0].assertion = "Changed bounded statement.";
    mutable.cases = mutable.cases.map(({ caseDigest: _caseDigest, ...item }: any) => item);
    delete mutable.manifestDigest;
    const next = freezeVerificationBenchmarkDataset(mutable);
    expect(prepareVerificationBenchmarkVersionDiff(input(next)).caseDiff.changed).toEqual(["case-1"]);
  });

  it.each([
    [
      "wrong reference",
      () => ({ ...input(), proposedManifestDigest: digest("0") }),
      "BENCHMARK_VERSION_DIFF_MANIFEST_REFERENCE_MISMATCH",
    ],
    [
      "bad lineage",
      () => ({
        ...input(freezeVerificationBenchmarkDataset(draft(1, null))),
        proposedManifestDigest: previous.manifestDigest,
      }),
      "BENCHMARK_REFRESH_LINEAGE_INVALID",
    ],
    [
      "tampered case digest",
      () => {
        const value: any = structuredClone(previous);
        value.cases[0].caseDigest = digest("9");
        return { ...input(), previousDataset: value };
      },
      "BENCHMARK_CASE_DIGEST_MISMATCH:case-1",
    ],
  ])("rejects %s raw input", (_name, value, code) =>
    expect(() => prepareVerificationBenchmarkVersionDiff(value())).toThrow(code),
  );
});
