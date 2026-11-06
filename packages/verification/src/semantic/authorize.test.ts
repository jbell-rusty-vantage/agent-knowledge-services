import { describe, expect, it } from "vitest";
import { sha256Digest } from "../canonical/index.js";
import { verifyDeterministicBundle } from "../deterministic/index.js";
import { prototypeClaimInput } from "../deterministic/engine-golden.fixture.js";
import { authorizeSemanticCase } from "./authorize.js";

const selectedFragments = [
  {
    evidenceId: "evidence-1",
    fragmentId: "fragment-evidence-1",
    exactText: "RAG was basically just a hack",
    selectedContentDigest: sha256Digest("RAG was basically just a hack"),
  },
];

describe("authorizeSemanticCase mechanical gate", () => {
  it("mints a case for a mechanically passed assertion", () => {
    const input = prototypeClaimInput();
    const semanticCase = authorizeSemanticCase({
      bundle: input.bundle,
      deterministicResult: verifyDeterministicBundle(input),
      assertionId: "claim-1",
      selectedFragments,
    });
    expect(semanticCase.assertionId).toBe("claim-1");
  });

  it("throws SEMANTIC_MECHANICAL_GATE_CLOSED when the assertion failed mechanically", () => {
    const corrupted = prototypeClaimInput();
    corrupted.bundle.assertions[0]!.evidence[0]!.fragment.selector = {
      kind: "text_quote",
      quote: "corrupted locator",
      normalization: "none",
    };
    const deterministicResult = verifyDeterministicBundle(corrupted);
    expect(deterministicResult.semanticEligibility).toBe(false);
    expect(() =>
      authorizeSemanticCase({
        bundle: corrupted.bundle,
        deterministicResult,
        assertionId: "claim-1",
        selectedFragments,
      }),
    ).toThrow("SEMANTIC_MECHANICAL_GATE_CLOSED");
  });

  it("throws SEMANTIC_MECHANICAL_GATE_CLOSED when the bundle passed but eligibility was withdrawn", () => {
    const input = prototypeClaimInput();
    const passed = verifyDeterministicBundle(input);
    const withdrawn = { ...passed, semanticEligibility: false };
    expect(() =>
      authorizeSemanticCase({
        bundle: input.bundle,
        deterministicResult: withdrawn,
        assertionId: "claim-1",
        selectedFragments,
      }),
    ).toThrow("SEMANTIC_MECHANICAL_GATE_CLOSED");
  });
});
