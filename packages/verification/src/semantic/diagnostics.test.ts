import { describe, expect, it, vi } from "vitest";
import { summarizeAttributionPerturbations } from "./attribution.js";
import { proposeUncitedEvidenceRescue } from "./rescue.js";

describe("uncited evidence rescue", () => {
  it("keeps rescue bounded and pending mechanical admission", async () => {
    const search = vi.fn(async () => [
      {
        candidateId: "r1",
        sourceUri: "https://example.test/source",
        exactText: "uncited alternative",
        sourceFamilyId: "independent-1",
      },
    ]);
    await expect(
      proposeUncitedEvidenceRescue(
        "diagnostic claim",
        { maximumCalls: 1, maximumFragments: 2, maximumCharacters: 100 },
        { search },
      ),
    ).resolves.toMatchObject({
      status: "pending_mechanical_admission",
      callsUsed: 1,
    });
    expect(search).toHaveBeenCalledWith({
      query: "diagnostic claim",
      maximumFragments: 2,
      maximumCharacters: 100,
    });
  });
});

describe("attribution perturbations", () => {
  it("labels perturbation evidence as an audit metric rather than causal proof", () => {
    expect(
      summarizeAttributionPerturbations([
        {
          assertionId: "a",
          baselineVerdict: "supported",
          deletionVerdict: "unsupported",
          replacementVerdict: "contradicted",
          reorderedVerdict: "supported",
        },
      ]),
    ).toEqual({
      status: "audit_metric_only",
      sampleSize: 1,
      claimSurvivalRate: 0,
      flipRate: 1,
      evidenceSensitivityRate: 1,
      causalProof: false,
    });
  });
});
