import { digestCanonical } from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import { USE_DECISION_SCHEMA_VERSION, type UseDecision, UseDecisionSchema } from "../records/decision.js";
import { AT, BINDING, TENANT, ref } from "../test-support.js";
import { normalizedValuesDigest } from "../ports/oracle.js";
import { type AdmissionContext, REVIEW_CONDITION, admissible } from "./use-decision.js";

const effect = digestCanonical({ effect: "apply-1" });

const decision: UseDecision = {
  schemaVersion: USE_DECISION_SCHEMA_VERSION,
  id: "decision-1",
  tenant: TENANT,
  binding: BINDING,
  subject: ref("assertion", "a-1"),
  report: ref("report", "report-1"),
  qualifiersDigest: digestCanonical({ q: 1 }),
  supportSet: ref("support_set", "s-1"),
  run: ref("verification_run", "run-1"),
  boundEffectDigest: effect,
  use: "course_publication",
  audience: "learners",
  normalizedValues: { throughput: "1200", unit: "tokens/s" },
  targetSchema: "aiengineer.claim.v3",
  disposition: "admitted",
  conditions: [],
  policy: ref("policy", "policy-1"),
  rubric: ref("rubric", "rubric-1"),
  revocationEpoch: 7,
  decidedAt: AT,
  expiresAt: "2026-11-24T20:00:00Z",
  reviewer: null,
};

const context: AdmissionContext = {
  tenant: TENANT,
  use: "course_publication",
  audience: "learners",
  authoritativeEpoch: 7,
  processedEpoch: 7,
  closureComplete: true,
  invalidated: new Set(),
  now: "2026-10-25T00:00:00Z",
  boundEffectDigest: effect,
  normalizedValuesDigest: normalizedValuesDigest({ throughput: "1200", unit: "tokens/s" }),
};

describe("exact-use admission (design §7)", () => {
  it("admits a current decision for the exact effect", () => {
    expect(UseDecisionSchema.parse(decision)).toEqual(decision);
    expect(admissible(decision, context)).toEqual({ status: "admitted" });
  });

  it("holds when the processed epoch is behind the authoritative epoch", () => {
    expect(admissible(decision, { ...context, authoritativeEpoch: 8 })).toEqual({
      status: "held",
      reason: "stale_epoch",
    });
    expect(admissible(decision, { ...context, authoritativeEpoch: 8, processedEpoch: 8 })).toEqual({
      status: "admitted",
    });
  });

  it("rejects an effect digest mismatch and use/audience/tenant drift", () => {
    expect(admissible(decision, { ...context, boundEffectDigest: digestCanonical({ effect: "edited" }) })).toEqual({
      status: "rejected",
      reason: "effect_digest_mismatch",
    });
    expect(admissible(decision, { ...context, audience: "public" }).status).toBe("rejected");
    expect(admissible(decision, { ...context, use: "official_record" }).status).toBe("rejected");
    expect(admissible(decision, { ...context, tenant: "tenant-b" })).toEqual({
      status: "rejected",
      reason: "scope_mismatch",
    });
  });

  it("holds when the authority is unavailable", () => {
    expect(admissible(decision, { ...context, authoritativeEpoch: null })).toEqual({
      status: "held",
      reason: "authority_unavailable",
    });
  });

  it("holds at and after expiry", () => {
    expect(admissible(decision, { ...context, now: "2026-11-24T20:00:00Z" })).toEqual({
      status: "held",
      reason: "expired",
    });
    expect(admissible(decision, { ...context, now: "2026-11-24T19:59:59.5Z" })).toEqual({ status: "admitted" });
  });

  it("holds on incomplete closure, rejects an invalidated decision; never admits a held or rejected decision", () => {
    expect(admissible(decision, { ...context, closureComplete: false }).status).toBe("held");
    // Checkpoint A: one semantics with the component (SQL rejected/DECISION_INVALIDATED).
    expect(admissible(decision, { ...context, invalidated: new Set(["decision-1"]) })).toEqual({
      status: "rejected",
      reason: "invalidated",
    });
    expect(admissible({ ...decision, disposition: "held" }, context).status).toBe("held");
    expect(admissible({ ...decision, disposition: "rejected" }, context).status).toBe("rejected");
  });

  it("rejects a normalized value mismatch (design §9)", () => {
    expect(
      admissible(decision, {
        ...context,
        normalizedValuesDigest: normalizedValuesDigest({ throughput: "1300", unit: "tokens/s" }),
      }),
    ).toEqual({ status: "rejected", reason: "normalized_values_mismatch" });
  });

  it("holds a review-conditioned decision until an approving, exactly bound, live adjudication names it", () => {
    const reviewed = { ...decision, conditions: [REVIEW_CONDITION] };
    expect(admissible(reviewed, context)).toEqual({ status: "held", reason: "review_required" });
    const withReviewer = { ...reviewed, reviewer: ref("adjudication", "adj-1") };
    const review = {
      adjudicationId: "adj-1",
      outcome: "approve" as const,
      boundEffectDigest: effect,
      qualifiersDigest: decision.qualifiersDigest,
      grantLive: true,
    };
    expect(admissible(withReviewer, { ...context, review })).toEqual({ status: "admitted" });
    expect(admissible(withReviewer, { ...context, review: { ...review, grantLive: false } }).status).toBe("held");
    expect(admissible(withReviewer, { ...context, review: { ...review, outcome: "hold" } }).status).toBe("held");
    expect(
      admissible(withReviewer, { ...context, review: { ...review, boundEffectDigest: digestCanonical({ e: 2 }) } })
        .status,
    ).toBe("held");
    expect(admissible(withReviewer, { ...context, review: { ...review, adjudicationId: "adj-2" } }).status).toBe(
      "held",
    );
  });

  it("requires an assertion decision to bind qualifiers, and its support set when admitted", () => {
    expect(UseDecisionSchema.safeParse({ ...decision, supportSet: null }).success).toBe(false);
    expect(UseDecisionSchema.safeParse({ ...decision, disposition: "held", supportSet: null }).success).toBe(true);
    expect(UseDecisionSchema.safeParse({ ...decision, qualifiersDigest: null, disposition: "held" }).success).toBe(
      false,
    );
    expect(UseDecisionSchema.safeParse({ ...decision, expiresAt: AT }).success).toBe(false);
  });
});
