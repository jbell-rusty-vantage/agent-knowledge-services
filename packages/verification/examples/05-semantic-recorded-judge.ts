import {
  RecordedSemanticJudgeAdapter,
  authorizeSemanticCase,
  digestCanonicalJson,
  semanticJudgeInput,
  sha256Digest,
  verifyAssertionSemantics,
  verifyDeterministicBundle,
  type MechanicallySelectedFragment,
  type SemanticJudgeAdapter,
} from "../src/index.js";
import { ASSERTION_ID, EVIDENCE_ID, FRAGMENT_ID, QUOTE, corruptedInput, passingInput } from "./bundle-fixture.js";

/**
 * Stage 4 — semantic support, without a network. `verifyAssertionSemantics`
 * runs closure → authorize → judge: a mechanically failed bundle is closed
 * before any judge is consulted, and a judge only ever sees the fragments the
 * deterministic engine selected. The recorded adapter answers by the digest
 * of that blinded input, so it cannot be steered by anything else.
 */
const placeholderDigest = `sha256:${"a".repeat(64)}` as const;

const identity = {
  deploymentId: "recorded-judge",
  provider: "recorded",
  family: "recorded",
  model: "recorded-fixture",
  capability: "llm_evidence_rubric" as const,
  graderVersion: "evidence-only.v1",
  promptDigest: placeholderDigest,
  outputSchemaDigest: placeholderDigest,
  configurationDigest: placeholderDigest,
};

const selectedFragments: readonly MechanicallySelectedFragment[] = [
  {
    evidenceId: EVIDENCE_ID,
    fragmentId: FRAGMENT_ID,
    exactText: QUOTE,
    selectedContentDigest: sha256Digest(QUOTE),
  },
];

const supportedOutput = {
  schemaVersion: "verification-semantic-judge.v1" as const,
  assertionId: ASSERTION_ID,
  verdict: "directly_supported" as const,
  nliLabel: "entailed" as const,
  supportingFragmentIds: [FRAGMENT_ID],
  contradictingFragmentIds: [],
  unsupportedFacets: [],
  qualifiersPreserved: true,
  publicRationale: "The cited sentence states the sample count directly.",
};

/** A judge that counts invocations and otherwise defers to the recording. */
function countingJudge(recorded: RecordedSemanticJudgeAdapter) {
  let calls = 0;
  const adapter: SemanticJudgeAdapter = {
    identity: recorded.identity,
    maximumInputCharacters: recorded.maximumInputCharacters,
    toolCatalog: [],
    judge(input, execution) {
      calls += 1;
      return recorded.judge(input, execution);
    },
  };
  return { adapter, callCount: () => calls };
}

export async function semanticRecordedJudgeExample() {
  const passing = passingInput();
  const passingResult = verifyDeterministicBundle(passing);
  const authorized = authorizeSemanticCase({
    bundle: passing.bundle,
    deterministicResult: passingResult,
    assertionId: ASSERTION_ID,
    selectedFragments,
  });
  const blindedInputDigest = digestCanonicalJson(semanticJudgeInput(authorized));
  const recorded = new RecordedSemanticJudgeAdapter({
    identity,
    outputs: new Map([[blindedInputDigest, supportedOutput]]),
  });

  const corrupted = corruptedInput();
  const gate = countingJudge(recorded);
  const closed = await verifyAssertionSemantics({
    bundle: corrupted.bundle,
    deterministicResult: verifyDeterministicBundle(corrupted),
    assertionId: ASSERTION_ID,
    selectedFragments,
    adapters: { primary: gate.adapter },
  });

  const judged = countingJudge(recorded);
  const supported = await verifyAssertionSemantics({
    bundle: passing.bundle,
    deterministicResult: passingResult,
    assertionId: ASSERTION_ID,
    selectedFragments,
    adapters: { primary: judged.adapter },
  });

  return {
    blindedInputDigest,
    closed: {
      verdict: closed.verdict,
      disposition: closed.disposition,
      reasonCodes: closed.reasonCodes,
      judgeCalls: gate.callCount(),
    },
    supported: {
      verdict: supported.verdict,
      disposition: supported.disposition,
      supportingFragmentIds: supported.supportingFragmentIds,
      judgeCalls: judged.callCount(),
    },
  };
}
