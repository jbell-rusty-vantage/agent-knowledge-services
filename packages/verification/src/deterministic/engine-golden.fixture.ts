import type {
  EvidenceEdge,
  VerificationArtifactHandle,
  VerificationBundle,
  VerificationMetricObservation,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "../canonical/index.js";
import type { DeterministicVerificationInput, RuntimePrincipalBinding } from "./bundle-verification.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const createdAt = "2026-08-23T00:53:08.482Z";

export const runtimePrincipals: RuntimePrincipalBinding = {
  basis: "runtime_principal_binding",
  producerDeploymentId: "research-synthesis",
  verifierDeploymentId: "verification-agent",
  producerPrincipalDigest: sha256Digest("producer-principal"),
  verifierPrincipalDigest: sha256Digest("verifier-principal"),
};

function artifact(content: string): VerificationArtifactHandle {
  return {
    artifactId,
    tenantId,
    digest: sha256Digest(content),
    mediaType: content.trimStart().startsWith("{") ? "application/json" : "text/plain",
    byteLength: new TextEncoder().encode(content).byteLength,
    objectKey: `verification/${artifactId}`,
    createdAt,
    producerActivityId: "fixture-capture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "test",
    dataClassification: "internal",
    parentArtifactIds: [],
  };
}

const authority = {
  authority: "primary" as const,
  independence: "self_reported" as const,
  directness: "direct" as const,
  freshness: "historical" as const,
  applicability: "direct" as const,
};

function edge(
  evidenceId: string,
  selector: EvidenceEdge["fragment"]["selector"],
  expectedSelectedContentDigest?: `sha256:${string}`,
): EvidenceEdge {
  return {
    evidenceId,
    fragment: {
      fragmentId: `fragment-${evidenceId}`,
      captureId: "capture-1",
      representationArtifactId: artifactId,
      selector,
    },
    role: "supports",
    origin: "declared",
    ...(expectedSelectedContentDigest === undefined ? {} : { expectedSelectedContentDigest }),
    authority,
    parserLineageArtifactIds: [],
  };
}

export function prototypeClaimInput(): DeterministicVerificationInput {
  const content =
    "Intro. RAG was basically just a hack. The package recorded 10 downloads on day one and 15 on day two.";
  const handle = artifact(content);
  const evidence = edge(
    "evidence-1",
    {
      kind: "text_quote",
      quote: "RAG was basically just a hack",
      normalization: "none",
    },
    sha256Digest("RAG was basically just a hack"),
  );
  const bundle: VerificationBundle = {
    verificationContractVersion: "verification.v1",
    bundleId: "prototype-claim-parity",
    policyVersion: "verification-policy-0.1.0",
    producer: {
      deploymentId: "research-synthesis",
      attemptId: "producer-attempt",
      capabilityVersion: "prototype-0.1.0",
    },
    verifier: {
      deploymentId: "verification-agent",
      attemptId: "verifier-attempt",
      capabilityVersion: "verification.v1",
    },
    sources: [
      {
        sourceId: "source-1",
        kind: "transcript",
        canonicalUri: "fixture:transcript",
        logicalIdentity: "prototype transcript",
      },
    ],
    captures: [
      {
        captureId: "capture-1",
        sourceId: "source-1",
        capturedAt: createdAt,
        captureMethod: "fixture",
        captureMethodVersion: "1",
        contentArtifact: handle,
      },
    ],
    assertions: [
      {
        assertionId: "claim-1",
        kind: "claim",
        claimType: "attribute",
        proposition: "The speaker described RAG as basically a hack.",
        producer: {
          deploymentId: "research-synthesis",
          attemptId: "producer-attempt",
          capabilityVersion: "prototype-0.1.0",
        },
        qualifiers: [],
        entityBindings: [],
        derivation: "direct",
        evidence: [evidence],
        intent: {
          intentId: "intent-1",
          operation: "verify_claim_support",
          subject: "claim-1",
          expectedResult: "The source contains the exact quoted description.",
          method: "Resolve the quote against hash-checked transcript bytes.",
          acceptanceCriteria: ["quote resolves uniquely", "offsets round-trip"],
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
  return { bundle, artifacts: [{ artifactId, content }], runtimePrincipals };
}

function jsonEvidence(id: string, pointer: string, value: unknown): EvidenceEdge {
  return edge(id, { kind: "json_pointer", pointer }, sha256Digest(JSON.stringify(value)));
}

function directMetric(
  observationId: string,
  value: string,
  valuePointer: string,
  evidenceSuffix: string,
): VerificationMetricObservation {
  const evidence = [
    jsonEvidence(`value-${evidenceSuffix}`, valuePointer, Number(value)),
    jsonEvidence(`unit-${evidenceSuffix}`, "/unit", "downloads"),
    jsonEvidence(`identity-${evidenceSuffix}`, "/entity", "@langchain/langgraph"),
  ];
  return {
    observationId,
    entity: {
      kind: "package",
      canonicalId: "npm:@langchain/langgraph",
      label: "@langchain/langgraph",
      parentCanonicalId: "product:langgraph",
      aliases: [],
    },
    artifactLevel: "package",
    provider: "npm_downloads_api",
    providerNativeField: valuePointer,
    metricDefinition: "daily registry downloads",
    metricDefinitionVersion: "npm-downloads-day-1",
    rawValue: Number(value),
    canonicalValue: value,
    unit: { symbol: "downloads", dimension: "count", scaleToCanonical: "1" },
    period: { timezone: "UTC", semantics: "point" },
    aggregation: "identity",
    deduplication: "provider_native",
    caveats: ["downloads are not unique users"],
    observedAt: createdAt,
    comparabilityGroup: "npm:downloads:daily",
    evidence,
    evidenceBindings: [
      {
        evidenceId: `value-${evidenceSuffix}`,
        facet: "value",
        expectedLiteral: value,
        comparison: "decimal",
      },
      {
        evidenceId: `unit-${evidenceSuffix}`,
        facet: "unit",
        expectedLiteral: "downloads",
        comparison: "exact_text",
      },
      {
        evidenceId: `identity-${evidenceSuffix}`,
        facet: "identity",
        expectedLiteral: "@langchain/langgraph",
        comparison: "exact_text",
      },
    ],
  };
}

export function prototypeMetricInput(): DeterministicVerificationInput {
  const content = JSON.stringify({
    entity: "@langchain/langgraph",
    unit: "downloads",
    day1: 10,
    day2: 15,
    total: 25,
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-02T23:59:59.999Z",
  });
  const handle = artifact(content);
  const day1 = directMetric("npm-downloads-day-1", "10", "/day1", "day1");
  const day2 = directMetric("npm-downloads-day-2", "15", "/day2", "day2");
  const evidence = [
    jsonEvidence("value-total", "/total", 25),
    jsonEvidence("unit-total", "/unit", "downloads"),
    jsonEvidence("identity-total", "/entity", "@langchain/langgraph"),
    jsonEvidence("period-start-total", "/start", "2026-08-01T00:00:00.000Z"),
    jsonEvidence("period-end-total", "/end", "2026-08-02T23:59:59.999Z"),
  ];
  const total: VerificationMetricObservation = {
    ...directMetric("npm-downloads-30d", "25", "/total", "unused"),
    metricDefinition: "inclusive-window registry downloads",
    metricDefinitionVersion: "npm-downloads-inclusive-window-1",
    period: {
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-02T23:59:59.999Z",
      timezone: "UTC",
      semantics: "interval",
    },
    comparabilityGroup: "npm:downloads:daily_sum:inclusive",
    evidence,
    evidenceBindings: [
      {
        evidenceId: "value-total",
        facet: "value",
        expectedLiteral: "25",
        comparison: "decimal",
      },
      {
        evidenceId: "unit-total",
        facet: "unit",
        expectedLiteral: "downloads",
        comparison: "exact_text",
      },
      {
        evidenceId: "identity-total",
        facet: "identity",
        expectedLiteral: "@langchain/langgraph",
        comparison: "exact_text",
      },
      {
        evidenceId: "period-start-total",
        facet: "period_start",
        expectedLiteral: "2026-08-01T00:00:00.000Z",
        comparison: "iso_datetime",
      },
      {
        evidenceId: "period-end-total",
        facet: "period_end",
        expectedLiteral: "2026-08-02T23:59:59.999Z",
        comparison: "iso_datetime",
      },
    ],
    calculation: {
      operation: "sum",
      operands: [
        { observationId: day1.observationId, value: "10" },
        { observationId: day2.observationId, value: "15" },
      ],
      expectedResult: "25",
      rounding: { mode: "none", decimalPlaces: 0 },
      tolerance: "0",
      operationVersion: "decimal.v1",
    },
  };
  return {
    bundle: {
      verificationContractVersion: "verification.v1",
      bundleId: "prototype-metric-parity",
      policyVersion: "verification-policy-0.1.0",
      producer: {
        deploymentId: "research-synthesis",
        attemptId: "producer-attempt",
        capabilityVersion: "prototype-0.1.0",
      },
      verifier: {
        deploymentId: "verification-agent",
        attemptId: "verifier-attempt",
        capabilityVersion: "verification.v1",
      },
      sources: [
        {
          sourceId: "source-1",
          kind: "api",
          canonicalUri: "fixture:npm",
          logicalIdentity: "npm range response",
        },
      ],
      captures: [
        {
          captureId: "capture-1",
          sourceId: "source-1",
          capturedAt: createdAt,
          captureMethod: "fixture",
          captureMethodVersion: "1",
          contentArtifact: handle,
        },
      ],
      assertions: [],
      metricObservations: [day1, day2, total],
      lineage: [],
    },
    artifacts: [{ artifactId, content }],
    runtimePrincipals,
  };
}
