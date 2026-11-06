import { describe, expect, it } from "vitest";
import { exactUseEvidenceOracle } from "../exact-use-oracle.js";
import type { IngestionIntent } from "../intent.js";

const intent = (exactUse: boolean) =>
  ({
    evidence: { verificationRuns: [{ runId: "vr_declared" }], claims: [] },
    ...(exactUse ? { exactUse: { useDecisionId: "decision-1" } } : {}),
  }) as unknown as IngestionIntent;

describe("exact-use evidence oracle (SV-17 replacement of the executor file-store oracle)", () => {
  it("makes a declared run eligible only under an exact-use binding and never returns authoritative provenance", async () => {
    const oracle = exactUseEvidenceOracle(intent(true));
    expect(await oracle.runSealed("vr_declared")).toBe(true);
    const eligibility = await oracle.claimEligible("vr_declared", "c_1");
    expect(eligibility).toEqual({ eligible: true, verdict: "exact_use_bound", fixtureOnly: true });
    expect("authoritative" in eligibility).toBe(false);
  });

  it("fails closed for undeclared runs and for intents without exactUse", async () => {
    expect(await exactUseEvidenceOracle(intent(true)).claimEligible("vr_other", "c_1")).toEqual({ eligible: false });
    const plain = exactUseEvidenceOracle(intent(false));
    expect(await plain.runSealed("vr_declared")).toBe(false);
    expect(await plain.claimEligible("vr_declared", "c_1")).toEqual({ eligible: false });
  });
});
