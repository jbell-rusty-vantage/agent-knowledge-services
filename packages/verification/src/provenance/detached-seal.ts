import { canonicalizeJson, digestCanonicalJson } from "../canonical/index.js";
import { ZERO_SHA256_DIGEST } from "../canonical/index.js";
import { deepFreeze } from "../internal/deep-freeze.js";
import type { AuditBundleSigner, AuditBundleSignatureVerifier } from "./model.js";

/** A manifest whose seal (digest plus optional signature) sits beside its body. */
export interface DetachedlySealedManifest {
  readonly seal: {
    readonly payloadDigest: string;
    readonly signature?:
      | {
          readonly algorithm: string;
          readonly keyId: string;
          readonly signatureBase64: string;
        }
      | undefined;
  };
}

export interface ManifestSchema<Manifest> {
  parse(value: unknown): Manifest;
}

export type DetachedSealBody<Manifest> = Omit<Manifest, "seal">;

export interface DetachedSealErrorCodes {
  readonly digestMismatch: string;
  readonly signatureRequired: string;
  readonly verifierRequired: string;
  readonly signatureInvalid: string;
}

export interface DetachedSealVerificationOptions {
  readonly verifier?: AuditBundleSignatureVerifier;
  readonly requireSignature?: boolean;
  readonly codes: DetachedSealErrorCodes;
}

export interface VerifiedDetachedManifest<Manifest> {
  readonly manifest: Manifest;
  readonly signatureStatus: "unsigned" | "verified";
}

/** Signature and payload digest both exclude the detached seal. */
function signable<Manifest extends DetachedlySealedManifest>(manifest: Manifest): DetachedSealBody<Manifest> {
  const { seal: _seal, ...body } = manifest;
  return body;
}

const payloadBytes = (payload: unknown): Uint8Array => new TextEncoder().encode(canonicalizeJson(payload));

/**
 * Parsing snapshots all caller-owned objects before an asynchronous signer, so
 * the signed bytes are exactly the bytes the returned manifest digests.
 */
export async function sealDetachedManifest<Manifest extends DetachedlySealedManifest>(
  schema: ManifestSchema<Manifest>,
  body: DetachedSealBody<Manifest>,
  signer?: AuditBundleSigner,
): Promise<Manifest> {
  const parsed = schema.parse({
    ...body,
    seal: { payloadDigest: ZERO_SHA256_DIGEST },
  });
  const payload = deepFreeze(signable(parsed));
  const seal = {
    payloadDigest: digestCanonicalJson(payload),
    ...(signer
      ? {
          signature: {
            algorithm: signer.algorithm,
            keyId: signer.keyId,
            signatureBase64: await signer.sign(payloadBytes(payload)),
          },
        }
      : {}),
  };
  return deepFreeze(schema.parse({ ...payload, seal }));
}

/** Digest integrity does not imply source quality or a trusted signing identity. */
export async function verifyDetachedManifest<Manifest extends DetachedlySealedManifest>(
  schema: ManifestSchema<Manifest>,
  value: unknown,
  options: DetachedSealVerificationOptions,
): Promise<VerifiedDetachedManifest<Manifest>> {
  const { codes } = options;
  const manifest = deepFreeze(schema.parse(value));
  const payload = signable(manifest);
  if (digestCanonicalJson(payload) !== manifest.seal.payloadDigest) throw new Error(codes.digestMismatch);
  const signature = manifest.seal.signature;
  if (!signature) {
    if (options.requireSignature) throw new Error(codes.signatureRequired);
    return deepFreeze({ manifest, signatureStatus: "unsigned" as const });
  }
  if (!options.verifier) throw new Error(codes.verifierRequired);
  const wellFormed = Buffer.from(signature.signatureBase64, "base64").toString("base64") === signature.signatureBase64;
  const verified =
    wellFormed &&
    (await options.verifier.verify({
      keyId: signature.keyId,
      payload: payloadBytes(payload),
      signatureBase64: signature.signatureBase64,
    }));
  if (!verified) throw new Error(codes.signatureInvalid);
  return deepFreeze({ manifest, signatureStatus: "verified" as const });
}
