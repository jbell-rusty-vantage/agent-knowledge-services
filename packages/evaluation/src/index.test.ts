import { describe, expect, it } from "vitest";
import { sha256Digest } from "@aiengineer/knowledge-core";
import {
  MAX_HUMAN_REVIEW_EVIDENCE_CHARS,
  assertCanonicalGate5HumanReviewPacket,
  bindHumanReviewReferences,
  createEvaluationReviewArtifact,
  createExperimentMatrix,
  createHumanReviewReferenceCases,
  createHumanReviewSamplePacket,
  createHumanReviewSubmissionTemplate,
  evaluatePromotionGate,
  evaluateRetrieval,
  freezeEvaluationDataset,
  proveRollback,
  runExperimentMatrix,
  validateHumanReviewSubmission,
  type EvaluationCaseOutput,
  type EvaluationDatasetInput,
  type PromotionGateDefinition,
} from "./index.js";

const baseDatasetInput: EvaluationDatasetInput = {
  id: "suite-v1",
  version: 1,
  name: "reviewed retrieval suite",
  reviewed: true,
  cases: [
    {
      id: "semantic",
      query: "agent reliability",
      domain: "engineering_claims",
      queryClass: "semantic",
      provenance: ["review:1"],
      authorProvenance: "test-author",
      reviewerProvenance: "test-reviewer",
      relevanceJudgments: [{ recordId: "claim-1", grade: 3, rationale: "directly relevant" }],
    },
    {
      id: "filtered",
      query: "typescript tool",
      domain: "tool_capabilities",
      queryClass: "filtered",
      provenance: ["review:2"],
      authorProvenance: "test-author",
      reviewerProvenance: "test-reviewer",
      expectedFilters: [{ field: "language", value: "typescript" }],
      relevanceJudgments: [{ recordId: "tool-1", grade: 3, rationale: "matches tool and language" }],
    },
    {
      id: "adversarial",
      query: "unsupported claim",
      domain: "source_native_sections",
      queryClass: "adversarial",
      provenance: ["review:3"],
      authorProvenance: "test-author",
      reviewerProvenance: "test-reviewer",
      relevanceJudgments: [],
      expectedAbstain: true,
    },
  ],
};
const datasetInput: EvaluationDatasetInput = {
  ...baseDatasetInput,
  reviewArtifact: createEvaluationReviewArtifact(baseDatasetInput, {
    authorIdentity: "test-author",
    reviewerIdentity: "test-reviewer",
    decision: "accept",
    reviewedAt: "2026-09-03T00:00:00.000Z",
    rationale: "Independent unit fixture review.",
  }),
};
const goodOutputs: EvaluationCaseOutput[] = [
  {
    caseId: "semantic",
    items: [{ recordId: "claim-1", rank: 1, score: 0.9, citation: { entailed: true, locatorValid: true } }],
    abstained: false,
    latencyMs: 20,
    costMicros: 3,
  },
  {
    caseId: "filtered",
    items: [
      {
        recordId: "tool-1",
        rank: 1,
        score: 0.8,
        matchedFilters: { language: "typescript" },
        citation: { entailed: true, locatorValid: true },
      },
    ],
    abstained: false,
    latencyMs: 30,
    costMicros: 4,
  },
  { caseId: "adversarial", items: [], abstained: true, latencyMs: 10, costMicros: 2 },
];

