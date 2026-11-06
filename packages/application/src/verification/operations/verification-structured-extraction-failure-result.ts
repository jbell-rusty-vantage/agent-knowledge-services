import {
  VerificationArtifactHandleSchema,
  VerificationStructuredExtractionFailureResultSchema,
  VerificationStructuredExtractionFailureSchema,
  type VerificationArtifactHandle,
  type VerificationStructuredExtractionFailure,
  type VerificationStructuredExtractionFailureResult,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type AuditBundleSignatureVerifier,
} from "@aiengineer/knowledge-verification";
import { structuredExtractionProviderCallDigest } from "./verification-structured-extraction-publication.js";
import {
  structuredExtractionFailureParentArtifactIds,
  structuredExtractionFailureTransformationSignature,
} from "./verification-structured-extraction-failure.js";

const encoder = new TextEncoder();

/**
 * Derives the compact failed terminal payload from an already retained,
 * signed captured-provider-failure publication. This authenticated helper
 * does not create receipts or decide retry policy.
 */
export async function createStructuredExtractionFailureOperationResult(input: {
  readonly manifest: VerificationStructuredExtractionFailure;
  readonly artifact: VerificationArtifactHandle;
  readonly verifier: AuditBundleSignatureVerifier;
}): Promise<VerificationStructuredExtractionFailureResult> {
  // Snapshot caller-owned data before the verifier's asynchronous boundary.
  const manifest = deepFreeze(VerificationStructuredExtractionFailureSchema.parse(structuredClone(input.manifest)));
  const artifact = deepFreeze(VerificationArtifactHandleSchema.parse(structuredClone(input.artifact)));
  const { seal, ...body } = manifest;
  const signableBytes = encoder.encode(canonicalizeJson(body));

  if (digestCanonicalJson(body) !== seal.payloadDigest) {
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_RESULT_MANIFEST_DIGEST_INVALID");
  }
  if (
    Buffer.from(seal.signature.signatureBase64, "base64").toString("base64") !== seal.signature.signatureBase64 ||
    Buffer.from(seal.signature.signatureBase64, "base64").byteLength !== 64
  ) {
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_RESULT_SIGNATURE_INVALID");
  }
  if (structuredExtractionProviderCallDigest(manifest.providerCall) !== manifest.providerCallDigest) {
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_RESULT_PROVIDER_CALL_INVALID");
  }

  const manifestBytes = encoder.encode(canonicalizeJson(manifest));
  const parentArtifactIds = structuredExtractionFailureParentArtifactIds(manifest);
  const transformationSignature = structuredExtractionFailureTransformationSignature({
    payloadDigest: sha256Digest(manifestBytes),
    sealPayloadDigest: seal.payloadDigest,
    tenantId: manifest.tenantId,
    operationId: manifest.operationId,
    operationStepId: manifest.operationStepId,
    producerAttemptId: manifest.producerAttemptId,
    executionDigest: manifest.execution.artifact.digest as `sha256:${string}`,
    providerCallDigest: manifest.providerCallDigest as `sha256:${string}`,
    failureCode: manifest.failure.code,
    originalDispatchFencingToken: manifest.response.capture.dispatchFencingToken,
    startedAt: manifest.startedAt,
    retentionStartedAt: manifest.retentionStartedAt,
    completedAt: manifest.completedAt,
    parentArtifactIds,
  });
  if (
    artifact.tenantId !== manifest.tenantId ||
    artifact.digest !== sha256Digest(manifestBytes) ||
    artifact.byteLength !== manifestBytes.byteLength ||
    artifact.createdAt !== manifest.completedAt ||
    !sameOrdered(artifact.parentArtifactIds, parentArtifactIds) ||
    artifact.transformationSignature !== transformationSignature
  ) {
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_RESULT_ARTIFACT_INVALID");
  }

  let verified = false;
  try {
    verified = await input.verifier.verify({
      keyId: seal.signature.keyId,
      payload: signableBytes,
      signatureBase64: seal.signature.signatureBase64,
    });
  } catch {
    verified = false;
  }
  if (!verified) throw new Error("STRUCTURED_EXTRACTION_FAILURE_RESULT_SIGNATURE_INVALID");

  return deepFreeze(
    VerificationStructuredExtractionFailureResultSchema.parse({
      schemaVersion: "verification-operation-result.v1",
      operationId: manifest.operationId,
      useCase: "extractStructuredData",
      requestDigest: manifest.requestDigest,
      output: {
        status: "failed",
        code: manifest.failure.code,
        category: manifest.failure.category,
        automaticRetry: false,
        candidateArtifact: null,
        executionArtifact: artifactReference(manifest.execution.artifact),
        manifestDigest: seal.payloadDigest,
        providerCallDigest: manifest.providerCallDigest,
      },
      resultArtifact: artifact,
    }),
  );
}

function artifactReference(artifact: VerificationArtifactHandle): {
  readonly artifactId: string;
  readonly digest: string;
} {
  return { artifactId: artifact.artifactId, digest: artifact.digest };
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
