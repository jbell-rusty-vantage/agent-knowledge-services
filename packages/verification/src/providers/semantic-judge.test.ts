import { describe, expect, it } from "vitest";
import { RecordedSemanticJudgeAdapter, ThreeWayNliSemanticJudgeAdapter } from "./semantic-judge.js";
import { digestCanonicalJson } from "../canonical/index.js";

const digest = ("sha256:" + "a".repeat(64)) as `sha256:${string}`;
const output = {
  schemaVersion: "verification-semantic-judge.v1" as const,
  assertionId: "assertion",
  verdict: "directly_supported" as const,
  nliLabel: "entailed" as const,
  supportingFragmentIds: ["fragment"],
  contradictingFragmentIds: [],
  unsupportedFacets: [],
  qualifiersPreserved: true,
  publicRationale: "Recorded fixture.",
};
const identity = (capability: "trained_nli" | "llm_evidence_rubric") => ({
  deploymentId: capability === "trained_nli" ? "nli-lab" : "haiku-lab",
  provider: "fixture",
  family: capability === "trained_nli" ? "nli" : "anthropic",
  model: "fixture-model",
  capability,
  graderVersion: "evidence-only.v1",
  promptDigest: digest,
  outputSchemaDigest: digest,
  configurationDigest: digest,
});

describe("semantic judge adapters", () => {
  it("returns only recorded categorical output and exposes an empty tool catalog", async () => {
    const input = {
      rubricVersion: "evidence-only.v1" as const,
      assertionId: "assertion",
      proposition: "p",
      value: { status: "preview" },
      qualifiers: [],
      entityBindings: [],
      fragments: [],
    };
    const recorded = new Map([[digestCanonicalJson(input), output]]);
    const adapter = new RecordedSemanticJudgeAdapter({
      identity: identity("llm_evidence_rubric"),
      outputs: recorded,
    });
    recorded.clear();
    expect(adapter.toolCatalog).toEqual([]);
    await expect(
      adapter.judge({ ...input, inputArtifactDigest: digestCanonicalJson(input) }, {}),
    ).resolves.toMatchObject({ verdict: "directly_supported" });
    await expect(
      adapter.judge(
        {
          ...input,
          inputArtifactDigest: digestCanonicalJson({
            ...input,
            value: { status: "ga" },
          }),
        },
        {},
      ),
    ).rejects.toThrow("RECORDED_JUDGE_FIXTURE_MISSING");
  });

  it("adapts a bounded three-way NLI classifier without tools", async () => {
    let observed: unknown;
    const adapter = new ThreeWayNliSemanticJudgeAdapter({
      identity: identity("trained_nli"),
      classify: async (input) => {
        observed = input;
        return output;
      },
    });
    expect(adapter.toolCatalog).toEqual([]);
    await expect(
      adapter.judge(
        {
          rubricVersion: "evidence-only.v1",
          assertionId: "assertion",
          proposition: "p",
          value: { status: "preview" },
          qualifiers: [],
          entityBindings: [],
          fragments: [{ fragmentId: "fragment", exactText: "e" }],
        },
        {},
      ),
    ).resolves.toMatchObject({ nliLabel: "entailed" });
    expect(observed).toMatchObject({
      assertionId: "assertion",
      value: { status: "preview" },
      qualifiers: [],
      entityBindings: [],
      execution: {},
    });
  });
});