describe("immutable evaluation datasets", () => {
  it("freezes qrels and produces deterministic manifests", () => {
    const a = freezeEvaluationDataset(datasetInput);
    const b = freezeEvaluationDataset(structuredClone(datasetInput));
    expect(a.manifestDigest).toBe(b.manifestDigest);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.cases[0]?.relevanceJudgments)).toBe(true);
  });
  it("rejects unreviewed, duplicate, and unanswerable cases", () => {
    expect(() => freezeEvaluationDataset({ ...datasetInput, reviewed: false })).toThrow("independently reviewed");
    expect(() =>
      freezeEvaluationDataset({ ...datasetInput, cases: [datasetInput.cases[0]!, datasetInput.cases[0]!] }),
    ).toThrow();
    expect(() =>
      freezeEvaluationDataset({ ...datasetInput, cases: [{ ...datasetInput.cases[0]!, relevanceJudgments: [] }] }),
    ).toThrow();
  });
  it("binds an independent acceptance to the exact candidate manifest", () => {
    const reviewedCases = datasetInput.cases.map((item) => ({
      ...item,
      authorProvenance: "author:v1",
      reviewerProvenance: "reviewer:v1",
    }));
    const candidate = { ...datasetInput, cases: reviewedCases };
    const reviewArtifact = createEvaluationReviewArtifact(candidate, {
      authorIdentity: "author:v1",
      reviewerIdentity: "reviewer:v1",
      decision: "accept",
      reviewedAt: "2026-09-03T00:00:00.000Z",
      rationale: "Blind qrel and partition review passed.",
    });
    expect(freezeEvaluationDataset({ ...candidate, reviewArtifact }).reviewArtifact?.digest).toBe(
      reviewArtifact.digest,
    );
    expect(() => freezeEvaluationDataset({ ...candidate, name: "mutated after review", reviewArtifact })).toThrow(
      "does not bind",
    );
    expect(() =>
      createEvaluationReviewArtifact(candidate, {
        authorIdentity: "same",
        reviewerIdentity: "same",
        decision: "accept",
        reviewedAt: "2026-09-03T00:00:00.000Z",
        rationale: "invalid",
      }),
    ).toThrow("independent");
  });
  it("keeps unreviewed development datasets distinct from independently reviewed datasets", () => {
    expect(freezeEvaluationDataset({ ...baseDatasetInput, reviewed: false, reviewMode: "development" }).reviewed).toBe(
      false,
    );
    expect(() => freezeEvaluationDataset(baseDatasetInput)).toThrow("bound review artifact");
    expect(() => freezeEvaluationDataset({ ...datasetInput, reviewMode: "development" })).toThrow(
      "cannot claim independent review",
    );
  });
});

