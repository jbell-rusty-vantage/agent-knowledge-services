import { SemanticJudgeOutputSchema, type SemanticJudgeOutput } from "@aiengineer/knowledge-contracts";
import { walkBoundedJson } from "../internal/bounded-json.js";
import type { AuthorizedSemanticCase } from "./authorize.js";

const MAX_SERIALIZED_OUTPUT_CHARS = 16_000;

/**
 * Admits a judge's raw output against the case it was asked about. Structure
 * and size are bounded before schema parsing; then the verdict lattice is
 * enforced so a verdict cannot contradict its own supporting fields.
 */
export function validateJudgeOutput(raw: unknown, semanticCase: AuthorizedSemanticCase): SemanticJudgeOutput {
  preflightJudgeOutput(raw);
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new Error("JUDGE_OUTPUT_NOT_SERIALIZABLE");
  }
  if (!serialized || serialized.length > MAX_SERIALIZED_OUTPUT_CHARS) throw new Error("JUDGE_OUTPUT_CAPACITY_EXCEEDED");
  const output = SemanticJudgeOutputSchema.parse(raw);
  if (output.assertionId !== semanticCase.assertionId) throw new Error("JUDGE_ASSERTION_BINDING_MISMATCH");
  requireFragmentReferencesAuthorized(output, semanticCase);
  requireVerdictConsistentWithFields(output);
  if (!output.qualifiersPreserved && semanticCase.qualifiers.length > 0 && output.unsupportedFacets.length === 0)
    throw new Error("JUDGE_MISSING_QUALIFIER_FACET_REQUIRED");
  return output;
}

/** Every referenced fragment id must be one the judge was given, once, in one role. */
function requireFragmentReferencesAuthorized(output: SemanticJudgeOutput, semanticCase: AuthorizedSemanticCase): void {
  const known = new Set(semanticCase.fragments.map((fragment) => fragment.fragmentId));
  const referenced = referencedFragmentIds(output);
  if (referenced.some((id) => !known.has(id))) throw new Error("JUDGE_FRAGMENT_ID_INVENTED");
  if (hasDuplicates(output.supportingFragmentIds) || hasDuplicates(output.contradictingFragmentIds))
    throw new Error("JUDGE_FRAGMENT_ID_DUPLICATE");
  if (hasDuplicates(output.unsupportedFacets)) throw new Error("JUDGE_UNSUPPORTED_FACET_DUPLICATE");
  if (output.supportingFragmentIds.some((id) => output.contradictingFragmentIds.includes(id)))
    throw new Error("JUDGE_FRAGMENT_ROLE_CONFLICT");
}

type Verdict = SemanticJudgeOutput["verdict"];

const SUPPORT_VERDICTS: readonly Verdict[] = [
  "directly_supported",
  "supported_with_qualification",
  "partially_supported",
];
const QUALIFIED_VERDICTS: readonly Verdict[] = ["supported_with_qualification", "partially_supported"];
const NEUTRAL_VERDICTS: readonly Verdict[] = ["not_supported", "insufficient_evidence", "context_only"];
const UNSUPPORTED_VERDICTS: readonly Verdict[] = ["not_supported", "insufficient_evidence"];

/** The verdict lattice: each verdict constrains the NLI label, fragment roles, facets and qualifier flag. Order of checks is retained. */
function requireVerdictConsistentWithFields(output: SemanticJudgeOutput): void {
  const { verdict } = output;
  if (SUPPORT_VERDICTS.includes(verdict) && output.supportingFragmentIds.length === 0)
    throw new Error("JUDGE_SUPPORT_FRAGMENT_REQUIRED");
  if (verdict === "directly_supported" && !isCleanDirectSupport(output))
    throw new Error("JUDGE_DIRECT_SUPPORT_FIELDS_CONTRADICT");
  if (
    verdict === "supported_with_qualification" &&
    (output.nliLabel === "contradicted" || output.contradictingFragmentIds.length > 0)
  )
    throw new Error("JUDGE_QUALIFIED_SUPPORT_FIELDS_CONTRADICT");
  if (verdict === "partially_supported" && output.nliLabel === "contradicted")
    throw new Error("JUDGE_PARTIAL_SUPPORT_FIELDS_CONTRADICT");
  if (QUALIFIED_VERDICTS.includes(verdict) && output.unsupportedFacets.length === 0)
    throw new Error("JUDGE_QUALIFICATION_FACET_REQUIRED");
  if (verdict === "contradicted" && !isCleanContradiction(output))
    throw new Error("JUDGE_CONTRADICTION_FIELDS_CONTRADICT");
  if (NEUTRAL_VERDICTS.includes(verdict) && output.nliLabel !== "neutral")
    throw new Error("JUDGE_NEUTRAL_FIELDS_CONTRADICT");
  if (UNSUPPORTED_VERDICTS.includes(verdict) && referencedFragmentIds(output).length > 0)
    throw new Error("JUDGE_UNSUPPORTED_FRAGMENT_FIELDS_CONTRADICT");
}

const isCleanDirectSupport = (output: SemanticJudgeOutput): boolean =>
  output.nliLabel === "entailed" &&
  output.unsupportedFacets.length === 0 &&
  output.qualifiersPreserved &&
  output.contradictingFragmentIds.length === 0;

const isCleanContradiction = (output: SemanticJudgeOutput): boolean =>
  output.nliLabel === "contradicted" &&
  output.contradictingFragmentIds.length > 0 &&
  output.supportingFragmentIds.length === 0;

const referencedFragmentIds = (output: SemanticJudgeOutput): string[] => [
  ...output.supportingFragmentIds,
  ...output.contradictingFragmentIds,
];

const hasDuplicates = (values: readonly string[]): boolean => new Set(values).size !== values.length;

const JUDGE_OUTPUT_LIMITS = {
  maximumNodes: 256,
  maximumDepth: 8,
  maximumCollection: 64,
  maximumObjectEntries: 32,
  maximumStringBudget: 16_000,
  maximumKeyLength: 160,
} as const;
const characterLength = (value: string): number => value.length;

/** Judge output is measured in UTF-16 units; numbers and non-JSON values are left to schema validation. */
export function preflightJudgeOutput(root: unknown): void {
  const violation = walkBoundedJson(root, {
    limits: JUDGE_OUTPUT_LIMITS,
    measure: { string: characterLength, key: characterLength },
    rejectNonFiniteNumbers: false,
    rejectNonJsonValues: false,
    plainObjectsOnly: false,
  });
  if (!violation) return;
  switch (violation.kind) {
    case "aliased_node":
      throw new Error("JUDGE_OUTPUT_NOT_SERIALIZABLE");
    case "string_budget":
    case "key_length":
      throw new Error("JUDGE_OUTPUT_CAPACITY_EXCEEDED");
    default:
      throw new Error("JUDGE_OUTPUT_STRUCTURE_EXCEEDED");
  }
}
