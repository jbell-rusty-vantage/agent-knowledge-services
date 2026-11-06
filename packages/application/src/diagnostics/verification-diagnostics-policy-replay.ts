import {
  VerificationPolicyDefinitionSchema,
  VerificationRecordedPolicyInputsSchema,
  type DeterministicVerificationResult,
  type SemanticAssessmentRecord,
  type VerificationPolicyDecision,
  type VerificationPolicyDefinition,
  type VerificationRecordedPolicyInputs,
  type VerificationSourceAssessment,
} from "@aiengineer/knowledge-contracts";
import { assessSourceAuthority, canonicalizeJson, digestCanonicalJson } from "@aiengineer/knowledge-verification";
import { evaluateVerificationPolicy, replayVerificationPolicy } from "@aiengineer/knowledge-policy";

const encoder = new TextEncoder();

/** Ownership metadata available from the frozen v1 catalog. It is intentionally
 * weaker than a source-authority judgment: applicability and freshness remain
 * unknown unless an independently retained assessment supplies them. */
export type DiagnosticsSourceClass =
  | "first_party"
  | "first_party_marketing"
  | "interested_party_comparison"
  | "publication";

export interface DiagnosticsPolicyReplayCase {
  readonly caseId: string;
  readonly caseDigest: `sha256:${string}`;
  readonly assertionId: string;
  readonly fragmentId: string;
  readonly captureId: string;
  readonly sourceFamilyId: string;
  readonly sourceOrganizationId: string;
  readonly sourceClass: DiagnosticsSourceClass;
  readonly claimScope: VerificationSourceAssessment["claimScope"];
  readonly evidenceScope: VerificationSourceAssessment["evidenceScope"];
  readonly publicationRelation: VerificationSourceAssessment["publicationRelation"];
  readonly riskClass: VerificationRecordedPolicyInputs["assertions"][number]["riskClass"];
  readonly downstreamUse: readonly string[];
  readonly semantic: SemanticAssessmentRecord;
}

export interface DiagnosticsPolicyReplayInput {
  readonly policy: VerificationPolicyDefinition;
  readonly runId: string;
  readonly recordedAt: string;
  readonly deterministicResult: DeterministicVerificationResult;
  readonly cases: readonly DiagnosticsPolicyReplayCase[];
}

