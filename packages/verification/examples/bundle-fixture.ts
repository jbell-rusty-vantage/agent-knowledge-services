import {
  sha256Digest,
  type DeterministicVerificationInput,
  type RuntimePrincipalBinding,
  type VerificationArtifactHandle,
  type VerificationBundle,
} from "../src/index.js";

/**
 * The smallest bundle the deterministic engine accepts: one source, one
 * capture whose bytes are supplied alongside, and one atomic text-quote
 * assertion produced by a deployment other than the verifier.
 */
export const TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
export const CAPTURE_ID = "capture-1";
export const ASSERTION_ID = "claim-1";
export const EVIDENCE_ID = "evidence-1";
export const FRAGMENT_ID = `fragment-${EVIDENCE_ID}`;
export const QUOTE = "The panel measured 42 samples";
export const CONTENT = `Methods. ${QUOTE} across two sites.`;

const capturedAt = "2026-09-19T00:00:00.000Z";

export const runtimePrincipals: RuntimePrincipalBinding = {
  basis: "runtime_principal_binding",
  producerDeploymentId: "research-synthesis",
  verifierDeploymentId: "verification-agent",
  producerPrincipalDigest: sha256Digest("producer-principal"),
  verifierPrincipalDigest: sha256Digest("verifier-principal"),
};

export function contentArtifact(content: string): VerificationArtifactHandle {
  return {
    artifactId: ARTIFACT_ID,
    tenantId: TENANT_ID,
    digest: sha256Digest(content),
    mediaType: "text/plain",
    byteLength: new TextEncoder().encode(content).byteLength,
    objectKey: `verification/${ARTIFACT_ID}`,
    createdAt: capturedAt,
    producerActivityId: "example-capture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "example",
    dataClassification: "internal",
    parentArtifactIds: [],
  };
}

export function minimalBundle(): VerificationBundle {
  return {
    verificationContractVersion: "verification.v1",
    bundleId: "example-bundle",
    policyVersion: "verification-policy-0.1.0",
    producer: {
      deploymentId: runtimePrincipals.producerDeploymentId,
      attemptId: "producer-attempt",
      capabilityVersion: "example-0.1.0",
    },
    verifier: {
      deploymentId: runtimePrincipals.verifierDeploymentId,
      attemptId: "verifier-attempt",
      capabilityVersion: "verification.v1",
    },
    sources: [
      {
        sourceId: "source-1",
        kind: "web_page",
        canonicalUri: "https://example.test/methods",
        logicalIdentity: "example methods page",
      },
    ],
    captures: [
      {
        captureId: CAPTURE_ID,
        sourceId: "source-1",
        capturedAt,
        captureMethod: "example",
        captureMethodVersion: "1",
        contentArtifact: contentArtifact(CONTENT),
      },
    ],
    assertions: [
      {
        assertionId: ASSERTION_ID,
        kind: "claim",
        claimType: "attribute",
        proposition: "The panel measured 42 samples.",
        producer: {
          deploymentId: runtimePrincipals.producerDeploymentId,
          attemptId: "producer-attempt",
          capabilityVersion: "example-0.1.0",
        },
        qualifiers: [],
        entityBindings: [],
        derivation: "direct",
        evidence: [
          {
            evidenceId: EVIDENCE_ID,
            fragment: {
              fragmentId: FRAGMENT_ID,
              captureId: CAPTURE_ID,
              representationArtifactId: ARTIFACT_ID,
              selector: {
                kind: "text_quote",
                quote: QUOTE,
                normalization: "none",
              },
            },
            role: "supports",
            origin: "declared",
            expectedSelectedContentDigest: sha256Digest(QUOTE),
            authority: {
              authority: "primary",
              independence: "self_reported",
              directness: "direct",
              freshness: "current",
              applicability: "direct",
            },
            parserLineageArtifactIds: [],
          },
        ],
        intent: {
          intentId: "intent-1",
          operation: "verify_claim_support",
          subject: ASSERTION_ID,
          expectedResult: "The page contains the exact quoted sentence.",
          method: "Resolve the quote against hash-checked page bytes.",
          acceptanceCriteria: ["quote resolves uniquely"],
          abstainWhen: ["quote is absent or ambiguous"],
        },
        riskClass: "medium",
        downstreamUse: ["semantic_verification"],
        atomic: true,
      },
    ],
    metricObservations: [],
    lineage: [],
  };
}

/** The bundle as produced: declared digest and supplied bytes agree. */
export function passingInput(): DeterministicVerificationInput {
  return {
    bundle: minimalBundle(),
    artifacts: [{ artifactId: ARTIFACT_ID, content: CONTENT }],
    runtimePrincipals,
  };
}

/**
 * Same declared handle, but the supplied bytes differ by one same-length
 * substitution ("42" → "24"), so length matches and only the digest disagrees.
 */
export function corruptedInput(): DeterministicVerificationInput {
  return {
    bundle: minimalBundle(),
    artifacts: [{ artifactId: ARTIFACT_ID, content: CONTENT.replace("42", "24") }],
    runtimePrincipals,
  };
}
