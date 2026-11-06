import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson } from "../canonical/index.js";
import { deepFreeze } from "../internal/deep-freeze.js";
import {
  CROSS_FIELD_TOTAL_SCHEMA_VERSION,
  EXTRACTION_FIELD_EVIDENCE_SCHEMA_VERSION,
  EXTRACTION_FIELD_FRAGMENT_SCHEMA_VERSION,
} from "../versions.js";
import type {
  CrossFieldTotalRule,
  ExtractionFieldRule,
  ExtractionFieldVerificationInput,
  ExtractionFieldVerificationResult,
} from "./field-rules.js";
import { verifyExtractionFieldsWithAcceptedSelections } from "./field-verification.js";

export type ExtractionEvidenceJsonScalar = string | number | boolean | null;
export type ExtractionNormalizationOperation =
  | "trim_ascii"
  | "ascii_whitespace_collapsed"
  | "decimal_exact"
  | "percentage_exact"
  | "currency_code_amount"
  | "unit_token"
  | "date_calendar"
  | "datetime_instant"
  | "enum_membership"
  | "identifier_format"
  | "checksum";
export type ExtractionLeafDerivation =
  | {
      readonly kind: "direct";
      readonly comparison: ExtractionFieldRule["comparison"];
    }
  | {
      readonly kind: "normalized";
      readonly comparison: ExtractionFieldRule["comparison"];
      readonly operation: ExtractionNormalizationOperation;
    };
export interface AcceptedExtractionLeaf {
  readonly path: string;
  readonly value: ExtractionEvidenceJsonScalar;
  readonly rawValue: ExtractionEvidenceJsonScalar;
  readonly derivation: ExtractionLeafDerivation;
  readonly source: {
    readonly captureId: string;
    readonly representationArtifactId: string;
    readonly representationDigest: `sha256:${string}`;
    readonly selector: VerificationSelector;
    readonly selectedContentDigest: `sha256:${string}`;
    readonly fragmentId: `fragment:${string}`;
  };
  /** Declared deterministic replay metadata. This does not claim that source evidence generated the value. */
  readonly computation?: {
    readonly schemaVersion: typeof CROSS_FIELD_TOTAL_SCHEMA_VERSION;
    readonly operation: CrossFieldTotalRule["operation"];
    readonly operandPaths: readonly string[];
    readonly tolerance: string;
  };
}
/** Core evidence only. Persistence requires the admission layer's registered parser lineage. */
export interface ExtractionFieldEvidenceResult extends ExtractionFieldVerificationResult {
  readonly schemaVersion: typeof EXTRACTION_FIELD_EVIDENCE_SCHEMA_VERSION;
  readonly acceptedLeaves: readonly AcceptedExtractionLeaf[];
}

const scalar = (value: unknown): value is ExtractionEvidenceJsonScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
function operation(
  rule: ExtractionFieldRule,
  input: ExtractionFieldVerificationInput,
): ExtractionNormalizationOperation {
  if (rule.comparison === "normalized_text")
    return input.normalizations?.find((item) => item.id === rule.normalizationId)?.operation ?? "trim_ascii";
  if (rule.comparison === "decimal") return "decimal_exact";
  if (rule.comparison === "percentage") return "percentage_exact";
  if (rule.comparison === "currency") return "currency_code_amount";
  if (rule.comparison === "unit") return "unit_token";
  if (rule.comparison === "date") return "date_calendar";
  if (rule.comparison === "datetime") return "datetime_instant";
  if (rule.comparison === "enum") return "enum_membership";
  if (rule.comparison === "identifier") return "identifier_format";
  return "checksum";
}
function copiedChecks(result: ExtractionFieldVerificationResult) {
  return result.checks.map((item) => deepFreeze({ ...item }));
}
function failed(result: ExtractionFieldVerificationResult, code: string): ExtractionFieldEvidenceResult {
  return deepFreeze({
    schemaVersion: EXTRACTION_FIELD_EVIDENCE_SCHEMA_VERSION,
    valid: false,
    candidateValid: result.candidateValid,
    checks: [
      ...copiedChecks(result),
      deepFreeze({
        code,
        path: "",
        status: "failed" as const,
        detail: "Accepted field evidence could not be reconstructed from the verified deterministic inputs.",
      }),
    ],
    acceptedLeaves: [],
  });
}

