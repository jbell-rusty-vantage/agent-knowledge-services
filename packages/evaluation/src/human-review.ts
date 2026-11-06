import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import {
  evaluateRetrieval,
  type EvaluationCaseOutput,
  type FrozenEvaluationCase,
  type FrozenEvaluationDataset,
} from "./index.js";

/**
 * Gate 5 has an intentionally small, blinded-to-the-reference-label human
 * audit.  A packet is immutable and a submission is only a review record: it
 * is never a publication decision.
 */
export const HUMAN_REVIEW_SCHEMA_VERSION = "gate5-human-review/v1" as const;
export const MAX_HUMAN_REVIEW_EVIDENCE_CHARS = 1200;
export const GATE5_HUMAN_REVIEW_SAMPLE = deepFreeze({
  sampleId: "gate5-broad-v3-human-sample-24",
  sampleSeed: "gate5-human-review-sample/v1",
  sampleSize: 24,
});
export const HUMAN_REVIEW_RUBRIC = {
  version: "gate5-human-rubric/v1",
  instructions: [
    "Read the query, the system's requested/applied filter fields, returned ranked results, and bounded source excerpts without using outside sources.",
    "Mark retrieval relevance pass only when the system's returned results answer the query; mark fail for irrelevant, incomplete, or unsupported retrieval.",
    "Mark citation correctness pass only when the returned locator/excerpt supports the retrieved material; mark uncertain rather than guessing.",
    "Mark abstention and policy correctness from the system behavior, including whether it withheld results when appropriate and respected the visible constraints.",
    "Use needs_follow_up for any uncertainty, contradiction, safety concern, or insufficient evidence.",
  ],
  scale: ["pass", "fail", "uncertain"] as const,
  decisions: ["accept", "reject", "needs_follow_up"] as const,
} as const;

export type HumanReviewGrade = (typeof HUMAN_REVIEW_RUBRIC.scale)[number];
export type HumanReviewDecision = (typeof HUMAN_REVIEW_RUBRIC.decisions)[number];

export interface HumanReviewEvidenceItem {
  readonly recordId: string;
  readonly text: string;
  readonly locatorDigests: readonly string[];
}

export interface HumanReviewEvidenceExcerpt {
  readonly recordId: string;
  readonly fullTextDigest: `sha256:${string}`;
  readonly fullTextLength: number;
  readonly excerpt: string;
  readonly excerptDigest: `sha256:${string}`;
  readonly truncated: boolean;
  readonly locatorDigests: readonly string[];
}

export interface HumanReviewSystemResult {
  readonly recordId: string;
  readonly rank: number;
  readonly score: number;
  readonly resultType: string;
  readonly locatorDigests: readonly string[];
  readonly graphPaths: readonly (readonly string[])[];
  readonly evidence: HumanReviewEvidenceExcerpt;
}

export interface HumanReviewSystemOutput {
  readonly caseId: string;
  /** Stable digest of the actual deterministic retrieval evidence packet. */
  readonly systemOutputDigest: `sha256:${string}`;
  readonly abstained: boolean;
  readonly requestedSpaces: readonly string[];
  /** Filters actually applied by the system; these are behavior, not hidden expectations. */
  readonly appliedFilters: readonly { readonly field: string; readonly operator: string; readonly value: unknown }[];
  readonly results: readonly Omit<HumanReviewSystemResult, "evidence">[];
}

export interface HumanReviewSystemBehavior {
  readonly abstained: boolean;
  readonly requestedSpaces: readonly string[];
  readonly appliedFilters: readonly { readonly field: string; readonly operator: string; readonly value: unknown }[];
  readonly results: readonly HumanReviewSystemResult[];
}

export interface HumanReviewReferenceCase {
  readonly caseId: string;
  readonly retrievalRelevanceCorrect: boolean;
  readonly citationCorrect: boolean;
  readonly abstentionCorrect: boolean;
  readonly policyCorrect: boolean;
  readonly expectedDecision: Exclude<HumanReviewDecision, "needs_follow_up">;
  readonly referenceDecisionDigest: `sha256:${string}`;
}

