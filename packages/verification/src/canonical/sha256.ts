import { createHash } from "node:crypto";
import { canonicalizeJson } from "./canonical-json.js";

export type Sha256Digest = `sha256:${string}`;

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** The all-zero digest used as a sentinel where a digest slot must be filled but nothing was hashed. */
export const ZERO_SHA256_DIGEST: Sha256Digest = `sha256:${"0".repeat(64)}`;

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

export function sha256Digest(value: string | Uint8Array): Sha256Digest {
  const hash = createHash("sha256");
  if (typeof value === "string") hash.update(value, "utf8");
  else hash.update(value);
  return `sha256:${hash.digest("hex")}`;
}

export function digestCanonicalJson(value: unknown): Sha256Digest {
  return sha256Digest(canonicalizeJson(value));
}

/** Compatibility boundary for the prototype's unprefixed digest representation. */
export function fromPrototypeSha256(value: string): Sha256Digest {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new TypeError("prototype SHA-256 must be 64 lowercase hexadecimal characters");
  return `sha256:${value}`;
}

export function toPrototypeSha256(value: Sha256Digest): string {
  return value.slice("sha256:".length);
}
