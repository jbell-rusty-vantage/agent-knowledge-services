import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";

export * from "./human-review.js";
export * from "./verification-statistics.js";
export * from "./verification-benchmark.js";
export * from "./verification-benchmark-run-comparison.js";
export * from "./verification-benchmark-v1.js";
export * from "./verification-human-review.js";

export type EvaluationDomain =
  | "engineering_claims"
  | "tool_capabilities"
  | "implementation_examples"
  | "paper_case_study_knowledge"
  | "entity_profiles"
  | "model_capabilities"
  | "benchmark_intelligence"
  | "source_native_sections";

export type QueryClass =
  | "semantic"
  | "lexical"
  | "filtered"
  | "graph"
  | "temporal"
  | "exact"
  | "conceptual"
  | "mixed"
  | "constraint"
  | "multi_hop"
  | "code"
  | "contradiction"
  | "freshness_temporal"
  | "negative_abstention"
  | "adversarial";
export type EvaluationPartition = "dev" | "calibration" | "heldout";
export type RelevanceGrade = 0 | 1 | 2 | 3;
export type FilterValue = string | number | boolean | readonly (string | number | boolean)[];

export interface RelevanceJudgment {
  readonly recordId: string;
  readonly grade: RelevanceGrade;
  readonly rationale: string;
}
export interface ExpectedFilter {
  readonly field: string;
  readonly value: FilterValue;
}
export interface EvaluationCaseInput {
  readonly id: string;
  readonly query: string;
  readonly domain: EvaluationDomain;
  readonly queryClass: QueryClass;
  readonly provenance: readonly string[];
  readonly relevanceJudgments: readonly RelevanceJudgment[];
  readonly expectedFilters?: readonly ExpectedFilter[];
  readonly expectedAbstain?: boolean;
  readonly partition?: EvaluationPartition;
  readonly sourceFamily?: string;
  readonly entityFamily?: string;
  readonly forbiddenResultIds?: readonly string[];
  readonly forbiddenFilters?: readonly ExpectedFilter[];
  readonly authorProvenance?: string;
  readonly reviewerProvenance?: string;
  readonly fixtureKind?: "real_bundle_grounded" | "synthetic_gap" | "reviewed_negative" | "adversarial";
  readonly expectedFacts?: readonly string[];
  readonly expectedLocatorDigests?: readonly string[];
  readonly requiredResultType?: string;
  readonly requiredResultTypes?: readonly string[];
  readonly difficulty?: "easy" | "medium" | "hard";
  readonly tags?: readonly string[];
  readonly policySlice?: string;
  readonly expectedGraphPath?: readonly string[];
}
export interface FrozenEvaluationCase extends Omit<EvaluationCaseInput, "expectedFilters" | "expectedAbstain"> {
  readonly expectedFilters: readonly ExpectedFilter[];
  readonly expectedAbstain: boolean;
  readonly partition: EvaluationPartition;
  readonly sourceFamily: string;
  readonly entityFamily: string;
  readonly forbiddenResultIds: readonly string[];
  readonly forbiddenFilters: readonly ExpectedFilter[];
  readonly authorProvenance: string;
  readonly reviewerProvenance: string;
  readonly fixtureKind: "real_bundle_grounded" | "synthetic_gap" | "reviewed_negative" | "adversarial";
  readonly expectedFacts: readonly string[];
  readonly expectedLocatorDigests: readonly string[];
  readonly requiredResultType: string;
  readonly requiredResultTypes: readonly string[];
  readonly difficulty: "easy" | "medium" | "hard";
  readonly tags: readonly string[];
  readonly policySlice: string;
  readonly expectedGraphPath: readonly string[];
  readonly digest: `sha256:${string}`;
}
export interface EvaluationDatasetInput {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly cases: readonly EvaluationCaseInput[];
  readonly reviewed: boolean;
  readonly reviewMode?: "independent" | "development";
  readonly reviewArtifact?: EvaluationReviewArtifact;
}
export interface EvaluationReviewArtifact {
  readonly candidateManifestDigest: `sha256:${string}`;
  readonly authorIdentity: string;
  readonly reviewerIdentity: string;
  readonly decision: "accept" | "reject";
  readonly reviewedCaseIds: readonly string[];
  readonly reviewedAt: string;
  readonly rationale: string;
  readonly digest: `sha256:${string}`;
}
export interface FrozenEvaluationDataset extends Omit<EvaluationDatasetInput, "cases"> {
  readonly frozen: true;
  readonly cases: readonly FrozenEvaluationCase[];
  readonly manifestDigest: `sha256:${string}`;
}

