import { sha256Digest, toPrototypeSha256 } from "../canonical/index.js";

/** Bare-hex SHA-256 over UTF-8 text, the digest form persisted by the prototype. */
export function prototypeSha256(value: string): string {
  return toPrototypeSha256(sha256Digest(value));
}
