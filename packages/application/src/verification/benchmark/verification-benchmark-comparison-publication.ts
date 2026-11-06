import {
  CompareBenchmarkRunsRequestSchema,
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationBenchmarkComparisonPublicationSchema,
  type VerificationArtifactHandle,
  type VerificationBenchmarkComparisonPublication,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  sealVerificationBenchmarkComparisonPublication,
  type AuditBundleSigner,
} from "@aiengineer/knowledge-verification";
import {
  assertPreparedVerificationBenchmarkComparison,
  type PreparedVerificationBenchmarkComparison,
} from "./verification-benchmark-comparison.js";
import type { BenchmarkPublicationArtifactPort } from "./verification-benchmark-publication.js";

/** Retains a branded comparison result, then signs its durable completed lifecycle. */
export class RegisteredBenchmarkComparisonPublicationBuilder {
  constructor(
    private readonly ports: {
      readonly artifacts: BenchmarkPublicationArtifactPort;
      readonly signer: AuditBundleSigner;
    },
  ) {}

  async retainResult(input: {
    tenantId: string;
    request: unknown;
    prepared: PreparedVerificationBenchmarkComparison;
    attemptId: string;
    createdAt: string;
    signal?: AbortSignal;
  }) {
    const tenantId = UuidSchema.parse(input.tenantId),
      attemptId = UuidSchema.parse(input.attemptId);
    assertPreparedVerificationBenchmarkComparison(input.prepared, { tenantId, request: input.request });
    const prepared = input.prepared,
      createdAt = VerificationBenchmarkComparisonPublicationSchema.shape.startedAt.parse(input.createdAt);
    const resultArtifact = await this.#retain({
      tenantId,
      attemptId,
      createdAt,
      artifactType: "verification_benchmark_comparison_result",
      value: prepared.result,
      parents: resultParents(prepared),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return deepFreeze({
      resultArtifact,
      resultDigest: prepared.result.resultDigest,
      engineeringGateOutcome: prepared.result.engineeringRegressionGate.outcome,
    });
  }

  async publish(input: {
    tenantId: string;
    operationId: string;
    comparisonId: string;
    request: unknown;
    prepared: PreparedVerificationBenchmarkComparison;
    runtime: VerificationBenchmarkComparisonPublication["runtime"];
    startedAt: string;
    completedAt: string;
    resultArtifact: VerificationArtifactHandle;
    resultDigest: string;
    engineeringGateOutcome: "not_requested" | "pass" | "fail";
    signal?: AbortSignal;
  }) {
    const tenantId = UuidSchema.parse(input.tenantId),
      operationId = UuidSchema.parse(input.operationId),
      comparisonId = UuidSchema.parse(input.comparisonId),
      request = CompareBenchmarkRunsRequestSchema.parse(input.request);
    assertPreparedVerificationBenchmarkComparison(input.prepared, { tenantId, request });
    const prepared = input.prepared,
      runtime = deepFreeze(VerificationBenchmarkComparisonPublicationSchema.shape.runtime.parse(input.runtime)),
      resultArtifact = deepFreeze(VerificationArtifactHandleSchema.parse(input.resultArtifact));
    const startedAt = VerificationBenchmarkComparisonPublicationSchema.shape.startedAt.parse(input.startedAt),
      completedAt = VerificationBenchmarkComparisonPublicationSchema.shape.completedAt.parse(input.completedAt);
    const bytes = new TextEncoder().encode(canonicalizeJson(prepared.result)),
      parents = resultParents(prepared);
    if (
      input.resultDigest !== prepared.result.resultDigest ||
      input.engineeringGateOutcome !== prepared.result.engineeringRegressionGate.outcome ||
      resultArtifact.tenantId !== tenantId ||
      resultArtifact.digest !== sha256Digest(bytes) ||
      resultArtifact.byteLength !== bytes.byteLength ||
      canonicalizeJson(resultArtifact.parentArtifactIds) !== canonicalizeJson(parents) ||
      resultArtifact.transformationSignature !==
        signature("verification_benchmark_comparison_result", bytes, parents, prepared.result.resultDigest)
    )
      throw new Error("BENCHMARK_COMPARISON_PUBLICATION_RESULT_BINDING_INVALID");
    active(input.signal);
    const side = (value: PreparedVerificationBenchmarkComparison["input"]["baseline"]) => ({
      runId: value.run.runId,
      publicationArtifact: value.publication.publicationArtifact,
      payloadDigest: value.publication.manifest.seal.payloadDigest,
    });
    const manifest = await sealVerificationBenchmarkComparisonPublication(
      {
        schemaVersion: "verification-benchmark-comparison-publication.v1",
        verificationContractVersion: "verification.v1",
        tenantId,
        operationId,
        comparisonId,
        requestDigest: digestCanonicalJson(request),
        baseline: side(prepared.input.baseline),
        candidate: side(prepared.input.candidate),
        profile: { profileId: prepared.input.profile.profileId, artifact: prepared.input.profileArtifact },
        result: { artifact: resultArtifact, resultDigest: prepared.result.resultDigest },
        engineeringGateOutcome: prepared.result.engineeringRegressionGate.outcome,
        interpretation: "observed_engineering_threshold_only",
        runtime,
        execution: { mode: "offline_recorded", externalProviderRequests: 0 },
        qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
        startedAt,
        completedAt,
      },
      this.ports.signer,
    );
    active(input.signal);
    const publicationArtifact = await this.#retain({
      tenantId,
      attemptId: runtime.attemptId,
      createdAt: completedAt,
      artifactType: "verification_benchmark_comparison_publication",
      value: manifest,
      parents: [
        ...parents,
        resultArtifact.artifactId,
        ...(runtime.dirtyStateArtifact ? [runtime.dirtyStateArtifact.artifactId] : []),
      ],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return deepFreeze({ manifest, publicationArtifact, publicationPayloadDigest: manifest.seal.payloadDigest });
  }