export interface HumanReviewPacketCase {
  /** Opaque sample-local identity; the frozen source case ID is withheld. */
  readonly caseId: string;
  readonly query: string;
  readonly domain: FrozenEvaluationCase["domain"];
  readonly policySlice: string;
  readonly systemOutputDigest: `sha256:${string}`;
  readonly systemBehavior: HumanReviewSystemBehavior;
  readonly referenceDecisionDigest: `sha256:${string}`;
}

export interface HumanReviewSamplePacket {
  readonly schemaVersion: typeof HUMAN_REVIEW_SCHEMA_VERSION;
  readonly sampleId: string;
  readonly sampleSeed: string;
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly datasetManifestDigest: `sha256:${string}`;
  readonly executionInputManifestDigest: `sha256:${string}`;
  readonly rubric: typeof HUMAN_REVIEW_RUBRIC;
  readonly rubricDigest: `sha256:${string}`;
  readonly cases: readonly HumanReviewPacketCase[];
  readonly sampleDigest: `sha256:${string}`;
  readonly packetDigest: `sha256:${string}`;
}

export interface HumanReviewAssessment {
  readonly caseId: string;
  readonly retrievalRelevance: HumanReviewGrade;
  readonly citationCorrectness: HumanReviewGrade;
  readonly abstentionCorrectness: HumanReviewGrade;
  readonly policyCorrectness: HumanReviewGrade;
  readonly decision: HumanReviewDecision;
  readonly rationale: string;
}

export interface HumanReviewSubmission {
  readonly schemaVersion: typeof HUMAN_REVIEW_SCHEMA_VERSION;
  readonly sampleId: string;
  readonly packetDigest: `sha256:${string}`;
  readonly sampleDigest: `sha256:${string}`;
  readonly datasetManifestDigest: `sha256:${string}`;
  readonly reviewerIdentity: string;
  /** A declaration, not cryptographic proof. An operator supplies trusted identities to the validator. */
  readonly humanAttestation: "I attest that I am the named human reviewer and personally completed this review.";
  readonly reviewedAt: string;
  readonly assessments: readonly HumanReviewAssessment[];
}

/** Deliberately invalid until a human supplies every required judgment. */
export interface HumanReviewSubmissionTemplate {
  readonly schemaVersion: typeof HUMAN_REVIEW_SCHEMA_VERSION;
  readonly sampleId: string;
  readonly packetDigest: `sha256:${string}`;
  readonly sampleDigest: `sha256:${string}`;
  readonly datasetManifestDigest: `sha256:${string}`;
  readonly reviewerIdentity: "";
  readonly humanAttestation: "I attest that I am the named human reviewer and personally completed this review.";
  readonly reviewedAt: "";
  readonly assessments: readonly {
    readonly caseId: string;
    readonly retrievalRelevance: "";
    readonly citationCorrectness: "";
    readonly abstentionCorrectness: "";
    readonly policyCorrectness: "";
    readonly decision: "";
    readonly rationale: "";
  }[];
}

export interface HumanReviewValidationOptions {
  readonly verifiedReviewerIdentities: readonly string[];
  readonly referenceByCaseId: ReadonlyMap<string, HumanReviewReferenceCase>;
}

export interface HumanReviewMetrics {
  readonly assessedCaseCount: number;
  readonly retrievalRelevanceAgreementRate: number;
  readonly citationCorrectnessAgreementRate: number;
  readonly abstentionAgreementRate: number;
  readonly policyAgreementRate: number;
  readonly acceptedCaseRate: number;
  readonly rejectedCaseRate: number;
  readonly needsFollowUpRate: number;
  readonly uncertaintyRate: number;
  readonly disagreementCaseIds: readonly string[];
  readonly followUpCaseIds: readonly string[];
}

