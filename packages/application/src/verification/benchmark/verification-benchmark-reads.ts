import {
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationBenchmarkPublicationManifestSchema,
  VerificationBenchmarkRunManifestResourceSchema,
  VerificationBenchmarkRunSummaryResourceSchema,
  type VerificationArtifactHandle,
  type VerificationBenchmarkPublicationManifest,
  type VerificationBenchmarkRunManifestResource,
  type VerificationBenchmarkRunSummaryResource,
} from "@aiengineer/knowledge-contracts";
import { z } from "zod";

const ReadRequestSchema = z.strictObject({ tenantId: UuidSchema, runId: UuidSchema });

export interface VerifiedBenchmarkPublicationReadSnapshot {
  readonly publicationArtifact: VerificationArtifactHandle;
  readonly manifest: VerificationBenchmarkPublicationManifest;
  readonly signatureStatus: "verified";
}

/** Repository boundary: authorization, terminal-operation, receipt, DB, artifact and signature checks precede this projection. */
export interface VerifiedBenchmarkPublicationReadPort {
  loadVerifiedBenchmarkPublication(tenantId: string, runId: string): Promise<VerifiedBenchmarkPublicationReadSnapshot>;
}

export type VerificationBenchmarkReadErrorCode = "INVALID" | "NOT_FOUND" | "INTEGRITY";
export class VerificationBenchmarkReadError extends Error {
  constructor(readonly code: VerificationBenchmarkReadErrorCode) {
    super(`VERIFICATION_BENCHMARK_READ_${code}`);
    this.name = "VerificationBenchmarkReadError";
  }
}

const compact = (handle: VerificationArtifactHandle) => {
  const parsed = VerificationArtifactHandleSchema.parse(handle);
  return {
    artifactId: parsed.artifactId,
    digest: parsed.digest,
    mediaType: parsed.mediaType,
    sizeBytes: parsed.byteLength,
  };
};

function parsedSnapshot(value: VerifiedBenchmarkPublicationReadSnapshot, request: z.infer<typeof ReadRequestSchema>) {
  const manifest = VerificationBenchmarkPublicationManifestSchema.parse(value.manifest);
  const publicationArtifact = VerificationArtifactHandleSchema.parse(value.publicationArtifact);
  if (
    value.signatureStatus !== "verified" ||
    manifest.tenantId !== request.tenantId ||
    manifest.runId !== request.runId ||
    publicationArtifact.tenantId !== request.tenantId ||
    manifest.seal.signature === undefined ||
    manifest.dataset.artifact.tenantId !== request.tenantId ||
    manifest.experiment.artifact.tenantId !== request.tenantId
  )
    throw new VerificationBenchmarkReadError("INTEGRITY");
  return { manifest, publicationArtifact };
}

function core(value: ReturnType<typeof parsedSnapshot>) {
  const { manifest, publicationArtifact } = value;
  return {
    verificationContractVersion: manifest.verificationContractVersion,
    tenantId: manifest.tenantId,
    runId: manifest.runId,
    operationId: manifest.operationId,
    publication: {
      artifact: compact(publicationArtifact),
      payloadDigest: manifest.seal.payloadDigest,
      signatureStatus: "verified" as const,
    },
    dataset: {
      artifact: compact(manifest.dataset.artifact),
      datasetId: manifest.dataset.datasetId,
      datasetVersionId: manifest.dataset.datasetVersionId,
      version: manifest.dataset.version,
      caseCount: manifest.dataset.caseCount,
      manifestDigest: manifest.dataset.manifestDigest,
      labelProvenance: manifest.dataset.labelProvenance,
    },
    experiment: {
      artifact: compact(manifest.experiment.artifact),
      experimentId: manifest.experiment.experimentId,
      runnerVersion: manifest.experiment.runnerVersion,
      randomSeed: manifest.experiment.randomSeed,
      repetitions: manifest.experiment.repetitions,
    },
    lifecycle: { startedAt: manifest.startedAt, completedAt: manifest.completedAt },
    qualityClaims: manifest.qualityClaims,
    arms: manifest.arms.map((arm) => ({
      armId: arm.armId,
      experimentArmId: arm.experimentArmId,
      evalRunId: arm.evalRunId,
      isControl: arm.isControl,
      terminalStatus: arm.terminalStatus,
      summaryDigest: arm.summaryDigest,
    })),
  };
}

/** Application projection for a signed, completed, fully mapped offline benchmark. */
export class VerificationBenchmarkReadService {
  constructor(private readonly repository: VerifiedBenchmarkPublicationReadPort) {}

  async getRun(input: unknown): Promise<VerificationBenchmarkRunSummaryResource> {
    const request = this.#request(input);
    try {
      return VerificationBenchmarkRunSummaryResourceSchema.parse(
        core(parsedSnapshot(await this.#load(request), request)),
      );
    } catch (error) {
      if (error instanceof VerificationBenchmarkReadError) throw error;
      throw new VerificationBenchmarkReadError("INTEGRITY");
    }
  }

  async getManifest(input: unknown): Promise<VerificationBenchmarkRunManifestResource> {
    const request = this.#request(input);
    try {
      const snapshot = parsedSnapshot(await this.#load(request), request),
        value = core(snapshot),
        { manifest } = snapshot;
      return VerificationBenchmarkRunManifestResourceSchema.parse({
        ...value,
        runtime: {
          deploymentId: manifest.runtime.deploymentId,
          attemptId: manifest.runtime.attemptId,
          capabilityVersion: manifest.runtime.capabilityVersion,
          targetCodeRef: manifest.runtime.targetCodeRef,
          gitSha: manifest.runtime.gitSha,
          dirty: manifest.runtime.dirty,
        },
        execution: manifest.execution,
        runnerManifestDigest: manifest.runnerManifestDigest,
        checkpointPlanDigest: manifest.checkpointPlanDigest,
        arms: value.arms.map((arm, index) => ({
          ...arm,
          configurationArtifact: compact(manifest.arms[index]!.configurationArtifact),
          policyArtifact: compact(manifest.arms[index]!.policyArtifact),
        })),
      });
    } catch (error) {
      if (error instanceof VerificationBenchmarkReadError) throw error;
      throw new VerificationBenchmarkReadError("INTEGRITY");
    }
  }

  #request(input: unknown) {
    const parsed = ReadRequestSchema.safeParse(input);
    if (!parsed.success) throw new VerificationBenchmarkReadError("INVALID");
    return parsed.data;
  }

  async #load(request: z.infer<typeof ReadRequestSchema>) {
    try {
      return await this.repository.loadVerifiedBenchmarkPublication(request.tenantId, request.runId);
    } catch (error) {
      if (error instanceof Error && error.message === "VERIFICATION_BENCHMARK_RUN_NOT_FOUND")
        throw new VerificationBenchmarkReadError("NOT_FOUND");
      throw error;
    }
  }
}