const cleanText = (value: string, label: string): string => {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} must be non-empty`);
  return cleaned;
};
const serialize = (value: unknown): string => JSON.stringify(value);

export function evaluationCandidateManifestDigest(
  input: Pick<EvaluationDatasetInput, "id" | "version" | "name" | "cases">,
): `sha256:${string}` {
  const cases = input.cases.map(({ reviewerProvenance: _reviewerProvenance, ...item }) => item);
  return sha256Digest(serialize({ id: input.id, version: input.version, name: input.name, cases }));
}

export function createEvaluationReviewArtifact(
  input: Pick<EvaluationDatasetInput, "id" | "version" | "name" | "cases">,
  review: Omit<EvaluationReviewArtifact, "candidateManifestDigest" | "reviewedCaseIds" | "digest">,
): EvaluationReviewArtifact {
  const candidateManifestDigest = evaluationCandidateManifestDigest(input);
  const reviewedCaseIds = input.cases.map(({ id }) => id).sort();
  const material = {
    candidateManifestDigest,
    authorIdentity: cleanText(review.authorIdentity, "review author"),
    reviewerIdentity: cleanText(review.reviewerIdentity, "reviewer identity"),
    decision: review.decision,
    reviewedCaseIds,
    reviewedAt: cleanText(review.reviewedAt, "review timestamp"),
    rationale: cleanText(review.rationale, "review rationale"),
  };
  if (material.authorIdentity === material.reviewerIdentity)
    throw new Error("evaluation author and reviewer must be independent");
  return deepFreeze({ ...material, digest: sha256Digest(serialize(material)) });
}

export function freezeEvaluationDataset(input: EvaluationDatasetInput): FrozenEvaluationDataset {
  cleanText(input.id, "dataset id");
  cleanText(input.name, "dataset name");
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new Error("dataset version must be a positive integer");
  const reviewMode = input.reviewMode ?? "independent";
  if (reviewMode === "independent" && !input.reviewed)
    throw new Error("evaluation dataset must be independently reviewed before freezing");
  if (reviewMode === "independent" && !input.reviewArtifact)
    throw new Error("independent evaluation dataset requires a bound review artifact");
  if (reviewMode === "development" && (input.reviewed || input.reviewArtifact))
    throw new Error("development evaluation datasets cannot claim independent review");
  if (input.cases.length === 0) throw new Error("evaluation dataset must contain cases");
  if (input.reviewArtifact) {
    const artifact = input.reviewArtifact;
    if (artifact.decision !== "accept") throw new Error("evaluation review did not accept the candidate");
    if (artifact.authorIdentity === artifact.reviewerIdentity)
      throw new Error("evaluation author and reviewer must be independent");
    if (artifact.candidateManifestDigest !== evaluationCandidateManifestDigest(input))
      throw new Error("evaluation review artifact does not bind this candidate manifest");
    const expectedIds = input.cases.map(({ id }) => id).sort();
    if (serialize(artifact.reviewedCaseIds) !== serialize(expectedIds))
      throw new Error("evaluation review artifact does not cover every case");
    const { digest: _digest, ...material } = artifact;
    if (artifact.digest !== sha256Digest(serialize(material)))
      throw new Error("evaluation review artifact digest is invalid");
    if (
      input.cases.some(
        (item) =>
          item.authorProvenance !== artifact.authorIdentity || item.reviewerProvenance !== artifact.reviewerIdentity,
      )
    )
      throw new Error("case provenance does not match the review artifact");
  }
  const ids = new Set<string>();
  const cases = input.cases.map((item): FrozenEvaluationCase => {
    const id = cleanText(item.id, "case id");
    if (ids.has(id)) throw new Error(`duplicate evaluation case ${id}`);
    ids.add(id);
    const query = cleanText(item.query, `${id} query`);
    if (item.provenance.length === 0) throw new Error(`${id} requires provenance`);
    const recordIds = new Set<string>();
    const relevanceJudgments = item.relevanceJudgments.map((qrel) => {
      cleanText(qrel.recordId, `${id} qrel record`);
      cleanText(qrel.rationale, `${id} qrel rationale`);
      if (recordIds.has(qrel.recordId)) throw new Error(`${id} has duplicate qrel ${qrel.recordId}`);
      recordIds.add(qrel.recordId);
      return { ...qrel };
    });
    const expectedAbstain = item.expectedAbstain ?? false;
    if (!expectedAbstain && !relevanceJudgments.some(({ grade }) => grade > 0))
      throw new Error(`${id} requires a relevant qrel or expected abstention`);
    const expectedFilters = (item.expectedFilters ?? []).map((filter) => ({
      field: cleanText(filter.field, `${id} filter field`),
      value: structuredClone(filter.value),
    }));
    const partition = item.partition ?? "dev";
    const sourceFamily = cleanText(item.sourceFamily ?? "unassigned-source-family", `${id} source family`);
    const entityFamily = cleanText(item.entityFamily ?? sourceFamily, `${id} entity family`);
    const forbiddenResultIds = [...(item.forbiddenResultIds ?? [])];
    const forbiddenFilters = (item.forbiddenFilters ?? []).map((filter) => ({
      field: cleanText(filter.field, `${id} forbidden filter field`),
      value: structuredClone(filter.value),
    }));
    const authorProvenance = cleanText(item.authorProvenance ?? "legacy-author", `${id} author provenance`);
    const reviewerProvenance = cleanText(item.reviewerProvenance ?? "legacy-reviewer", `${id} reviewer provenance`);
    const fixtureKind = item.fixtureKind ?? "synthetic_gap";
    const positivelyRelevantIds = new Set(
      relevanceJudgments.filter(({ grade }) => grade > 0).map(({ recordId }) => recordId),
    );
    if (forbiddenResultIds.some((recordId) => positivelyRelevantIds.has(recordId)))
      throw new Error(`${id} marks a relevant result as forbidden`);
    const expectedFacts = [...(item.expectedFacts ?? [])];
    const expectedLocatorDigests = [...(item.expectedLocatorDigests ?? [])];
    const requiredResultType =
      item.requiredResultType === undefined ? "" : cleanText(item.requiredResultType, `${id} result type`);
    const requiredResultTypes = [...(item.requiredResultTypes ?? [])].map((value) =>
      cleanText(value, `${id} required result type`),
    );
    const difficulty = item.difficulty ?? "medium";
    const tags = [...(item.tags ?? [])];
    const policySlice = cleanText(item.policySlice ?? "default", `${id} policy slice`);
    const expectedGraphPath = [...(item.expectedGraphPath ?? [])];
    const material = {
      id,
      query,
      domain: item.domain,
      queryClass: item.queryClass,
      provenance: [...item.provenance],
      relevanceJudgments,
      expectedFilters,
      expectedAbstain,
      partition,
      sourceFamily,
      entityFamily,
      forbiddenResultIds,
      forbiddenFilters,
      authorProvenance,
      reviewerProvenance,
      fixtureKind,
      expectedFacts,
      expectedLocatorDigests,
      requiredResultType,
      requiredResultTypes,
      difficulty,
      tags,
      policySlice,
      expectedGraphPath,
    };
    return deepFreeze({ ...material, digest: sha256Digest(serialize(material)) });
  });
  const manifest = {
    id: input.id,
    version: input.version,
    name: input.name,
    reviewed: input.reviewed,
    reviewMode,
    reviewArtifactDigest: input.reviewArtifact?.digest,
    cases: cases.map(({ id, digest }) => ({ id, digest })),
  };
  return deepFreeze({
    id: input.id,
    version: input.version,
    name: input.name,
    reviewed: input.reviewed,
    reviewMode,
    ...(input.reviewArtifact ? { reviewArtifact: input.reviewArtifact } : {}),
    frozen: true,
    cases,
    manifestDigest: sha256Digest(serialize(manifest)),
  });
}

export function auditDatasetPartitions(dataset: FrozenEvaluationDataset) {
  const sourcePartitions = new Map<string, Set<EvaluationPartition>>();
  const entityPartitions = new Map<string, Set<EvaluationPartition>>();
  for (const item of dataset.cases) {
    for (const [map, family] of [
      [sourcePartitions, item.sourceFamily],
      [entityPartitions, item.entityFamily],
    ] as const)
      map.set(family, new Set([...(map.get(family) ?? []), item.partition]));
  }
  const violations = [...sourcePartitions]
    .filter(([, partitions]) => partitions.size > 1)
    .map(([family]) => `source_family_leakage:${family}`);
  violations.push(
    ...[...entityPartitions]
      .filter(([, partitions]) => partitions.size > 1)
      .map(([family]) => `entity_family_leakage:${family}`),
  );
  const counts = Object.fromEntries(
    (["dev", "calibration", "heldout"] as const).map((partition) => [
      partition,
      dataset.cases.filter((item) => item.partition === partition).length,
    ]),
  );
  return deepFreeze({
    valid: violations.length === 0,
    violations,
    counts,
    digest: sha256Digest(serialize({ violations, counts })),
  });
}

export interface RetrievedEvaluationItem {
  readonly recordId: string;
  readonly rank: number;
  readonly score: number;
  readonly matchedFilters?: Readonly<Record<string, FilterValue>>;
  readonly citation?: { readonly entailed: boolean; readonly locatorValid: boolean };
  readonly resultType?: string;
  readonly locatorDigests?: readonly string[];
  readonly graphPaths?: readonly (readonly string[])[];
  readonly contentDigest?: `sha256:${string}`;
}
export interface EvaluationCaseOutput {
  readonly caseId: string;
  readonly items: readonly RetrievedEvaluationItem[];
  readonly abstained: boolean;
  readonly latencyMs: number;
  readonly costMicros: number;
}
export interface CaseMetrics {
  readonly caseId: string;
  readonly domain: EvaluationDomain;
  readonly queryClass: QueryClass;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly reciprocalRank: number;
  readonly ndcgAtK: number;
  readonly filterSatisfaction: number;
  readonly abstentionCorrectness: number;
  readonly citationCorrectness: number;
  readonly falseAcceptance: boolean;
  readonly forbiddenResultViolations: number;
  readonly forbiddenFilterViolations: number;
  readonly latencyMs: number;
  readonly costMicros: number;
}
export interface MetricSummary {
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly filterSatisfaction: number;
  readonly abstentionAccuracy: number;
  readonly citationCorrectness: number;
  readonly falseAcceptanceCount: number;
  readonly p95LatencyMs: number;
  readonly totalCostMicros: number;
}
export interface EvaluationReport {
  readonly datasetManifestDigest: `sha256:${string}`;
  readonly k: number;
  readonly cases: readonly CaseMetrics[];
  readonly overall: MetricSummary;
  readonly byDomain: Readonly<Partial<Record<EvaluationDomain, MetricSummary>>>;
  readonly byQueryClass: Readonly<Partial<Record<QueryClass, MetricSummary>>>;
  readonly outputManifestDigest: `sha256:${string}`;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number): number => Number(value.toFixed(12));
function equalFilter(actual: FilterValue | undefined, expected: FilterValue): boolean {
  if (actual === undefined) return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((value) => actual.includes(value));
  return actual === expected;
}
function summarize(cases: readonly CaseMetrics[]): MetricSummary {
  const sortedLatency = cases.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1);
  return deepFreeze({
    recallAtK: round(mean(cases.map((item) => item.recallAtK))),
    precisionAtK: round(mean(cases.map((item) => item.precisionAtK))),
    mrr: round(mean(cases.map((item) => item.reciprocalRank))),
    ndcgAtK: round(mean(cases.map((item) => item.ndcgAtK))),
    filterSatisfaction: round(mean(cases.map((item) => item.filterSatisfaction))),
    abstentionAccuracy: round(mean(cases.map((item) => item.abstentionCorrectness))),
    citationCorrectness: round(mean(cases.map((item) => item.citationCorrectness))),
    falseAcceptanceCount:
      cases.filter(({ falseAcceptance }) => falseAcceptance).length +
      cases.reduce((total, item) => total + item.forbiddenResultViolations + item.forbiddenFilterViolations, 0),
    p95LatencyMs: sortedLatency[p95Index] ?? 0,
    totalCostMicros: cases.reduce((sum, item) => sum + item.costMicros, 0),
  });
}

export function evaluateRetrieval(
  dataset: FrozenEvaluationDataset,
  outputs: readonly EvaluationCaseOutput[],
  k = 10,
): EvaluationReport {
  if (!dataset.frozen) throw new Error("evaluation dataset must be frozen");
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
  const byId = new Map(outputs.map((output) => [output.caseId, output]));
  if (byId.size !== outputs.length) throw new Error("duplicate case output");
  const unknown = outputs.find(({ caseId }) => !dataset.cases.some(({ id }) => id === caseId));
  if (unknown) throw new Error(`unknown case output ${unknown.caseId}`);
  const cases = dataset.cases.map((testCase): CaseMetrics => {
    const output = byId.get(testCase.id);
    if (!output) throw new Error(`missing output for ${testCase.id}`);
    if (output.latencyMs < 0 || output.costMicros < 0) throw new Error(`${testCase.id} has negative telemetry`);
    const ordered = [...output.items].sort((a, b) => a.rank - b.rank);
    if (new Set(ordered.map(({ recordId }) => recordId)).size !== ordered.length)
      throw new Error(`${testCase.id} returned duplicate records`);
    if (ordered.some((item, index) => item.rank !== index + 1 || !Number.isFinite(item.score)))
      throw new Error(`${testCase.id} has invalid ranks or scores`);
    const top = ordered.slice(0, k);
    const qrels = new Map(testCase.relevanceJudgments.map((qrel) => [qrel.recordId, qrel.grade]));
    const relevant = testCase.relevanceJudgments.filter(({ grade }) => grade > 0);
    const relevantRetrieved = top.filter(({ recordId }) => (qrels.get(recordId) ?? 0) > 0).length;
    const recallAtK = relevant.length === 0 ? (top.length === 0 ? 1 : 0) : relevantRetrieved / relevant.length;
    const precisionAtK = top.length === 0 ? (relevant.length === 0 ? 1 : 0) : relevantRetrieved / top.length;
    const firstRelevant = top.findIndex(({ recordId }) => (qrels.get(recordId) ?? 0) > 0);
    const dcg = top.reduce(
      (sum, item, index) => sum + (2 ** (qrels.get(item.recordId) ?? 0) - 1) / Math.log2(index + 2),
      0,
    );
    const ideal = [...testCase.relevanceJudgments]
      .sort((a, b) => b.grade - a.grade)
      .slice(0, k)
      .reduce((sum, item, index) => sum + (2 ** item.grade - 1) / Math.log2(index + 2), 0);
    const filterChecks = testCase.expectedFilters.flatMap((filter) =>
      top.map((item) => (equalFilter(item.matchedFilters?.[filter.field], filter.value) ? 1 : 0)),
    );
    const citations = top
      .map(({ citation }) => citation)
      .filter((citation): citation is NonNullable<typeof citation> => citation !== undefined);
    const returnedResultTypes = new Set(top.flatMap(({ resultType }) => (resultType ? [resultType] : [])));
    const resultTypesValid =
      testCase.requiredResultTypes.length > 0
        ? testCase.requiredResultTypes.every((resultType) => returnedResultTypes.has(resultType))
        : !testCase.requiredResultType || top.every(({ resultType }) => resultType === testCase.requiredResultType);
    const returnedLocatorDigests = new Set(top.flatMap(({ locatorDigests }) => locatorDigests ?? []));
    const expectedLocatorsValid = testCase.expectedLocatorDigests.every((locatorDigest) =>
      returnedLocatorDigests.has(locatorDigest),
    );
    const returnedContentDigests = new Set(top.flatMap(({ contentDigest }) => (contentDigest ? [contentDigest] : [])));
    const expectedFactsValid = testCase.expectedFacts.every((fact) => returnedContentDigests.has(sha256Digest(fact)));
    const graphPathValid =
      testCase.expectedGraphPath.length === 0 ||
      top.some(({ graphPaths }) =>
        (graphPaths ?? []).some((path) => serialize(path) === serialize(testCase.expectedGraphPath)),
      );
    const forbiddenResultViolations = top.filter((item) => testCase.forbiddenResultIds.includes(item.recordId)).length;
    const forbiddenFilterViolations = testCase.forbiddenFilters
      .flatMap((filter) => top.map((item) => (equalFilter(item.matchedFilters?.[filter.field], filter.value) ? 1 : 0)))
      .reduce<number>((left, right) => left + right, 0);
    const falseAcceptance = testCase.expectedAbstain && (!output.abstained || top.length > 0);
    return deepFreeze({
      caseId: testCase.id,
      domain: testCase.domain,
      queryClass: testCase.queryClass,
      recallAtK: round(recallAtK),
      precisionAtK: round(precisionAtK),
      reciprocalRank:
        relevant.length === 0
          ? Number(output.abstained && top.length === 0)
          : firstRelevant < 0
            ? 0
            : round(1 / (firstRelevant + 1)),
      ndcgAtK: ideal === 0 ? (dcg === 0 ? 1 : 0) : round(dcg / ideal),
      filterSatisfaction: testCase.expectedFilters.length === 0 ? 1 : round(mean(filterChecks)),
      abstentionCorrectness: Number(output.abstained === testCase.expectedAbstain),
      citationCorrectness:
        citations.length === 0
          ? top.length === 0
            ? 1
            : 0
          : round(
              mean(citations.map((citation) => Number(citation.entailed && citation.locatorValid))) *
                Number(resultTypesValid && expectedLocatorsValid && expectedFactsValid && graphPathValid),
            ),
      falseAcceptance,
      forbiddenResultViolations,
      forbiddenFilterViolations,
      latencyMs: output.latencyMs,
      costMicros: output.costMicros,
    });
  });
  const group = <K extends string>(key: (item: CaseMetrics) => K): Partial<Record<K, MetricSummary>> => {
    const groups = new Map<K, CaseMetrics[]>();
    for (const item of cases) {
      const name = key(item);
      groups.set(name, [...(groups.get(name) ?? []), item]);
    }
    return Object.fromEntries([...groups].map(([name, items]) => [name, summarize(items)])) as Partial<
      Record<K, MetricSummary>
    >;
  };
  const core = {
    datasetManifestDigest: dataset.manifestDigest,
    k,
    cases,
    overall: summarize(cases),
    byDomain: group((item) => item.domain),
    byQueryClass: group((item) => item.queryClass),
  };
  return deepFreeze({ ...core, outputManifestDigest: sha256Digest(serialize(core)) });
}

export interface ExperimentArm<Configuration> {
  readonly id: string;
  readonly name: string;
  readonly configuration: Readonly<Configuration>;
  readonly control: boolean;
}
export interface ExperimentMatrix<Configuration> {
  readonly id: string;
  readonly hypothesis: string;
  readonly datasetManifestDigest: string;
  readonly arms: readonly ExperimentArm<Configuration>[];
  readonly digest: `sha256:${string}`;
}
export interface ExperimentArmResult<Configuration> {
  readonly arm: ExperimentArm<Configuration>;
  readonly report: EvaluationReport;
}
export interface ExperimentResult<Configuration> {
  readonly matrixDigest: string;
  readonly arms: readonly ExperimentArmResult<Configuration>[];
  readonly digest: `sha256:${string}`;
}

export function createExperimentMatrix<Configuration>(
  id: string,
  hypothesis: string,
  dataset: FrozenEvaluationDataset,
  arms: readonly ExperimentArm<Configuration>[],
): ExperimentMatrix<Configuration> {
  cleanText(id, "experiment id");
  cleanText(hypothesis, "experiment hypothesis");
  if (arms.length < 2) throw new Error("experiment matrix requires at least two arms");
  if (arms.filter(({ control }) => control).length !== 1)
    throw new Error("experiment matrix requires exactly one control arm");
  if (new Set(arms.map(({ id: armId }) => armId)).size !== arms.length)
    throw new Error("experiment arm ids must be unique");
  const material = {
    id,
    hypothesis,
    datasetManifestDigest: dataset.manifestDigest,
    arms: arms.map((arm) => ({ ...arm, configuration: structuredClone(arm.configuration) })),
  };
  return deepFreeze({ ...material, digest: sha256Digest(serialize(material)) });
}
export async function runExperimentMatrix<Configuration>(
  matrix: ExperimentMatrix<Configuration>,
  dataset: FrozenEvaluationDataset,
  runner: (arm: ExperimentArm<Configuration>, testCase: FrozenEvaluationCase) => Promise<EvaluationCaseOutput>,
  k = 10,
): Promise<ExperimentResult<Configuration>> {
  if (matrix.datasetManifestDigest !== dataset.manifestDigest)
    throw new Error("experiment matrix dataset digest mismatch");
  const arms: ExperimentArmResult<Configuration>[] = [];
  for (const arm of matrix.arms) {
    const outputs = await Promise.all(dataset.cases.map((testCase) => runner(arm, testCase)));
    arms.push(deepFreeze({ arm, report: evaluateRetrieval(dataset, outputs, k) }));
  }
  const material = { matrixDigest: matrix.digest, arms };
  return deepFreeze({ ...material, digest: sha256Digest(serialize(material)) });
}

export type QualityMetric =
  | "recallAtK"
  | "precisionAtK"
  | "mrr"
  | "ndcgAtK"
  | "filterSatisfaction"
  | "abstentionAccuracy"
  | "citationCorrectness";
export interface PromotionGateDefinition {
  readonly id: string;
  readonly minimums: Readonly<Partial<Record<QualityMetric, number>>>;
  readonly maximumP95LatencyMs?: number;
  readonly maximumTotalCostMicros?: number;
  readonly requireEveryDomain: boolean;
  readonly requireEveryQueryClass: boolean;
  readonly maximumOverallRegression: number;
  readonly maximumDomainRegression: number;
  readonly requiredQueryClasses?: readonly QueryClass[];
}
export interface PromotionGateResult {
  readonly gateId: string;
  readonly reportDigest: string;
  readonly passed: boolean;
  readonly hardFailures: readonly string[];
  readonly qualityFailures: readonly string[];
  readonly regressionFailures: readonly string[];
  readonly digest: `sha256:${string}`;
}
const metricValue = (summary: MetricSummary, metric: QualityMetric): number => summary[metric];
export function evaluatePromotionGate(
  definition: PromotionGateDefinition,
  candidate: EvaluationReport,
  baseline?: EvaluationReport,
): PromotionGateResult {
  const hardFailures: string[] = [];
  if (candidate.overall.falseAcceptanceCount > 0)
    hardFailures.push(`false_acceptance_count:${candidate.overall.falseAcceptanceCount}`);
  if (candidate.cases.some((item) => item.citationCorrectness < 1)) hardFailures.push("invalid_or_unentailed_citation");
  if (definition.requireEveryDomain) {
    const domains: EvaluationDomain[] = [
      "engineering_claims",
      "tool_capabilities",
      "implementation_examples",
      "paper_case_study_knowledge",
      "entity_profiles",
      "model_capabilities",
      "benchmark_intelligence",
    ];
    for (const domain of domains) if (!candidate.byDomain[domain]) hardFailures.push(`missing_domain:${domain}`);
  }
  if (definition.requireEveryQueryClass) {
    const classes: readonly QueryClass[] = definition.requiredQueryClasses ?? [
      "semantic",
      "lexical",
      "filtered",
      "graph",
      "temporal",
      "adversarial",
    ];
    for (const queryClass of classes)
      if (!candidate.byQueryClass[queryClass]) hardFailures.push(`missing_query_class:${queryClass}`);
  }
  const qualityFailures: string[] = [];
  for (const [metric, minimum] of Object.entries(definition.minimums) as [QualityMetric, number][])
    if (metricValue(candidate.overall, metric) < minimum)
      qualityFailures.push(`${metric}:${metricValue(candidate.overall, metric)}<${minimum}`);
  if (definition.maximumP95LatencyMs !== undefined && candidate.overall.p95LatencyMs > definition.maximumP95LatencyMs)
    qualityFailures.push(`p95LatencyMs:${candidate.overall.p95LatencyMs}>${definition.maximumP95LatencyMs}`);
  if (
    definition.maximumTotalCostMicros !== undefined &&
    candidate.overall.totalCostMicros > definition.maximumTotalCostMicros
  )
    qualityFailures.push(`totalCostMicros:${candidate.overall.totalCostMicros}>${definition.maximumTotalCostMicros}`);
  const regressionFailures: string[] = [];
  if (baseline) {
    for (const metric of Object.keys(definition.minimums) as QualityMetric[]) {
      const decline = metricValue(baseline.overall, metric) - metricValue(candidate.overall, metric);
      if (decline > definition.maximumOverallRegression)
        regressionFailures.push(`overall:${metric}:declined_by_${round(decline)}`);
      for (const [domain, baselineSummary] of Object.entries(baseline.byDomain) as [
        EvaluationDomain,
        MetricSummary,
      ][]) {
        const candidateSummary = candidate.byDomain[domain];
        if (!candidateSummary) continue;
        const domainDecline = metricValue(baselineSummary, metric) - metricValue(candidateSummary, metric);
        if (domainDecline > definition.maximumDomainRegression)
          regressionFailures.push(`domain:${domain}:${metric}:declined_by_${round(domainDecline)}`);
      }
    }
  }
  const material = {
    gateId: definition.id,
    reportDigest: candidate.outputManifestDigest,
    passed: hardFailures.length + qualityFailures.length + regressionFailures.length === 0,
    hardFailures,
    qualityFailures,
    regressionFailures,
  };
  return deepFreeze({ ...material, digest: sha256Digest(serialize(material)) });
}

export interface PublishedVersionProof {
  readonly publicationId: string;
  readonly vectorSpaceVersionId: string;
  readonly evaluationReportDigest: string;
  readonly gateResultDigest: string;
  readonly gatePassed: true;
}
export interface RollbackProof {
  readonly failedPublicationId: string;
  readonly restoredPublicationId: string;
  readonly restoredVectorSpaceVersionId: string;
  readonly observedActiveVectorSpaceVersionId: string;
  readonly verificationQueryCount: number;
  readonly verificationPassed: boolean;
  readonly passed: boolean;
  readonly digest: `sha256:${string}`;
}
export function proveRollback(input: {
  readonly failedPublicationId: string;
  readonly previous: PublishedVersionProof;
  readonly observedActiveVectorSpaceVersionId: string;
  readonly verificationQueryCount: number;
  readonly verificationPassed: boolean;
}): RollbackProof {
  if (input.verificationQueryCount < 1 || !Number.isInteger(input.verificationQueryCount))
    throw new Error("rollback proof requires verification queries");
  const material = {
    failedPublicationId: cleanText(input.failedPublicationId, "failed publication id"),
    restoredPublicationId: cleanText(input.previous.publicationId, "previous publication id"),
    restoredVectorSpaceVersionId: cleanText(input.previous.vectorSpaceVersionId, "previous vector version"),
    observedActiveVectorSpaceVersionId: cleanText(input.observedActiveVectorSpaceVersionId, "observed vector version"),
    verificationQueryCount: input.verificationQueryCount,
    verificationPassed: input.verificationPassed,
    passed:
      input.verificationPassed && input.observedActiveVectorSpaceVersionId === input.previous.vectorSpaceVersionId,
  };
  return deepFreeze({ ...material, digest: sha256Digest(serialize(material)) });
}
