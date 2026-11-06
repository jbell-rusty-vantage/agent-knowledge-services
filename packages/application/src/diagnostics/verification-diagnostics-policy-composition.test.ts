import { describe, expect, it } from "vitest";
import type { DeterministicVerificationResult, SemanticAssessmentRecord } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson } from "@aiengineer/knowledge-verification";
import {
  composeDiagnosticsPolicyReplay,
  type AuthenticatedDiagnosticsSemanticReplayResult,
} from "./verification-diagnostics-policy-composition.js";

const digest = `sha256:${"b".repeat(64)}` as const;
const deterministic: DeterministicVerificationResult = {
  verificationContractVersion: "verification.v1",
  status: "passed",
  semanticEligibility: true,
  deploymentSeparation: {
    status: "established",
    basis: "runtime_principal_binding",
    producerDeploymentId: "producer",
    verifierDeploymentId: "verifier",
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
const assessment: SemanticAssessmentRecord = {
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

function replayCase(
  caseId: string,
  proposition: string,
  sourceClass: string,
): AuthenticatedDiagnosticsSemanticReplayResult {
  return {
    caseId,
    assessment,
    deterministicResult: deterministic,
    authenticatedEvidence: {
      assertionId: "claim-1",
      caseDigest: digest,
      proposition,
      sourceFamilyId: "source-family",
      sourceClass,
      sourceKey: "source-key",
      captureId: "capture-1",
      fragmentId: "fragment-1",
      selector: { kind: "html", domPath: "1/0" },
      representationArtifactId: "projection-1",
      selectedContentDigest: digest,
      sourceArtifact: { artifactId: "source-1", digest, tenantId: "tenant-1" },
      projectionArtifact: { artifactId: "projection-1", digest, tenantId: "tenant-1" },
    },
  };
}

describe("diagnostic policy composition", () => {
  it("rejects an unknown runtime purpose before composing a policy decision", () => {
    expect(() =>
      composeDiagnosticsPolicyReplay({
        runIdPrefix: "invalid-purpose",
        recordedAt: "2026-09-08T00:00:00.000Z",
        replay: [],
        purpose: "unsupported" as "internal_research",
      }),
    ).toThrow("DIAGNOSTICS_POLICY_PURPOSE_INVALID");
  });
  it("abstains from publication eligibility when a supported source summary lacks critical authority facts", () => {
    const entry = replayCase("publication-source", "A bounded source statement", "publication");
    const args = { runIdPrefix: "eligibility", recordedAt: "2026-09-08T00:00:00.000Z", replay: [entry] };
    const internal = composeDiagnosticsPolicyReplay(args);
    const publication = composeDiagnosticsPolicyReplay({ ...args, purpose: "publication_eligibility" });
    expect(internal.cases[0]!.decision.outcome).toBe("review");
    expect(publication.purpose).toBe("publication_eligibility");
    expect(publication.cases[0]!.decision.outcome).toBe("abstain");
    expect(publication.cases[0]!.decision.reasonCodes).toContain("UNKNOWN_CRITICAL_FACTS");
    expect(publication.cases[0]!.decision).toEqual(publication.cases[0]!.replayDecision);
    const inputs = JSON.parse(publication.cases[0]!.policyInputsJson);
    expect(inputs.assertions[0].downstreamUse).toEqual(["publication"]);
    expect(inputs.assertions[0].semantic).toEqual(entry.assessment);
    expect(digestCanonicalJson(inputs)).toBe(publication.cases[0]!.policyInputsDigest);
  });
  it("composes one authenticated original case without reassigning its identity", () => {
    const result = composeDiagnosticsPolicyReplay({
      runIdPrefix: "semantic-replay",
      recordedAt: "2026-09-08T00:00:00.000Z",
      replay: [replayCase("legacy-38-case", "bounded source statement", "first_party")],
    });
    expect(result.schemaVersion).toBe("verification-diagnostics-policy-composition.v1");
    expect(result.policy.authority).toBe("engineering_replay_policy");
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({
      caseId: "legacy-38-case",
      assertionId: "claim-1",
      sourceClass: "first_party",
      provenance: { captureId: "capture-1", fragmentId: "fragment-1" },
    });
    expect(result.cases[0]!.decision).toEqual(result.cases[0]!.replayDecision);
    expect(result.cases[0]!.decision.outcome).toBe("review");
    expect(result.cases[0]!.claimScope).toBe("source_summary");
    expect(result.cases[0]!.sourceAssessmentStatus.independentCorroboration).toBe(false);
    expect(JSON.parse(result.cases[0]!.policyInputsJson).assertions[0].criticalFactsKnown).toBe(false);
    const inputs = JSON.parse(result.cases[0]!.policyInputsJson);
    expect(digestCanonicalJson(inputs)).toBe(result.cases[0]!.policyInputsDigest);
    expect(canonicalizeJson(inputs)).toBe(result.cases[0]!.policyInputsJson);
  });

  it("maps exact high-risk promotional and publication propositions to withheld scopes", () => {
    const promotional = composeDiagnosticsPolicyReplay({
      runIdPrefix: "replay",
      recordedAt: "2026-09-08T00:00:00.000Z",
      replay: [
        replayCase(
          "noise-method-mutated",
          "This paragraph proves that SystemAge is superior to TruAge in an independent head-to-head clinical trial.",
          "publication",
        ),
      ],
    });
    expect(promotional.cases[0]).toMatchObject({
      claimScope: "comparative_superiority",
      riskClass: "high",
      sourceAssessmentStatus: { independentCorroboration: false, status: "withheld" },
    });
    expect(promotional.cases[0]!.decision.outcome).toBe("review");
    const publication = composeDiagnosticsPolicyReplay({
      runIdPrefix: "replay",
      recordedAt: "2026-09-08T00:00:00.000Z",
      replay: [
        replayCase(
          "pace-definition-mutated",
          "This paragraph validates every commercial feature of TruAge and SystemAge.",
          "publication",
        ),
      ],
    });
    expect(publication.cases[0]).toMatchObject({
      claimScope: "product_validation",
      riskClass: "high",
      sourceAssessmentStatus: { independentCorroboration: false, status: "withheld" },
    });
    expect(publication.cases[0]!.decision.reasonCodes).toContain("SOURCE_AUTHORITY_WITHHELD");
  });

  it("rejects semantic identity mismatch before policy composition", () => {
    const wrong = {
      ...replayCase("legacy-38-case", "bounded source statement", "first_party"),
      assessment: { ...assessment, assertionId: "different-claim" },
    };
    expect(() =>
      composeDiagnosticsPolicyReplay({
        runIdPrefix: "replay",
        recordedAt: "2026-09-08T00:00:00.000Z",
        replay: [wrong],
      }),
    ).toThrow("SEMANTIC_BINDING");
  });
});
