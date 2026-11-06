import {
  SemanticAssessmentRecordSchema,
  SemanticJudgeIdentitySchema,
  type SemanticAssessmentRecord,
  type SemanticJudgeIdentity,
  type SemanticJudgeOutput,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson } from "../canonical/index.js";
import {
  isRuntimeAuthorizedSemanticCase,
  MAX_TOTAL_CHARS,
  semanticJudgeInput,
  type AuthorizedSemanticCase,
} from "./authorize.js";
import { validateJudgeOutput } from "./judge-output.js";
import type { SemanticJudgeAdapter, SemanticJudgeExecution } from "./ports.js";

export interface SemanticJudgeAdapters {
  readonly primary: SemanticJudgeAdapter;
  readonly crossFamily?: SemanticJudgeAdapter;
}

interface AdapterSnapshot {
  readonly adapter: SemanticJudgeAdapter;
  readonly identity: SemanticJudgeIdentity;
  readonly maximumInputCharacters: number;
}

interface Judgment {
  readonly identity: SemanticJudgeIdentity;
  readonly output: SemanticJudgeOutput;
}

type Verdict = SemanticJudgeOutput["verdict"];

const uncertain = new Set<Verdict>([
  "supported_with_qualification",
  "partially_supported",
  "context_only",
  "insufficient_evidence",
]);
const supported = new Set<Verdict>(["directly_supported", "supported_with_qualification"]);

/**
 * Judges an authorized case: snapshot the adapters → primary judgment → a
 * cross-family second judgment when risk or uncertainty requires one →
 * reconcile into one assessment record. Only runtime-authorized cases are
 * accepted; a structurally identical object is rejected.
 */
export async function verifySemanticCase(
  semanticCase: AuthorizedSemanticCase,
  adapters: SemanticJudgeAdapters,
  execution: SemanticJudgeExecution = {},
): Promise<SemanticAssessmentRecord> {
  if (!isRuntimeAuthorizedSemanticCase(semanticCase)) throw new Error("SEMANTIC_CASE_NOT_RUNTIME_AUTHORIZED");
  const primarySnapshot = snapshotAdapter(adapters.primary);
  const crossFamilySnapshot = adapters.crossFamily ? snapshotAdapter(adapters.crossFamily) : undefined;
  const primary = await runJudge(primarySnapshot, semanticCase, execution);
  const secondRequired = ["high", "critical"].includes(semanticCase.riskClass) || uncertain.has(primary.output.verdict);
  const judgments: Judgment[] = [primary];
  let crossFamily = false;
  if (secondRequired && crossFamilySnapshot) {
    crossFamily = isCrossFamily(primary.identity, crossFamilySnapshot.identity);
    if (crossFamily) judgments.push(await runJudge(crossFamilySnapshot, semanticCase, execution));
  }
  return reconcileJudgments({
    semanticCase,
    judgments,
    secondRequired,
    crossFamily,
  });
}

/** A second judge only counts when it is a different model family on a different deployment. */
const isCrossFamily = (primary: SemanticJudgeIdentity, second: SemanticJudgeIdentity): boolean =>
  second.family !== primary.family && second.deploymentId !== primary.deploymentId;

/** Adapter identity and capacity are read once, before any judgment, so a misbehaving adapter cannot change them mid-run. */
function snapshotAdapter(adapter: SemanticJudgeAdapter): AdapterSnapshot {
  const identity = Object.freeze(SemanticJudgeIdentitySchema.parse(adapter.identity));
  if (
    !Number.isInteger(adapter.maximumInputCharacters) ||
    adapter.maximumInputCharacters < 1 ||
    adapter.maximumInputCharacters > MAX_TOTAL_CHARS
  )
    throw new Error("JUDGE_CAPACITY_INVALID");
  if (adapter.toolCatalog !== undefined && adapter.toolCatalog.length !== 0)
    throw new Error("JUDGE_TOOL_CATALOG_NOT_EMPTY");
  return Object.freeze({
    adapter,
    identity,
    maximumInputCharacters: adapter.maximumInputCharacters,
  });
}

async function runJudge(
  snapshot: AdapterSnapshot,
  semanticCase: AuthorizedSemanticCase,
  execution: SemanticJudgeExecution,
): Promise<Judgment> {
  assertExecutionActive(execution);
  if (inputCharacterCount(semanticCase) > snapshot.maximumInputCharacters)
    throw new Error("JUDGE_INPUT_CAPACITY_EXCEEDED");
  const blindedInput = semanticJudgeInput(semanticCase);
  const raw = await snapshot.adapter.judge(
    { ...blindedInput, inputArtifactDigest: digestCanonicalJson(blindedInput) },
    execution,
  );
  assertExecutionActive(execution);
  return {
    identity: snapshot.identity,
    output: validateJudgeOutput(raw, semanticCase),
  };
}

