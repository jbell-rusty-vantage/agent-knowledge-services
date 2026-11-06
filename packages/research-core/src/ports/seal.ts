import type { Digest } from "@aiengineer/knowledge-operation-protocol";
import type { Seal } from "../records/run.js";

/**
 * K07 sealing ports (design §6). A signer produces the detached Ed25519 seal over `sealSigningBytes`; a verifier holds
 * the pinned public keys by key id. Keys are configuration (key file or environment variable name), never record data,
 * and private key material is never logged, stored with a record or returned.
 */
export interface SealSigner {
  /** The key id the signer signs with; verifiers pin the matching public key under this id. */
  readonly keyId: string;
  sign(manifestDigest: Digest, context: { readonly signer: string; readonly signedAt: string }): Promise<Seal>;
}

export type SealVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "SEAL_INVALID";
      readonly reason: "unknown_key" | "retired_key" | "algorithm" | "digest_mismatch" | "signature";
    };

export interface SealVerifier {
  /** Verify a seal against the digest recomputed from the stored manifest bytes (never the seal's own claim alone). */
  verify(seal: Seal, recomputedManifestDigest: string): SealVerification;
}
