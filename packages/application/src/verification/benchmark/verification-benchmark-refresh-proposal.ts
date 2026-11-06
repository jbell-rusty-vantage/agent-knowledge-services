import { z } from "zod";

import {
  VerificationBenchmarkDatasetSchema,
  VerificationCaptureTerminalResourceSchema,
  type VerificationBenchmarkDataset,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { assertFrozenVerificationBenchmarkDataset } from "@aiengineer/knowledge-evaluation";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(255);
const sourceClass = z.string().min(1).max(255);
const uri = z.string().url().max(2_048);
const sourceLedgerEntry = z.strictObject({
  sourceKey: identifier,
  url: uri,
  sourceClass,
  captureId: z.uuid(),
  sourceArtifactDigest: digest,
  originalCapturedAt: z.string().datetime({ offset: true }).nullable(),
  rights: z.string().min(1).max(4_096),
  goldStatus: z.enum(["not_labeled", "engineering_expectation", "expert_adjudicated"]),
});
const sourceLedger = z.strictObject({
  schemaVersion: z.literal("verification-benchmark-source-ledger.v1"),
  sourcePreparationDigest: digest,
  sources: z.array(sourceLedgerEntry).length(16),
});
const outcome = z.discriminatedUnion("state", [
  z.strictObject({
    sourceKey: identifier,
    state: z.literal("succeeded"),
    capture: VerificationCaptureTerminalResourceSchema,
  }),
  z.strictObject({
    sourceKey: identifier,
    state: z.literal("unavailable"),
    unavailableCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/u),
  }),
]);
const V1_CATALOG_MANIFEST_DIGEST = "sha256:fc927c53f8bc308227fe3e9f1f5d321e3075986140a25ce07755208c86ac09e1";
const V1_DATASET_MANIFEST_DIGEST = "sha256:e3529d2d27e3f473d4f6eb9da633b404c14c48f20b9db8c1d7a428220d538d9e";
const V1_SOURCE_LEDGER_DIGEST = "sha256:11484b83a4cb8aacd2434887e13be3b115ba35b4bb8b269002e1b2b68db2f0cc";
const bytePreflight = (values: readonly unknown[]) => {
  let total = 0;
  for (const value of values) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error("BENCHMARK_REFRESH_PROPOSAL_INPUT_ENCODING_INVALID");
    }
    if (serialized === undefined) throw new Error("BENCHMARK_REFRESH_PROPOSAL_INPUT_ENCODING_INVALID");
    total += new TextEncoder().encode(serialized).byteLength;
    if (total > 8 * 1024 * 1024) throw new Error("BENCHMARK_REFRESH_PROPOSAL_INPUT_BOUND_EXCEEDED");
  }
};

export interface PrepareDiagnosticsBenchmarkRefreshProposalInput {
  /** An immutable historical dataset; this function never reuses it as a refreshed dataset. */
  readonly tenantId: unknown;
  readonly baselineDataset: unknown;
  readonly baselineSourceLedger: unknown;
  /** Pins the verified catalog/ledger bodies supplied by the trusted loader. */
  readonly baselineCatalogManifestDigest: unknown;
  /** Canonical JSON digest, distinct from the catalog's raw-file digest. */
  readonly baselineSourceLedgerCanonicalDigest: unknown;
  /** Server-authenticated terminal records, one for every historical source key. */
  readonly authenticatedCaptureOutcomes: unknown;
}

/**
 * Produces review-gated refresh material only. New selectors, assertions,
 * labels, human approval, and a frozen successor dataset are deliberately
 * outside this pure boundary.
 */