describe("retrieval metrics", () => {
  it("scores recall, precision, nDCG, MRR, filters, abstention, citations, latency and cost", () => {
    const report = evaluateRetrieval(freezeEvaluationDataset(datasetInput), goodOutputs, 3);
    expect(report.overall).toMatchObject({
      recallAtK: 1,
      precisionAtK: 1,
      mrr: 1,
      ndcgAtK: 1,
      filterSatisfaction: 1,
      abstentionAccuracy: 1,
      citationCorrectness: 1,
      falseAcceptanceCount: 0,
      p95LatencyMs: 30,
      totalCostMicros: 9,
    });
    expect(report.byDomain.tool_capabilities?.filterSatisfaction).toBe(1);
  });
  it("detects false acceptance, invalid citations, bad filters, and deterministic output", () => {
    const dataset = freezeEvaluationDataset(datasetInput);
    const bad: EvaluationCaseOutput[] = [
      goodOutputs[0]!,
      {
        ...goodOutputs[1]!,
        items: [
          {
            ...goodOutputs[1]!.items[0]!,
            matchedFilters: { language: "python" },
            citation: { entailed: false, locatorValid: true },
          },
        ],
      },
      { ...goodOutputs[2]!, items: [{ recordId: "hallucination", rank: 1, score: 0.5 }], abstained: false },
    ];
    const report = evaluateRetrieval(dataset, bad);
    expect(report.overall.falseAcceptanceCount).toBe(1);
    expect(report.overall.filterSatisfaction).toBeLessThan(1);
    expect(report.overall.citationCorrectness).toBeLessThan(1);
    expect(evaluateRetrieval(dataset, bad).outputManifestDigest).toBe(report.outputManifestDigest);
  });
  it("rejects incomplete and malformed run output", () => {
    const dataset = freezeEvaluationDataset(datasetInput);
    expect(() => evaluateRetrieval(dataset, goodOutputs.slice(1))).toThrow("missing output");
    expect(() =>
      evaluateRetrieval(dataset, [
        { ...goodOutputs[0]!, items: [{ recordId: "a", rank: 2, score: 1 }] },
        ...goodOutputs.slice(1),
      ]),
    ).toThrow("invalid ranks");
  });
  it("scores expected content, locator, graph path, and result types", () => {
    const semanticCase = {
      ...baseDatasetInput.cases[0]!,
      expectedFacts: ["fact body"],
      expectedLocatorDigests: ["sha256:locator"],
      requiredResultType: "engineering_claims",
      requiredResultTypes: ["engineering_claims"],
      expectedGraphPath: ["a", "supports", "b"],
    };
    const candidate = { ...baseDatasetInput, cases: [semanticCase] };
    const reviewArtifact = createEvaluationReviewArtifact(candidate, {
      authorIdentity: "test-author",
      reviewerIdentity: "test-reviewer",
      decision: "accept",
      reviewedAt: "2026-09-03T00:00:00.000Z",
      rationale: "Reviewed semantic assertions.",
    });
    const dataset = freezeEvaluationDataset({ ...candidate, reviewArtifact });
    const common = { caseId: "semantic", abstained: false, latencyMs: 1, costMicros: 0 };
    const correct = {
      ...common,
      items: [
        {
          recordId: "claim-1",
          rank: 1,
          score: 1,
          resultType: "engineering_claims",
          contentDigest: "sha256:365a6e2fe443f36c76e763add4c793003e77ea7b2f35eee69af063f4d20c0985" as const,
          locatorDigests: ["sha256:locator"],
          graphPaths: [["a", "supports", "b"]],
          citation: { entailed: true, locatorValid: true },
        },
      ],
    };
    expect(evaluateRetrieval(dataset, [correct]).overall.citationCorrectness).toBe(1);
    expect(
      evaluateRetrieval(dataset, [{ ...correct, items: [{ ...correct.items[0]!, resultType: "tool_capabilities" }] }])
        .overall.citationCorrectness,
    ).toBe(0);
  });
});

describe("experiments and promotion gates", () => {
  const gate: PromotionGateDefinition = {
    id: "retrieval-v1",
    minimums: {
      recallAtK: 0.9,
      ndcgAtK: 0.9,
      mrr: 0.9,
      filterSatisfaction: 0.9,
      abstentionAccuracy: 1,
      citationCorrectness: 1,
    },
    maximumP95LatencyMs: 100,
    requireEveryDomain: false,
    requireEveryQueryClass: false,
    maximumOverallRegression: 0.02,
    maximumDomainRegression: 0.05,
  };
  it("runs a frozen ablation matrix with exactly one control", async () => {
    const dataset = freezeEvaluationDataset(datasetInput);
    const matrix = createExperimentMatrix("rrf", "fusion improves ranking", dataset, [
      { id: "control", name: "ann", configuration: { rrf: false }, control: true },
      { id: "candidate", name: "rrf", configuration: { rrf: true }, control: false },
    ]);
    const result = await runExperimentMatrix(
      matrix,
      dataset,
      async (_arm, testCase) => goodOutputs.find(({ caseId }) => caseId === testCase.id)!,
    );
    expect(result.arms).toHaveLength(2);
    expect(result.arms.every(({ report }) => report.overall.recallAtK === 1)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() =>
      createExperimentMatrix("x", "x", dataset, [
        { id: "a", name: "a", configuration: {}, control: true },
        { id: "b", name: "b", configuration: {}, control: true },
      ]),
    ).toThrow("exactly one control");
  });
  it("passes quality and blocks hard failures and regressions", () => {
    const dataset = freezeEvaluationDataset(datasetInput);
    const baseline = evaluateRetrieval(dataset, goodOutputs);
    expect(evaluatePromotionGate(gate, baseline).passed).toBe(true);
    const degradedOutputs: EvaluationCaseOutput[] = [
      {
        ...goodOutputs[0]!,
        items: [{ recordId: "wrong", rank: 1, score: 0.7, citation: { entailed: false, locatorValid: true } }],
      },
      goodOutputs[1]!,
      { ...goodOutputs[2]!, items: [{ recordId: "fabricated", rank: 1, score: 0.4 }], abstained: false },
    ];
    const failed = evaluatePromotionGate(gate, evaluateRetrieval(dataset, degradedOutputs), baseline);
    expect(failed.passed).toBe(false);
    expect(failed.hardFailures).toContain("false_acceptance_count:1");
    expect(failed.hardFailures).toContain("invalid_or_unentailed_citation");
    expect(failed.regressionFailures.length).toBeGreaterThan(0);
  });
});

