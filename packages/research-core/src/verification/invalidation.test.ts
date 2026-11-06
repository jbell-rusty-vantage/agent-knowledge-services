import { describe, expect, it } from "vitest";
import { ref } from "../test-support.js";
import { invalidate } from "./invalidation.js";

const capture = ref("artifact", "capture-1");
const otherCapture = ref("artifact", "capture-2");
const fragment = ref("fragment", "f-1");
const otherFragment = ref("fragment", "f-2");
const set = ref("support_set", "s-1");
const assertion = ref("assertion", "a-1");
const otherAssertion = ref("assertion", "a-2");
const report = ref("report", "r-1");
const otherReport = ref("report", "r-2");
const decision = ref("use_decision", "d-1");
const otherDecision = ref("use_decision", "d-2");
const effect = ref("effect", "e-1");

const edges = [
  { from: capture, to: fragment },
  { from: fragment, to: set },
  { from: set, to: assertion },
  { from: assertion, to: report },
  { from: report, to: decision },
  { from: decision, to: effect },
  { from: otherCapture, to: otherFragment },
  { from: otherFragment, to: otherAssertion },
  { from: otherAssertion, to: otherReport },
  { from: otherReport, to: otherDecision },
];

describe("invalidation closure (design §7)", () => {
  it("holds every dependent decision of a corrected capture and leaves unrelated branches untouched", () => {
    const result = invalidate(edges, [capture], 7);
    if (!result.ok) throw new Error("unexpected refusal");
    expect(result.holdDecisions.map((ref) => ref.id)).toEqual(["d-1"]);
    expect(result.untouchedDecisions.map((ref) => ref.id)).toEqual(["d-2"]);
    expect(result.recheck.supportSets.map((ref) => ref.id)).toEqual(["s-1"]);
    expect(result.recheck.reports.map((ref) => ref.id)).toEqual(["r-1"]);
    expect(result.effects.map((ref) => ref.id)).toEqual(["e-1"]);
    expect(result.affected.map((ref) => ref.id)).not.toContain("a-2");
    expect(result.authoritativeEpoch).toBe(8);
  });

  it("starts the closure at any corrected record and does not advance the epoch when nothing depends on it", () => {
    const fromAssertion = invalidate(edges, [assertion], 3);
    expect(fromAssertion.ok && fromAssertion.affected.map((ref) => ref.id).sort()).toEqual(["d-1", "e-1", "r-1"]);
    const leaf = invalidate(edges, [effect], 3);
    expect(leaf.ok && leaf.authoritativeEpoch).toBe(3);
  });

  it("refuses an edge pointing back up the dependency chain", () => {
    const result = invalidate([...edges, { from: report, to: fragment }], [capture], 0);
    expect(result).toMatchObject({ ok: false, code: "INVALID_EDGE" });
  });
});
