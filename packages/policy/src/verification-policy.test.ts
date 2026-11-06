import { describe, expect, it } from "vitest";
import type {
  DeterministicVerificationResult,
  SemanticAssessmentRecord,
  VerificationPolicyDefinition,
  VerificationRecordedPolicyInputs,
  VerificationSourceAssessment,
} from "@aiengineer/knowledge-contracts";
import {
  appendAuthorizedPolicyOverride,
  evaluateVerificationPolicy,
  replayVerificationPolicy,
} from "./verification-policy.js";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";

const hash = `sha256:${"a".repeat(64)}` as const;
const policy: VerificationPolicyDefinition = {
  schemaVersion: "verification-policy.v1" as const,
  policyVersion: "verification-policy-0.1.0",
  definitionId: "diagnostics-policy",
  criticalDownstreamUses: ["clinical_decision", "publication"],
  requireCrossFamilyForRisk: ["high", "critical"],
  requireIndependentAuthorityForScopes: [
    "population_accuracy",
    "clinical_utility",
    "comparative_superiority",
    "causal",
    "product_validation",
  ],
  mixedEvidenceOutcome: "review" as const,
  unknownCriticalOutcome: "abstain" as const,
  authorityWithheldOutcome: "review" as const,
  reviewAvailable: true,
};

function mechanical(): DeterministicVerificationResult {
  return {
    verificationContractVersion: "verification.v1",
    status: "passed",
    semanticEligibility: true,
    deploymentSeparation: {
      status: "established",
      basis: "runtime_principal_binding",
      producerDeploymentId: "producer-runtime",
      verifierDeploymentId: "verifier-runtime",
    },
    captureChecks: [],
    assertions: [
      {
        assertionId: "claim-1",
        status: "passed",
        semanticEligibility: true,
        verdict: "pending_semantic_review",
        evidence: [],
        checks: [],
      },
    ],
    metrics: [],
    summary: {
      capturesTotal: 1,
      capturesPassed: 1,
      assertionsTotal: 1,
      assertionsPassed: 1,
      metricsTotal: 0,
      metricsPassed: 0,
      failedCheckCodes: [],
      reviewReasons: [],
    },
  };
}

function semantic(overrides: Partial<SemanticAssessmentRecord> = {}): SemanticAssessmentRecord {
  return {
    assertionId: "claim-1",
    verdict: "directly_supported",
    disposition: "admit",
    evidenceSupport: "satisfied",
    worldCorrectness: "not_assessed",
    attributionFaithfulness: "not_assessed",
    sourceAuthority: "not_assessed",
    provenanceIntegrity: "satisfied",
    judgeIdentities: [
      {
        deploymentId: "luna",
        provider: "synthetic",
        family: "luna",
        model: "synthetic",
        capability: "llm_evidence_rubric",
        graderVersion: "synthetic.v1",
        promptDigest: hash,
        outputSchemaDigest: hash,
        configurationDigest: hash,
      },
      {
        deploymentId: "haiku",
        provider: "synthetic",
        family: "haiku",
        model: "synthetic",
        capability: "llm_evidence_rubric",
        graderVersion: "synthetic.v1",
        promptDigest: hash,
        outputSchemaDigest: hash,
        configurationDigest: hash,
      },
    ],
    supportingFragmentIds: ["fragment-evidence-1"],
    contradictingFragmentIds: [],
    unsupportedFacets: [],
    reasonCodes: [],
    crossFamilySecondJudge: true,
    rawProviderConfidences: [],
    ...overrides,
  };
}

function source(overrides: Partial<VerificationSourceAssessment> = {}): VerificationSourceAssessment {
  return {
    assessmentId: "source-assessment-1",
    assertionId: "claim-1",
    fragmentId: "fragment-evidence-1",
    sourceFamilyId: "independent-paper",
    sourceOrganizationId: "university",
    vector: {
      authority: "primary",
      independence: "independent",
      directness: "direct",
      freshness: "current",
      applicability: "direct",
    },
    claimScope: "descriptive_fact",
    evidenceScope: "population",
    publicationRelation: "validates_antecedent_method",
    jurisdictionKnown: true,
    licenseKnown: true,
    freshnessKnown: true,
    ...overrides,
  };
}

