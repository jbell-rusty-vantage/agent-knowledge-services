import { describe, expect, it } from "vitest";
import { sha256Digest } from "../canonical/index.js";
import {
  acceptClaimDecomposition,
  evaluateDecompositionProposal,
  type ClaimDecompositionProposal,
} from "./decomposition.js";

const report =
  "Generation Lab reports 19 systems. Another section reports 21 systems. Turnaround is 2–4 weeks for one context and 3–4 weeks for another.";

function twoSegmentProposal(): ClaimDecompositionProposal {
  const split = report.indexOf(" Another") + 1;
  return {
    schemaVersion: "verification-claim-decomposition.v1",
    annotationVersion: "declared-synthetic.v1",
    offsetUnit: "utf16_code_unit",
    reportDigest: sha256Digest(report),
    segments: [
      {
        segmentId: "claim-a",
        start: 0,
        end: split,
        exactText: report.slice(0, split),
        classification: "externally_verifiable_fact",
        atomizationBasis: "semantic_proposition",
        atomic: true,
        qualifiers: ["19 systems"],
      },
      {
        segmentId: "claim-b",
        start: split,
        end: report.length,
        exactText: report.slice(split),
        classification: "externally_verifiable_fact",
        atomizationBasis: "semantic_proposition",
        atomic: true,
        qualifiers: ["2–4 weeks", "3–4 weeks"],
      },
    ],
  };
}

describe("claim decomposition acceptance", () => {
  it("accepts a proposal that reconstructs the report exactly", () => {
    const accepted = acceptClaimDecomposition(report, twoSegmentProposal());
    expect(accepted.reconstructedReport).toBe(report);
  });

  it("rejects a segment whose declared qualifier is not in its text", () => {
    const proposal = twoSegmentProposal();
    expect(() =>
      acceptClaimDecomposition(report, {
        ...proposal,
        segments: [{ ...proposal.segments[0]!, qualifiers: ["missing qualifier"] }, proposal.segments[1]!],
      }),
    ).toThrow("DECOMPOSITION_QUALIFIER_NOT_PRESERVED");
  });
});

describe("decomposition proposal evaluation", () => {
  it("leaves declared-synthetic annotations unscored", () => {
    const accepted = acceptClaimDecomposition(report, twoSegmentProposal());
    expect(
      evaluateDecompositionProposal(accepted, {
        caseId: "diagnostic-synthetic",
        reportDigest: sha256Digest(report),
        expectedClaimRanges: [],
        provenance: "declared_synthetic",
      }),
    ).toEqual({ status: "pending_human_gold" });
  });
});
