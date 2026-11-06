import { z } from "zod";
import { CANONICALIZATION, digestBytes, digestCanonical } from "./canonical.js";
import type { Digest } from "./canonical.js";
import { type Origin, OriginSchema, originDigest, originIdentity } from "./origin.js";
import { DigestSchema, IdSchema, SafeIntSchema } from "./primitives.js";

/**
 * Effect identity (design §5, preserving OC-D85). Six independent identities:
 *  - `effectKey`: host-minted opaque id, scoped by issuer/application/tenant; stable for one logical effect.
 *  - `semanticPayloadDigest`: diagnostic digest of the exact business input; never sufficient for deduplication.
 *  - `originatingOrigin`: the admitted original invocation, inside the immutable native bytes.
 *  - `boundEffectDigest`: canonical digest over the native payload digest and the originating origin identity.
 *  - `currentCallerOrigin`: the host-authenticated invocation of this dispatch.
 *  - `dispatchId` and `envelopeDigest`: this authorized transmission; credential bytes are never part of either.
 */
export const EffectBindingSchema = z.strictObject({
  effectKey: IdSchema,
  semanticPayloadDigest: DigestSchema,
  originatingOrigin: OriginSchema,
  boundEffectDigest: DigestSchema,
  canonicalization: z.literal(CANONICALIZATION),
});
export type EffectBinding = z.infer<typeof EffectBindingSchema>;

export const EffectIdentitySchema = EffectBindingSchema.extend({
  currentCallerOrigin: OriginSchema,
  dispatchId: IdSchema,
  envelopeDigest: DigestSchema,
  /** Monotonic per effect key: 1 for the initial dispatch, +1 per retry or recovery transmission. */
  dispatchSequence: SafeIntSchema.min(1),
});
export type EffectIdentity = z.infer<typeof EffectIdentitySchema>;

/** What the digest binds: exact native bytes and the originating origin's identity, nothing else. */
export function boundEffectDigest(nativePayload: Uint8Array | string, originatingOrigin: Origin): Digest {
  return digestCanonical({
    canonicalization: CANONICALIZATION,
    payloadDigest: digestBytes(nativePayload),
    originatingOrigin: originIdentity(originatingOrigin),
  });
}

/** Bind a logical effect once, at admission of the original invocation. */
export function bindEffect(input: {
  effectKey: string;
  nativePayload: Uint8Array | string;
  originatingOrigin: Origin;
}): EffectBinding {
  return EffectBindingSchema.parse({
    effectKey: input.effectKey,
    semanticPayloadDigest: digestBytes(input.nativePayload),
    originatingOrigin: input.originatingOrigin,
    boundEffectDigest: boundEffectDigest(input.nativePayload, input.originatingOrigin),
    canonicalization: CANONICALIZATION,
  });
}

export type DispatchAdmission =
  | { readonly admitted: true; readonly mode: "initial" | "retry" | "recovery" }
  | {
      readonly admitted: false;
      readonly code: "EFFECT_CONFLICT" | "ORIGIN_MISMATCH" | "SCOPE_DENIED";
      readonly reason: string;
    };

/** The recovery claim shape (`credential-claims.v2` `recovery`); structural so this module stays import-acyclic. */
export interface DispatchRecoveryClaim {
  readonly scope: "read_only" | "effect";
  readonly authorityRef: string;
  readonly effectKey: string | null;
  readonly boundEffectDigest: string | null;
}

/**
 * Admission of a dispatch for an already-bound effect:
 *  - initial dispatch: caller must equal the originating origin;
 *  - retry: identical native bytes (same bound digest) and the same originating identity, fresh credential;
 *  - different caller (a new attempt, the `current_caller_origin`): only with an `effect`-scoped recovery claim naming
 *    this exact effect key and bound digest, presented by a live invocation; a read-only recovery, a `recovery` origin
 *    or the same tenant is insufficient (Checkpoint A decision, SPRINT-V-DESIGN §10.1);
 *  - same key, different digest: refused (`EFFECT_CONFLICT`); edited proposals mint a new key with explicit lineage.
 * K07 (the executor) additionally verifies that the issuer really scoped the authority to that key/digest.
 */
export function admitDispatch(input: {
  existing: EffectBinding | null;
  incoming: EffectBinding;
  caller: Origin;
  recovery?: DispatchRecoveryClaim | null;
}): DispatchAdmission {
  const { existing, incoming, caller } = input;
  const recovery = input.recovery ?? null;
  if (
    caller.tenantId !== incoming.originatingOrigin.tenantId ||
    caller.applicationId !== incoming.originatingOrigin.applicationId ||
    caller.installationId !== incoming.originatingOrigin.installationId
  ) {
    return { admitted: false, code: "SCOPE_DENIED", reason: "caller scope differs from the bound effect scope" };
  }
  if (existing !== null) {
    if (existing.effectKey !== incoming.effectKey) {
      return { admitted: false, code: "EFFECT_CONFLICT", reason: "effect key differs from the recorded binding" };
    }
    if (existing.boundEffectDigest !== incoming.boundEffectDigest) {
      return {
        admitted: false,
        code: "EFFECT_CONFLICT",
        reason: "same effect key with different bound bytes; an edited proposal needs a new key and lineage",
      };
    }
    if (originDigest(existing.originatingOrigin) !== originDigest(incoming.originatingOrigin)) {
      return { admitted: false, code: "EFFECT_CONFLICT", reason: "originating origin may not be rewritten on retry" };
    }
  }
  const callerIsOriginator = originDigest(caller) === originDigest(incoming.originatingOrigin);
  if (callerIsOriginator) return { admitted: true, mode: existing === null ? "initial" : "retry" };
  if (
    recovery !== null &&
    recovery.scope === "effect" &&
    (caller.kind === "mission_invocation" || caller.kind === "durable_worker") &&
    recovery.effectKey === incoming.effectKey &&
    recovery.boundEffectDigest === incoming.boundEffectDigest
  ) {
    return { admitted: true, mode: "recovery" };
  }
  return {
    admitted: false,
    code: "ORIGIN_MISMATCH",
    reason: "a different caller requires effect-scoped host recovery authority for this exact effect key and digest",
  };
}