/**
 * Adds immutable leaf evidence to the existing field verifier. It calls the legacy
 * verifier first and never changes its byte/shape contract used by sealed replay.
 */
export function verifyExtractionFieldsWithEvidence(
  input: ExtractionFieldVerificationInput,
): ExtractionFieldEvidenceResult {
  const { result, selections } = verifyExtractionFieldsWithAcceptedSelections(input);
  if (!result.valid)
    return deepFreeze({
      schemaVersion: EXTRACTION_FIELD_EVIDENCE_SCHEMA_VERSION,
      valid: false,
      candidateValid: result.candidateValid,
      checks: copiedChecks(result),
      acceptedLeaves: [],
    });
  const totals = new Map<string, CrossFieldTotalRule>();
  for (const total of input.totals ?? []) {
    if (totals.has(total.resultPath)) return failed(result, "ACCEPTED_LEAF_TOTAL_DUPLICATE");
    totals.set(total.resultPath, total);
  }
  const selectedByPath = new Map(selections.map((item) => [item.path, item]));
  const leaves: AcceptedExtractionLeaf[] = [];
  for (const path of [...selectedByPath.keys()].sort()) {
    const selected = selectedByPath.get(path)!;
    if (!scalar(selected.value) || !scalar(selected.rawValue)) return failed(result, "ACCEPTED_LEAF_SELECTION_INVALID");
    const rule = selected.rule,
      edge = selected.evidence;
    const same = canonicalizeJson(selected.value) === canonicalizeJson(selected.rawValue);
    // Direct describes value preservation, not absence of typed validation; comparison records that rule.
    const derivation: ExtractionLeafDerivation =
      same && rule.comparison !== "normalized_text"
        ? { kind: "direct", comparison: rule.comparison }
        : {
            kind: "normalized",
            comparison: rule.comparison,
            operation: operation(rule, input),
          };
    const fragmentDigest = digestCanonicalJson({
      schemaVersion: EXTRACTION_FIELD_FRAGMENT_SCHEMA_VERSION,
      captureId: edge.captureId,
      representationArtifactId: edge.representationArtifactId,
      representationDigest: edge.representationDigest,
      selector: edge.selector,
      selectedContentDigest: selected.selectedContentDigest,
    });
    const total = totals.get(path);
    leaves.push(
      deepFreeze({
        path,
        value: selected.value,
        rawValue: selected.rawValue,
        derivation,
        source: deepFreeze({
          captureId: edge.captureId,
          representationArtifactId: edge.representationArtifactId,
          representationDigest: edge.representationDigest,
          selector: structuredClone(edge.selector),
          selectedContentDigest: selected.selectedContentDigest,
          fragmentId: `fragment:${fragmentDigest.slice("sha256:".length)}` as `fragment:${string}`,
        }),
        ...(total
          ? {
              computation: deepFreeze({
                schemaVersion: CROSS_FIELD_TOTAL_SCHEMA_VERSION,
                operation: total.operation,
                operandPaths: [...total.operandPaths],
                tolerance: total.tolerance ?? "0",
              }),
            }
          : {}),
      }),
    );
  }
  if (leaves.length !== input.fields.length || selectedByPath.size !== input.fields.length)
    return failed(result, "ACCEPTED_LEAF_INPUT_MISSING");
  return deepFreeze({
    schemaVersion: EXTRACTION_FIELD_EVIDENCE_SCHEMA_VERSION,
    valid: true,
    candidateValid: true,
    checks: copiedChecks(result),
    acceptedLeaves: leaves,
  });
}
