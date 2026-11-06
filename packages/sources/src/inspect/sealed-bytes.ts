import { digestBytes } from "@aiengineer/knowledge-core";

export function sealedCaptureDigestMatches(bytes: Uint8Array, digest: string): boolean {
  return digestBytes(bytes) === digest;
}

export function assertSealedCaptureDigest(bytes: Uint8Array, digest: string): void {
  if (!sealedCaptureDigestMatches(bytes, digest)) throw new Error("CAPTURE_DIGEST_MISMATCH");
}
