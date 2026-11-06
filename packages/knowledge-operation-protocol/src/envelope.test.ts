import { describe, expect, it } from "vitest";
import { checkCapabilities } from "./capability.js";
import type { BindingDescriptor } from "./capability.js";
import { digestCanonical } from "./canonical.js";
import { CredentialClaimsSchema, credentialWindow } from "./credential.js";
import { OperationEnvelopeSchema, envelopeDigest } from "./envelope.js";
import { applyEnvelope, effectRecoveryClaims, missionOrigin, readOnlyRecoveryClaims } from "./test-support.js";

describe("operation envelope", () => {
  const envelope = applyEnvelope();

  it("accepts the golden apply envelope and refuses unknown fields and wrong versions", () => {
    expect(OperationEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(OperationEnvelopeSchema.safeParse({ ...envelope, extra: 1 }).success).toBe(false);
    expect(
      OperationEnvelopeSchema.safeParse({ ...envelope, protocolVersion: "ks.knowledge_operation.v1" }).success,
    ).toBe(false);
  });

  it("declares use and audience on effectful operations only, both or neither", () => {
    const declared = { ...envelope, use: "knowledge_ingestion.apply", audience: "official" };
    expect(OperationEnvelopeSchema.safeParse(declared).success).toBe(true);
    expect(envelopeDigest(OperationEnvelopeSchema.parse(declared))).not.toBe(envelopeDigest(envelope));
    expect(OperationEnvelopeSchema.safeParse({ ...envelope, use: "knowledge_ingestion.apply" }).success).toBe(false);
    expect(OperationEnvelopeSchema.safeParse({ ...envelope, use: "Not A Name", audience: "official" }).success).toBe(
      false,
    );
    const read = {
      ...envelope,
      operation: "knowledge.read",
      effect: null,
      use: "internal_research",
      audience: "team",
    };
    expect(OperationEnvelopeSchema.safeParse(read).success).toBe(false);
  });

  it("binds effectful operations to an effect and the payload digest", () => {
    expect(OperationEnvelopeSchema.safeParse({ ...envelope, effect: null }).success).toBe(false);
    expect(OperationEnvelopeSchema.safeParse({ ...envelope, operation: "knowledge.read" }).success).toBe(false);
    const input = envelope.input as NonNullable<typeof envelope.input>;
    const tampered = { ...envelope, input: { ...input, payloadDigest: digestCanonical({ other: 1 }) } };
    expect(OperationEnvelopeSchema.safeParse(tampered).success).toBe(false);
  });

  it("addresses polling, cancel and receipt lookups explicitly", () => {
    const read = { ...envelope, operation: "operation.get", effect: null, input: null } as const;
    expect(OperationEnvelopeSchema.safeParse(read).success).toBe(false);
    const withHandle = {
      ...read,
      target: {
        handle: {
          protocolVersion: "ks.knowledge_operation.v2",
          tenant: envelope.tenant,
          application: "ai-engineer",
          binding: "aiengineer-postgres",
          operationId: "op-1",
        },
        effectKey: null,
      },
    };
    expect(OperationEnvelopeSchema.safeParse(withHandle).success).toBe(true);
    expect(OperationEnvelopeSchema.safeParse({ ...withHandle, operation: "operation.cancel" }).success).toBe(false);
    expect(
      OperationEnvelopeSchema.safeParse({ ...withHandle, operation: "operation.cancel", cancelRequestId: "c-1" })
        .success,
    ).toBe(true);
    const receipt = { ...read, target: { handle: null, effectKey: "effect-0001" }, operation: "receipt.get" };
    expect(OperationEnvelopeSchema.safeParse(receipt).success).toBe(true);
  });

  it("checks an inline payload against its digest", () => {
    const inline = { a: 1, b: ["x"] };
    const base = { ...envelope, operation: "knowledge.read", effect: null } as const;
    const input = envelope.input as NonNullable<typeof envelope.input>;
    const ok = {
      ...base,
      input: { ...input, inlinePayload: inline, payloadDigest: digestCanonical(inline), payloadRef: null },
    };
    expect(OperationEnvelopeSchema.safeParse(ok).success).toBe(true);
    const bad = { ...ok, input: { ...ok.input, inlinePayload: { a: 2 } } };
    expect(OperationEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it("envelope digests are stable across key order", () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, item]) => [key, reversed(item)]),
        );
      }
      return value;
    };
    const reordered = reversed(envelope);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(envelope));
    expect(envelopeDigest(OperationEnvelopeSchema.parse(reordered))).toBe(envelopeDigest(envelope));
  });
});

