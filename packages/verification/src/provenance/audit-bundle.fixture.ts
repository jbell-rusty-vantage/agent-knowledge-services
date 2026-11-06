import type { VerificationArtifactHandle, VerificationRunManifest } from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson, sha256Digest } from "../canonical/index.js";
import { verifyDeterministicBundle, type DeterministicVerificationInput } from "../deterministic/index.js";
import { prototypeClaimInput } from "../deterministic/engine-golden.fixture.js";
import { verificationManifestDigest } from "./seal.js";

/**
 * A mechanically passing run manifest and recorded policy inputs around a
 * deterministic input. Shared by the provenance tests and the examples so
 * there is one fixture manifest shape.
 */
export interface AuditBundleFixtureOptions {
  readonly deterministicInput?: DeterministicVerificationInput;
  /** Record a judged semantic assessment instead of a pending review. */
  readonly judged?: boolean;
}

const createdAt = "2026-09-05T02:00:00.000Z";
export const policyBytes = new TextEncoder().encode(
  '{"policy":"pass mechanically valid fixtures","version":"verification-policy-0.1.0"}',
);

function policyHandle(tenantId: string): VerificationArtifactHandle {
  const digest = sha256Digest(policyBytes);
  return {
    artifactId: "44444444-4444-4444-8444-444444444444",
    tenantId,
    digest,
    mediaType: "application/json",
    byteLength: policyBytes.byteLength,
    objectKey: `${tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}`,
    createdAt,
    producerActivityId: "policy-publisher",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "internal",
    parentArtifactIds: [],
  };
}

export function auditBundleFixture(options: AuditBundleFixtureOptions = {}) {
  const judged = options.judged ?? false;
  const deterministicInput = options.deterministicInput ?? prototypeClaimInput();
  const deterministicResult = verifyDeterministicBundle(deterministicInput);
  const sourceHandle = deterministicInput.bundle.captures[0]!.contentArtifact;
  const policyArtifact = policyHandle(sourceHandle.tenantId);
  const recordedPolicyInputsBytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: "verification-policy-inputs.v1",
      policyVersion: deterministicInput.bundle.policyVersion,
      runId: "run-1",
      recordedAt: createdAt,
      deterministicResult,
      assertions: [
        {
          assertionId: "claim-1",
          riskClass: "medium",
          downstreamUse: ["semantic_verification"],
          claimScope: "source_summary",
          semantic: {
            assertionId: "claim-1",
            verdict: judged ? "directly_supported" : "pending_semantic_review",
            disposition: judged ? "admit" : "review",
            evidenceSupport: judged ? "satisfied" : "not_assessed",
            worldCorrectness: "not_assessed",
            attributionFaithfulness: "not_assessed",
            sourceAuthority: "not_assessed",
            provenanceIntegrity: "satisfied",
            judgeIdentities: [],
            supportingFragmentIds: ["fragment-evidence-1"],
            contradictingFragmentIds: [],
            unsupportedFacets: [],
            reasonCodes: [],
            crossFamilySecondJudge: false,
            rawProviderConfidences: [],
          },
          authorityStatus: "unknown",
          independentCorroboration: false,
          conflictPresent: false,
          criticalFactsKnown: true,
        },
      ],
      metrics: [],
      sourceAssessments: [],
    }),
  );
  const recordedPolicyInputsDigest = sha256Digest(recordedPolicyInputsBytes);
  const recordedPolicyInputsArtifact: VerificationArtifactHandle = {
    ...policyArtifact,
    artifactId: "55555555-5555-4555-8555-555555555555",
    digest: recordedPolicyInputsDigest,
    byteLength: recordedPolicyInputsBytes.byteLength,
    objectKey: `${sourceHandle.tenantId}/${recordedPolicyInputsDigest.slice(7, 9)}/${recordedPolicyInputsDigest.slice(7)}`,
    producerActivityId: "verification-policy-input-recorder",
  };
  const policyDecision = {
    outcome: "pass",
    tokenUsage: 34,
    inputTokens: 21,
    outputTokens: 13,
  };
  const manifest: VerificationRunManifest = {
    verificationContractVersion: "verification.v1",
    manifestId: "manifest-1",
    runId: "run-1",
    versions: {
      policy: deterministicInput.bundle.policyVersion,
      schema: "verification.v1",
      normalizer: "text.v1",
    },
    code: { gitSha: "fixture-sha", dirty: false },
    runtime: {
      platform: "test",
      deploymentId: deterministicInput.bundle.verifier.deploymentId,
    },
    provider: {
      endpointIdentity: "fixture-provider",
      model: "fixture-model",
      nativeConfiguration: {
        tokenUsage: 34,
        inputTokens: 21,
        outputTokens: 13,
      },
      pricingSnapshotArtifactId: policyArtifact.artifactId,
    },
    inputArtifacts: [sourceHandle, policyArtifact, recordedPolicyInputsArtifact],
    outputArtifacts: [],
    stages: [
      {
        name: "deterministic",
        status: "succeeded",
        startedAt: createdAt,
        endedAt: createdAt,
      },
    ],
    calls: [],
    toolPolicy: [],
    networkPolicy: "disabled",
    deterministicResult,
    judgments: [],
    policyOutcome: "pass",
    resultDigest: digestCanonicalJson(deterministicResult),
    lineage: [],
    canonicalization: {
      algorithm: "RFC8785",
      implementationVersion: "knowledge-verification.v1",
      manifestDigest: sha256Digest(""),
    },
    startedAt: createdAt,
    completedAt: createdAt,
  };
  manifest.canonicalization.manifestDigest = verificationManifestDigest(manifest);
  return {
    deterministicInput,
    deterministicResult,
    sourceHandle,
    policyArtifact,
    recordedPolicyInputsArtifact,
    recordedPolicyInputsBytes,
    policyDecision,
    manifest,
  };
}
