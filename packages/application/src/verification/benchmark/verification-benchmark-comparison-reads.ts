import { z } from "zod";
import {
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationBenchmarkComparisonPublicationSchema,
  VerificationBenchmarkComparisonResourceSchema,
  VerificationBenchmarkComparisonMetricResourceSchema,
  VerificationBenchmarkEngineeringMetricSchema,
  type VerificationArtifactHandle,
  type VerificationBenchmarkComparisonPublication,
  type VerificationBenchmarkComparisonResource,
} from "@aiengineer/knowledge-contracts";
const metric = VerificationBenchmarkComparisonMetricResourceSchema.shape;
const rawMetric = z.object({
  denominator: metric.denominator,
  baseline: z.object(metric.baseline.shape),
  candidate: z.object(metric.candidate.shape),
  delta: metric.delta,
  regressionObservation: metric.regressionObservation,
  clusterBootstrap: metric.clusterBootstrap,
  mcnemar: z.object({ pValue: metric.mcnemarPValue }),
  pairedClusterSignFlip: z.object({ pValue: metric.clusterSignFlipPValue }),
});
const rawResult = z.object({
  pairComparisons: z
    .array(
      z.object({
        pairId: z.string(),
        comparison: z.object({
          pairing: z.object({
            caseCount: z.int().positive(),
            clusterCount: z.int().positive(),
            clusterUnit: z.enum(["source_family", "report_cluster"]),
            clusterIndependenceAssessed: z.literal(false),
            repetitionCount: z.literal(1),
          }),
          metrics: z.record(VerificationBenchmarkEngineeringMetricSchema, rawMetric),
        }),
      }),
    )
    .min(1)
    .max(16),
  globalInference: z.object(VerificationBenchmarkComparisonResourceSchema.shape.globalInference.shape),
});
export interface VerifiedBenchmarkComparisonReadSnapshot {
  readonly publicationArtifact: VerificationArtifactHandle;
  readonly manifest: VerificationBenchmarkComparisonPublication;
  readonly result: unknown;
  readonly signatureStatus: "verified";
}
export interface VerifiedBenchmarkComparisonReadPort {
  loadVerifiedBenchmarkComparison(
    tenantId: string,
    comparisonId: string,
  ): Promise<VerifiedBenchmarkComparisonReadSnapshot>;
}
export class VerificationBenchmarkComparisonReadError extends Error {
  constructor(readonly code: "INVALID" | "NOT_FOUND" | "INTEGRITY") {
    super(`VERIFICATION_BENCHMARK_COMPARISON_READ_${code}`);
  }
}
/** Projects authenticated statistical results without Storage object paths or key material. */
export class VerificationBenchmarkComparisonReadService {
  constructor(private readonly publications: VerifiedBenchmarkComparisonReadPort) {}
  async getComparison(input: {
    tenantId: unknown;
    comparisonId: unknown;
  }): Promise<VerificationBenchmarkComparisonResource> {
    const tenant = UuidSchema.safeParse(input.tenantId),
      id = UuidSchema.safeParse(input.comparisonId);
    if (!tenant.success || !id.success) throw new VerificationBenchmarkComparisonReadError("INVALID");
    const snapshot = await this.publications.loadVerifiedBenchmarkComparison(tenant.data, id.data);
    try {
      const manifest = VerificationBenchmarkComparisonPublicationSchema.parse(snapshot.manifest),
        publication = VerificationArtifactHandleSchema.parse(snapshot.publicationArtifact),
        result = rawResult.parse(snapshot.result);
      if (
        snapshot.signatureStatus !== "verified" ||
        !manifest.seal.signature ||
        manifest.tenantId !== tenant.data ||
        manifest.comparisonId !== id.data ||
        publication.tenantId !== tenant.data
      )
        throw new Error("BINDING");
      const reference = (handle: VerificationArtifactHandle) => ({
        artifactId: handle.artifactId,
        digest: handle.digest,
      });
      return VerificationBenchmarkComparisonResourceSchema.parse({
        verificationContractVersion: "verification.v1",
        tenantId: tenant.data,
        comparisonId: id.data,
        operationId: manifest.operationId,
        baselineRunId: manifest.baseline.runId,
        candidateRunId: manifest.candidate.runId,
        profile: { profileId: manifest.profile.profileId, artifact: reference(manifest.profile.artifact) },
        publication: {
          artifact: reference(publication),
          payloadDigest: manifest.seal.payloadDigest,
          signatureStatus: "verified",
        },
        result: { artifact: reference(manifest.result.artifact), resultDigest: manifest.result.resultDigest },
        startedAt: manifest.startedAt,
        completedAt: manifest.completedAt,
        engineeringGateOutcome: manifest.engineeringGateOutcome,
        qualityClaims: manifest.qualityClaims,
        statisticalScope: "paired_engineering_observations_without_assessed_cluster_independence",
        pairs: result.pairComparisons.map((pair) => ({
          pairId: pair.pairId,
          caseCount: pair.comparison.pairing.caseCount,
          clusterCount: pair.comparison.pairing.clusterCount,
          clusterUnit: pair.comparison.pairing.clusterUnit,
          metrics: VerificationBenchmarkEngineeringMetricSchema.options.map((name) => {
            const { mcnemar, pairedClusterSignFlip, ...values } = pair.comparison.metrics[name];
            return {
              metric: name,
              ...values,
              mcnemarPValue: mcnemar.pValue,
              clusterSignFlipPValue: pairedClusterSignFlip.pValue,
            };
          }),
        })),
        globalInference: result.globalInference,
      });
    } catch {
      throw new VerificationBenchmarkComparisonReadError("INTEGRITY");
    }
  }
}
