import { describe, expect, it } from "vitest";
import { digestBytes as digestBytesOf } from "./canonical.js";
import { admitDispatch, bindEffect, boundEffectDigest } from "./effect.js";
import { OriginSchema, originDigest } from "./origin.js";
import { PAYLOAD, missionOrigin, recoveryOrigin, retryOrigin } from "./test-support.js";

describe("effect identity (design §5)", () => {
  const origin = missionOrigin();
  const bound = bindEffect({ effectKey: "effect-1", nativePayload: PAYLOAD, originatingOrigin: origin });

  it("binds exact bytes and the originating identity; per-authentication fields do not change the digest", () => {
    const reauthenticated = missionOrigin({ invocationId: "inv-0003", authenticatedAt: "2026-10-24T21:00:00Z" });
    expect(boundEffectDigest(PAYLOAD, reauthenticated)).toBe(bound.boundEffectDigest);
    expect(boundEffectDigest(Buffer.concat([PAYLOAD, Buffer.from(" ")]), origin)).not.toBe(bound.boundEffectDigest);
    expect(originDigest(retryOrigin())).not.toBe(originDigest(origin));
  });

  it("admits the initial dispatch by the originator and a retry with identical bytes", () => {
    expect(admitDispatch({ existing: null, incoming: bound, caller: origin })).toEqual({
      admitted: true,
      mode: "initial",
    });
    expect(admitDispatch({ existing: bound, incoming: bound, caller: origin })).toEqual({
      admitted: true,
      mode: "retry",
    });
  });

  it("refuses the same key with different bytes (EFFECT_CONFLICT)", () => {
    const edited = bindEffect({
      effectKey: "effect-1",
      nativePayload: Buffer.from("different"),
      originatingOrigin: origin,
    });
    const admission = admitDispatch({ existing: bound, incoming: edited, caller: origin });
    expect(admission.admitted).toBe(false);
    if (!admission.admitted) expect(admission.code).toBe("EFFECT_CONFLICT");
  });

  it("refuses a rewritten originating origin on retry", () => {
    const rewritten = bindEffect({ effectKey: "effect-1", nativePayload: PAYLOAD, originatingOrigin: retryOrigin() });
    const admission = admitDispatch({ existing: bound, incoming: rewritten, caller: retryOrigin() });
    expect(admission).toMatchObject({ admitted: false, code: "EFFECT_CONFLICT" });
  });

  it("a different caller needs effect-scoped recovery authority for the exact key/digest; same tenant is insufficient", () => {
    const retryByLaterAttempt = admitDispatch({ existing: bound, incoming: bound, caller: retryOrigin() });
    expect(retryByLaterAttempt).toMatchObject({ admitted: false, code: "ORIGIN_MISMATCH" });
    const grant = {
      scope: "effect" as const,
      authorityRef: "recovery-grant-7",
      effectKey: bound.effectKey,
      boundEffectDigest: bound.boundEffectDigest,
    };
    // The new attempt presents itself as current_caller_origin with the unchanged originating origin and bytes.
    expect(admitDispatch({ existing: bound, incoming: bound, caller: retryOrigin(), recovery: grant })).toEqual({
      admitted: true,
      mode: "recovery",
    });
    expect(
      admitDispatch({
        existing: bound,
        incoming: bound,
        caller: retryOrigin(),
        recovery: { ...grant, effectKey: "x" },
      }),
    ).toMatchObject({ admitted: false, code: "ORIGIN_MISMATCH" });
    expect(
      admitDispatch({
        existing: bound,
        incoming: bound,
        caller: retryOrigin(),
        recovery: { ...grant, boundEffectDigest: digestBytesOf("other") },
      }),
    ).toMatchObject({ admitted: false, code: "ORIGIN_MISMATCH" });
    // Read-only recovery (and a recovery origin) never dispatches an effect.
    expect(
      admitDispatch({
        existing: bound,
        incoming: bound,
        caller: retryOrigin(),
        recovery: { ...grant, scope: "read_only" },
      }),
    ).toMatchObject({ admitted: false, code: "ORIGIN_MISMATCH" });
    expect(
      admitDispatch({ existing: bound, incoming: bound, caller: recoveryOrigin(), recovery: grant }),
    ).toMatchObject({
      admitted: false,
      code: "ORIGIN_MISMATCH",
    });
    // The grant cannot rewrite the originating origin or the bytes.
    const edited = bindEffect({
      effectKey: "effect-1",
      nativePayload: Buffer.from("edited"),
      originatingOrigin: origin,
    });
    expect(admitDispatch({ existing: bound, incoming: edited, caller: retryOrigin(), recovery: grant })).toMatchObject({
      admitted: false,
      code: "EFFECT_CONFLICT",
    });
    const otherTenant = missionOrigin({ tenantId: "00000000-0000-7000-8000-0000000000bb" });
    expect(admitDispatch({ existing: bound, incoming: bound, caller: otherTenant })).toMatchObject({
      admitted: false,
      code: "SCOPE_DENIED",
    });
  });

  it("rejects template coordinates and recovery origins without authority", () => {
    const template = missionOrigin();
    const templateMission = { ...(template.mission as NonNullable<typeof template.mission>) };
    templateMission.operationId = "manifest-template/research";
    expect(OriginSchema.safeParse({ ...template, mission: templateMission }).success).toBe(false);
    expect(OriginSchema.safeParse({ ...recoveryOrigin(), recoveryAuthorityRef: null }).success).toBe(false);
    expect(OriginSchema.safeParse({ ...template, recoveryAuthorityRef: "x" }).success).toBe(false);
  });
});
