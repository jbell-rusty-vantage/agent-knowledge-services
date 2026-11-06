import type {
  VerificationBenchmarkDataset,
  VerificationBenchmarkV1CandidatePool,
} from "@aiengineer/knowledge-contracts";
import { VerificationBenchmarkV1CandidatePoolSchema } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { assertFrozenVerificationBenchmarkDataset, verificationBenchmarkDigest } from "./verification-benchmark.js";

type Digest = `sha256:${string}`;
const bytewise = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export interface VerificationBenchmarkV1CandidatePoolImport {
  readonly pool: VerificationBenchmarkV1CandidatePool;
  readonly candidatePoolDigest: Digest;
  readonly sourceKeyCount: number;
  readonly sourceClassCount: number;
}
const candidateEvidenceBinding = (item: {
  readonly fragmentId: string;
  readonly captureId: string;
  readonly sourceKey: string;
  readonly sourceClass: string;
  readonly projectionArtifactId: string;
  readonly projectionDigest: string;
  readonly selector: unknown;
  readonly selectedContentDigest: string;
}) =>
  verificationBenchmarkDigest({
    fragmentId: item.fragmentId,
    captureId: item.captureId,
    sourceKey: item.sourceKey,
    sourceClass: item.sourceClass,
    projectionArtifactId: item.projectionArtifactId,
    projectionDigest: item.projectionDigest,
    selector: item.selector,
    selectedContentDigest: item.selectedContentDigest,
  });

/** Strictly imports a 150-300 row source-bound candidate pool without assigning labels or independence. */
export function importVerificationBenchmarkV1CandidatePool(input: unknown): VerificationBenchmarkV1CandidatePoolImport {
  const pool = deepFreeze(VerificationBenchmarkV1CandidatePoolSchema.parse(structuredClone(input)));
  return deepFreeze({
    pool,
    candidatePoolDigest: verificationBenchmarkDigest(pool),
    sourceKeyCount: new Set(pool.candidates.map((item) => item.sourceKey)).size,
    sourceClassCount: new Set(pool.candidates.map((item) => item.sourceClass)).size,
  });
}

export interface VerificationBenchmarkV1CurationQueueItem {
  readonly candidateId: string;
  readonly candidatePoolDigest: Digest;
  readonly sourceKey: string;
  readonly sourceClass: string;
  readonly fragmentId: string;
  readonly captureId: string;
  readonly selectedContentDigest: Digest;
  readonly status: "awaiting_case_atomization_and_human_review";
  readonly requiredActions: readonly [
    "atomize_assertion",
    "assign_provenance_groups",
    "two_blinded_human_annotations",
    "expert_adjudication",
    "seal_case_artifacts",
  ];
}

/** Produces the concrete, case-specific queue. Identity strings are structural and do not authenticate a human reviewer. */
export function buildVerificationBenchmarkV1CurationQueue(
  imported: VerificationBenchmarkV1CandidatePoolImport,
): readonly VerificationBenchmarkV1CurationQueueItem[] {
  const parsed = importVerificationBenchmarkV1CandidatePool(imported.pool);
  if (parsed.candidatePoolDigest !== imported.candidatePoolDigest)
    throw new Error("BENCHMARK_V1_CANDIDATE_POOL_IMPORT_INVALID");
  return deepFreeze(
    parsed.pool.candidates.map((item) => ({
      candidateId: item.candidateId,
      candidatePoolDigest: parsed.candidatePoolDigest,
      sourceKey: item.sourceKey,
      sourceClass: item.sourceClass,
      fragmentId: item.fragmentId,
      captureId: item.captureId,
      selectedContentDigest: item.selectedContentDigest as Digest,
      status: "awaiting_case_atomization_and_human_review" as const,
      requiredActions: [
        "atomize_assertion",
        "assign_provenance_groups",
        "two_blinded_human_annotations",
        "expert_adjudication",
        "seal_case_artifacts",
      ] as const,
    })),
  );
}

export interface VerificationBenchmarkV1Grouping {
  readonly candidateId: string;
  readonly sourceFamily: string;
  readonly entityFamily: string;
  readonly reportCluster: string;
  readonly pairCluster: string;
}
export interface VerificationBenchmarkV1SplitAssignment extends VerificationBenchmarkV1Grouping {
  readonly partition: "development" | "calibration" | "locked_test";
  readonly componentDigest: Digest;
}

/**
 * Assigns connected provenance groups as indivisible units. Any shared source/entity/report/pair
 * identifier joins candidates into the same component, preventing split leakage.
 */
