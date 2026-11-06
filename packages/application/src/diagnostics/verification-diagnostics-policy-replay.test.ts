import { describe, expect, it } from "vitest";
import type {
  DeterministicVerificationResult,
  SemanticAssessmentRecord,
  VerificationPolicyDefinition,
} from "@aiengineer/knowledge-contracts";
import { replayDiagnosticsPolicy, type DiagnosticsPolicyReplayCase } from "./verification-diagnostics-policy-replay.js";

const hash = `sha256:${"a".repeat(64)}` as const;
const policy: VerificationPolicyDefinition = {
  schemaVersion: "verification-policy.v1",
  policyVersion: "diagnostics-policy.v1",
  definitionId: "diagnostics-policy",
  criticalDownstreamUses: ["publication"],
  requireCrossFamilyForRisk: ["high", "critical"],
  requireIndependentAuthorityForScopes: [
    "population_accuracy",
    "clinical_utility",
    "comparative_superiority",
    "causal",
    "product_validation",
  ],
  mixedEvidenceOutcome: "review",
  unknownCriticalOutcome: "abstain",
  authorityWithheldOutcome: "review",
  reviewAvailable: true,
};

function deterministic(overrides: Partial<DeterministicVerificationResult> = {}): DeterministicVerificationResult {
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
    ...overrides,
  };
}

function semantic(): SemanticAssessmentRecord {
  return {
    assertionId: "claim-1",
    verdict: "directly_supported",
    disposition: "admit",
    evidenceSupport: "satisfied",
    worldCorrectness: "not_assessed",
    attributionFaithfulness: "not_assessed",
    sourceAuthority: "not_assessed",
    provenanceIntegrity: "satisfied",
    judgeIdentities: [],
    supportingFragmentIds: ["fragment-1"],
    contradictingFragmentIds: [],
    unsupportedFacets: [],
    reasonCodes: [],
    crossFamilySecondJudge: false,
    rawProviderConfidences: [],
  };
}

function caseInput(overrides: Partial<DiagnosticsPolicyReplayCase> = {}): DiagnosticsPolicyReplayCase {
  return {
    caseId: "gl-historical-wording-source",
    caseDigest: hash,
    assertionId: "claim-1",
    fragmentId: "fragment-1",
    captureId: "capture-1",
    sourceFamilyId: "source-family-gl",
    sourceOrganizationId: "source-org-gl",
    sourceClass: "first_party_marketing",
    claimScope: "product_validation",
    evidenceScope: "commercial_product",
    publicationRelation: "not_publication",
    riskClass: "high",
    downstreamUse: ["publication"],
    semantic: semantic(),
    ...overrides,
  };
}

describe("bounded diagnostic policy replay", () => {
  it("executes the canonical policy and preserves a withheld source boundary", () => {
    const result = replayDiagnosticsPolicy({
      policy,
      runId: "run-1",
      recordedAt: "2026-09-08T00:00:00.000Z",
      deterministicResult: deterministic(),
      cases: [caseInput()],
    });
    expect(result.externalRequests).toBe(0);
    expect(result.decision).toEqual(result.replayDecision);
    expect(result.policy.digest).toMatch(/^sha256:/u);
    expect(result.recordedInputs.digest).toMatch(/^sha256:/u);
    expect(result.evidenceClosure.digest).toMatch(/^sha256:/u);
    expect(result.sourceAssessmentStatus[0]).toMatchObject({ status: "withheld", independentCorroboration: false });
    expect(result.decision.outcome).toBe("abstain");
    expect(result.decision.reasonCodes).toContain("SOURCE_AUTHORITY_WITHHELD");
  });

  it("does not manufacture metric policy metadata from a deterministic result", () => {
    const metricResult = deterministic({
      metrics: [
        { observationId: "metric-1", status: "passed", semanticEligibility: true, checks: [], replayedValue: "1" },
      ],
      summary: {
        capturesTotal: 1,
        capturesPassed: 1,
        assertionsTotal: 1,
        assertionsPassed: 1,
        metricsTotal: 1,
        metricsPassed: 1,
        failedCheckCodes: [],
        reviewReasons: [],
      },
    });
    expect(() =>
      replayDiagnosticsPolicy({
        policy,
        runId: "run-1",
        recordedAt: "2026-09-08T00:00:00.000Z",
        deterministicResult: metricResult,
        cases: [caseInput()],
      }),
    ).toThrow("METRIC_METADATA_REQUIRED");
  });

  it("rejects duplicate assertion coverage instead of copying lexical labels", () => {
    expect(() =>
      replayDiagnosticsPolicy({
        policy,
        runId: "run-1",
        recordedAt: "2026-09-08T00:00:00.000Z",
        deterministicResult: deterministic(),
        cases: [caseInput(), caseInput({ caseId: "gl-historical-wording-mutated" })],
      }),
    ).toThrow("DUPLICATE_ASSERTION");
  });
});