export interface HumanReviewReceipt {
  readonly schemaVersion: typeof HUMAN_REVIEW_SCHEMA_VERSION;
  readonly kind: "sampled_human_review_receipt";
  readonly status: "recorded" | "identity_unverified" | "requires_follow_up";
  readonly publicationAuthorityGranted: false;
  readonly packetDigest: `sha256:${string}`;
  readonly sampleDigest: `sha256:${string}`;
  readonly datasetManifestDigest: `sha256:${string}`;
  readonly reviewerIdentity: string;
  readonly reviewerIdentityVerified: boolean;
  readonly reviewedAt: string;
  readonly submissionDigest: `sha256:${string}`;
  readonly metrics: HumanReviewMetrics;
  readonly receiptDigest: `sha256:${string}`;
}

const gradeValues = new Set<string>(HUMAN_REVIEW_RUBRIC.scale);
const decisionValues = new Set<string>(HUMAN_REVIEW_RUBRIC.decisions);
const attestation = "I attest that I am the named human reviewer and personally completed this review." as const;
const digest = (value: unknown): `sha256:${string}` => sha256Digest(value as never);
const nonEmpty = (value: string, label: string): string => {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`HUMAN_REVIEW_${label.toUpperCase()}_REQUIRED`);
  return cleaned;
};
const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`HUMAN_REVIEW_${label}_OBJECT_REQUIRED`);
  return value as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`HUMAN_REVIEW_${label}_SCHEMA_INVALID`);
};
const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`HUMAN_REVIEW_${label}_STRING_REQUIRED`);
  return nonEmpty(value, label);
};
const asArray = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`HUMAN_REVIEW_${label}_ARRAY_REQUIRED`);
  return value;
};
const parseTimestamp = (value: string): string => {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error("HUMAN_REVIEW_REVIEWED_AT_INVALID");
  return value;
};
const rate = (values: readonly boolean[]): number =>
  values.length === 0 ? 0 : Number((values.filter(Boolean).length / values.length).toFixed(12));
export const humanReviewCaseId = (sampleId: string, sampleSeed: string, sourceCaseId: string): string =>
  `case-${digest({ sampleId, sampleSeed, sourceCaseId }).slice(7, 23)}`;
const humanReviewRecordId = (caseId: string, sourceRecordId: string): string =>
  `result-${digest({ caseId, sourceRecordId }).slice(7, 23)}`;
export function bindHumanReviewReferences(
  sampleId: string,
  sampleSeed: string,
  references: ReadonlyMap<string, HumanReviewReferenceCase>,
): ReadonlyMap<string, HumanReviewReferenceCase> {
  return new Map(
    [...references].map(([sourceCaseId, reference]) => [
      humanReviewCaseId(sampleId, sampleSeed, sourceCaseId),
      reference,
    ]),
  );
}
export function assertCanonicalGate5HumanReviewPacket(packet: HumanReviewSamplePacket): void {
  if (
    packet.sampleId !== GATE5_HUMAN_REVIEW_SAMPLE.sampleId ||
    packet.sampleSeed !== GATE5_HUMAN_REVIEW_SAMPLE.sampleSeed ||
    packet.cases.length !== GATE5_HUMAN_REVIEW_SAMPLE.sampleSize
  )
    throw new Error("HUMAN_REVIEW_CANONICAL_SAMPLE_REQUIRED");
}

function boundedExcerpt(text: string): { readonly excerpt: string; readonly truncated: boolean } {
  if (text.length <= MAX_HUMAN_REVIEW_EVIDENCE_CHARS) return { excerpt: text, truncated: false };
  const marker = "\n\n[… excerpt truncated; full text is bound by digest …]\n\n";
  const remaining = MAX_HUMAN_REVIEW_EVIDENCE_CHARS - marker.length;
  const prefixLength = Math.ceil(remaining / 2);
  const suffixLength = Math.floor(remaining / 2);
  return { excerpt: `${text.slice(0, prefixLength)}${marker}${text.slice(-suffixLength)}`, truncated: true };
}