describe("rollback proof", () => {
  it("proves the previous evaluated version is active and searchable", () => {
    const proof = proveRollback({
      failedPublicationId: "publication-bad",
      previous: {
        publicationId: "publication-good",
        vectorSpaceVersionId: "space-v1",
        evaluationReportDigest: "report",
        gateResultDigest: "gate",
        gatePassed: true,
      },
      observedActiveVectorSpaceVersionId: "space-v1",
      verificationQueryCount: 7,
      verificationPassed: true,
    });
    expect(proof.passed).toBe(true);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(
      proveRollback({
        failedPublicationId: "bad",
        previous: {
          publicationId: "good",
          vectorSpaceVersionId: "v1",
          evaluationReportDigest: "r",
          gateResultDigest: "g",
          gatePassed: true,
        },
        observedActiveVectorSpaceVersionId: "v2",
        verificationQueryCount: 1,
        verificationPassed: true,
      }).passed,
    ).toBe(false);
  });
});

describe("sampled human review", () => {
  const evidence = new Map([
    [
      "claim-1",
      {
        recordId: "claim-1",
        text: "A durable agent state claim with a source locator.",
        locatorDigests: ["sha256:claim-locator"],
      },
    ],
    [
      "tool-1",
      {
        recordId: "tool-1",
        text: "A TypeScript-capable research tool with a source locator.",
        locatorDigests: ["sha256:tool-locator"],
      },
    ],
  ]);
  const humanDataset = freezeEvaluationDataset(datasetInput);
  const referenceByCaseId = createHumanReviewReferenceCases(humanDataset, goodOutputs);
  const systemOutputsByCaseId = new Map(
    goodOutputs.map((output) => [
      output.caseId,
      {
        caseId: output.caseId,
        systemOutputDigest: sha256Digest(`system-output:${output.caseId}`),
        abstained: output.abstained,
        requestedSpaces: [humanDataset.cases.find(({ id }) => id === output.caseId)!.domain],
        appliedFilters: humanDataset.cases
          .find(({ id }) => id === output.caseId)!
          .expectedFilters.map(({ field, value }) => ({ field, operator: "eq", value })),
        results: output.items.map((item) => ({
          recordId: item.recordId,
          rank: item.rank,
          score: item.score,
          resultType: item.resultType ?? "unknown",
          locatorDigests: item.locatorDigests ?? [],
          graphPaths: item.graphPaths ?? [],
        })),
      },
    ]),
  );
  const executionInputManifestDigest = sha256Digest("unit-public-requests");
  const packet = createHumanReviewSamplePacket({
    dataset: humanDataset,
    evidenceByRecordId: evidence,
    systemOutputsByCaseId,
    referenceByCaseId,
    executionInputManifestDigest,
    sampleId: "gate5-unit-sample",
    sampleSeed: "unit-seed",
    sampleSize: 3,
  });
  const boundReferences = bindHumanReviewReferences("gate5-unit-sample", "unit-seed", referenceByCaseId);
  const validationOptions = {
    verifiedReviewerIdentities: ["reviewer@example.test"],
    referenceByCaseId: boundReferences,
  };
  const completedSubmission = () => ({
    ...createHumanReviewSubmissionTemplate(packet),
    reviewerIdentity: "reviewer@example.test",
    reviewedAt: "2026-09-03T12:00:00.000Z",
    assessments: packet.cases.map(({ caseId }) => ({
      caseId,
      retrievalRelevance: "pass" as const,
      citationCorrectness: "pass" as const,
      abstentionCorrectness: "pass" as const,
      policyCorrectness: "pass" as const,
      decision: "accept" as const,
      rationale:
        "The system result is relevant, cited, appropriately abstained or answered, and respects the visible policy behavior.",
    })),
  });

  it("creates a deterministic, representative packet without exposing frozen qrel grades", () => {
    const duplicate = createHumanReviewSamplePacket({
      dataset: humanDataset,
      evidenceByRecordId: evidence,
      systemOutputsByCaseId,
      referenceByCaseId,
      executionInputManifestDigest,
      sampleId: "gate5-unit-sample",
      sampleSeed: "unit-seed",
      sampleSize: 3,
    });
    expect(packet.packetDigest).toBe(duplicate.packetDigest);
    expect(packet.cases).toHaveLength(3);
    expect(new Set(packet.cases.map(({ domain }) => domain))).toEqual(
      new Set(["engineering_claims", "tool_capabilities", "source_native_sections"]),
    );
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain('grade":3');
    expect(serialized).not.toContain("expectedAbstain");
    expect(serialized).not.toContain("expectedFilters");
    expect(serialized).not.toContain("queryClass");
    expect(serialized).not.toContain("fixtureKind");
    expect(serialized).not.toContain("partition");
    expect(serialized).not.toContain("decoy:");
    expect(serialized).not.toContain("entailed");
    expect(serialized).not.toContain("locatorValid");
    expect(packet.cases.every(({ caseId }) => /^case-[a-f0-9]{16}$/.test(caseId))).toBe(true);
    expect(
      packet.cases.every(({ systemBehavior }) =>
        systemBehavior.results.every(({ evidence: item }) => item.fullTextDigest.startsWith("sha256:")),
      ),
    ).toBe(true);
    const changedOutputDigest = new Map(systemOutputsByCaseId);
    const original = changedOutputDigest.get("semantic")!;
    changedOutputDigest.set("semantic", { ...original, systemOutputDigest: sha256Digest("different-system-output") });
    const changedPacket = createHumanReviewSamplePacket({
      dataset: humanDataset,
      evidenceByRecordId: evidence,
      systemOutputsByCaseId: changedOutputDigest,
      referenceByCaseId,
      executionInputManifestDigest,
      sampleId: "gate5-unit-sample",
      sampleSeed: "unit-seed",
      sampleSize: 3,
    });
    expect(changedPacket.packetDigest).not.toBe(packet.packetDigest);
    const noisyOutputs = goodOutputs.map((output) =>
      output.caseId === "semantic"
        ? { ...output, items: [...output.items, { ...output.items[0]!, recordId: "tool-1", rank: 2 }] }
        : output,
    );
    expect(createHumanReviewReferenceCases(humanDataset, noisyOutputs).get("semantic")?.retrievalRelevanceCorrect).toBe(
      false,
    );
  });

  it("uses bounded deterministic excerpts while preserving full-text bindings", () => {
    const longText = `${"prefix evidence ".repeat(100)}${"suffix evidence ".repeat(100)}`;
    const longEvidence = new Map(evidence);
    longEvidence.set("claim-1", { recordId: "claim-1", text: longText, locatorDigests: ["sha256:claim-locator"] });
    const longPacket = createHumanReviewSamplePacket({
      dataset: humanDataset,
      evidenceByRecordId: longEvidence,
      systemOutputsByCaseId,
      referenceByCaseId,
      executionInputManifestDigest,
      sampleId: "gate5-unit-sample",
      sampleSeed: "unit-seed",
      sampleSize: 3,
    });
    const excerpt = longPacket.cases
      .flatMap(({ systemBehavior }) => systemBehavior.results.map(({ evidence: item }) => item))
      .find(({ fullTextDigest }) => fullTextDigest === sha256Digest(longText))!;
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.excerpt.length).toBeLessThanOrEqual(MAX_HUMAN_REVIEW_EVIDENCE_CHARS);
    expect(excerpt.fullTextDigest).toBe(sha256Digest(longText));
    expect(excerpt.excerptDigest).toBe(sha256Digest(excerpt.excerpt));
  });

  it("requires declared identity verification, exact binding, complete assessments, and records agreement metrics", () => {
    const submission = completedSubmission();
    const unverified = validateHumanReviewSubmission(packet, submission, {
      verifiedReviewerIdentities: [],
      referenceByCaseId: boundReferences,
    });
    expect(unverified.status).toBe("identity_unverified");
    const receipt = validateHumanReviewSubmission(packet, submission, validationOptions);
    expect(receipt.status).toBe("recorded");
    expect(receipt.publicationAuthorityGranted).toBe(false);
    expect(receipt.metrics).toMatchObject({
      assessedCaseCount: 3,
      retrievalRelevanceAgreementRate: 1,
      citationCorrectnessAgreementRate: 1,
      abstentionAgreementRate: 1,
      policyAgreementRate: 1,
      acceptedCaseRate: 1,
      uncertaintyRate: 0,
    });
    expect(() =>
      validateHumanReviewSubmission(packet, { ...submission, packetDigest: "sha256:wrong" }, validationOptions),
    ).toThrow("PACKET_BINDING");
    expect(() =>
      validateHumanReviewSubmission(
        packet,
        { ...submission, assessments: submission.assessments.slice(1) },
        validationOptions,
      ),
    ).toThrow("ASSESSMENT_COVERAGE");
    expect(() =>
      validateHumanReviewSubmission(packet, { ...submission, reviewedAt: "not-a-timestamp" }, validationOptions),
    ).toThrow("REVIEWED_AT_INVALID");
    expect(() => validateHumanReviewSubmission(packet, { ...submission, unexpected: true }, validationOptions)).toThrow(
      "SUBMISSION_SCHEMA_INVALID",
    );
    expect(() =>
      validateHumanReviewSubmission(packet, submission, { ...validationOptions, referenceByCaseId: new Map() }),
    ).toThrow("REFERENCE_BINDING");
    const tamperedPacket = {
      ...packet,
      cases: packet.cases.map((item, index) =>
        index === 0 ? { ...item, query: "misleading replacement query" } : item,
      ),
    };
    expect(() => validateHumanReviewSubmission(tamperedPacket, submission, validationOptions)).toThrow(
      "PACKET_INTEGRITY",
    );
  });

  it("requires follow-up for disagreement or uncertainty instead of treating it as a completed gate", () => {
    const submission = completedSubmission();
    const assessments = submission.assessments.map((item, index) =>
      index === 0 ? { ...item, retrievalRelevance: "fail" as const, decision: "needs_follow_up" as const } : item,
    );
    const receipt = validateHumanReviewSubmission(packet, { ...submission, assessments }, validationOptions);
    expect(receipt.status).toBe("requires_follow_up");
    expect(receipt.metrics.disagreementCaseIds).toHaveLength(1);
    expect(receipt.metrics.followUpCaseIds).toHaveLength(1);
  });

  it("rejects a caller-selected sample as canonical Gate 5 evidence", () => {
    expect(() => assertCanonicalGate5HumanReviewPacket(packet)).toThrow("CANONICAL_SAMPLE_REQUIRED");
  });
});
