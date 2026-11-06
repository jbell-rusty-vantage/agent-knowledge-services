import { createHash } from "node:crypto";
import {
  JsonValueSchema,
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationBenchmarkComparisonProfileSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import {
  VerificationBenchmarkComparisonReadError,
  type VerifiedBenchmarkComparisonReadPort,
  type VerifiedBenchmarkComparisonReadSnapshot,
} from "@aiengineer/knowledge-application";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  digestCanonicalJson,
  verifyVerificationBenchmarkComparisonPublication,
  type AuditBundleSignatureVerifier,
} from "@aiengineer/knowledge-verification";
import type { PostgresCanonicalRepository } from "./postgres.js";
import type { PostgresVerificationRepository } from "./verification.js";

/** Visibility requires canonical success; signed bytes must match every durable binding. */
export class PostgresVerificationBenchmarkComparisonReadRepository implements VerifiedBenchmarkComparisonReadPort {
  constructor(
    private readonly database: Pick<PostgresCanonicalRepository, "transaction">,
    private readonly artifacts: Pick<PostgresVerificationRepository, "createTrustedArtifactResolver">,
    private readonly options: { verifier: AuditBundleSignatureVerifier },
  ) {}
  async loadVerifiedBenchmarkComparison(
    tenantId: string,
    comparisonId: string,
  ): Promise<VerifiedBenchmarkComparisonReadSnapshot> {
    if (!UuidSchema.safeParse(tenantId).success || !UuidSchema.safeParse(comparisonId).success)
      throw new VerificationBenchmarkComparisonReadError("INVALID");
    const row = await this.database.transaction(
      tenantId,
      async (client) =>
        (
          await client.query<Record<string, unknown>>(
            `select c.*,o.attempt_id operation_attempt_id,
      orchestration.verification_artifact_is_admitted(c.tenant_id,c.publication_artifact_id,'verification_benchmark_comparison_publication',c.publication_sha256) publication_admitted,
      orchestration.verification_artifact_is_admitted(c.tenant_id,c.result_artifact_id,'verification_benchmark_comparison_result',c.result_sha256) result_admitted,
      orchestration.verification_artifact_is_admitted(c.tenant_id,c.profile_artifact_id,'verification_benchmark_comparison_profile',c.profile_sha256) profile_admitted
      from evaluation.verification_benchmark_comparison c join knowledge_service.operation o on o.tenant_id=c.tenant_id and o.id=c.operation_id
      where c.tenant_id=$1 and c.id=$2 and c.status='sealed' and o.status='succeeded' and o.operation_kind='verification_benchmark_compare'`,
            [tenantId, comparisonId],
          )
        ).rows[0],
    );
    if (!row) throw new VerificationBenchmarkComparisonReadError("NOT_FOUND");
    try {
      if (row.publication_admitted !== true || row.result_admitted !== true || row.profile_admitted !== true)
        throw new Error("ARTIFACT_ADMISSION");
      const publication = await this.#hydrate(
        tenantId,
        String(row.publication_artifact_id),
        `sha256:${row.publication_sha256}`,
      );
      const verified = await verifyVerificationBenchmarkComparisonPublication(publication.value, this.options.verifier),
        manifest = verified.manifest;
      const requestDigest = digestCanonicalJson({
        verificationContractVersion: "verification.v1",
        baselineRunId: row.baseline_run_id,
        candidateRunId: row.candidate_run_id,
        comparisonProfile: row.profile_id,
      });
      const time = (value: unknown) => new Date(value as Date | string).toISOString();
      if (
        manifest.tenantId !== tenantId ||
        manifest.comparisonId !== comparisonId ||
        manifest.operationId !== row.operation_id ||
        manifest.requestDigest !== requestDigest ||
        manifest.baseline.runId !== row.baseline_run_id ||
        manifest.candidate.runId !== row.candidate_run_id ||
        manifest.baseline.publicationArtifact.artifactId !== row.baseline_publication_artifact_id ||
        manifest.baseline.publicationArtifact.digest !== `sha256:${row.baseline_publication_sha256}` ||
        manifest.baseline.payloadDigest !== `sha256:${row.baseline_payload_sha256}` ||
        manifest.candidate.publicationArtifact.artifactId !== row.candidate_publication_artifact_id ||
        manifest.candidate.publicationArtifact.digest !== `sha256:${row.candidate_publication_sha256}` ||
        manifest.candidate.payloadDigest !== `sha256:${row.candidate_payload_sha256}` ||
        manifest.profile.profileId !== row.profile_id ||
        manifest.profile.artifact.artifactId !== row.profile_artifact_id ||
        manifest.profile.artifact.digest !== `sha256:${row.profile_sha256}` ||
        manifest.result.artifact.artifactId !== row.result_artifact_id ||
        manifest.result.artifact.digest !== `sha256:${row.result_sha256}` ||
        manifest.result.resultDigest !== `sha256:${row.result_digest_sha256}` ||
        manifest.seal.payloadDigest !== `sha256:${row.publication_payload_sha256}` ||
        manifest.engineeringGateOutcome !== row.engineering_gate_outcome ||
        manifest.runtime.attemptId !== row.operation_attempt_id ||
        digestCanonicalJson(manifest.runtime) !== `sha256:${row.runtime_sha256}` ||
        canonicalizeJson(manifest.runtime) !== canonicalizeJson(row.runtime) ||
        manifest.startedAt !== time(row.started_at) ||
        manifest.completedAt !== time(row.completed_at)
      )
        throw new Error("PUBLICATION_BINDING");
      const receipts = await this.database.transaction(
        tenantId,
        async (client) =>
          (
            await client.query<{ body: unknown }>(
              `select r.body from knowledge_service.receipt r join knowledge_service.operation_step s on s.tenant_id=r.tenant_id and s.id=r.step_id and s.operation_id=r.operation_id where r.tenant_id=$1 and r.operation_id=$2 and r.outcome='succeeded' and r.receipt_kind='compare_registered_and_publish.succeeded' and s.status='succeeded' and s.step_key='compare_registered_and_publish'`,
              [tenantId, row.operation_id],
            )
          ).rows,
      );
      if (receipts.length !== 1) throw new Error("RECEIPT_COUNT");
      const receipt = object(receipts[0]!.body),
        output = object(receipt.output);
      if (
        receipt.schemaVersion !== "verification-operation-result.v1" ||
        receipt.operationId !== row.operation_id ||
        receipt.useCase !== "compareBenchmarkRuns" ||
        output.comparisonId !== comparisonId ||
        output.baselineRunId !== manifest.baseline.runId ||
        output.candidateRunId !== manifest.candidate.runId ||
        output.resultDigest !== manifest.result.resultDigest ||
        output.manifestDigest !== manifest.seal.payloadDigest ||
        output.engineeringGateOutcome !== manifest.engineeringGateOutcome ||
        canonicalizeJson(output.qualityClaims) !== canonicalizeJson(manifest.qualityClaims) ||
        canonicalizeJson(receipt.resultArtifact) !== canonicalizeJson(publication.artifact)
      )
        throw new Error("RECEIPT_BINDING");
      const resultArtifact = await this.#hydrate(
          tenantId,
          manifest.result.artifact.artifactId,
          manifest.result.artifact.digest,
          manifest.result.artifact,
        ),
        result = object(resultArtifact.value),
        { resultDigest, ...material } = result;
      if (
        result.schemaVersion !== "verification-benchmark-comparison-result.v1" ||
        result.verificationContractVersion !== "verification.v1" ||
        result.tenantId !== tenantId ||
        result.requestDigest !== requestDigest ||
        resultDigest !== manifest.result.resultDigest ||
        digestCanonicalJson(material) !== resultDigest
      )
        throw new Error("RESULT_BINDING");
      const resultProfile = object(result.profile),
        gate = object(result.engineeringRegressionGate),
        claims = object(result.claimScope);
      if (
        resultProfile.profileId !== manifest.profile.profileId ||
        canonicalizeJson(resultProfile.artifact) !==
          canonicalizeJson({
            artifactId: manifest.profile.artifact.artifactId,
            digest: manifest.profile.artifact.digest,
          }) ||
        gate.outcome !== manifest.engineeringGateOutcome ||
        gate.interpretation !== "observed_engineering_threshold_only" ||
        [
          "humanGoldQualityClaim",
          "populationInferenceClaim",
          "promotionClaim",
          "calibrationClaim",
          "sourceAuthorityAssessmentClaim",
          "clinicalClaim",
        ].some((key) => claims[key] !== false)
      )
        throw new Error("RESULT_PROFILE_CLAIMS");
      for (const side of ["baseline", "candidate"] as const) {
        const binding = object(result[side]);
        if (
          binding.runId !== manifest[side].runId ||
          binding.publicationPayloadDigest !== manifest[side].payloadDigest ||
          canonicalizeJson(binding.publicationArtifact) !==
            canonicalizeJson({
              artifactId: manifest[side].publicationArtifact.artifactId,
              digest: manifest[side].publicationArtifact.digest,
            })
        )
          throw new Error("RESULT_INPUT_BINDING");
      }
      const profileArtifact = await this.#hydrate(
          tenantId,
          manifest.profile.artifact.artifactId,
          manifest.profile.artifact.digest,
          manifest.profile.artifact,
        ),
        profile = VerificationBenchmarkComparisonProfileSchema.parse(profileArtifact.value);
      if (
        profile.tenantId !== tenantId ||
        profile.profileId !== manifest.profile.profileId ||
        profile.version !== resultProfile.version
      )
        throw new Error("PROFILE_BINDING");
      if (!Array.isArray(result.pairComparisons) || result.pairComparisons.length !== profile.armPairs.length)
        throw new Error("PAIR_COUNT");
      for (const [index, pair] of profile.armPairs.entries()) {
        const retained = object(result.pairComparisons[index]),
          comparison = object(retained.comparison),
          baseline = object(comparison.baseline),
          candidate = object(comparison.candidate);
        if (
          retained.pairId !== pair.pairId ||
          baseline.armId !== pair.baselineArmId ||
          candidate.armId !== pair.candidateArmId ||
          baseline.runId !== manifest.baseline.runId ||
          candidate.runId !== manifest.candidate.runId
        )
          throw new Error("PAIR_BINDING");
      }
      return deepFreeze({
        publicationArtifact: publication.artifact,
        manifest,
        result,
        signatureStatus: "verified" as const,
      });
    } catch (error) {
      if (error instanceof VerificationBenchmarkComparisonReadError) throw error;
      throw new VerificationBenchmarkComparisonReadError("INTEGRITY");
    }
  }
  async #hydrate(tenantId: string, artifactId: string, digest: string, expected?: VerificationArtifactHandle) {
    const resolver = this.artifacts.createTrustedArtifactResolver();
    await resolver.authorizeArtifact({ tenantId, artifactId, purpose: "verification_replay" });
    const loaded = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId }),
      artifact = VerificationArtifactHandleSchema.parse(loaded.registration);
    if (
      loaded.bytes.byteLength > 8 * 1024 * 1024 ||
      artifact.tenantId !== tenantId ||
      artifact.artifactId !== artifactId ||
      artifact.digest !== digest ||
      artifact.byteLength !== loaded.bytes.byteLength ||
      `sha256:${createHash("sha256").update(loaded.bytes).digest("hex")}` !== digest ||
      (expected && canonicalizeJson(artifact) !== canonicalizeJson(expected))
    )
      throw new Error("ARTIFACT_BYTES");
    return {
      artifact,
      value: JsonValueSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(loaded.bytes))),
    };
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OBJECT_REQUIRED");
  return value as Record<string, unknown>;
}