function packetSelection(
  dataset: FrozenEvaluationDataset,
  sampleSeed: string,
  sampleSize: number,
): readonly FrozenEvaluationCase[] {
  if (!Number.isInteger(sampleSize) || sampleSize < 1) throw new Error("HUMAN_REVIEW_SAMPLE_SIZE_INVALID");
  if (sampleSize > dataset.cases.length) throw new Error("HUMAN_REVIEW_SAMPLE_SIZE_EXCEEDS_DATASET");
  const ordered = [...dataset.cases].sort(
    (left, right) =>
      digest(`${sampleSeed}:${left.id}`).localeCompare(digest(`${sampleSeed}:${right.id}`)) ||
      left.id.localeCompare(right.id),
  );
  const selected: FrozenEvaluationCase[] = [];
  const selectedIds = new Set<string>();
  const seenDomains = new Set<string>();
  const seenClasses = new Set<string>();
  const seenPartitions = new Set<string>();
  const seenFixtureKinds = new Set<string>();
  const seenAbstentionExpectations = new Set<string>();
  while (selected.length < sampleSize) {
    const candidate = ordered
      .filter((item) => !selectedIds.has(item.id))
      .sort((left, right) => {
        const gain = (item: FrozenEvaluationCase) =>
          Number(!seenDomains.has(item.domain)) +
          Number(!seenClasses.has(item.queryClass)) +
          Number(!seenPartitions.has(item.partition)) +
          Number(!seenFixtureKinds.has(item.fixtureKind)) +
          Number(!seenAbstentionExpectations.has(String(item.expectedAbstain)));
        return (
          gain(right) - gain(left) ||
          digest(`${sampleSeed}:${left.id}`).localeCompare(digest(`${sampleSeed}:${right.id}`)) ||
          left.id.localeCompare(right.id)
        );
      })[0];
    if (!candidate) break;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    seenDomains.add(candidate.domain);
    seenClasses.add(candidate.queryClass);
    seenPartitions.add(candidate.partition);
    seenFixtureKinds.add(candidate.fixtureKind);
    seenAbstentionExpectations.add(String(candidate.expectedAbstain));
  }
  const expectedDomains = new Set(dataset.cases.map((item) => item.domain));
  const expectedClasses = new Set(dataset.cases.map((item) => item.queryClass));
  const expectedPartitions = new Set(dataset.cases.map((item) => item.partition));
  const expectedFixtureKinds = new Set(dataset.cases.map((item) => item.fixtureKind));
  const expectedAbstentionExpectations = new Set(dataset.cases.map((item) => String(item.expectedAbstain)));
  const missingCoverage = (required: ReadonlySet<string>, actual: ReadonlySet<string>) =>
    required.size <= sampleSize && [...required].some((value) => !actual.has(value));
  if (
    missingCoverage(expectedDomains, seenDomains) ||
    missingCoverage(expectedClasses, seenClasses) ||
    missingCoverage(expectedPartitions, seenPartitions) ||
    missingCoverage(expectedFixtureKinds, seenFixtureKinds) ||
    missingCoverage(expectedAbstentionExpectations, seenAbstentionExpectations)
  )
    throw new Error("HUMAN_REVIEW_SAMPLE_NOT_REPRESENTATIVE");
  return selected.sort((left, right) => left.id.localeCompare(right.id));
}

