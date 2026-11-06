import type { JsonValue } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "./digest.js";
import { DomainInvariantError } from "./errors.js";

export interface IdempotencyIdentity {
  capabilityVersion: string;
  parameterDigest: string;
  inputDigests: readonly string[];
}
export function createIdempotencyKey(identity: IdempotencyIdentity): string {
  return sha256Digest({
    capabilityVersion: identity.capabilityVersion,
    parameterDigest: identity.parameterDigest,
    inputDigests: [...identity.inputDigests],
  } as JsonValue);
}
export function assertIdempotentReplay(
  existingInputDigest: string,
  replayInputDigest: string,
  existingOutputDigest: string,
  replayOutputDigest: string,
): void {
  if (existingInputDigest !== replayInputDigest || existingOutputDigest !== replayOutputDigest)
    throw new DomainInvariantError(
      "IDEMPOTENCY_CONFLICT",
      "An idempotency key cannot identify conflicting inputs or outputs",
    );
}
