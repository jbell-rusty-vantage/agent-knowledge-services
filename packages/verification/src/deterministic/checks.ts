import type { VerificationCheck } from "@aiengineer/knowledge-contracts";

/**
 * Every deterministic check code the engine can emit. Codes are retained in
 * results and summarized in `failedCheckCodes`; renaming one is a contract change.
 */
export const CHECK = {
  SOURCE_IDS_UNIQUE: "SOURCE_IDS_UNIQUE",
  ARTIFACT_IDS_UNIQUE: "ARTIFACT_IDS_UNIQUE",
  CAPTURE_IDS_UNIQUE: "CAPTURE_IDS_UNIQUE",
  OBSERVATION_IDS_UNIQUE: "OBSERVATION_IDS_UNIQUE",
  CAPTURE_SOURCE_PRESENT: "CAPTURE_SOURCE_PRESENT",
  CAPTURE_ARTIFACT_PRESENT: "CAPTURE_ARTIFACT_PRESENT",
  CAPTURE_DIGEST_MATCH: "CAPTURE_DIGEST_MATCH",
  CAPTURE_BYTE_LENGTH_MATCH: "CAPTURE_BYTE_LENGTH_MATCH",
  PROJECTION_DIGEST_MATCH: "PROJECTION_DIGEST_MATCH",
  PROJECTION_BYTE_LENGTH_MATCH: "PROJECTION_BYTE_LENGTH_MATCH",
  PROJECTION_LINEAGE_BOUND: "PROJECTION_LINEAGE_BOUND",
  RUNTIME_PRINCIPAL_BINDING_MATCH: "RUNTIME_PRINCIPAL_BINDING_MATCH",
  RUNTIME_PRINCIPAL_DIGESTS_VALID: "RUNTIME_PRINCIPAL_DIGESTS_VALID",
  PRODUCER_VERIFIER_INDEPENDENT: "PRODUCER_VERIFIER_INDEPENDENT",
  CAPTURE_PRESENT: "CAPTURE_PRESENT",
  REPRESENTATION_BOUND_TO_CAPTURE: "REPRESENTATION_BOUND_TO_CAPTURE",
  REPRESENTATION_ARTIFACT_VERIFIED: "REPRESENTATION_ARTIFACT_VERIFIED",
  SELECTOR_RESOLVER_ADMITTED: "SELECTOR_RESOLVER_ADMITTED",
  SELECTOR_CAPTURE_BOUND: "SELECTOR_CAPTURE_BOUND",
  SELECTOR_REPRESENTATION_BOUND: "SELECTOR_REPRESENTATION_BOUND",
  SELECTOR_DEFINITION_BOUND: "SELECTOR_DEFINITION_BOUND",
  LOCATOR_UNIQUE: "LOCATOR_UNIQUE",
  SELECTED_CONTENT_DIGEST_REPLAYED: "SELECTED_CONTENT_DIGEST_REPLAYED",
  EXPECTED_SELECTED_CONTENT_DIGEST_MATCH: "EXPECTED_SELECTED_CONTENT_DIGEST_MATCH",
  LOSSY_TEXT_NORMALIZATION: "LOSSY_TEXT_NORMALIZATION",
  ASSERTION_PRODUCER_MATCH: "ASSERTION_PRODUCER_MATCH",
  ASSERTION_ATOMIC: "ASSERTION_ATOMIC",
  EVIDENCE_PRESENT: "EVIDENCE_PRESENT",
  EVIDENCE_MECHANICALLY_VALID: "EVIDENCE_MECHANICALLY_VALID",
  ENTITY_ID_EXPLICIT: "ENTITY_ID_EXPLICIT",
  CANONICAL_NUMBER_VALID: "CANONICAL_NUMBER_VALID",
  UNIT_EXPLICIT_AND_VALID: "UNIT_EXPLICIT_AND_VALID",
  OBSERVATION_PERIOD_VALID: "OBSERVATION_PERIOD_VALID",
  COMPARABILITY_GROUP_PRESENT: "COMPARABILITY_GROUP_PRESENT",
  METRIC_BINDING_DECLARATION_MATCH: "METRIC_BINDING_DECLARATION_MATCH",
  METRIC_FACET_SOURCE_BOUND: "METRIC_FACET_SOURCE_BOUND",
  CALCULATION_GRAPH_ACYCLIC: "CALCULATION_GRAPH_ACYCLIC",
  CALCULATION_OPERAND_PRESENT: "CALCULATION_OPERAND_PRESENT",
  CALCULATION_OPERAND_VALUE_BOUND: "CALCULATION_OPERAND_VALUE_BOUND",
  CALCULATION_OPERAND_VERIFIED: "CALCULATION_OPERAND_VERIFIED",
  CALCULATION_REPLAYS: "CALCULATION_REPLAYS",
  OBSERVED_VALUE_MATCHES_CALCULATION: "OBSERVED_VALUE_MATCHES_CALCULATION",
  DIRECT_OBSERVATION_DECLARED: "DIRECT_OBSERVATION_DECLARED",
} as const;

export type CheckCode = (typeof CHECK)[keyof typeof CHECK];
export type CheckStatus = VerificationCheck["status"];

/** Detail text for a `require`: one string for both outcomes, or one per outcome. */
export type RequireDetail = string | { readonly pass: string; readonly fail: string };

export function verificationCheck(
  code: CheckCode,
  status: CheckStatus,
  severity: VerificationCheck["severity"],
  detail: string,
  targetId?: string,
): VerificationCheck {
  return {
    code,
    status,
    deterministic: true,
    severity,
    detail,
    ...(targetId === undefined ? {} : { targetId }),
  };
}

/** Hard failures dominate; any review or non-hard failure demands review; otherwise passed. */
export function combineCheckStatus(checks: readonly VerificationCheck[]): CheckStatus {
  if (checks.some((item) => item.status === "failed" && item.severity === "hard")) return "failed";
  if (checks.some((item) => item.status === "review_required" || item.status === "failed")) return "review_required";
  return "passed";
}

/**
 * Ordered collector of checks for one verification target. Emission order is
 * retained in the result, so callers add checks in the order they are decided.
 */
export class Checks {
  readonly #items: VerificationCheck[] = [];
  readonly #targetId: string | undefined;

  constructor(targetId?: string) {
    this.#targetId = targetId;
  }

  get items(): readonly VerificationCheck[] {
    return this.#items;
  }

  pass(code: CheckCode, detail: string, targetId = this.#targetId): this {
    return this.add(verificationCheck(code, "passed", "hard", detail, targetId));
  }

  fail(code: CheckCode, detail: string, targetId = this.#targetId): this {
    return this.add(verificationCheck(code, "failed", "hard", detail, targetId));
  }

  review(code: CheckCode, detail: string, targetId = this.#targetId): this {
    return this.add(verificationCheck(code, "review_required", "review", detail, targetId));
  }

  require(code: CheckCode, condition: boolean, detail: RequireDetail, targetId = this.#targetId): this {
    const text = typeof detail === "string" ? detail : condition ? detail.pass : detail.fail;
    return condition ? this.pass(code, text, targetId) : this.fail(code, text, targetId);
  }

  add(check: VerificationCheck): this {
    this.#items.push(check);
    return this;
  }

  status(): CheckStatus {
    return combineCheckStatus(this.#items);
  }
}
