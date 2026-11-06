import { VerificationSourceAssessmentSchema, type VerificationSourceAssessment } from "@aiengineer/knowledge-contracts";

export interface AuthorityDecision {
  readonly assertionId: string;
  readonly status: "sufficient" | "withheld" | "unknown";
  readonly independentCorroboration: boolean;
  readonly conflictPresent: boolean;
  readonly reasonCodes: readonly string[];
}

const independentRequired = new Set<VerificationSourceAssessment["claimScope"]>([
  "population_accuracy",
  "clinical_utility",
  "comparative_superiority",
  "causal",
  "product_validation",
]);

export function assessSourceAuthority(
  assertionId: string,
  rawAssessments: readonly VerificationSourceAssessment[],
): AuthorityDecision {
  const assessments = rawAssessments.map((item) => VerificationSourceAssessmentSchema.parse(item));
  if (assessments.some((item) => item.assertionId !== assertionId))
    throw new Error("AUTHORITY_ASSERTION_BINDING_MISMATCH");
  const fragmentIds = assessments.map((item) => item.fragmentId);
  if (new Set(fragmentIds).size !== fragmentIds.length) throw new Error("AUTHORITY_FRAGMENT_DUPLICATE");
  if (assessments.length === 0)
    return Object.freeze({
      assertionId,
      status: "unknown",
      independentCorroboration: false,
      conflictPresent: false,
      reasonCodes: Object.freeze(["NO_SOURCE_ASSESSMENT"]),
    });
  const scopes = new Set(assessments.map((item) => item.claimScope));
  if (scopes.size !== 1) throw new Error("AUTHORITY_CLAIM_SCOPE_CONFLICT");
  const scope = assessments[0]!.claimScope;
  const conflicts = new Set(assessments.flatMap((item) => (item.conflictSetId ? [item.conflictSetId] : [])));
  const independent = assessments.filter(
    (item) =>
      item.vector.independence === "independent" &&
      item.vector.authority !== "promotional" &&
      item.vector.applicability === "direct" &&
      item.vector.directness === "direct",
  );
  const independentFamilies = new Set(independent.map((item) => item.sourceFamilyId));
  const independentCorroboration = independentFamilies.size > 0;
  const reasons: string[] = [];
  let status: AuthorityDecision["status"] = "sufficient";
  if (
    assessments.some(
      (item) => item.vector.authority === "unknown" || item.vector.applicability === "unknown" || !item.freshnessKnown,
    )
  ) {
    status = "unknown";
    reasons.push("CRITICAL_AUTHORITY_FACT_UNKNOWN");
  }
  if (independentRequired.has(scope) && !independentCorroboration) {
    status = "withheld";
    reasons.push("INDEPENDENT_DIRECT_AUTHORITY_REQUIRED");
  }
  if (scope === "population_accuracy" && !independent.some((item) => item.evidenceScope === "population")) {
    status = "withheld";
    reasons.push("SINGLE_SAMPLE_TECHNICAL_RESULT_NOT_POPULATION_ACCURACY");
  }
  if (scope === "product_validation" && !independent.some((item) => item.publicationRelation === "validates_product")) {
    status = "withheld";
    reasons.push("PUBLICATION_DOES_NOT_VALIDATE_PRODUCT");
  }
  if (assessments.every((item) => ["promotional", "secondary"].includes(item.vector.authority))) {
    status = "withheld";
    reasons.push("PROMOTIONAL_OR_SECONDARY_ONLY");
  }
  if (conflicts.size > 0) reasons.push("SOURCE_CONFLICT_PRESENT");
  return Object.freeze({
    assertionId,
    status,
    independentCorroboration,
    conflictPresent: conflicts.size > 0,
    reasonCodes: Object.freeze([...new Set(reasons)].sort()),
  });
}
