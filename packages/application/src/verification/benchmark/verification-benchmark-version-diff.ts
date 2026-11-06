import { VerificationBenchmarkDatasetSchema, type VerificationBenchmarkDataset } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  assertFrozenVerificationBenchmarkDataset,
  diffVerificationBenchmarkDatasets,
  verificationBenchmarkDigest,
} from "@aiengineer/knowledge-evaluation";

type Digest = `sha256:${string}`;
const maximumDatasetBytes = 8 * 1024 * 1024;
const digest = (value: unknown): value is Digest => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);

export interface VerificationBenchmarkVersionDiffInput {
  readonly previousDataset: unknown;
  readonly proposedDataset: unknown;
  /** Caller-supplied references must bind to the exact sealed dataset bodies. */
  readonly previousManifestDigest: string;
  readonly proposedManifestDigest: string;
}

const pendingReviewCount = (dataset: VerificationBenchmarkDataset) =>
  dataset.cases.filter((item) => item.expectation.labelStatus !== "expert_adjudicated").length;
const humanGoldCount = (dataset: VerificationBenchmarkDataset) =>
  dataset.cases.filter((item) => item.humanGoldScoringEligible).length;

function parseFrozenDataset(value: unknown, role: "previous" | "proposed"): VerificationBenchmarkDataset {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new Error(`BENCHMARK_VERSION_DIFF_${role.toUpperCase()}_DATASET_ENCODING_INVALID`);
  }
  if (bytes < 2 || bytes > maximumDatasetBytes)
    throw new Error(`BENCHMARK_VERSION_DIFF_${role.toUpperCase()}_DATASET_BOUND_EXCEEDED`);
  const dataset = VerificationBenchmarkDatasetSchema.parse(structuredClone(value));
  assertFrozenVerificationBenchmarkDataset(dataset);
  return deepFreeze(dataset);
}

/**
 * Purely compares two supplied, sealed dataset bodies. It neither discovers
 * files nor proposes, labels, approves, captures, or persists a version.
 */
export function prepareVerificationBenchmarkVersionDiff(input: VerificationBenchmarkVersionDiffInput) {
  if (!digest(input.previousManifestDigest) || !digest(input.proposedManifestDigest))
    throw new Error("BENCHMARK_VERSION_DIFF_MANIFEST_REFERENCE_INVALID");
  const previous = parseFrozenDataset(input.previousDataset, "previous");
  const proposed = parseFrozenDataset(input.proposedDataset, "proposed");
  if (
    previous.manifestDigest !== input.previousManifestDigest ||
    proposed.manifestDigest !== input.proposedManifestDigest
  )
    throw new Error("BENCHMARK_VERSION_DIFF_MANIFEST_REFERENCE_MISMATCH");
  const caseDiff = diffVerificationBenchmarkDatasets(previous, proposed);
  const material = {
    schemaVersion: "verification-benchmark-version-diff.v1" as const,
    lineage: {
      datasetId: previous.datasetId,
      previousVersion: previous.version,
      proposedVersion: proposed.version,
      previousManifestDigest: previous.manifestDigest,
      proposedManifestDigest: proposed.manifestDigest,
      proposedSupersedesManifestDigest: proposed.supersedesManifestDigest,
      valid: true as const,
    },
    caseDiff,
    sourcePreparation: {
      previousDigest: previous.sourcePreparationDigest,
      proposedDigest: proposed.sourcePreparationDigest,
      changed: previous.sourcePreparationDigest !== proposed.sourcePreparationDigest,
    },
    reviewState: {
      previousLabelProvenance: previous.labelProvenance,
      proposedLabelProvenance: proposed.labelProvenance,
      labelProvenanceChanged: previous.labelProvenance !== proposed.labelProvenance,
      previousHumanGoldEligibleCaseCount: humanGoldCount(previous),
      proposedHumanGoldEligibleCaseCount: humanGoldCount(proposed),
      previousPendingReviewCaseCount: pendingReviewCount(previous),
      proposedPendingReviewCaseCount: pendingReviewCount(proposed),
      previousAdjudicationArtifactDigest: previous.adjudicationArtifactDigest ?? null,
      proposedAdjudicationArtifactDigest: proposed.adjudicationArtifactDigest ?? null,
      humanApprovalGranted: false as const,
    },
  };
  return deepFreeze({ ...material, resultDigest: verificationBenchmarkDigest(material) });
}