export function createHumanReviewReferenceCases(
  dataset: FrozenEvaluationDataset,
  outputs: readonly EvaluationCaseOutput[],
): ReadonlyMap<string, HumanReviewReferenceCase> {
  const report = evaluateRetrieval(dataset, outputs);
  const outputById = new Map(outputs.map((output) => [output.caseId, output]));
  return new Map(
    report.cases.map((metrics) => {
      const testCase = dataset.cases.find(({ id }) => id === metrics.caseId)!;
      const output = outputById.get(metrics.caseId)!;
      const retrievalRelevanceCorrect =
        metrics.recallAtK === 1 &&
        metrics.precisionAtK === 1 &&
        (!testCase.expectedAbstain || (output.abstained && output.items.length === 0));
      const citationCorrect = metrics.citationCorrectness === 1;
      const abstentionCorrect = metrics.abstentionCorrectness === 1;
      const policyCorrect =
        metrics.filterSatisfaction === 1 &&
        !metrics.falseAcceptance &&
        metrics.forbiddenResultViolations === 0 &&
        metrics.forbiddenFilterViolations === 0;
      const expectedDecision =
        retrievalRelevanceCorrect && citationCorrect && abstentionCorrect && policyCorrect
          ? ("accept" as const)
          : ("reject" as const);
      const referenceDecisionDigest = digest({
        caseDigest: testCase.digest,
        qrels: testCase.relevanceJudgments,
        expectedAbstain: testCase.expectedAbstain,
        expectedFilters: testCase.expectedFilters,
        forbiddenResultIds: testCase.forbiddenResultIds,
        forbiddenFilters: testCase.forbiddenFilters,
        output: { caseId: output.caseId, abstained: output.abstained, items: output.items },
        outcomes: { retrievalRelevanceCorrect, citationCorrect, abstentionCorrect, policyCorrect, expectedDecision },
      });
      return [
        metrics.caseId,
        deepFreeze({
          caseId: metrics.caseId,
          retrievalRelevanceCorrect,
          citationCorrect,
          abstentionCorrect,
          policyCorrect,
          expectedDecision,
          referenceDecisionDigest,
        }),
      ] as const;
    }),
  );
}

export function createHumanReviewSamplePacket(input: {
  readonly dataset: FrozenEvaluationDataset;
  readonly evidenceByRecordId: ReadonlyMap<string, HumanReviewEvidenceItem>;
  readonly systemOutputsByCaseId: ReadonlyMap<string, HumanReviewSystemOutput>;
  readonly referenceByCaseId: ReadonlyMap<string, HumanReviewReferenceCase>;
  readonly executionInputManifestDigest: `sha256:${string}`;
  readonly sampleId: string;
  readonly sampleSeed: string;
  readonly sampleSize: number;
}): HumanReviewSamplePacket {
  const sampleId = nonEmpty(input.sampleId, "sample_id");
  const sampleSeed = nonEmpty(input.sampleSeed, "sample_seed");
  const selected = packetSelection(input.dataset, sampleSeed, input.sampleSize);
  const cases = selected.map((testCase): HumanReviewPacketCase => {
    const systemOutput = input.systemOutputsByCaseId.get(testCase.id);
    const reference = input.referenceByCaseId.get(testCase.id);
    if (!systemOutput || !reference || systemOutput.caseId !== testCase.id || reference.caseId !== testCase.id)
      throw new Error(`HUMAN_REVIEW_SYSTEM_OUTPUT_OR_REFERENCE_MISSING:${testCase.id}`);
    if (!systemOutput.systemOutputDigest.startsWith("sha256:"))
      throw new Error(`HUMAN_REVIEW_SYSTEM_OUTPUT_DIGEST_INVALID:${testCase.id}`);
    const reviewCaseId = humanReviewCaseId(sampleId, sampleSeed, testCase.id);
    const results = systemOutput.results.map((result, index): HumanReviewSystemResult => {
      if (result.rank !== index + 1 || !Number.isFinite(result.score))
        throw new Error(`HUMAN_REVIEW_SYSTEM_RESULT_INVALID:${testCase.id}`);
      const item = input.evidenceByRecordId.get(result.recordId);
      if (!item) throw new Error(`HUMAN_REVIEW_EVIDENCE_MISSING:${result.recordId}`);
      if (!item.locatorDigests.every((locator) => locator.startsWith("sha256:")))
        throw new Error(`HUMAN_REVIEW_EVIDENCE_LOCATOR_INVALID:${item.recordId}`);
      if (!item.text.trim()) throw new Error("HUMAN_REVIEW_EVIDENCE_TEXT_REQUIRED");
      const text = item.text;
      const bounded = boundedExcerpt(text);
      const recordId = humanReviewRecordId(reviewCaseId, nonEmpty(item.recordId, "evidence_record_id"));
      const evidence = deepFreeze({
        recordId,
        fullTextDigest: digest(text),
        fullTextLength: text.length,
        excerpt: bounded.excerpt,
        excerptDigest: digest(bounded.excerpt),
        truncated: bounded.truncated,
        locatorDigests: [...item.locatorDigests].sort(),
      });
      return deepFreeze({
        recordId,
        rank: result.rank,
        score: result.score,
        resultType: result.resultType,
        locatorDigests: [...result.locatorDigests].sort(),
        graphPaths: result.graphPaths.map((path) => path.map((node) => humanReviewRecordId(reviewCaseId, node))),
        evidence,
      });
    });
    if (new Set(results.map(({ recordId }) => recordId)).size !== results.length)
      throw new Error(`HUMAN_REVIEW_SYSTEM_RESULT_DUPLICATE:${testCase.id}`);
    const systemBehavior = deepFreeze({
      abstained: systemOutput.abstained,
      requestedSpaces: [...systemOutput.requestedSpaces].sort(),
      appliedFilters: [...systemOutput.appliedFilters].sort(
        (left, right) => left.field.localeCompare(right.field) || left.operator.localeCompare(right.operator),
      ),
      results,
    });
    return deepFreeze({
      caseId: reviewCaseId,
      query: testCase.query,
      domain: testCase.domain,
      policySlice: testCase.policySlice,
      systemOutputDigest: systemOutput.systemOutputDigest,
      systemBehavior,
      referenceDecisionDigest: reference.referenceDecisionDigest,
    });
  });
  const rubricDigest = digest(HUMAN_REVIEW_RUBRIC);
  const sampleDigest = digest({
    sampleId,
    sampleSeed,
    datasetManifestDigest: input.dataset.manifestDigest,
    executionInputManifestDigest: input.executionInputManifestDigest,
    cases: cases.map(({ caseId, referenceDecisionDigest }) => ({ caseId, referenceDecisionDigest })),
  });
  const material = {
    schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
    sampleId,
    sampleSeed,
    datasetId: input.dataset.id,
    datasetVersion: input.dataset.version,
    datasetManifestDigest: input.dataset.manifestDigest,
    executionInputManifestDigest: input.executionInputManifestDigest,
    rubric: HUMAN_REVIEW_RUBRIC,
    rubricDigest,
    cases,
    sampleDigest,
  };
  return deepFreeze({ ...material, packetDigest: digest(material) });
}

