import {
  VerificationBenchmarkComparisonPublicationSchema,
  type VerificationBenchmarkComparisonPublication,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "../internal/deep-freeze.js";
import {
  sealDetachedManifest,
  verifyDetachedManifest,
  type DetachedSealBody,
  type DetachedSealErrorCodes,
} from "./detached-seal.js";
import type { AuditBundleSigner, AuditBundleSignatureVerifier } from "./model.js";

const codes: DetachedSealErrorCodes = {
  digestMismatch: "BENCHMARK_COMPARISON_PUBLICATION_DIGEST_MISMATCH",
  signatureRequired: "BENCHMARK_COMPARISON_PUBLICATION_SIGNATURE_REQUIRED",
  verifierRequired: "BENCHMARK_COMPARISON_PUBLICATION_SIGNATURE_VERIFIER_REQUIRED",
  signatureInvalid: "BENCHMARK_COMPARISON_PUBLICATION_SIGNATURE_INVALID",
};

/** Comparison publications are always signed; there is no unsigned form. */
export function sealVerificationBenchmarkComparisonPublication(
  body: DetachedSealBody<VerificationBenchmarkComparisonPublication>,
  signer: AuditBundleSigner,
): Promise<VerificationBenchmarkComparisonPublication> {
  return sealDetachedManifest(VerificationBenchmarkComparisonPublicationSchema, body, signer);
}

export async function verifyVerificationBenchmarkComparisonPublication(
  value: unknown,
  verifier: AuditBundleSignatureVerifier,
): Promise<{
  readonly manifest: VerificationBenchmarkComparisonPublication;
  readonly signatureStatus: "verified";
}> {
  const { manifest } = await verifyDetachedManifest(VerificationBenchmarkComparisonPublicationSchema, value, {
    verifier,
    requireSignature: true,
    codes,
  });
  return deepFreeze({ manifest, signatureStatus: "verified" as const });
}
