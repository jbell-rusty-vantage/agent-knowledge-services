import {
  VerificationBenchmarkPublicationManifestSchema,
  type VerificationBenchmarkPublicationManifest,
} from "@aiengineer/knowledge-contracts";
import {
  sealDetachedManifest,
  verifyDetachedManifest,
  type DetachedSealBody,
  type DetachedSealErrorCodes,
  type VerifiedDetachedManifest,
} from "./detached-seal.js";
import type { AuditBundleSigner, AuditBundleSignatureVerifier } from "./model.js";

const codes: DetachedSealErrorCodes = {
  digestMismatch: "BENCHMARK_PUBLICATION_DIGEST_MISMATCH",
  signatureRequired: "BENCHMARK_PUBLICATION_SIGNATURE_REQUIRED",
  verifierRequired: "BENCHMARK_PUBLICATION_SIGNATURE_VERIFIER_REQUIRED",
  signatureInvalid: "BENCHMARK_PUBLICATION_SIGNATURE_INVALID",
};

export function sealVerificationBenchmarkPublication(
  body: DetachedSealBody<VerificationBenchmarkPublicationManifest>,
  signer?: AuditBundleSigner,
): Promise<VerificationBenchmarkPublicationManifest> {
  return sealDetachedManifest(VerificationBenchmarkPublicationManifestSchema, body, signer);
}

export function verifyVerificationBenchmarkPublication(
  value: unknown,
  options: {
    readonly verifier?: AuditBundleSignatureVerifier;
    readonly requireSignature?: boolean;
  } = {},
): Promise<VerifiedDetachedManifest<VerificationBenchmarkPublicationManifest>> {
  return verifyDetachedManifest(VerificationBenchmarkPublicationManifestSchema, value, { ...options, codes });
}