export function createHumanReviewSubmissionTemplate(packet: HumanReviewSamplePacket): HumanReviewSubmissionTemplate {
  return deepFreeze({
    schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
    sampleId: packet.sampleId,
    packetDigest: packet.packetDigest,
    sampleDigest: packet.sampleDigest,
    datasetManifestDigest: packet.datasetManifestDigest,
    reviewerIdentity: "",
    humanAttestation: attestation,
    reviewedAt: "",
    assessments: packet.cases.map(({ caseId }) => ({
      caseId,
      retrievalRelevance: "" as const,
      citationCorrectness: "" as const,
      abstentionCorrectness: "" as const,
      policyCorrectness: "" as const,
      decision: "" as const,
      rationale: "",
    })),
  });
}

function parseSubmission(value: unknown): HumanReviewSubmission {
  const submission = asRecord(value, "SUBMISSION");
  exactKeys(
    submission,
    [
      "schemaVersion",
      "sampleId",
      "packetDigest",
      "sampleDigest",
      "datasetManifestDigest",
      "reviewerIdentity",
      "humanAttestation",
      "reviewedAt",
      "assessments",
    ],
    "SUBMISSION",
  );
  if (submission.schemaVersion !== HUMAN_REVIEW_SCHEMA_VERSION) throw new Error("HUMAN_REVIEW_SCHEMA_VERSION_INVALID");
  if (submission.humanAttestation !== attestation) throw new Error("HUMAN_REVIEW_ATTESTATION_INVALID");
  const assessments = asArray(submission.assessments, "ASSESSMENTS").map((raw): HumanReviewAssessment => {
    const assessment = asRecord(raw, "ASSESSMENT");
    exactKeys(
      assessment,
      [
        "caseId",
        "retrievalRelevance",
        "citationCorrectness",
        "abstentionCorrectness",
        "policyCorrectness",
        "decision",
        "rationale",
      ],
      "ASSESSMENT",
    );
    const grades = [
      assessment.retrievalRelevance,
      assessment.citationCorrectness,
      assessment.abstentionCorrectness,
      assessment.policyCorrectness,
    ];
    if (grades.some((grade) => typeof grade !== "string" || !gradeValues.has(grade)))
      throw new Error("HUMAN_REVIEW_ASSESSMENT_GRADE_INVALID");
    if (typeof assessment.decision !== "string" || !decisionValues.has(assessment.decision))
      throw new Error("HUMAN_REVIEW_ASSESSMENT_DECISION_INVALID");
    return {
      caseId: asString(assessment.caseId, "assessment_case_id"),
      retrievalRelevance: assessment.retrievalRelevance as HumanReviewGrade,
      citationCorrectness: assessment.citationCorrectness as HumanReviewGrade,
      abstentionCorrectness: assessment.abstentionCorrectness as HumanReviewGrade,
      policyCorrectness: assessment.policyCorrectness as HumanReviewGrade,
      decision: assessment.decision as HumanReviewDecision,
      rationale: asString(assessment.rationale, "assessment_rationale"),
    };
  });
  return {
    schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
    sampleId: asString(submission.sampleId, "sample_id"),
    packetDigest: asString(submission.packetDigest, "packet_digest") as `sha256:${string}`,
    sampleDigest: asString(submission.sampleDigest, "sample_digest") as `sha256:${string}`,
    datasetManifestDigest: asString(submission.datasetManifestDigest, "dataset_manifest_digest") as `sha256:${string}`,
    reviewerIdentity: asString(submission.reviewerIdentity, "reviewer_identity"),
    humanAttestation: attestation,
    reviewedAt: parseTimestamp(asString(submission.reviewedAt, "reviewed_at")),
    assessments,
  };
}