export function planVerificationBenchmarkV1Splits(input: {
  readonly imported: VerificationBenchmarkV1CandidatePoolImport;
  readonly groupings: readonly VerificationBenchmarkV1Grouping[];
  readonly seed: number;
}): {
  readonly schemaVersion: "verification-benchmark-v1-split-plan.v1";
  readonly candidatePoolDigest: Digest;
  readonly seed: number;
  readonly assignments: readonly VerificationBenchmarkV1SplitAssignment[];
  readonly counts: Readonly<Record<"development" | "calibration" | "locked_test", number>>;
  readonly componentCount: number;
  readonly planDigest: Digest;
} {
  const imported = importVerificationBenchmarkV1CandidatePool(input.imported.pool);
  if (imported.candidatePoolDigest !== input.imported.candidatePoolDigest || !Number.isSafeInteger(input.seed))
    throw new Error("BENCHMARK_V1_SPLIT_INPUT_INVALID");
  if (
    input.groupings.length !== imported.pool.count ||
    new Set(input.groupings.map((item) => item.candidateId)).size !== input.groupings.length
  )
    throw new Error("BENCHMARK_V1_SPLIT_CARDINALITY_INVALID");
  const poolIds = new Set(imported.pool.candidates.map((item) => item.candidateId));
  for (const item of input.groupings)
    if (
      !poolIds.has(item.candidateId) ||
      [item.sourceFamily, item.entityFamily, item.reportCluster, item.pairCluster].some(
        (value) => typeof value !== "string" || value.trim().length === 0 || value.length > 512,
      )
    )
      throw new Error(`BENCHMARK_V1_SPLIT_GROUP_INVALID:${item.candidateId}`);

  const parent = input.groupings.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const union = (left: number, right: number) => {
    const a = find(left),
      b = find(right);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  const owner = new Map<string, number>();
  input.groupings.forEach((item, index) => {
    for (const [dimension, group] of Object.entries({
      sourceFamily: item.sourceFamily,
      entityFamily: item.entityFamily,
      reportCluster: item.reportCluster,
      pairCluster: item.pairCluster,
    })) {
      const key = `${dimension}:${group}`;
      const prior = owner.get(key);
      if (prior === undefined) owner.set(key, index);
      else union(index, prior);
    }
  });
  const components = [
    ...Map.groupBy(
      input.groupings.map((item, index) => ({ item, index })),
      (entry) => find(entry.index),
    ).values(),
  ]
    .map((entries) => {
      const members = entries.map((entry) => entry.item).sort((a, b) => bytewise(a.candidateId, b.candidateId));
      return {
        members,
        digest: verificationBenchmarkDigest({
          seed: input.seed,
          candidateIds: members.map((item) => item.candidateId),
          groups: members.map((item) => [item.sourceFamily, item.entityFamily, item.reportCluster, item.pairCluster]),
        }),
      };
    })
    .sort((left, right) => bytewise(left.digest, right.digest));
  if (components.length < 3) throw new Error("BENCHMARK_V1_SPLIT_REQUIRES_THREE_PROVENANCE_COMPONENTS");

  const partitions = ["development", "calibration", "locked_test"] as const;
  const targets = {
    development: input.groupings.length * 0.6,
    calibration: input.groupings.length * 0.2,
    locked_test: input.groupings.length * 0.2,
  };
  const counts = { development: 0, calibration: 0, locked_test: 0 };
  const componentPartition = new Map<Digest, (typeof partitions)[number]>();
  components.forEach((component, index) => {
    const partition =
      index < partitions.length
        ? partitions[index]!
        : [...partitions].sort(
            (left, right) => targets[right] - counts[right] - (targets[left] - counts[left]) || bytewise(left, right),
          )[0]!;
    componentPartition.set(component.digest, partition);
    counts[partition] += component.members.length;
  });
  const assignments = components
    .flatMap((component) =>
      component.members.map((item) => ({
        ...item,
        partition: componentPartition.get(component.digest)!,
        componentDigest: component.digest,
      })),
    )
    .sort((left, right) => bytewise(left.candidateId, right.candidateId));
  const material = {
    schemaVersion: "verification-benchmark-v1-split-plan.v1" as const,
    candidatePoolDigest: imported.candidatePoolDigest,
    seed: input.seed,
    assignments,
    counts,
    componentCount: components.length,
  };
  return deepFreeze({ ...material, planDigest: verificationBenchmarkDigest(material) });
}

/** Structural readiness only; trusted human identity/adjudication admission remains an application boundary. */
export function assessVerificationBenchmarkV1Readiness(input: {
  readonly imported: VerificationBenchmarkV1CandidatePoolImport;
  readonly dataset?: unknown;
}) {
  const imported = importVerificationBenchmarkV1CandidatePool(input.imported.pool);
  if (imported.candidatePoolDigest !== input.imported.candidatePoolDigest)
    throw new Error("BENCHMARK_V1_CANDIDATE_POOL_IMPORT_INVALID");
  if (input.dataset === undefined)
    return deepFreeze({
      structurallyRunnable: false,
      humanGoldPromotionReady: false,
      candidateCount: imported.pool.count,
      boundCaseCount: 0,
      blockers: [
        "case_atomization_pending",
        "split_assignment_pending",
        "two_blinded_human_annotations_pending",
        "expert_adjudication_pending",
        "case_artifact_sealing_pending",
        "trusted_reviewer_identity_admission_pending",
      ] as const,
    });
  assertFrozenVerificationBenchmarkDataset(input.dataset);
  const dataset = input.dataset as VerificationBenchmarkDataset;
  const poolEvidenceBindings = new Map(
    imported.pool.candidates.map((item) => [item.fragmentId, candidateEvidenceBinding(item)]),
  );
  const allEvidenceBound = dataset.cases.every(
    (item) =>
      item.evidence.length > 0 &&
      item.evidence.every(
        (evidence) => poolEvidenceBindings.get(evidence.fragmentId) === candidateEvidenceBinding(evidence),
      ),
  );
  const stageValid = dataset.stage === "benchmark_v1" && dataset.cases.length >= 150 && dataset.cases.length <= 300;
  const allExpertAdjudicated = dataset.cases.every(
    (item) =>
      item.expectation.labelStatus === "expert_adjudicated" &&
      item.humanGoldScoringEligible &&
      item.adjudicationId !== null,
  );
  const blockers = [
    ...(!stageValid ? ["benchmark_v1_stage_or_cardinality_invalid"] : []),
    ...(!allEvidenceBound ? ["candidate_pool_evidence_binding_incomplete"] : []),
    ...(!allExpertAdjudicated ? ["expert_adjudication_or_human_gold_scope_incomplete"] : []),
    "trusted_reviewer_identity_admission_pending",
  ];
  return deepFreeze({
    structurallyRunnable: stageValid && allEvidenceBound,
    humanGoldPromotionReady: false,
    candidateCount: imported.pool.count,
    boundCaseCount: dataset.cases.length,
    blockers,
  });
}
