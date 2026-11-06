import { describe, expect, it, vi } from "vitest";
import { digestCanonicalJson, sha256Digest } from "../canonical/index.js";
import { verifyDeterministicBundle } from "../deterministic/index.js";
import { prototypeClaimInput } from "../deterministic/engine-golden.fixture.js";
import {
  authorizeSemanticCase,
  semanticJudgeInput,
  observeSemanticModelDrift,
  verifyAssertionSemantics,
  verifySemanticCase,
  type AuthorizedSemanticCase,
  type SemanticJudgeAdapter,
} from "./index.js";

const digest = `sha256:${"a".repeat(64)}` as const;
function adapter(deploymentId: string, family: string, output: Record<string, unknown>): SemanticJudgeAdapter {
  return {
    identity: {
      deploymentId,
      provider: "declared-synthetic",
      family,
      model: `synthetic-${family}`,
      capability: "llm_evidence_rubric",
      graderVersion: "synthetic.v1",
      promptDigest: digest,
      outputSchemaDigest: digest,
      configurationDigest: digest,
    },
    maximumInputCharacters: 64_000,
    judge: vi.fn(async () => output),
  };
}

function directOutput(verdict = "directly_supported") {
  return {
    schemaVersion: "verification-semantic-judge.v1",
    assertionId: "claim-1",
    verdict,
    nliLabel: verdict === "contradicted" ? "contradicted" : verdict === "directly_supported" ? "entailed" : "neutral",
    supportingFragmentIds: verdict === "contradicted" ? [] : ["fragment-evidence-1"],
    contradictingFragmentIds: verdict === "contradicted" ? ["fragment-evidence-1"] : [],
    unsupportedFacets: [],
    qualifiersPreserved: true,
    publicRationale: "Synthetic fixture judgment over the cited fragment.",
    rawProviderConfidence: 0.7,
  };
}

function fixture() {
  const input = prototypeClaimInput();
  const deterministicResult = verifyDeterministicBundle(input);
  return {
    input,
    deterministicResult,
    selectedFragments: [
      {
        evidenceId: "evidence-1",
        fragmentId: "fragment-evidence-1",
        exactText: "RAG was basically just a hack",
        selectedContentDigest: sha256Digest("RAG was basically just a hack"),
      },
    ],
  };
}