  async #retain(input: {
    tenantId: string;
    attemptId: string;
    createdAt: string;
    artifactType: string;
    value: unknown;
    parents: readonly string[];
    signal?: AbortSignal;
  }) {
    active(input.signal);
    const bytes = new TextEncoder().encode(canonicalizeJson(input.value)),
      parentArtifactIds = [...new Set(input.parents)],
      transformationSignature =
        input.artifactType === "verification_benchmark_comparison_result"
          ? signature(
              input.artifactType,
              bytes,
              parentArtifactIds,
              (input.value as { resultDigest: string }).resultDigest,
            )
          : publicationSignature(input.value as VerificationBenchmarkComparisonPublication, bytes, parentArtifactIds);
    const artifact = VerificationArtifactHandleSchema.parse(
      await this.ports.artifacts.register({
        tenantId: input.tenantId,
        producerAttemptId: input.attemptId,
        createdAt: input.createdAt,
        artifactType: input.artifactType,
        bytes,
        parentArtifactIds,
        transformationSignature,
      }),
    );
    active(input.signal);
    if (
      artifact.tenantId !== input.tenantId ||
      artifact.digest !== sha256Digest(bytes) ||
      artifact.byteLength !== bytes.byteLength ||
      canonicalizeJson(artifact.parentArtifactIds) !== canonicalizeJson(parentArtifactIds) ||
      artifact.transformationSignature !== transformationSignature
    )
      throw new Error("BENCHMARK_COMPARISON_REGISTERED_ARTIFACT_MISMATCH");
    return deepFreeze(artifact);
  }
}
function resultParents(prepared: PreparedVerificationBenchmarkComparison): string[] {
  return [
    ...new Set([
      prepared.input.profileArtifact.artifactId,
      prepared.input.baseline.publication.publicationArtifact.artifactId,
      prepared.input.candidate.publication.publicationArtifact.artifactId,
    ]),
  ];
}
function signature(
  artifactType: string,
  bytes: Uint8Array,
  parentArtifactIds: readonly string[],
  semanticDigest: string,
  binding: readonly string[] = [],
) {
  return sha256Digest(
    new TextEncoder().encode(
      [
        "verification-benchmark-comparison-artifact.v2",
        artifactType,
        sha256Digest(bytes),
        ...parentArtifactIds,
        semanticDigest,
        ...binding,
      ].join("|"),
    ),
  );
}
function publicationSignature(
  value: VerificationBenchmarkComparisonPublication,
  bytes: Uint8Array,
  parents: readonly string[],
) {
  return signature("verification_benchmark_comparison_publication", bytes, parents, value.seal.payloadDigest, [
    value.tenantId,
    value.operationId,
    value.comparisonId,
    value.baseline.runId,
    value.baseline.payloadDigest,
    value.candidate.runId,
    value.candidate.payloadDigest,
    value.profile.profileId,
    digestCanonicalJson(value.runtime),
    value.startedAt,
    value.completedAt,
    value.result.resultDigest,
    value.engineeringGateOutcome,
  ]);
}
function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
}