function inputCharacterCount(semanticCase: AuthorizedSemanticCase): number {
  return (
    semanticCase.assertionId.length +
    semanticCase.proposition.length +
    (semanticCase.value === undefined ? 0 : canonicalizeJson(semanticCase.value).length) +
    semanticCase.qualifiers.reduce((sum, item) => sum + item.length, 0) +
    semanticCase.entityBindings.reduce((sum, item) => sum + item.role.length + item.canonicalId.length, 0) +
    semanticCase.fragments.reduce((sum, item) => sum + item.fragmentId.length + item.exactText.length, 0)
  );
}

function assertExecutionActive(execution: SemanticJudgeExecution): void {
  if (execution.signal?.aborted) throw new Error("JUDGE_CANCELLED");
  if (execution.deadlineEpochMs !== undefined) {
    if (!Number.isFinite(execution.deadlineEpochMs) || execution.deadlineEpochMs <= 0)
      throw new Error("JUDGE_DEADLINE_INVALID");
    if (Date.now() >= execution.deadlineEpochMs) throw new Error("JUDGE_DEADLINE_EXCEEDED");
  }
}

interface ReconcileInput {
  readonly semanticCase: AuthorizedSemanticCase;
  readonly judgments: readonly Judgment[];
  readonly secondRequired: boolean;
  readonly crossFamily: boolean;
}

/** Primary verdict, downgraded to review/abstain when a required second judge was unavailable or disagreed. */
function reconcileJudgments({
  semanticCase,
  judgments,
  secondRequired,
  crossFamily,
}: ReconcileInput): SemanticAssessmentRecord {
  const primary = judgments[0]!;
  const outputs = judgments.map((item) => item.output);
  let verdict: SemanticAssessmentRecord["verdict"] = primary.output.verdict;
  let disposition: SemanticAssessmentRecord["disposition"] = supported.has(primary.output.verdict)
    ? "admit"
    : primary.output.verdict === "contradicted"
      ? "fail"
      : "review";
  const reasonCodes: string[] = [];
  if (secondRequired && !crossFamily) {
    disposition = semanticCase.riskClass === "critical" ? "abstain" : "review";
    reasonCodes.push("CROSS_FAMILY_SECOND_JUDGE_REQUIRED");
  }
  if (judgments.length === 2 && judgments[0]!.output.verdict !== judgments[1]!.output.verdict) {
    const bothSupport = outputs.every((output) => supported.has(output.verdict));
    verdict = bothSupport ? "supported_with_qualification" : "mixed_or_conflicting";
    disposition = "review";
    reasonCodes.push("JUDGE_DISAGREEMENT");
  }
  if (
    outputs.some((output) => output.verdict === "contradicted") &&
    outputs.some((output) => supported.has(output.verdict))
  ) {
    verdict = "mixed_or_conflicting";
    disposition = "review";
  }
  const evidenceSupport =
    verdict === "directly_supported" || verdict === "supported_with_qualification"
      ? "satisfied"
      : verdict === "contradicted" || verdict === "not_supported"
        ? "not_satisfied"
        : "unknown";
  return SemanticAssessmentRecordSchema.parse({
    assertionId: semanticCase.assertionId,
    ...(semanticCase.value !== undefined ? { assertionValueDigest: digestCanonicalJson(semanticCase.value) } : {}),
    verdict,
    disposition,
    evidenceSupport,
    worldCorrectness: "not_assessed",
    attributionFaithfulness: "not_assessed",
    sourceAuthority: "not_assessed",
    provenanceIntegrity: "satisfied",
    judgeIdentities: judgments.map((item) => item.identity),
    supportingFragmentIds: unique(outputs.flatMap((output) => output.supportingFragmentIds)),
    contradictingFragmentIds: unique(outputs.flatMap((output) => output.contradictingFragmentIds)),
    unsupportedFacets: unique(outputs.flatMap((output) => output.unsupportedFacets)),
    reasonCodes,
    crossFamilySecondJudge: crossFamily,
    rawProviderConfidences: judgments.flatMap((item) =>
      item.output.rawProviderConfidence === undefined
        ? []
        : [
            {
              deploymentId: item.identity.deploymentId,
              value: item.output.rawProviderConfidence,
            },
          ],
    ),
  });
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