describe("evidence-closed semantic verification with declared synthetic adapters", () => {
  it("records returned-model drift as an alert class", () => {
    expect(
      observeSemanticModelDrift({
        requestedModel: "haiku",
        returnedModel: "luna",
        deploymentId: "judge-1",
      }),
    ).toMatchObject({ drifted: true, alertClass: "returned_model_mismatch" });
    expect(
      observeSemanticModelDrift({
        requestedModel: "haiku",
        deploymentId: "judge-1",
      }),
    ).toMatchObject({ drifted: false, alertClass: "none" });
  });
  it("passes only mechanically selected fragment bytes and keeps provider confidence uncalibrated", async () => {
    const value = fixture();
    const primary = adapter("gateway-luna-runtime", "luna", directOutput());
    const result = await verifyAssertionSemantics({
      bundle: value.input.bundle,
      deterministicResult: value.deterministicResult,
      assertionId: "claim-1",
      selectedFragments: value.selectedFragments,
      adapters: { primary },
    });
    expect(result).toMatchObject({
      verdict: "directly_supported",
      disposition: "admit",
      worldCorrectness: "not_assessed",
      attributionFaithfulness: "not_assessed",
      sourceAuthority: "not_assessed",
    });
    expect(result.rawProviderConfidences).toEqual([{ deploymentId: "gateway-luna-runtime", value: 0.7 }]);
    expect(result).not.toHaveProperty("calibratedProbability");
    expect(primary.judge).toHaveBeenCalledTimes(1);
  });

  it("requires an actual cross-family deployment for high-risk and disagreement review", async () => {
    const value = fixture();
    value.input.bundle.assertions[0]!.riskClass = "high";
    const deterministicResult = verifyDeterministicBundle(value.input);
    const sameFamily = await verifyAssertionSemantics({
      bundle: value.input.bundle,
      deterministicResult,
      assertionId: "claim-1",
      selectedFragments: value.selectedFragments,
      adapters: {
        primary: adapter("luna-a", "luna", directOutput()),
        crossFamily: adapter("luna-b", "luna", directOutput()),
      },
    });
    expect(sameFamily).toMatchObject({
      disposition: "review",
      crossFamilySecondJudge: false,
      reasonCodes: ["CROSS_FAMILY_SECOND_JUDGE_REQUIRED"],
    });
    const disagreement = await verifyAssertionSemantics({
      bundle: value.input.bundle,
      deterministicResult,
      assertionId: "claim-1",
      selectedFragments: value.selectedFragments,
      adapters: {
        primary: adapter("luna-a", "luna", directOutput()),
        crossFamily: adapter("haiku-a", "haiku", directOutput("contradicted")),
      },
    });
    expect(disagreement).toMatchObject({
      verdict: "mixed_or_conflicting",
      disposition: "review",
      crossFamilySecondJudge: true,
    });
  });

  it("rejects invented fragments, contradictory fields, extra private reasoning and capacity overflow", async () => {
    const value = fixture();
    await expect(
      verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: value.deterministicResult,
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: {
          primary: adapter("luna-a", "luna", {
            ...directOutput(),
            supportingFragmentIds: ["invented"],
          }),
        },
      }),
    ).rejects.toThrow("JUDGE_FRAGMENT_ID_INVENTED");
    await expect(
      verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: value.deterministicResult,
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: {
          primary: adapter("luna-a", "luna", {
            ...directOutput(),
            nliLabel: "contradicted",
          }),
        },
      }),
    ).rejects.toThrow("JUDGE_DIRECT_SUPPORT_FIELDS_CONTRADICT");
    await expect(
      verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: value.deterministicResult,
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: {
          primary: adapter("luna-a", "luna", {
            ...directOutput("supported_with_qualification"),
            nliLabel: "contradicted",
          }),
        },
      }),
    ).rejects.toThrow("JUDGE_QUALIFIED_SUPPORT_FIELDS_CONTRADICT");
    await expect(
      verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: value.deterministicResult,
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: {
          primary: adapter("luna-a", "luna", {
            ...directOutput(),
            privateReasoning: "hidden",
          }),
        },
      }),
    ).rejects.toThrow();
    const tiny = {
      ...adapter("luna-a", "luna", directOutput()),
      maximumInputCharacters: 1,
    };
    await expect(
      verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: value.deterministicResult,
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: { primary: tiny },
      }),
    ).rejects.toThrow("JUDGE_INPUT_CAPACITY_EXCEEDED");
    const deeplyNested: Record<string, unknown> = { ...directOutput() };
    let cursor = deeplyNested;
    for (let depth = 0; depth < 12; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    await expect(
      verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: value.deterministicResult,
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: { primary: adapter("luna-a", "luna", deeplyNested) },
      }),
    ).rejects.toThrow("JUDGE_OUTPUT_STRUCTURE_EXCEEDED");
  });

  it("rejects a structurally fabricated semantic case at runtime", async () => {
    const forged = {
      assertionId: "claim-1",
      proposition: "forged",
      qualifiers: [],
      entityBindings: [],
      riskClass: "low",
      downstreamUse: ["publication"],
      fragments: [],
    } as unknown as AuthorizedSemanticCase;
    await expect(
      verifySemanticCase(forged, {
        primary: adapter("luna-a", "luna", directOutput()),
      }),
    ).rejects.toThrow("SEMANTIC_CASE_NOT_RUNTIME_AUTHORIZED");
  });

  it("propagates per-request cancellation and deadlines without calling the adapter", async () => {
    const value = fixture();
    const primary = adapter("luna-a", "luna", directOutput());
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: value.deterministicResult,
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: { primary },
        execution: { signal: controller.signal },
      }),
    ).rejects.toThrow("JUDGE_CANCELLED");
    await expect(
      verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: value.deterministicResult,
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: { primary },
        execution: { deadlineEpochMs: 1 },
      }),
    ).rejects.toThrow("JUDGE_DEADLINE_EXCEEDED");
    expect(primary.judge).not.toHaveBeenCalled();
  });

  it("closes semantics before any model call on corrupted locators and abstains for unsupported visual selectors", async () => {
    const corrupted = prototypeClaimInput();
    corrupted.bundle.assertions[0]!.evidence[0]!.fragment.selector = {
      kind: "text_quote",
      quote: "corrupted locator",
      normalization: "none",
    };
    const primary = adapter("luna-a", "luna", directOutput());
    const failed = await verifyAssertionSemantics({
      bundle: corrupted.bundle,
      deterministicResult: verifyDeterministicBundle(corrupted),
      assertionId: "claim-1",
      selectedFragments: [],
      adapters: { primary },
    });
    expect(failed).toMatchObject({
      verdict: "locator_error",
      disposition: "fail",
      reasonCodes: ["MECHANICAL_GATE_CLOSED"],
    });
    expect(primary.judge).not.toHaveBeenCalled();

    const visual = prototypeClaimInput();
    visual.bundle.assertions[0]!.evidence[0]!.fragment.selector = {
      kind: "bounding_box",
      page: 1,
      coordinateSpace: "normalized",
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    };
    const visualResult = await verifyAssertionSemantics({
      bundle: visual.bundle,
      deterministicResult: verifyDeterministicBundle(visual),
      assertionId: "claim-1",
      selectedFragments: [],
      adapters: { primary },
    });
    expect(visualResult).toMatchObject({
      verdict: "unverifiable",
      disposition: "abstain",
    });
    expect(primary.judge).not.toHaveBeenCalled();
  });

  it.each(["swapped entity", "swapped algorithm", "swapped count", "swapped negation"])(
    "records %s as contradicted when the evidence-closed synthetic fixture says so",
    async (variant) => {
      const value = fixture();
      value.input.bundle.assertions[0]!.proposition = variant;
      const result = await verifyAssertionSemantics({
        bundle: value.input.bundle,
        deterministicResult: verifyDeterministicBundle(value.input),
        assertionId: "claim-1",
        selectedFragments: value.selectedFragments,
        adapters: {
          primary: adapter("luna-a", "luna", directOutput("contradicted")),
        },
      });
      expect(result).toMatchObject({
        verdict: "contradicted",
        disposition: "fail",
      });
    },
  );
  it("includes normalized values in judged bytes, clones them, and binds the returned assessment", async () => {
    const value = fixture();
    const normalized = { status: "preview", nested: { scope: "limited" } };
    value.input.bundle.assertions[0]!.value = normalized;
    const authorized = authorizeSemanticCase({
      bundle: value.input.bundle,
      deterministicResult: value.deterministicResult,
      assertionId: "claim-1",
      selectedFragments: value.selectedFragments,
    });
    normalized.nested.scope = "unrestricted";
    const input = semanticJudgeInput(authorized);
    expect(input.value).toEqual({
      status: "preview",
      nested: { scope: "limited" },
    });
    const judge = adapter("synthetic", "synthetic", directOutput());
    const assessment = await verifySemanticCase(authorized, { primary: judge });
    expect(assessment.assertionValueDigest).toBe(digestCanonicalJson(input.value));
    expect(judge.judge).toHaveBeenCalledWith(
      expect.objectContaining({
        value: input.value,
        inputArtifactDigest: digestCanonicalJson(input),
      }),
      {},
    );
    expect(digestCanonicalJson({ ...input, value: { status: "ga" } })).not.toBe(digestCanonicalJson(input));
  });
});
