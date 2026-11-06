import {
  DeterministicVerificationResultSchema,
  VerificationBundleSchema,
  type DeterministicVerificationResult,
  type MetricMechanicalResult,
  type VerificationArtifactHandle,
  type VerificationBundle,
  type VerificationCheck,
} from "@aiengineer/knowledge-contracts";
import type { EvidenceSelectorResolver } from "../evidence-selection/index.js";
import { VERIFICATION_CONTRACT_VERSION } from "../versions.js";
import { verifyAssertion, type AssertionResult } from "./assertion-verification.js";
import { indexBundle, verifyCaptures, type VerifiedCaptures } from "./capture-integrity.js";
import { combineCheckStatus } from "./checks.js";
import { verifyEvidenceEdge, type EvidenceEdgeContext, type EvidenceEdgeVerifier } from "./evidence-edge.js";
import { verifyMetricGraph } from "./metric-verification.js";
import { establishRuntimeSeparation, type RuntimeSeparation } from "./runtime-separation.js";

export interface HydratedVerificationArtifact {
  readonly artifactId: string;
  readonly content: Uint8Array | string;
}

export interface RuntimePrincipalBinding {
  readonly basis: "runtime_principal_binding";
  readonly producerDeploymentId: string;
  readonly verifierDeploymentId: string;
  readonly producerPrincipalDigest: `sha256:${string}`;
  readonly verifierPrincipalDigest: `sha256:${string}`;
}

export interface DeterministicVerificationInput {
  readonly bundle: VerificationBundle;
  readonly artifacts: readonly HydratedVerificationArtifact[];
  readonly runtimePrincipals: RuntimePrincipalBinding;
}

export interface DeterministicVerificationOptions {
  readonly selectorResolvers?: readonly EvidenceSelectorResolver[];
  /** Trusted application port backed by hydrated capture-specific transformation
   * envelopes. Never construct from serialized caller assertions. Byte identity
   * remains independently checked by this engine. */
  readonly isProjectionLineageAdmitted?: (binding: {
    readonly captureId: string;
    readonly sourceArtifact: VerificationArtifactHandle;
    readonly projectionArtifact: VerificationArtifactHandle;
  }) => boolean;
}

/**
 * Deterministic verification of one bundle, in stages that each return their
 * own checks: index ids → verify capture bytes → establish producer/verifier
 * separation → verify each assertion's evidence edges → replay the metric
 * graph → aggregate. Nothing here consults a model; the result gates whether
 * semantic verification may run at all.
 */
export function verifyDeterministicBundle(
  input: DeterministicVerificationInput,
  options: DeterministicVerificationOptions = {},
): DeterministicVerificationResult {
  const bundle = VerificationBundleSchema.parse(input.bundle);
  const index = indexBundle(bundle, input.artifacts);
  const captures = verifyCaptures(bundle, index, options.isProjectionLineageAdmitted);
  const separation = establishRuntimeSeparation(bundle, input.runtimePrincipals);
  const evidenceContext: EvidenceEdgeContext = {
    captures: index.captures,
    verifiedArtifacts: captures.verifiedArtifacts,
    selectorResolvers: options.selectorResolvers ?? [],
  };
  const verifyEvidence: EvidenceEdgeVerifier = (edge) => verifyEvidenceEdge(evidenceContext, edge);
  const assertions = bundle.assertions.map((assertion) =>
    verifyAssertion({ producer: bundle.producer, separation, verifyEvidence }, assertion),
  );
  const metricGraph = verifyMetricGraph({
    observations: bundle.metricObservations,
    separation,
    verifyEvidence,
  });
  return buildDeterministicResult({
    bundle,
    runtimePrincipals: input.runtimePrincipals,
    captureChecks: [...index.duplicateChecks, ...captures.checks, ...separation.checks, ...metricGraph.duplicateChecks],
    verifiedArtifacts: captures.verifiedArtifacts,
    separation,
    assertions,
    metrics: metricGraph.metrics,
  });
}

interface DeterministicResultParts {
  readonly bundle: VerificationBundle;
  readonly runtimePrincipals: RuntimePrincipalBinding;
  readonly captureChecks: readonly VerificationCheck[];
  readonly verifiedArtifacts: VerifiedCaptures["verifiedArtifacts"];
  readonly separation: RuntimeSeparation;
  readonly assertions: readonly AssertionResult[];
  readonly metrics: readonly MetricMechanicalResult[];
}

function buildDeterministicResult(parts: DeterministicResultParts): DeterministicVerificationResult {
  const { bundle, assertions, metrics, captureChecks } = parts;
  const allChecks = [
    ...captureChecks,
    ...assertions.flatMap((item) => [...item.checks, ...item.evidence.flatMap((edge) => edge.checks)]),
    ...metrics.flatMap((item) => item.checks),
  ];
  const status = combineCheckStatus(allChecks);
  const semanticEligibility =
    status === "passed" &&
    assertions.every((item) => item.semanticEligibility) &&
    metrics.every((item) => item.semanticEligibility);
  return DeterministicVerificationResultSchema.parse({
    verificationContractVersion: VERIFICATION_CONTRACT_VERSION,
    status,
    semanticEligibility,
    deploymentSeparation: {
      status: parts.separation.established ? "established" : "not_established",
      basis: "runtime_principal_binding",
      producerDeploymentId: parts.runtimePrincipals.producerDeploymentId,
      verifierDeploymentId: parts.runtimePrincipals.verifierDeploymentId,
    },
    captureChecks,
    assertions,
    metrics,
    summary: {
      capturesTotal: bundle.captures.length,
      capturesPassed: bundle.captures.filter((capture) =>
        parts.verifiedArtifacts.has(capture.contentArtifact.artifactId),
      ).length,
      assertionsTotal: assertions.length,
      assertionsPassed: assertions.filter((item) => item.status === "passed").length,
      metricsTotal: metrics.length,
      metricsPassed: metrics.filter((item) => item.status === "passed").length,
      failedCheckCodes: uniqueSorted(allChecks.filter((item) => item.status === "failed").map((item) => item.code)),
      reviewReasons: uniqueSorted(
        allChecks.filter((item) => item.status === "review_required").map((item) => item.detail),
      ),
    },
  });
}

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort();