function recorded(
  overrides: Partial<VerificationRecordedPolicyInputs["assertions"][number]> = {},
  sourceOverrides: Partial<VerificationSourceAssessment> = {},
): VerificationRecordedPolicyInputs {
  const assertion = {
    assertionId: "claim-1",
    riskClass: "low" as const,
    downstreamUse: ["internal_research"],
    claimScope: "descriptive_fact" as const,
    semantic: semantic(),
    authorityStatus: "sufficient" as const,
    independentCorroboration: true,
    conflictPresent: false,
    criticalFactsKnown: true,
    ...overrides,
  };
  return {
    schemaVersion: "verification-policy-inputs.v1",
    policyVersion: policy.policyVersion,
    runId: "run-1",
    recordedAt: "2026-09-05T00:00:00.000Z",
    deterministicResult: mechanical(),
    assertions: [assertion],
    metrics: [],
    sourceAssessments: [source({ claimScope: assertion.claimScope, ...sourceOverrides })],
  };
}

describe("immutable verification policy truth table", () => {
  it("admits direct support while keeping first-party support distinct from independent corroboration", () => {
    expect(evaluateVerificationPolicy(policy, recorded())).toMatchObject({ outcome: "pass", overrideApplied: false });
    const firstParty = recorded(
      { independentCorroboration: false, claimScope: "clinical_utility", authorityStatus: "withheld" },
      {
        claimScope: "clinical_utility",
        sourceFamilyId: "company",
        sourceOrganizationId: "company",
        vector: {
          authority: "primary",
          independence: "self_reported",
          directness: "direct",
          freshness: "current",
          applicability: "direct",
        },
      },
    );
    expect(evaluateVerificationPolicy(policy, firstParty)).toMatchObject({ outcome: "review" });
  });

  it("separates missing-qualifier partial support, count conflict and unknown critical facts", () => {
    expect(
      evaluateVerificationPolicy(
        policy,
        recorded({
          semantic: semantic({
            verdict: "partially_supported",
            disposition: "admit",
            unsupportedFacets: ["qualifier:not-a-diagnosis"],
          }),
        }),
      ),
    ).toMatchObject({ outcome: "pass_with_warnings" });
    expect(
      evaluateVerificationPolicy(
        policy,
        recorded({ riskClass: "high", conflictPresent: true }, { conflictSetId: "systems-count-conflict" }),
      ),
    ).toMatchObject({ outcome: "review" });
    expect(
      evaluateVerificationPolicy(
        policy,
        recorded({ riskClass: "critical", downstreamUse: ["clinical_decision"], criticalFactsKnown: false }),
      ),
    ).toMatchObject({ outcome: "abstain" });
  });

  it("keeps critical correctness and provenance gates distinct from support and authority", () => {
    const critical = { riskClass: "critical" as const, downstreamUse: ["clinical_decision"] };
    expect(
      evaluateVerificationPolicy(policy, recorded({ ...critical, semantic: semantic({ worldCorrectness: "unknown" }) }))
        .reasonCodes,
    ).toContain("UNKNOWN_CRITICAL_FACTS");
    expect(
      evaluateVerificationPolicy(
        policy,
        recorded({ ...critical, semantic: semantic({ provenanceIntegrity: "not_satisfied" }) }),
      ).reasonCodes,
    ).toContain("UNKNOWN_CRITICAL_FACTS");
    const faithfulnessOnly = evaluateVerificationPolicy(
      policy,
      recorded({ semantic: semantic({ attributionFaithfulness: "not_satisfied" }) }),
    );
    expect(faithfulnessOnly).toMatchObject({ outcome: "pass" });
    expect(faithfulnessOnly.reasonCodes).not.toContain("SOURCE_AUTHORITY_WITHHELD");
  });

  it.each([
    "promotional clinical accuracy",
    "one-person triplicate population claim",
    "publication-to-product overextension",
  ])("withholds %s", () => {
    const decision = evaluateVerificationPolicy(
      policy,
      recorded(
        {
          riskClass: "high",
          claimScope: "clinical_utility",
          authorityStatus: "withheld",
          independentCorroboration: false,
        },
        {
          claimScope: "clinical_utility",
          vector: {
            authority: "promotional",
            independence: "interested_party",
            directness: "direct",
            freshness: "current",
            applicability: "direct",
          },
          evidenceScope: "single_sample_technical",
          publicationRelation: "validates_antecedent_method",
        },
      ),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.reasonCodes).toContain("SOURCE_AUTHORITY_WITHHELD");
  });

  it("never allows semantic or override state to reverse a mechanical failure", () => {
    const value = recorded();
    value.deterministicResult.assertions[0]!.status = "failed";
    value.deterministicResult.assertions[0]!.semanticEligibility = false;
    value.deterministicResult.status = "failed";
    value.deterministicResult.semanticEligibility = false;
    const decision = evaluateVerificationPolicy(policy, value);
    expect(decision.outcome).toBe("fail");
    for (const after of ["pass", "pass_with_warnings"] as const) {
      expect(() =>
        appendAuthorizedPolicyOverride({
          decision,
          after,
          reason: "Cannot waive pointer integrity",
          authority: { principalId: "trusted-reviewer-runtime", authorities: ["verification_policy_override"] },
          recordedAt: "2026-09-05T01:00:00.000Z",
          existing: [],
        }),
      ).toThrow("POLICY_OVERRIDE_FAIL_CLOSED");
    }
  });

  it("rejects caller-asserted authority, conflict and scope fields that disagree with source assessments", () => {
    expect(() => evaluateVerificationPolicy(policy, recorded({ authorityStatus: "withheld" }))).toThrow(
      "POLICY_AUTHORITY_STATUS_CLAIM_MISMATCH",
    );
    expect(() => evaluateVerificationPolicy(policy, recorded({ conflictPresent: true }))).toThrow(
      "POLICY_CONFLICT_CLAIM_MISMATCH",
    );
    expect(() => evaluateVerificationPolicy(policy, recorded({}, { claimScope: "clinical_utility" }))).toThrow(
      "POLICY_SOURCE_CLAIM_SCOPE_MISMATCH",
    );
  });

  it("handles metric-only policy inputs explicitly and fails a metric-only mechanical bundle", () => {
    const passed = mechanical();
    passed.assertions = [];
    passed.metrics = [
      { observationId: "metric-1", status: "passed", semanticEligibility: true, checks: [], replayedValue: "21" },
    ];
    passed.summary.assertionsTotal = 0;
    passed.summary.assertionsPassed = 0;
    passed.summary.metricsTotal = 1;
    passed.summary.metricsPassed = 1;
    const metricOnly: VerificationRecordedPolicyInputs = {
      schemaVersion: "verification-policy-inputs.v1",
      policyVersion: policy.policyVersion,
      runId: "metric-run",
      recordedAt: "2026-09-05T00:00:00.000Z",
      deterministicResult: passed,
      assertions: [],
      metrics: [
        {
          observationId: "metric-1",
          riskClass: "low",
          downstreamUse: ["internal_research"],
          criticalFactsKnown: true,
          conflictPresent: false,
        },
      ],
      sourceAssessments: [],
    };
    expect(evaluateVerificationPolicy(policy, metricOnly)).toMatchObject({ outcome: "pass" });
    metricOnly.deterministicResult.metrics[0]!.status = "failed";
    metricOnly.deterministicResult.metrics[0]!.semanticEligibility = false;
    metricOnly.deterministicResult.status = "failed";
    metricOnly.deterministicResult.semanticEligibility = false;
    const failed = evaluateVerificationPolicy(policy, metricOnly);
    expect(failed).toMatchObject({ outcome: "fail" });
    expect(failed.reasonCodes).toContain("MECHANICAL_BUNDLE_FAILURE");
  });

  it("replays solely from immutable bytes and appends authorized hash-linked override records", () => {
    const inputs = recorded();
    const replay = replayVerificationPolicy({
      policyVersion: policy.policyVersion,
      policyBytes: new TextEncoder().encode(JSON.stringify(policy)),
      recordedPolicyInputsBytes: new TextEncoder().encode(JSON.stringify(inputs)),
    });
    expect(replay).toMatchObject({ outcome: "pass", decision: { runId: "run-1" } });
    const records = appendAuthorizedPolicyOverride({
      decision: replay.decision,
      after: "review",
      reason: "Escalate declared synthetic fixture",
      authority: { principalId: "trusted-reviewer-runtime", authorities: ["verification_policy_override"] },
      recordedAt: "2026-09-05T01:00:00.000Z",
      existing: [],
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.decisionDigest).toBe(digestCanonicalJson(replay.decision));
    const chained = appendAuthorizedPolicyOverride({
      decision: replay.decision,
      after: "abstain",
      reason: "Further escalation",
      authority: { principalId: "trusted-reviewer-runtime", authorities: ["verification_policy_override"] },
      recordedAt: "2026-09-05T01:05:00.000Z",
      existing: records,
    });
    expect(chained[1]).toMatchObject({
      before: "review",
      after: "abstain",
      previousOverrideDigest: expect.stringMatching(/^sha256:/),
    });
    expect(() =>
      appendAuthorizedPolicyOverride({
        decision: replay.decision,
        after: "review",
        reason: "unauthorized",
        authority: { principalId: "caller-label", authorities: [] },
        recordedAt: "2026-09-05T01:00:00.000Z",
        existing: records,
      }),
    ).toThrow("POLICY_OVERRIDE_UNAUTHORIZED");
  });
});

describe("explicit literal-extraction policy", () => {
  const pending = () =>
    semantic({
      verdict: "pending_semantic_review",
      disposition: "review",
      evidenceSupport: "not_assessed",
      worldCorrectness: "not_assessed",
      attributionFaithfulness: "not_assessed",
      sourceAuthority: "not_assessed",
      provenanceIntegrity: "not_assessed",
      judgeIdentities: [],
      supportingFragmentIds: [],
      contradictingFragmentIds: [],
      unsupportedFacets: ["semantic_support", "source_authority"],
      reasonCodes: ["DETERMINISTIC_ONLY"],
      crossFamilySecondJudge: false,
      rawProviderConfidences: [],
    });
  const definition: VerificationPolicyDefinition = {
    ...policy,
    literalExtraction: { assertionIds: ["claim-1"], downstreamUses: ["knowledge_ingestion:claim.materialize"] },
  };
  const extraction = () =>
    recorded({
      literalExtraction: true,
      downstreamUse: ["knowledge_ingestion:claim.materialize"],
      semantic: pending(),
    });
  it("defaults to semantic review, and accepts only an explicit frozen opt-in", () => {
    expect(evaluateVerificationPolicy(policy, extraction()).outcome).toBe("review");
    expect(evaluateVerificationPolicy(definition, extraction())).toMatchObject({
      outcome: "pass",
      assertionOutcomes: [{ assertionId: "claim-1", reasonCodes: ["LITERAL_EXTRACTION_POLICY_AUTHORIZED"] }],
    });
  });
  it.each(["risk", "use", "classification", "manual-review", "semantic-fail", "judgment", "authority"])(
    "never waives %s restrictions",
    (restriction) => {
      const input = extraction();
      const assertion = input.assertions[0]!;
      if (restriction === "risk") assertion.riskClass = "high";
      if (restriction === "use") assertion.downstreamUse = ["publication"];
      if (restriction === "classification") delete assertion.literalExtraction;
      if (restriction === "manual-review") assertion.semantic.reasonCodes = ["HUMAN_REVIEW_REQUIRED"];
      if (restriction === "semantic-fail") (assertion.semantic = pending()), (assertion.semantic.disposition = "fail");
      if (restriction === "judgment")
        assertion.semantic = semantic({ disposition: "review", verdict: "pending_semantic_review" });
      if (restriction === "authority") {
        input.sourceAssessments[0]!.vector.authority = "unknown";
        assertion.authorityStatus = "unknown";
      }
      expect(["review", "abstain", "fail"]).toContain(evaluateVerificationPolicy(definition, input).outcome);
    },
  );
});
