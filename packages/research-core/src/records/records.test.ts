import { describe, expect, it } from "vitest";
import { assertSameRef, recordDigest, recordRef } from "../digest.js";
import { QualifiersSchema, profileFor, qualifiersFor } from "../profiles/index.js";
import { assertion, qualifiers, ref, supportObservation, supportSet } from "../test-support.js";
import { AssertionVersionSchema } from "./assertion.js";
import { VerificationObservationSchema } from "./observation.js";
import { SupportSetSchema } from "./support.js";

const claim = assertion("a-1");
const set = supportSet("s-1", claim, [{ premise: "p", evidence: [ref("fragment", "f-1")] }]);
const observation = supportObservation({ id: "o-1", set, target: claim, verdict: "full_support" });

describe("strict records", () => {
  it("parses valid records and derives K01 refs from canonical bytes", () => {
    expect(AssertionVersionSchema.parse(claim)).toEqual(claim);
    expect(SupportSetSchema.parse(set)).toEqual(set);
    expect(VerificationObservationSchema.parse(observation)).toEqual(observation);
    const claimRef = recordRef("assertion", claim);
    expect(claimRef).toMatchObject({ kind: "assertion", id: "a-1", version: "research-core.assertion.v2" });
    expect(claimRef.digest).toBe(recordDigest(claim));
    expect(recordRef("assertion", { ...claim, proposition: "changed" }).digest).not.toBe(claimRef.digest);
    expect(() => assertSameRef(claimRef, recordRef("assertion", { ...claim, proposition: "x" }))).toThrow(/expected/);
  });

  it("refuses unknown fields, wrong schema versions and unknown enum values", () => {
    expect(AssertionVersionSchema.safeParse({ ...claim, extra: true }).success).toBe(false);
    expect(AssertionVersionSchema.safeParse({ ...claim, schemaVersion: "research-core.assertion.v1" }).success).toBe(
      false,
    );
    expect(AssertionVersionSchema.safeParse({ ...claim, kind: "opinion" }).success).toBe(false);
    expect(AssertionVersionSchema.safeParse({ ...claim, qualifiers: { ...claim.qualifiers, mood: "x" } }).success).toBe(
      false,
    );
    expect(
      VerificationObservationSchema.safeParse({ ...observation, outcome: { ...observation.outcome, verdict: "pass" } })
        .success,
    ).toBe(false);
    expect(VerificationObservationSchema.safeParse({ ...observation, outcome: { result: "pass" } }).success).toBe(
      false,
    );
  });

  it("enforces outcome and target rules per property", () => {
    const census = { ...observation, property: "census" };
    expect(VerificationObservationSchema.safeParse(census).success).toBe(false);
    expect(VerificationObservationSchema.safeParse({ ...observation, qualifiersDigest: null }).success).toBe(false);
    const noCitation = { ...observation, outcome: { ...observation.outcome, citedFragments: [] } };
    expect(VerificationObservationSchema.safeParse(noCitation).success).toBe(false);
    const challengeOnSet = {
      ...observation,
      property: "challenge",
      outcome: { status: "not_searched", reason: "budget" },
    };
    expect(VerificationObservationSchema.safeParse(challengeOnSet).success).toBe(false);
    const challenge = { ...challengeOnSet, target: recordRef("assertion", claim) };
    expect(VerificationObservationSchema.safeParse(challenge).success).toBe(true);
  });

  it("refuses derivations without premises and duplicate premises in a set", () => {
    expect(AssertionVersionSchema.safeParse({ ...claim, kind: "derivation" }).success).toBe(false);
    const duplicate = { ...set, required: [...set.required, ...set.required] };
    expect(SupportSetSchema.safeParse(duplicate).success).toBe(false);
    expect(
      SupportSetSchema.safeParse({ ...set, required: [{ premise: "p", evidence: [], derivedFrom: [] }] }).success,
    ).toBe(false);
  });
});

describe("qualifier profiles", () => {
  it("resolves the profile a rubric requires and refuses unknown rubrics", () => {
    expect(profileFor(ref("rubric", "r-eng"))).toEqual({ ok: true, profile: "engineering.v2", domain: "engineering" });
    expect(profileFor(ref("rubric", "r-sci", { version: "research-rubric.scientific.v2" }))).toMatchObject({
      ok: true,
      profile: "scientific.v2",
    });
    expect(profileFor(ref("rubric", "r-med", { version: "research-rubric.medical.v2" }))).toMatchObject({
      ok: false,
      code: "SCHEMA_UNSUPPORTED",
    });
  });

  it("refuses qualifiers of an unknown profile or the wrong profile for the rubric", () => {
    expect(QualifiersSchema.safeParse({ ...qualifiers(), profile: "medical.v2" }).success).toBe(false);
    const scientific = ref("rubric", "r-sci", { version: "research-rubric.scientific.v2" });
    expect(qualifiersFor(scientific, qualifiers())).toMatchObject({ ok: false, code: "PROFILE_MISMATCH" });
    expect(qualifiersFor(ref("rubric", "r-eng"), qualifiers())).toMatchObject({ ok: true });
    expect(qualifiersFor(ref("rubric", "r-eng"), { ...qualifiers(), repositoryCommit: "abc" })).toMatchObject({
      ok: false,
      code: "SCHEMA_UNSUPPORTED",
    });
  });
});