export function validateHumanReviewSubmission(
  packet: HumanReviewSamplePacket,
  rawSubmission: unknown,
  options: HumanReviewValidationOptions,
): HumanReviewReceipt {
  const { packetDigest, ...packetMaterial } = packet;
  if (digest(packetMaterial) !== packetDigest || digest(packet.rubric) !== packet.rubricDigest)
    throw new Error("HUMAN_REVIEW_PACKET_INTEGRITY_INVALID");
  const expectedSampleDigest = digest({
    sampleId: packet.sampleId,
    sampleSeed: packet.sampleSeed,
    datasetManifestDigest: packet.datasetManifestDigest,
    executionInputManifestDigest: packet.executionInputManifestDigest,
    cases: packet.cases.map(({ caseId, referenceDecisionDigest }) => ({ caseId, referenceDecisionDigest })),
  });
  if (expectedSampleDigest !== packet.sampleDigest) throw new Error("HUMAN_REVIEW_SAMPLE_INTEGRITY_INVALID");
  const submission = parseSubmission(rawSubmission);
  if (
    submission.sampleId !== packet.sampleId ||
    submission.packetDigest !== packet.packetDigest ||
    submission.sampleDigest !== packet.sampleDigest ||
    submission.datasetManifestDigest !== packet.datasetManifestDigest
  )
    throw new Error("HUMAN_REVIEW_PACKET_BINDING_INVALID");
  const expectedIds = packet.cases.map(({ caseId }) => caseId).sort();
  const actualIds = submission.assessments.map(({ caseId }) => caseId).sort();
  if (
    new Set(actualIds).size !== actualIds.length ||
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  )
    throw new Error("HUMAN_REVIEW_ASSESSMENT_COVERAGE_INVALID");
  for (const testCase of packet.cases) {
    const reference = options.referenceByCaseId.get(testCase.caseId);
    if (!reference || reference.referenceDecisionDigest !== testCase.referenceDecisionDigest)
      throw new Error(`HUMAN_REVIEW_REFERENCE_BINDING_INVALID:${testCase.caseId}`);
  }
  const reviewerIdentityVerified = options.verifiedReviewerIdentities
    .map((identity) => identity.trim())
    .filter(Boolean)
    .includes(submission.reviewerIdentity);
  const matches = (grade: HumanReviewGrade, expected: boolean) =>
    grade !== "uncertain" && (grade === "pass") === expected;
  const allGrades = submission.assessments.flatMap((item) => [
    item.retrievalRelevance,
    item.citationCorrectness,
    item.abstentionCorrectness,
    item.policyCorrectness,
  ]);
  const assessmentReference = (item: HumanReviewAssessment) => options.referenceByCaseId.get(item.caseId)!;
  const disagreementCaseIds = submission.assessments
    .filter((item) => {
      const reference = assessmentReference(item);
      return (
        !matches(item.retrievalRelevance, reference.retrievalRelevanceCorrect) ||
        !matches(item.citationCorrectness, reference.citationCorrect) ||
        !matches(item.abstentionCorrectness, reference.abstentionCorrect) ||
        !matches(item.policyCorrectness, reference.policyCorrect) ||
        item.decision !== reference.expectedDecision
      );
    })
    .map(({ caseId }) => caseId);
  const followUpCaseIds = submission.assessments
    .filter(
      (item) =>
        item.decision === "needs_follow_up" ||
        [item.retrievalRelevance, item.citationCorrectness, item.abstentionCorrectness, item.policyCorrectness].some(
          (grade) => grade === "uncertain",
        ),
    )
    .map(({ caseId }) => caseId);
  const metrics: HumanReviewMetrics = deepFreeze({
    assessedCaseCount: submission.assessments.length,
    retrievalRelevanceAgreementRate: rate(
      submission.assessments.map((item) =>
        matches(item.retrievalRelevance, assessmentReference(item).retrievalRelevanceCorrect),
      ),
    ),
    citationCorrectnessAgreementRate: rate(
      submission.assessments.map((item) =>
        matches(item.citationCorrectness, assessmentReference(item).citationCorrect),
      ),
    ),
    abstentionAgreementRate: rate(
      submission.assessments.map((item) =>
        matches(item.abstentionCorrectness, assessmentReference(item).abstentionCorrect),
      ),
    ),
    policyAgreementRate: rate(
      submission.assessments.map((item) => matches(item.policyCorrectness, assessmentReference(item).policyCorrect)),
    ),
    acceptedCaseRate: rate(submission.assessments.map((item) => item.decision === "accept")),
    rejectedCaseRate: rate(submission.assessments.map((item) => item.decision === "reject")),
    needsFollowUpRate: rate(submission.assessments.map((item) => item.decision === "needs_follow_up")),
    uncertaintyRate: rate(allGrades.map((grade) => grade === "uncertain")),
    disagreementCaseIds: [...disagreementCaseIds].sort(),
    followUpCaseIds: [...followUpCaseIds].sort(),
  });
  const status = !reviewerIdentityVerified
    ? ("identity_unverified" as const)
    : followUpCaseIds.length > 0 || disagreementCaseIds.length > 0
      ? ("requires_follow_up" as const)
      : ("recorded" as const);
  const submissionDigest = digest(submission);
  const material = {
    schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
    kind: "sampled_human_review_receipt" as const,
    status,
    publicationAuthorityGranted: false as const,
    packetDigest: packet.packetDigest,
    sampleDigest: packet.sampleDigest,
    datasetManifestDigest: packet.datasetManifestDigest,
    reviewerIdentity: submission.reviewerIdentity,
    reviewerIdentityVerified,
    reviewedAt: submission.reviewedAt,
    submissionDigest,
    metrics,
  };
  return deepFreeze({ ...material, receiptDigest: digest(material) });
}