export function prepareDiagnosticsBenchmarkRefreshProposal(input: PrepareDiagnosticsBenchmarkRefreshProposalInput) {
  bytePreflight([
    input.tenantId,
    input.baselineDataset,
    input.baselineSourceLedger,
    input.baselineCatalogManifestDigest,
    input.baselineSourceLedgerCanonicalDigest,
    input.authenticatedCaptureOutcomes,
  ]);
  const tenantId = z.uuid().parse(input.tenantId);
  const baseline = VerificationBenchmarkDatasetSchema.parse(
    structuredClone(input.baselineDataset),
  ) as VerificationBenchmarkDataset;
  assertFrozenVerificationBenchmarkDataset(baseline);
  if (
    baseline.datasetId !== "diagnostics-companies" ||
    baseline.version !== 1 ||
    baseline.manifestDigest !== V1_DATASET_MANIFEST_DIGEST
  )
    throw new Error("BENCHMARK_REFRESH_PROPOSAL_BASELINE_DATASET_INVALID");
  const ledger = sourceLedger.parse(structuredClone(input.baselineSourceLedger));
  if (
    ledger.sourcePreparationDigest !== baseline.sourcePreparationDigest ||
    new Set(ledger.sources.map((item) => item.sourceKey)).size !== 16 ||
    input.baselineCatalogManifestDigest !== V1_CATALOG_MANIFEST_DIGEST ||
    input.baselineSourceLedgerCanonicalDigest !== V1_SOURCE_LEDGER_DIGEST ||
    digestCanonicalJson(ledger) !== input.baselineSourceLedgerCanonicalDigest
  )
    throw new Error("BENCHMARK_REFRESH_PROPOSAL_BASELINE_LEDGER_INVALID");
  const baselineKeys = new Set(baseline.cases.flatMap((item) => item.evidence.map((evidence) => evidence.sourceKey)));
  // The ledger has 16 registered sources, including historical unavailable/PDF
  // sources that need not appear in an existing case evidence edge.
  if (
    baselineKeys.size < 1 ||
    baselineKeys.size > 16 ||
    [...baselineKeys].some((key) => !ledger.sources.some((source) => source.sourceKey === key))
  )
    throw new Error("BENCHMARK_REFRESH_PROPOSAL_BASELINE_EVIDENCE_INVALID");
  const outcomes = z.array(outcome).length(16).parse(structuredClone(input.authenticatedCaptureOutcomes));
  if (
    new Set(outcomes.map((item) => item.sourceKey)).size !== 16 ||
    outcomes.some((item) => !ledger.sources.some((source) => source.sourceKey === item.sourceKey))
  )
    throw new Error("BENCHMARK_REFRESH_PROPOSAL_OUTCOME_SET_INVALID");
  const succeeded = outcomes.filter(
    (item): item is Extract<(typeof outcomes)[number], { state: "succeeded" }> => item.state === "succeeded",
  );
  if (
    new Set(succeeded.map((item) => item.capture.operationId)).size !== succeeded.length ||
    new Set(succeeded.map((item) => item.capture.capture.captureId)).size !== succeeded.length
  )
    throw new Error("BENCHMARK_REFRESH_PROPOSAL_CAPTURE_IDENTITY_DUPLICATE");

  const sourceDiff = ledger.sources.map((source) => {
    const current = outcomes.find((item) => item.sourceKey === source.sourceKey)!;
    if (current.state === "unavailable")
      return {
        sourceKey: source.sourceKey,
        sourceClass: source.sourceClass,
        priorCaptureId: source.captureId,
        priorSourceArtifactDigest: source.sourceArtifactDigest,
        status: "unavailable" as const,
        unavailableCode: current.unavailableCode,
      };
    const pdf = source.sourceKey === "tru-sample-report";
    const expectedRequest = pdf
      ? {
          verificationContractVersion: "verification.v1" as const,
          source: { mode: "acquire" as const, sourceKind: "pdf" as const, sourceUri: source.url },
          requestedProjectionKinds: ["pdf_text", "geometry"],
        }
      : {
          verificationContractVersion: "verification.v1" as const,
          source: { mode: "acquire" as const, sourceKind: "web_page" as const, sourceUri: source.url },
          requestedProjectionKinds: ["html_dom"],
        };
    if (
      current.capture.tenantId !== tenantId ||
      current.capture.captureMode !== "acquire" ||
      current.capture.source.canonicalUri !== source.url ||
      current.capture.requestDigest !== digestCanonicalJson(expectedRequest)
    )
      throw new Error(`BENCHMARK_REFRESH_PROPOSAL_CAPTURE_BINDING_INVALID:${source.sourceKey}`);
    if (pdf) {
      if (
        current.capture.source.kind !== "pdf" ||
        current.capture.projections.length !== 2 ||
        current.capture.projections[0]?.projectionKind !== "pdf_text" ||
        current.capture.projections[0]?.projectionOrdinal !== 0 ||
        current.capture.projections[1]?.projectionKind !== "geometry" ||
        current.capture.projections[1]?.projectionOrdinal !== 1
      )
        throw new Error(`BENCHMARK_REFRESH_PROPOSAL_CAPTURE_BINDING_INVALID:${source.sourceKey}`);
      return {
        sourceKey: source.sourceKey,
        sourceClass: source.sourceClass,
        priorCaptureId: source.captureId,
        priorSourceArtifactDigest: source.sourceArtifactDigest,
        status:
          current.capture.capture.contentArtifact.digest === source.sourceArtifactDigest
            ? ("unchanged" as const)
            : ("changed" as const),
        operationId: current.capture.operationId,
        requestDigest: current.capture.requestDigest,
        captureId: current.capture.capture.captureId,
        contentArtifact: current.capture.capture.contentArtifact,
        projections: current.capture.projections.map((projection) => ({
          projectionKind: projection.projectionKind,
          projectionOrdinal: projection.projectionOrdinal,
          projectionArtifact: projection.projectionArtifact,
          transformationArtifact: projection.transformationArtifact,
        })),
        resultArtifact: current.capture.resultArtifact,
      };
    }
    if (current.capture.source.kind !== "web_page" || current.capture.projections.length !== 1)
      throw new Error(`BENCHMARK_REFRESH_PROPOSAL_CAPTURE_BINDING_INVALID:${source.sourceKey}`);
    const projection = current.capture.projections[0]!;
    return {
      sourceKey: source.sourceKey,
      sourceClass: source.sourceClass,
      priorCaptureId: source.captureId,
      priorSourceArtifactDigest: source.sourceArtifactDigest,
      status:
        current.capture.capture.contentArtifact.digest === source.sourceArtifactDigest
          ? ("unchanged" as const)
          : ("changed" as const),
      operationId: current.capture.operationId,
      requestDigest: current.capture.requestDigest,
      captureId: current.capture.capture.captureId,
      contentArtifact: current.capture.capture.contentArtifact,
      projectionArtifact: projection.projectionArtifact,
      transformationArtifact: projection.transformationArtifact,
      resultArtifact: current.capture.resultArtifact,
    };
  });
  const historicalCases = baseline.cases.map((item) => ({
    caseId: item.caseId,
    caseDigest: item.caseDigest,
    historicalEvidence: item.evidence.map((evidence) => ({
      fragmentId: evidence.fragmentId,
      sourceKey: evidence.sourceKey,
      captureId: evidence.captureId,
      projectionArtifactId: evidence.projectionArtifactId,
      projectionDigest: evidence.projectionDigest,
      transformationArtifactId: evidence.transformationArtifactId,
      selectedContentDigest: evidence.selectedContentDigest,
    })),
  }));
  const material = {
    schemaVersion: "diagnostics-benchmark-refresh-proposal.v1" as const,
    tenantId,
    baseline: {
      datasetId: baseline.datasetId,
      version: baseline.version,
      datasetManifestDigest: baseline.manifestDigest,
      sourcePreparationDigest: baseline.sourcePreparationDigest,
    },
    proposedDataset: {
      datasetId: "diagnostics-companies",
      version: 2,
      supersedesDatasetManifestDigest: baseline.manifestDigest,
    },
    sourceDiff,
    historicalCases,
    review: {
      sourceLicenseReviewRequired: true as const,
      sourceDriftReviewRequired: true as const,
      selectorRevalidationRequired: true as const,
      leakageReviewRequired: true as const,
      goldLabelUpdateRequired: true as const,
      humanGoldScoringEligible: false as const,
      humanApprovalGranted: false as const,
      frozenSuccessorDatasetCreated: false as const,
    },
  };
  return deepFreeze({ ...material, proposalDigest: digestCanonicalJson(material) });
}
