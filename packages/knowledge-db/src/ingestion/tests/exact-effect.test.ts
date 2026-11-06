import { type Origin, boundEffectDigest, digestBytes } from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import { IngestionIntentSchema } from "../intent.js";
import { buildPlan, nativeEffectPayload } from "../plan.js";
import { fixtureFacts, priceIntent } from "./test-fixtures.js";

/** SV-08: the plan computes the exact native effect an exact-use decision binds (planned bytes + originating origin). */
const executor = { version: "knowledge-executor/test", migrationHead: "20260912020000" };
const origin: Origin = {
  kind: "standalone",
  installationId: "install-1",
  applicationId: "ai-engineer",
  tenantId: "00000000-0000-7000-8000-000000000001",
  issuer: "mission-control",
  subject: "runtime",
  mission: null,
  recoveryAuthorityRef: null,
  invocationId: "inv-1",
  authenticatedAt: "2026-10-25T00:00:00Z",
};
const exactUse = {
  useDecisionId: "ud-1",
  boundEffectDigest: digestBytes("placeholder"),
  processedEpoch: 0,
  normalizedValuesDigest: digestBytes("values"),
  effectKey: "effect-1",
  originatingOrigin: origin,
};

describe("plan effect digest (exact-use binding)", () => {
  it("is null without a binding and the K01 bound digest of the planned bytes with one", () => {
    const plain = buildPlan(IngestionIntentSchema.parse(priceIntent()), fixtureFacts(), executor);
    expect(plain.effect).toBeNull();
    const intent = IngestionIntentSchema.parse({ ...priceIntent(), exactUse });
    const plan = buildPlan(intent, fixtureFacts(), executor);
    const payload = nativeEffectPayload(intent, plan.subjects, plan.proposals);
    expect(plan.effect).toEqual({
      schemaVersion: "knowledge-ingestion-effect.v1",
      effectKey: "effect-1",
      semanticPayloadDigest: digestBytes(payload),
      boundEffectDigest: boundEffectDigest(payload, origin),
    });
    // Floats never reach canonical bytes: non-integers are bound as decimal strings.
    expect(payload).not.toMatch(/[0-9]\.[0-9]+[,}\]]/);
  });

  it("is independent of the presented digest and processed epoch, but changes with the origin or the proposals", () => {
    const base = buildPlan(IngestionIntentSchema.parse({ ...priceIntent(), exactUse }), fixtureFacts(), executor);
    const sameBytes = buildPlan(
      IngestionIntentSchema.parse({
        ...priceIntent(),
        exactUse: { ...exactUse, boundEffectDigest: digestBytes("x"), processedEpoch: 9 },
      }),
      fixtureFacts(),
      executor,
    );
    expect(sameBytes.effect?.boundEffectDigest).toBe(base.effect?.boundEffectDigest);
    const otherOrigin = buildPlan(
      IngestionIntentSchema.parse({
        ...priceIntent(),
        exactUse: { ...exactUse, originatingOrigin: { ...origin, subject: "other" } },
      }),
      fixtureFacts(),
      executor,
    );
    expect(otherOrigin.effect?.boundEffectDigest).not.toBe(base.effect?.boundEffectDigest);
    expect(otherOrigin.effect?.semanticPayloadDigest).toBe(base.effect?.semanticPayloadDigest);
    const edited = buildPlan(
      IngestionIntentSchema.parse({ ...priceIntent({ intentId: "price-edited" }), exactUse }),
      fixtureFacts(),
      executor,
    );
    expect(edited.effect?.boundEffectDigest).not.toBe(base.effect?.boundEffectDigest);
  });

  it("refuses an exact-use binding with a malformed origin or digest", () => {
    expect(
      IngestionIntentSchema.safeParse({ ...priceIntent(), exactUse: { ...exactUse, boundEffectDigest: "abc" } })
        .success,
    ).toBe(false);
    expect(
      IngestionIntentSchema.safeParse({
        ...priceIntent(),
        exactUse: { ...exactUse, originatingOrigin: { ...origin, kind: "recovery" } },
      }).success,
    ).toBe(false);
  });
});
