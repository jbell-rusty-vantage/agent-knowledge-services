import { describe, expect, it } from "vitest";
import { sha256Digest } from "../canonical/index.js";
import { verifyDeterministicBundle } from "../deterministic/index.js";
import { prototypeClaimInput } from "../deterministic/engine-golden.fixture.js";
import { verifyAssertionSemantics, type SemanticJudgeAdapter } from "./index.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function adapter(output: unknown): SemanticJudgeAdapter {
  return {
    identity: {
      deploymentId: "luna-a",
      provider: "declared-synthetic",
      family: "luna",
      model: "synthetic-luna",
      capability: "llm_evidence_rubric",
      graderVersion: "synthetic.v1",
      promptDigest: digest,
      outputSchemaDigest: digest,
      configurationDigest: digest,
    },
    maximumInputCharacters: 64_000,
    judge: async () => output,
  };
}

function directOutput(): Record<string, unknown> {
  return {
    schemaVersion: "verification-semantic-judge.v1",
    assertionId: "claim-1",
    verdict: "directly_supported",
    nliLabel: "entailed",
    supportingFragmentIds: ["fragment-evidence-1"],
    contradictingFragmentIds: [],
    unsupportedFacets: [],
    qualifiersPreserved: true,
    publicRationale: "Synthetic fixture judgment over the cited fragment.",
    rawProviderConfidence: 0.7,
  };
}

async function judgeFailure(output: unknown): Promise<string | undefined> {
  const input = prototypeClaimInput();
  try {
    await verifyAssertionSemantics({
      bundle: input.bundle,
      deterministicResult: verifyDeterministicBundle(input),
      assertionId: "claim-1",
      selectedFragments: [
        {
          evidenceId: "evidence-1",
          fragmentId: "fragment-evidence-1",
          exactText: "RAG was basically just a hack",
          selectedContentDigest: sha256Digest("RAG was basically just a hack"),
        },
      ],
      adapters: { primary: adapter(output) },
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function nestedObjects(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const child: Record<string, unknown> = {};
    cursor.child = child;
    cursor = child;
  }
  return root;
}

describe("semantic judge output preflight failure precedence", () => {
  it("accepts a well-formed output", async () => {
    expect(await judgeFailure(directOutput())).toBeUndefined();
  });

  it("reports a cyclic output as JUDGE_OUTPUT_NOT_SERIALIZABLE", async () => {
    const output: Record<string, unknown> = directOutput();
    output.self = output;
    expect(await judgeFailure(output)).toBe("JUDGE_OUTPUT_NOT_SERIALIZABLE");
  });

  it("reports an aliased subtree as JUDGE_OUTPUT_NOT_SERIALIZABLE", async () => {
    const shared = { v: 1 };
    expect(await judgeFailure({ ...directOutput(), a: shared, b: shared })).toBe("JUDGE_OUTPUT_NOT_SERIALIZABLE");
  });

  it("reports depth beyond 8 as JUDGE_OUTPUT_STRUCTURE_EXCEEDED", async () => {
    expect(await judgeFailure({ ...directOutput(), extra: nestedObjects(9) })).toBe("JUDGE_OUTPUT_STRUCTURE_EXCEEDED");
  });

  it("reports more than 256 nodes as JUDGE_OUTPUT_STRUCTURE_EXCEEDED", async () => {
    const wide = Array.from({ length: 60 }, () => [1, 1, 1, 1]);
    expect(await judgeFailure({ ...directOutput(), extra: wide })).toBe("JUDGE_OUTPUT_STRUCTURE_EXCEEDED");
  });

  it("reports an array longer than 64 as JUDGE_OUTPUT_STRUCTURE_EXCEEDED", async () => {
    const extra = Array.from({ length: 65 }, () => 1);
    expect(await judgeFailure({ ...directOutput(), extra })).toBe("JUDGE_OUTPUT_STRUCTURE_EXCEEDED");
  });

  it("reports an object with more than 32 entries as JUDGE_OUTPUT_STRUCTURE_EXCEEDED", async () => {
    const extra: Record<string, unknown> = {};
    for (let index = 0; index < 33; index += 1) extra[`k${index}`] = 1;
    expect(await judgeFailure({ ...directOutput(), extra })).toBe("JUDGE_OUTPUT_STRUCTURE_EXCEEDED");
  });

  it("reports more than 16 000 characters as JUDGE_OUTPUT_CAPACITY_EXCEEDED", async () => {
    expect(await judgeFailure({ ...directOutput(), extra: "x".repeat(16_001) })).toBe("JUDGE_OUTPUT_CAPACITY_EXCEEDED");
  });

  it("reports a key longer than 160 characters as JUDGE_OUTPUT_CAPACITY_EXCEEDED", async () => {
    expect(await judgeFailure({ ...directOutput(), ["k".repeat(161)]: 1 })).toBe("JUDGE_OUTPUT_CAPACITY_EXCEEDED");
  });

  it("measures characters, not bytes", async () => {
    const output = { ...directOutput(), extra: "é".repeat(15_000) };
    const failure = await judgeFailure(output);
    expect(failure).not.toBe("JUDGE_OUTPUT_CAPACITY_EXCEEDED");
  });

  it("lets the structure bound win over a cycle that sits deeper than 8", async () => {
    const extra = nestedObjects(12);
    let cursor: Record<string, unknown> = extra;
    while (typeof cursor.child === "object" && cursor.child !== null) cursor = cursor.child as Record<string, unknown>;
    cursor.back = extra;
    expect(await judgeFailure({ ...directOutput(), extra })).toBe("JUDGE_OUTPUT_STRUCTURE_EXCEEDED");
  });
});
