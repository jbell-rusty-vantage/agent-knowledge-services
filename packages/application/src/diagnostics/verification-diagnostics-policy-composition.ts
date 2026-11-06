import type {
  DeterministicVerificationResult,
  SemanticAssessmentRecord,
  VerificationPolicyDefinition,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson } from "@aiengineer/knowledge-verification";
import {
  replayDiagnosticsPolicy,
  type DiagnosticsPolicyReplayResult,
} from "./verification-diagnostics-policy-replay.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface AuthenticatedDiagnosticsSemanticReplayResult {
  readonly caseId: string;
  readonly assessment: SemanticAssessmentRecord;
  readonly deterministicResult: DeterministicVerificationResult;
  readonly authenticatedEvidence: {
    readonly assertionId: string;
    readonly caseDigest: `sha256:${string}`;
    readonly proposition: string;
    readonly sourceFamilyId: string;
    readonly sourceClass: string;
    readonly sourceKey: string;
    readonly captureId: string;
    readonly fragmentId: string;
    readonly selector: unknown;
    readonly representationArtifactId: string;
    readonly selectedContentDigest: string;
    readonly sourceArtifact: { readonly artifactId: string; readonly digest: string; readonly tenantId: string };
    readonly projectionArtifact: { readonly artifactId: string; readonly digest: string; readonly tenantId: string };
  };
}