describe("binding descriptor and credential claims", () => {
  const descriptor: BindingDescriptor = {
    protocolVersions: ["ks.knowledge_operation.v2"],
    binding: "aiengineer-postgres",
    application: "ai-engineer",
    coreSchemas: ["research-report.v2"],
    operations: ["knowledge.describe", "knowledge.read", "knowledge.apply", "receipt.get"],
    auditorKind: "independent",
    reportKinds: ["evidence_report", "study_appraisal"],
    media: ["text/markdown"],
    guarantees: {
      exactRead: "exact_revision",
      receiptLookup: "by_effect_key",
      nativeCancellation: "stop_dispatch_and_reconcile",
      admission: "exact_use_decision",
      revocation: "epoch_checked",
      writeAtomicity: "single_transaction",
    },
    signingIssuer: "mission-control",
    pinnedSchema: {
      name: "aiengineer-database-contract",
      version: "aiengineer-database-contract.v1",
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
    },
    qualification: [
      {
        capability: "knowledge.apply",
        receiptRef: "proof-1",
        tier: "T1-KS",
        recordedAt: "2026-10-24T20:00:00Z",
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000003",
      },
    ],
    describedAt: "2026-10-24T20:00:00Z",
  };

  it("refuses required capabilities that are missing or merely installed", () => {
    expect(checkCapabilities(descriptor, ["knowledge.apply"])).toEqual({ ok: true });
    expect(checkCapabilities(descriptor, ["verify.claims", "knowledge.read", "exactRead:exact_revision"])).toEqual({
      ok: false,
      missing: ["verify.claims"],
      unqualified: ["knowledge.read", "exactRead:exact_revision"],
    });
  });

  it("credential claims pin scope, lifetime and one exact effect", () => {
    const origin = missionOrigin();
    const claims = {
      typ: "ks-knowledge-operation+jwt",
      iss: "mission-control",
      aud: "knowledge-services",
      sub: "mission-control-runtime",
      jti: "jti-1",
      iat: 1_000,
      nbf: 1_000,
      exp: 1_300,
      tenant: origin.tenantId,
      application: "ai-engineer",
      binding: "aiengineer-postgres",
      origin,
      operations: ["knowledge.apply"],
      effect: {
        effectKey: "effect-0001",
        boundEffectDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000002",
      },
      dispatchId: "dispatch-0001",
      recovery: null,
    };
    expect(CredentialClaimsSchema.safeParse(claims).success).toBe(true);
    expect(CredentialClaimsSchema.safeParse({ ...claims, effect: null }).success).toBe(false);
    expect(CredentialClaimsSchema.safeParse({ ...claims, exp: 1_301 }).success).toBe(false);
    expect(CredentialClaimsSchema.safeParse({ ...claims, tenant: "other" }).success).toBe(false);
    const parsed = CredentialClaimsSchema.parse(claims);
    expect(credentialWindow(parsed, 999)).toEqual({ valid: true });
    expect(credentialWindow(parsed, 960)).toEqual({ valid: false, reason: "not_yet_valid" });
    expect(credentialWindow(parsed, 1_330)).toEqual({ valid: false, reason: "expired" });
  });

  it("recovery claims: effect scope for a new attempt's exact effect, read-only for a recovery origin", () => {
    const effectful = effectRecoveryClaims();
    expect(CredentialClaimsSchema.safeParse(effectful).success).toBe(true);
    const recovery = effectful.recovery as NonNullable<typeof effectful.recovery>;
    // The grant must cover exactly the credential's effect.
    expect(
      CredentialClaimsSchema.safeParse({ ...effectful, recovery: { ...recovery, effectKey: "effect-other" } }).success,
    ).toBe(false);
    expect(CredentialClaimsSchema.safeParse({ ...effectful, recovery: { ...recovery, effectKey: null } }).success).toBe(
      false,
    );
    // Effect scope is presented by a live invocation, never by a recovery origin; it grants the effect only.
    expect(
      CredentialClaimsSchema.safeParse({ ...effectful, operations: ["knowledge.apply", "report.assess"] }).success,
    ).toBe(false);
    const lookup = readOnlyRecoveryClaims();
    expect(CredentialClaimsSchema.safeParse(lookup).success).toBe(true);
    expect(CredentialClaimsSchema.safeParse({ ...lookup, operations: ["receipt.get", "knowledge.read"] }).success).toBe(
      false,
    );
    expect(CredentialClaimsSchema.safeParse({ ...lookup, recovery: null }).success).toBe(false);
    expect(
      CredentialClaimsSchema.safeParse({
        ...lookup,
        recovery: { ...(lookup.recovery as NonNullable<typeof lookup.recovery>), authorityRef: "grant-other" },
      }).success,
    ).toBe(false);
    expect(
      CredentialClaimsSchema.safeParse({
        ...lookup,
        recovery: { ...(lookup.recovery as NonNullable<typeof lookup.recovery>), scope: "effect" },
      }).success,
    ).toBe(false);
    expect(
      CredentialClaimsSchema.safeParse({ ...effectful, recovery: { ...recovery, scope: "read_only" } }).success,
    ).toBe(false);
    expect(CredentialClaimsSchema.safeParse({ ...effectful, sub: "someone-else" }).success).toBe(false);
  });
});