export interface DiagnosticsPolicyReplayResult {
  readonly schemaVersion: "verification-diagnostics-policy-replay.v1";
  readonly runId: string;
  readonly policy: { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
  readonly recordedInputs: { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
  readonly evidenceClosure: { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
  readonly decision: VerificationPolicyDecision;
  readonly replayDecision: VerificationPolicyDecision;
  readonly sourceAssessmentStatus: readonly {
    readonly assertionId: string;
    readonly status: "sufficient" | "withheld" | "unknown";
    readonly independentCorroboration: boolean;
    readonly reasonCodes: readonly string[];
  }[];
  readonly externalRequests: 0;
}

function ownershipVector(sourceClass: DiagnosticsSourceClass): VerificationSourceAssessment["vector"] {
  if (sourceClass === "first_party_marketing") {
    return {
      authority: "promotional",
      independence: "self_reported",
      directness: "direct",
      freshness: "unknown",
      applicability: "unknown",
    };
  }
  if (sourceClass === "interested_party_comparison") {
    return {
      authority: "promotional",
      independence: "interested_party",
      directness: "direct",
      freshness: "unknown",
      applicability: "unknown",
    };
  }
  if (sourceClass === "first_party") {
    return {
      authority: "primary",
      independence: "same_organization",
      directness: "direct",
      freshness: "unknown",
      applicability: "unknown",
    };
  }
  return {
    authority: "unknown",
    independence: "unknown",
    directness: "direct",
    freshness: "unknown",
    applicability: "unknown",
  };
}

function sourceAssessment(input: DiagnosticsPolicyReplayCase): VerificationSourceAssessment {
  return {
    assessmentId: `${input.assertionId}:source-assessment`,
    assertionId: input.assertionId,
    fragmentId: input.fragmentId,
    sourceFamilyId: input.sourceFamilyId,
    sourceOrganizationId: input.sourceOrganizationId,
    vector: ownershipVector(input.sourceClass),
    claimScope: input.claimScope,
    evidenceScope: input.evidenceScope,
    publicationRelation: input.publicationRelation,
    jurisdictionKnown: false,
    licenseKnown: false,
    freshnessKnown: false,
  };
}

function policyBytes(policy: VerificationPolicyDefinition): Uint8Array {
  return encoder.encode(canonicalizeJson(VerificationPolicyDefinitionSchema.parse(policy)));
}

/**
 * Executes the production policy evaluator against retained diagnostic
 * evidence, then replays the exact canonical bytes. No provider, catalog, or
 * persistence access occurs here. Unknown source facts are retained as
 * unknown, so this helper cannot turn source ownership into product
 * applicability or independent corroboration.
 */
export function replayDiagnosticsPolicy(input: DiagnosticsPolicyReplayInput): DiagnosticsPolicyReplayResult {
  const policy = VerificationPolicyDefinitionSchema.parse(input.policy);
  const sourceAssessments = input.cases.map(sourceAssessment);
  if (input.deterministicResult.metrics.length > 0)
    throw new Error("DIAGNOSTICS_POLICY_REPLAY_METRIC_METADATA_REQUIRED");
  const byAssertion = new Map<string, DiagnosticsPolicyReplayCase>();
  for (const item of input.cases) {
    if (byAssertion.has(item.assertionId)) throw new Error("DIAGNOSTICS_POLICY_REPLAY_DUPLICATE_ASSERTION");
    byAssertion.set(item.assertionId, item);
  }
  const assertions = input.deterministicResult.assertions.map((mechanical) => {
    const item = byAssertion.get(mechanical.assertionId);
    if (!item) throw new Error("DIAGNOSTICS_POLICY_REPLAY_ASSERTION_COVERAGE");
    if (item.semantic.assertionId !== item.assertionId) throw new Error("DIAGNOSTICS_POLICY_REPLAY_SEMANTIC_BINDING");
    const authority = assessSourceAuthority(
      item.assertionId,
      sourceAssessments.filter((source) => source.assertionId === item.assertionId),
    );
    return {
      assertionId: item.assertionId,
      riskClass: item.riskClass,
      downstreamUse: [...item.downstreamUse],
      claimScope: item.claimScope,
      semantic: item.semantic,
      authorityStatus: authority.status,
      independentCorroboration: authority.independentCorroboration,
      conflictPresent: authority.conflictPresent,
      criticalFactsKnown: false,
    };
  });
  if (assertions.length !== input.cases.length) throw new Error("DIAGNOSTICS_POLICY_REPLAY_ASSERTION_COVERAGE");
  const recorded: VerificationRecordedPolicyInputs = VerificationRecordedPolicyInputsSchema.parse({
    schemaVersion: "verification-policy-inputs.v1",
    policyVersion: policy.policyVersion,
    runId: input.runId,
    recordedAt: input.recordedAt,
    deterministicResult: input.deterministicResult,
    assertions,
    metrics: [],
    sourceAssessments,
  });
  const inputsBytes = encoder.encode(canonicalizeJson(recorded));
  const definitionBytes = policyBytes(policy);
  const evidenceClosureBytes = encoder.encode(
    canonicalizeJson(
      input.cases.map((item) => ({
        caseId: item.caseId,
        caseDigest: item.caseDigest,
        assertionId: item.assertionId,
        fragmentId: item.fragmentId,
        captureId: item.captureId,
        sourceFamilyId: item.sourceFamilyId,
        sourceOrganizationId: item.sourceOrganizationId,
        sourceClass: item.sourceClass,
        claimScope: item.claimScope,
        evidenceScope: item.evidenceScope,
        publicationRelation: item.publicationRelation,
      })),
    ),
  );
  const decision = evaluateVerificationPolicy(policy, recorded);
  const replay = replayVerificationPolicy({
    policyVersion: policy.policyVersion,
    policyBytes: definitionBytes,
    recordedPolicyInputsBytes: inputsBytes,
  });
  if (digestCanonicalJson(decision) !== digestCanonicalJson(replay.decision))
    throw new Error("DIAGNOSTICS_POLICY_REPLAY_DRIFT");
  return Object.freeze({
    schemaVersion: "verification-diagnostics-policy-replay.v1",
    runId: input.runId,
    policy: Object.freeze({ bytes: definitionBytes, digest: digestCanonicalJson(policy) }),
    recordedInputs: Object.freeze({ bytes: inputsBytes, digest: digestCanonicalJson(recorded) }),
    evidenceClosure: Object.freeze({
      bytes: evidenceClosureBytes,
      digest: digestCanonicalJson(
        input.cases.map((item) => ({
          caseId: item.caseId,
          caseDigest: item.caseDigest,
          assertionId: item.assertionId,
          fragmentId: item.fragmentId,
          captureId: item.captureId,
          sourceFamilyId: item.sourceFamilyId,
          sourceOrganizationId: item.sourceOrganizationId,
          sourceClass: item.sourceClass,
          claimScope: item.claimScope,
          evidenceScope: item.evidenceScope,
          publicationRelation: item.publicationRelation,
        })),
      ),
    }),
    decision,
    replayDecision: replay.decision,
    sourceAssessmentStatus: Object.freeze(
      input.cases.map((item) => {
        const authority = assessSourceAuthority(
          item.assertionId,
          sourceAssessments.filter((source) => source.assertionId === item.assertionId),
        );
        return Object.freeze({
          assertionId: item.assertionId,
          status: authority.status,
          independentCorroboration: authority.independentCorroboration,
          reasonCodes: authority.reasonCodes,
        });
      }),
    ),
    externalRequests: 0,
  });
}
