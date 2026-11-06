import { describe, expect, it } from "vitest";
import { recordRef } from "../digest.js";
import { qualifiersDigest } from "../records/assertion.js";
import {
  SCOPE,
  assertion,
  integrityObservation,
  qualifiers,
  ref,
  supportObservation,
  supportSet,
} from "../test-support.js";
import { evaluateSupport } from "./algebra.js";

const claim = assertion("a-1");
const f1 = ref("fragment", "f-1");
const f2 = ref("fragment", "f-2");
const f3 = ref("fragment", "f-3");
const f4 = ref("fragment", "f-4");

function ok(result: ReturnType<typeof evaluateSupport>) {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result;
}

describe("support algebra (design §9 support-sets seam)", () => {
  it("fails a set whose required premise is unsupported, without averaging", () => {
    const set = supportSet("s-1", claim, [
      { premise: "throughput", evidence: [f1] },
      { premise: "hardware", evidence: [f2] },
    ]);
    const observations = [
      supportObservation({ id: "o-1", set, target: claim, verdict: "full_support", premise: "throughput" }),
      supportObservation({ id: "o-2", set, target: claim, verdict: "insufficient_evidence", premise: "hardware" }),
    ];
    const result = ok(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [set], observations }),
    );
    expect(result.passes).toBe(false);
    expect(result.sets[0]?.status).toBe("failed");
    expect(result.sets[0]?.reasons).toContain("premise_unsupported:hardware");
  });

  it("fails a set whose required premise was never assessed", () => {
    const set = supportSet("s-1", claim, [
      { premise: "throughput", evidence: [f1] },
      { premise: "hardware", evidence: [f2] },
    ]);
    const observations = [
      supportObservation({ id: "o-1", set, target: claim, verdict: "full_support", premise: "throughput" }),
    ];
    const result = ok(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [set], observations }),
    );
    expect(result.passes).toBe(false);
    expect(result.sets[0]?.premises.map((premise) => premise.status)).toEqual(["supported", "unassessed"]);
  });

  it("passes on an alternative complete set and selects it", () => {
    const weak = supportSet("s-1", claim, [{ premise: "p", evidence: [f1] }]);
    const strong = supportSet("s-2", claim, [{ premise: "p", evidence: [f2] }]);
    const observations = [
      supportObservation({ id: "o-1", set: weak, target: claim, verdict: "partial_or_context_only" }),
      supportObservation({ id: "o-2", set: strong, target: claim, verdict: "full_support" }),
    ];
    const result = ok(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [weak, strong], observations }),
    );
    expect(result.passes).toBe(true);
    expect(result.selected).toEqual(recordRef("support_set", strong));
    expect(result.selectedStatus).toBe("supported");
  });

  it("retains contrary evidence from unselected sets and contradicting observations", () => {
    const easy = supportSet("s-1", claim, [{ premise: "p", evidence: [f1] }], { contrary: [f3] });
    // The contradiction is grounded: it cites f-4, which the contested set retains as contrary evidence.
    const contested = supportSet("s-2", claim, [{ premise: "p", evidence: [f2] }], { contrary: [f4] });
    const observations = [
      supportObservation({ id: "o-1", set: easy, target: claim, verdict: "full_support" }),
      supportObservation({ id: "o-2", set: contested, target: claim, verdict: "contradiction", contradicting: [f4] }),
    ];
    const result = ok(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [easy, contested], observations }),
    );
    expect(result.passes).toBe(true);
    expect(result.contraryRetained.map((fragment) => fragment.id).sort()).toEqual(["f-3", "f-4"]);
    expect(result.contradictingObservations).toHaveLength(1);
    expect(result.materialConflict).toBe(true);
    expect(result.sets.find((set) => set.status === "contradicted")).toBeDefined();
  });

  it("holds a disagreement between authoritative evaluators as disputed; it never rejects on its own (SV-09)", () => {
    const set = supportSet("s-d", claim, [{ premise: "p", evidence: [f1] }]);
    const observations = [
      supportObservation({ id: "o-judge", set, target: claim, verdict: "qualified_support", role: "judge" }),
      supportObservation({ id: "o-second", set, target: claim, verdict: "conflict", role: "second_family_judge" }),
    ];
    const result = ok(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [set], observations }),
    );
    expect(result.passes).toBe(false);
    expect(result.materialConflict).toBe(false);
    expect(result.contradictingObservations).toHaveLength(0);
    // Both sides of the disagreement are named (R1 F3), not only the dissenting observation.
    expect(result.disputedObservations.map((o) => o.id).sort()).toEqual(["o-judge", "o-second"]);
    expect(result.sets[0]?.status).toBe("disputed");
    // A contradiction citing a fragment the set does not retain as contrary is a dispute too, not a rejection.
    const ungrounded = [
      supportObservation({ id: "o-j2", set, target: claim, verdict: "full_support", role: "judge" }),
      supportObservation({
        id: "o-u",
        set,
        target: claim,
        verdict: "contradiction",
        contradicting: [f2],
        role: "second_family_judge",
      }),
    ];
    const second = ok(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [set], observations: ungrounded }),
    );
    expect(second.materialConflict).toBe(false);
    expect(second.sets[0]?.status).toBe("disputed");
    // R1 F3: full support from one evaluator does not win over partial support from another.
    const split = [
      supportObservation({ id: "o-p", set, target: claim, verdict: "partial_or_context_only", role: "judge" }),
      supportObservation({ id: "o-f", set, target: claim, verdict: "full_support", role: "second_family_judge" }),
    ];
    const third = ok(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [set], observations: split }),
    );
    expect(third.passes).toBe(false);
    expect(third.sets[0]?.status).toBe("disputed");
    expect(third.disputedObservations.map((o) => o.id).sort()).toEqual(["o-f", "o-p"]);
    // One evaluator's own retry keeps the ordinary ranking.
    const retry = [
      supportObservation({ id: "o-p1", set, target: claim, verdict: "partial_or_context_only", role: "judge" }),
      supportObservation({ id: "o-f1", set, target: claim, verdict: "full_support", role: "judge" }),
    ];
    const fourth = ok(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [set], observations: retry }),
    );
    expect(fourth.sets[0]?.status).toBe("supported");
  });

  // Content addressing forbids a digest cycle, so a derivation cycle runs through logical ids: A(v2) <- B <- A(v1).
  const a1 = assertion("x-a1", { logicalId: "L-a" });
  const b = assertion("x-b", { logicalId: "L-b", kind: "derivation", premises: [recordRef("assertion", a1)] });
  const a2 = assertion("x-a2", { logicalId: "L-a", kind: "derivation", premises: [recordRef("assertion", b)] });
  const setA2 = supportSet("s-a2", a2, [{ premise: "from-b", derivedFrom: [recordRef("assertion", b)] }]);
  const setB = supportSet("s-b", b, [{ premise: "from-a", derivedFrom: [recordRef("assertion", a1)] }]);

  it("refuses an ungrounded derivation cycle", () => {
    const result = evaluateSupport({
      scope: SCOPE,
      assertion: a2,
      assertions: [a1, b],
      supportSets: [setA2, setB],
      observations: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNGROUNDED_CYCLE");
  });

  it("does not refuse a cycle when an alternative set grounds the premise in evidence", () => {
    const grounded = supportSet("s-b-evidence", b, [{ premise: "measured", evidence: [f1] }]);
    const result = ok(
      evaluateSupport({
        scope: SCOPE,
        assertion: a2,
        assertions: [a1, b],
        supportSets: [setA2, setB, grounded],
        observations: [supportObservation({ id: "o-1", set: grounded, target: b, verdict: "full_support" })],
      }),
    );
    expect(result.passes).toBe(true);
  });

  it("accepts a derivation whose premise assertion is grounded in evidence", () => {
    const base = assertion("g-base");
    const baseSet = supportSet("s-base", base, [{ premise: "p", evidence: [f1] }]);
    const derived = assertion("g-derived", { kind: "derivation", premises: [recordRef("assertion", base)] });
    const derivedSet = supportSet("s-derived", derived, [
      { premise: "from-base", derivedFrom: [recordRef("assertion", base)] },
    ]);
    const result = ok(
      evaluateSupport({
        scope: SCOPE,
        assertion: derived,
        assertions: [base],
        supportSets: [baseSet, derivedSet],
        observations: [supportObservation({ id: "o-1", set: baseSet, target: base, verdict: "full_support" })],
      }),
    );
    expect(result.passes).toBe(true);
  });

  it("refuses refs scoped to another tenant or binding", () => {
    const foreign = ref("fragment", "f-x", { tenant: "tenant-b" });
    const set = supportSet("s-1", claim, [{ premise: "p", evidence: [foreign] }]);
    const result = evaluateSupport({
      scope: SCOPE,
      assertion: claim,
      assertions: [],
      supportSets: [set],
      observations: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FOREIGN_SCOPE_REF");
      expect(result.refs.map((r) => r.id)).toEqual(["f-x"]);
    }
    const otherBinding = supportSet("s-2", claim, [
      { premise: "p", evidence: [ref("fragment", "f-y", { binding: "biotech-graph" })] },
    ]);
    expect(
      evaluateSupport({ scope: SCOPE, assertion: claim, assertions: [], supportSets: [otherBinding], observations: [] })
        .ok,
    ).toBe(false);
  });

  it("does not reuse observations or sets after a qualifier change", () => {
    const original = claim;
    const set = supportSet("s-1", original, [{ premise: "p", evidence: [f1] }]);
    const observation = supportObservation({ id: "o-1", set, target: original, verdict: "full_support" });
    const changed = assertion("a-1", { qualifiers: qualifiers({ negation: true }) });
    expect(qualifiersDigest(changed.qualifiers)).not.toBe(qualifiersDigest(original.qualifiers));
    const result = ok(
      evaluateSupport({
        scope: SCOPE,
        assertion: changed,
        assertions: [],
        supportSets: [],
        observations: [observation],
      }),
    );
    expect(result.passes).toBe(false);
    // A set re-targeted at the changed assertion but keeping the old qualifiers digest is invalidated, and the old
    // observation is stale.
    const retargeted = { ...set, assertion: recordRef("assertion", changed) };
    const staleObservation = { ...observation, target: recordRef("support_set", retargeted) };
    const second = ok(
      evaluateSupport({
        scope: SCOPE,
        assertion: changed,
        assertions: [],
        supportSets: [retargeted],
        observations: [staleObservation],
      }),
    );
    expect(second.passes).toBe(false);
    expect(second.sets[0]?.status).toBe("invalidated");
    expect(second.staleObservations).toHaveLength(1);
  });

  it("qualified support passes as qualified and marks forecasts as not fact-entailed", () => {
    const forecast = assertion("fc-1", { kind: "forecast" });
    const set = supportSet("s-1", forecast, [{ premise: "p", evidence: [f1] }]);
    const result = ok(
      evaluateSupport({
        scope: SCOPE,
        assertion: forecast,
        assertions: [],
        supportSets: [set],
        observations: [supportObservation({ id: "o-1", set, target: forecast, verdict: "qualified_support" })],
      }),
    );
    expect(result.selectedStatus).toBe("qualified");
    expect(result.factEntailed).toBe(false);
  });

  it("an L0 integrity failure on a premise fragment voids the set whatever judges or reviewers concluded", () => {
    const broken = supportSet("s-1", claim, [
      { premise: "throughput", evidence: [f1] },
      { premise: "hardware", evidence: [f2] },
    ]);
    const intact = supportSet("s-2", claim, [{ premise: "throughput", evidence: [f3] }]);
    const support = [
      supportObservation({ id: "o-1", set: broken, target: claim, verdict: "full_support", role: "judge" }),
      supportObservation({ id: "o-2", set: broken, target: claim, verdict: "full_support", role: "human_reviewer" }),
    ];
    // Failure recorded against another set's fragment f2: still voids the premise of s-1 that cites f2.
    const failure = integrityObservation({ id: "i-1", target: recordRef("support_set", intact), evidence: [f2] });
    const voided = ok(
      evaluateSupport({
        scope: SCOPE,
        assertion: claim,
        assertions: [],
        supportSets: [broken],
        observations: [...support, failure],
      }),
    );
    expect(voided.passes).toBe(false);
    expect(voided.sets[0]?.status).toBe("integrity_failed");
    expect(voided.sets[0]?.premises.map((premise) => premise.status)).toEqual(["supported", "integrity_failed"]);
    expect(voided.integrityFailures).toEqual([recordRef("observation", failure)]);
    // A whole-set failure with no fragment named voids every premise; a passing check changes nothing.
    const whole = integrityObservation({ id: "i-2", target: recordRef("support_set", broken) });
    const allVoided = ok(
      evaluateSupport({
        scope: SCOPE,
        assertion: claim,
        assertions: [],
        supportSets: [broken],
        observations: [...support, whole],
      }),
    );
    expect(allVoided.sets[0]?.premises.every((premise) => premise.status === "integrity_failed")).toBe(true);
    const passed = integrityObservation({ id: "i-3", target: recordRef("support_set", broken), result: "pass" });
    expect(
      ok(
        evaluateSupport({
          scope: SCOPE,
          assertion: claim,
          assertions: [],
          supportSets: [broken],
          observations: [...support, passed],
        }),
      ).passes,
    ).toBe(true);
    // An intact alternative still supports the assertion.
    const alternative = ok(
      evaluateSupport({
        scope: SCOPE,
        assertion: claim,
        assertions: [],
        supportSets: [broken, intact],
        observations: [
          ...support,
          failure,
          supportObservation({ id: "o-3", set: intact, target: claim, verdict: "full_support", role: "judge" }),
        ],
      }),
    );
    expect(alternative.passes).toBe(true);
    expect(alternative.selected?.id).toBe("s-2");
  });
});