export const CONSERVATIVE_DIAGNOSTICS_REPLAY_POLICY: VerificationPolicyDefinition = {
  schemaVersion: "verification-policy.v1",
  policyVersion: "diagnostics-policy-engineering-replay-v1",
  definitionId: "diagnostics-policy-engineering-replay",
  criticalDownstreamUses: ["clinical_decision", "publication"],
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

export interface DiagnosticsPolicyComposition {
  readonly schemaVersion: "verification-diagnostics-policy-composition.v1";
  readonly purpose: "internal_research" | "publication_eligibility";
  readonly policy: {
    readonly policyVersion: string;
    readonly json: string;
    readonly digest: `sha256:${string}`;
    readonly authority: "engineering_replay_policy";
  };
  readonly cases: readonly {
    readonly caseId: string;
    readonly caseDigest: `sha256:${string}`;
    readonly assertionId: string;
    readonly sourceClass: string;
    readonly claimScope: "source_summary" | "product_validation" | "comparative_superiority";
    readonly riskClass: "low" | "high";
    readonly sourceAssessmentStatus: DiagnosticsPolicyReplayResult["sourceAssessmentStatus"][number];
    readonly decision: DiagnosticsPolicyReplayResult["decision"];
    readonly replayDecision: DiagnosticsPolicyReplayResult["replayDecision"];
    readonly policyInputsJson: string;
    readonly policyInputsDigest: `sha256:${string}`;
    readonly evidenceClosureJson: string;
    readonly evidenceClosureDigest: `sha256:${string}`;
    readonly provenance: {
      readonly captureId: string;
      readonly fragmentId: string;
      readonly sourceArtifactId: string;
      readonly projectionArtifactId: string;
      readonly selectedContentDigest: `sha256:${string}`;
    };
  }[];
  readonly externalRequests: 0;
}

/**
 * Composes policy decisions only after the semantic fixture has authenticated
 * the original bundle, capture, selector, deterministic result, and semantic
 * assessment. The policy is explicitly an engineering replay policy; it is not
 * a historical approval or human-gold policy. Source organization and
 * applicability remain unknown because the v1 fixture does not authenticate
 * those facts.
 */
export function composeDiagnosticsPolicyReplay(input: {
  readonly replay: readonly AuthenticatedDiagnosticsSemanticReplayResult[];
  readonly runIdPrefix: string;
  readonly recordedAt: string;
  readonly policy?: VerificationPolicyDefinition;
  /** Evaluates eligibility only; never publishes content or grants approval. */
  readonly purpose?: "internal_research" | "publication_eligibility";
}): DiagnosticsPolicyComposition {
  const policy = input.policy ?? CONSERVATIVE_DIAGNOSTICS_REPLAY_POLICY;
  const purpose = input.purpose ?? "internal_research";
  if (purpose !== "internal_research" && purpose !== "publication_eligibility")
    throw new Error("DIAGNOSTICS_POLICY_PURPOSE_INVALID");
  const policyJson = canonicalizeJson(policy);
  const cases = input.replay.map((entry) => {
    const sourceClass = entry.authenticatedEvidence.sourceClass;
    if (!["first_party", "first_party_marketing", "interested_party_comparison", "publication"].includes(sourceClass))
      throw new Error("DIAGNOSTICS_POLICY_COMPOSITION_SOURCE_CLASS");
    const normalizedProposition = entry.authenticatedEvidence.proposition.replace(/\s+/gu, " ").trim();
    const exactProductValidation =
      entry.caseId === "pace-definition-mutated" &&
      normalizedProposition === "This paragraph validates every commercial feature of TruAge and SystemAge.";
    const exactComparativeClaim =
      entry.caseId === "noise-method-mutated" &&
      normalizedProposition ===
        "This paragraph proves that SystemAge is superior to TruAge in an independent head-to-head clinical trial.";
    const exactInterestedComparison =
      entry.caseId === "gl-interested-comparison-source" &&
      normalizedProposition ===
        "Used by thousands of people around the world, the SystemAge test by Generation Lab is the most advanced and comprehensive aging speed test in preventive healthcare.";
    if (
      (entry.caseId === "pace-definition-mutated" && !exactProductValidation) ||
      (entry.caseId === "noise-method-mutated" && !exactComparativeClaim) ||
      (entry.caseId === "gl-interested-comparison-source" && !exactInterestedComparison)
    )
      throw new Error("DIAGNOSTICS_POLICY_COMPOSITION_SCOPE_DRIFT");
    const claimScope: "source_summary" | "product_validation" | "comparative_superiority" = exactProductValidation
      ? "product_validation"
      : exactComparativeClaim || exactInterestedComparison
        ? "comparative_superiority"
        : "source_summary";
    const riskClass: "low" | "high" = claimScope === "source_summary" ? "low" : "high";
    const evidenceScope: "unknown" | "company_statement" =
      sourceClass === "publication" ? "unknown" : "company_statement";
    const publicationRelation: "unknown" | "not_publication" =
      sourceClass === "publication" ? "unknown" : "not_publication";
    const result = replayDiagnosticsPolicy({
      policy,
      runId: `${input.runIdPrefix}:${entry.caseId}`,
      recordedAt: input.recordedAt,
      deterministicResult: entry.deterministicResult,
      cases: [
        {
          caseId: entry.caseId,
          caseDigest: entry.authenticatedEvidence.caseDigest,
          assertionId: entry.authenticatedEvidence.assertionId,
          fragmentId: entry.authenticatedEvidence.fragmentId,
          captureId: entry.authenticatedEvidence.captureId,
          sourceFamilyId: entry.authenticatedEvidence.sourceFamilyId,
          sourceOrganizationId: "unknown-source-organization",
          sourceClass: sourceClass as
            | "first_party"
            | "first_party_marketing"
            | "interested_party_comparison"
            | "publication",
          claimScope,
          evidenceScope,
          publicationRelation,
          riskClass,
          downstreamUse: [purpose === "publication_eligibility" ? "publication" : "internal_research"],
          semantic: entry.assessment,
        },
      ],
    });
    return {
      caseId: entry.caseId,
      caseDigest: entry.authenticatedEvidence.caseDigest,
      assertionId: entry.authenticatedEvidence.assertionId,
      sourceClass,
      claimScope,
      riskClass,
      sourceAssessmentStatus: result.sourceAssessmentStatus[0]!,
      decision: result.decision,
      replayDecision: result.replayDecision,
      policyInputsJson: decoder.decode(result.recordedInputs.bytes),
      policyInputsDigest: result.recordedInputs.digest,
      evidenceClosureJson: decoder.decode(result.evidenceClosure.bytes),
      evidenceClosureDigest: result.evidenceClosure.digest,
      provenance: {
        captureId: entry.authenticatedEvidence.captureId,
        fragmentId: entry.authenticatedEvidence.fragmentId,
        sourceArtifactId: entry.authenticatedEvidence.sourceArtifact.artifactId,
        projectionArtifactId: entry.authenticatedEvidence.projectionArtifact.artifactId,
        selectedContentDigest: entry.authenticatedEvidence.selectedContentDigest as `sha256:${string}`,
      },
    };
  });
  return Object.freeze({
    schemaVersion: "verification-diagnostics-policy-composition.v1",
    purpose,
    policy: {
      policyVersion: policy.policyVersion,
      json: policyJson,
      digest: digestCanonicalJson(policy),
      authority: "engineering_replay_policy" as const,
    },
    cases: Object.freeze(cases),
    externalRequests: 0,
  });
}
