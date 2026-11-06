import { sha256Digest } from "../canonical/index.js";
import { resolveEvidenceSelector, type EvidenceSelection } from "../evidence-selection/index.js";
import { ExtractionChecks, getAtBoundedPointer, isBoundedJsonPointer } from "./checks.js";
import { checkDuplicateRecords, replayCrossFieldTotals } from "./cross-field.js";
import { compareFieldValue, strictDecimal } from "./field-comparators.js";
import type {
  ExtractionEvidence,
  ExtractionFieldRule,
  ExtractionFieldVerificationInput,
  ExtractionFieldVerificationResult,
  ExtractionNormalizationRule,
  ExtractionScalar,
  FieldComparison,
  ImmutableExtractionRepresentation,
  VerifiedExtractionScalarSelection,
} from "./field-rules.js";
import { validateExtractionCandidate } from "./schema.js";
import { sourceComponentValue } from "./source-component.js";

export interface ExtractionFieldVerification {
  readonly result: ExtractionFieldVerificationResult;
  readonly selections: readonly VerifiedExtractionScalarSelection[];
}

/**
 * Re-resolves every evidence edge from verified bytes. It intentionally receives no provider result/status/confidence field.
 * Upstream persistence must authorize and hydrate the representations; this pure layer verifies their digest and content again.
 */
export function verifyExtractionFields(input: ExtractionFieldVerificationInput): ExtractionFieldVerificationResult {
  return verifyExtractionFieldsWithAcceptedSelections(input).result;
}

/**
 * The one authoritative field-verification pass. Stages, in order: work
 * limits → candidate shape → rule/evidence/representation indexes → one
 * resolution and comparison per candidate leaf → leaf coverage → duplicate
 * records → cross-field totals. Used by the evidence adapter; the legacy
 * result shape never changes.
 */
export function verifyExtractionFieldsWithAcceptedSelections(
  input: ExtractionFieldVerificationInput,
): ExtractionFieldVerification {
  const checks = new ExtractionChecks();
  if (!checkWorkLimits(checks, input)) return candidateInvalid(checks);
  const candidate = validateExtractionCandidate(input.schema, input.candidate);
  for (const item of candidate.checks) checks.fail(item.code, item.path, item.detail);
  if (!candidate.valid) return candidateInvalid(checks);

  const indexes = indexRulesEvidenceRepresentations(checks, input);
  const selections: VerifiedExtractionScalarSelection[] = [];
  for (const path of candidate.leafPaths) {
    const selection = verifyLeaf(checks, input, indexes, path);
    if (selection) selections.push(selection);
  }
  for (const [path] of indexes.ruleByPath)
    if (!candidate.leafPaths.includes(path))
      checks.fail("FIELD_RULE_NOT_LEAF", path, "Field rule points to a missing or non-leaf candidate path.");
  for (const [path] of indexes.evidenceByPath)
    if (!candidate.leafPaths.includes(path))
      checks.fail("FIELD_EVIDENCE_NOT_LEAF", path, "Evidence points to a missing or non-leaf candidate path.");
  checkDuplicateRecords(checks, input.candidate, input.duplicates ?? []);
  replayCrossFieldTotals(checks, input.candidate, input.totals ?? []);

  const result: ExtractionFieldVerificationResult = {
    valid: checks.allPassed,
    candidateValid: true,
    checks: checks.items,
  };
  return { result, selections: result.valid ? Object.freeze(selections) : [] };
}

const candidateInvalid = (checks: ExtractionChecks): ExtractionFieldVerification => ({
  result: { valid: false, candidateValid: false, checks: checks.items },
  selections: [],
});

// ---------------------------------------------------------------------------
// Stage: work limits
// ---------------------------------------------------------------------------

const MAX_FIELD_ITEMS = 10_000;
const MAX_NORMALIZATIONS = 256;
const MAX_CROSS_FIELD_RULES = 1_024;
const MAX_REPRESENTATIONS = 256;
const MAX_REPRESENTATION_BYTES = 1_048_576;
const MAX_TOTAL_REPRESENTATION_BYTES = 64 * 1_024 * 1_024;
const MAX_EVIDENCE_SCAN_BYTES = 64 * 1_024 * 1_024;

/** Hard input bounds, checked before any bytes are hashed or any selector runs. Returns false on the first violation. */
function checkWorkLimits(checks: ExtractionChecks, input: ExtractionFieldVerificationInput): boolean {
  if (
    input.fields.length > MAX_FIELD_ITEMS ||
    input.evidence.length > MAX_FIELD_ITEMS ||
    (input.normalizations?.length ?? 0) > MAX_NORMALIZATIONS ||
    (input.duplicates?.length ?? 0) > MAX_CROSS_FIELD_RULES ||
    (input.totals?.length ?? 0) > MAX_CROSS_FIELD_RULES ||
    input.representations.length > MAX_REPRESENTATIONS
  ) {
    checks.fail(
      "EXTRACTION_VERIFICATION_LIMIT_EXCEEDED",
      "",
      "Field, evidence, normalization, duplicate, total, or representation input exceeds hard limits.",
    );
    return false;
  }
  if (input.representations.some((item) => item.content.byteLength > MAX_REPRESENTATION_BYTES)) {
    checks.fail("REPRESENTATION_BYTES_EXCEEDED", "", "Representation bytes exceed the selector verification limit.");
    return false;
  }
  const totalBytes = input.representations.reduce((total, item) => total + item.content.byteLength, 0);
  if (totalBytes > MAX_TOTAL_REPRESENTATION_BYTES) {
    checks.fail(
      "REPRESENTATION_AGGREGATE_BYTES_EXCEEDED",
      "",
      "Aggregate representation bytes exceed the hard verification limit.",
    );
    return false;
  }
  const bytesByArtifact = new Map(input.representations.map((item) => [item.artifactId, item.content.byteLength]));
  let scanBytes = 0;
  for (const edge of input.evidence) {
    scanBytes += bytesByArtifact.get(edge.representationArtifactId) ?? 0;
    if (scanBytes > MAX_EVIDENCE_SCAN_BYTES) {
      checks.fail(
        "EVIDENCE_SCAN_BYTES_EXCEEDED",
        "",
        "Repeated selector resolution would exceed the hard aggregate scan budget.",
      );
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stage: indexes of rules, evidence, representations, normalizations
// ---------------------------------------------------------------------------

interface VerificationIndexes {
  readonly normalizations: ReadonlyMap<string, ExtractionNormalizationRule>;
  readonly ruleByPath: ReadonlyMap<string, ExtractionFieldRule>;
  readonly evidenceByPath: ReadonlyMap<string, ExtractionEvidence>;
  readonly representationById: ReadonlyMap<string, ImmutableExtractionRepresentation>;
}

const MAX_NORMALIZATION_ID_LENGTH = 255;
const MAX_ALLOWED_VALUES = 128;
const MAX_ALLOWED_VALUE_LENGTH = 128;

const comparisonKinds = new Set<FieldComparison>([
  "exact",
  "normalized_text",
  "decimal",
  "percentage",
  "currency",
  "unit",
  "date",
  "datetime",
  "enum",
  "identifier",
  "checksum",
]);
const sourceComponents = new Set<NonNullable<ExtractionFieldRule["sourceComponent"]>>([
  "table_cell_value",
  "geometry_token_text",
  "transcript_text",
]);

/** Invalid or duplicate entries are reported and dropped; valid ones are indexed by path/id. Representations are re-hashed here. */
function indexRulesEvidenceRepresentations(
  checks: ExtractionChecks,
  input: ExtractionFieldVerificationInput,
): VerificationIndexes {
  const normalizations = new Map<string, ExtractionNormalizationRule>();
  for (const rule of input.normalizations ?? []) {
    if (!isNormalizationRuleValid(rule) || normalizations.has(rule.id))
      checks.fail(
        "NORMALIZATION_RULE_INVALID",
        "",
        "Normalization rules require a unique bounded ID and supported operation.",
      );
    else normalizations.set(rule.id, rule);
  }
  const ruleByPath = new Map<string, ExtractionFieldRule>();
  for (const rule of input.fields) {
    if (!isFieldRuleValid(rule) || ruleByPath.has(rule.path))
      checks.fail(
        "FIELD_RULE_INVALID",
        rule.path,
        "Field rule path, comparison, options, scalar source component, and decimal bounds must be bounded and applicable.",
      );
    else ruleByPath.set(rule.path, rule);
  }
  const evidenceByPath = new Map<string, ExtractionEvidence>();
  for (const item of input.evidence) {
    if (!isBoundedJsonPointer(item.path) || evidenceByPath.has(item.path))
      checks.fail("FIELD_EVIDENCE_INVALID", item.path, "Evidence path must be a unique RFC 6901 pointer.");
    else evidenceByPath.set(item.path, item);
  }
  const representationById = new Map<string, ImmutableExtractionRepresentation>();
  for (const item of input.representations) {
    if (representationById.has(item.artifactId) || sha256Digest(item.content) !== item.digest)
      checks.fail(
        "REPRESENTATION_IMMUTABILITY_FAILED",
        "",
        "Representation identity is duplicate or content does not match its immutable digest.",
      );
    else representationById.set(item.artifactId, item);
  }
  return { normalizations, ruleByPath, evidenceByPath, representationById };
}

function isNormalizationRuleValid(rule: ExtractionNormalizationRule): boolean {
  return (
    typeof rule.id === "string" &&
    rule.id.length > 0 &&
    rule.id.length <= MAX_NORMALIZATION_ID_LENGTH &&
    (rule.operation === "trim_ascii" || rule.operation === "ascii_whitespace_collapsed")
  );
}

/** Path, comparison, options, scalar source component and decimal bounds must all be bounded and applicable to the comparison. */
function isFieldRuleValid(rule: ExtractionFieldRule): boolean {
  const decimalBoundsValid =
    rule.comparison === "decimal"
      ? (rule.minimum === undefined || strictDecimal(rule.minimum) !== undefined) &&
        (rule.maximum === undefined || strictDecimal(rule.maximum) !== undefined)
      : rule.minimum === undefined && rule.maximum === undefined;
  const componentValid =
    rule.sourceComponent === undefined
      ? rule.sourceJoiner === undefined
      : sourceComponents.has(rule.sourceComponent) &&
        (rule.sourceComponent === "table_cell_value"
          ? rule.sourceJoiner === undefined
          : rule.sourceJoiner === "space" || rule.sourceJoiner === "none");
  const optionsApplicable =
    (rule.allowedValues === undefined ||
      rule.comparison === "enum" ||
      rule.comparison === "currency" ||
      rule.comparison === "unit") &&
    (rule.identifierKind === undefined || rule.comparison === "identifier") &&
    (rule.normalizationId === undefined || rule.comparison === "normalized_text") &&
    (rule.checksum === undefined || rule.comparison === "checksum");
  return (
    isBoundedJsonPointer(rule.path) &&
    comparisonKinds.has(rule.comparison) &&
    boundedAllowedValues(rule.allowedValues) &&
    decimalBoundsValid &&
    componentValid &&
    optionsApplicable
  );
}

const boundedAllowedValues = (values: readonly string[] | undefined): boolean =>
  values === undefined ||
  (values.length <= MAX_ALLOWED_VALUES &&
    values.every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_ALLOWED_VALUE_LENGTH,
    ) &&
    new Set(values).size === values.length);

// ---------------------------------------------------------------------------
// Stage: one resolution and one comparison per candidate leaf
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Resolves the leaf's evidence once, extracts its scalar, compares it to the candidate; returns the accepted selection when the comparison passed. */
function verifyLeaf(
  checks: ExtractionChecks,
  input: ExtractionFieldVerificationInput,
  indexes: VerificationIndexes,
  path: string,
): VerifiedExtractionScalarSelection | undefined {
  const rule = indexes.ruleByPath.get(path);
  if (!rule) {
    checks.fail("FIELD_RULE_MISSING", path, "Every candidate leaf requires an explicit verification rule.");
    return undefined;
  }
  const evidence = indexes.evidenceByPath.get(path);
  if (!evidence) {
    checks.fail("FIELD_EVIDENCE_MISSING", path, "Every candidate leaf requires evidence.");
    return undefined;
  }
  const resolved = resolveLeafEvidence(checks, input, indexes, evidence);
  if (!resolved) return undefined;
  const { selection, selectedContentDigest } = resolved;
  const selected = selectedScalar(checks, rule, evidence, selection);
  if (selected === undefined) return undefined;
  const actual = getAtBoundedPointer(input.candidate, path);
  if (!actual.found) {
    checks.fail("FIELD_CANDIDATE_MISSING", path, "Validated leaf unexpectedly cannot be read.");
    return undefined;
  }
  const outcome = compareFieldValue({
    rule,
    candidate: actual.value,
    evidence: selected,
    normalizations: indexes.normalizations,
  });
  checks.record(`FIELD_${rule.comparison.toUpperCase()}_MATCH`, path, outcome.passed, outcome.detail);
  if (!outcome.passed || !isScalar(actual.value) || !isScalar(selected)) return undefined;
  return Object.freeze({
    path,
    value: actual.value,
    rawValue: selected,
    rule: Object.freeze({ ...rule }),
    evidence: Object.freeze({
      ...evidence,
      selector: structuredClone(evidence.selector),
    }),
    selectedContentDigest,
  });
}

interface ResolvedLeafEvidence {
  readonly selection: EvidenceSelection;
  /** Re-hashed from the selected bytes; equal to the resolver's claim. */
  readonly selectedContentDigest: `sha256:${string}`;
}

/** The evidence must bind to a verified representation and resolve uniquely to bytes that replay their digest. */
function resolveLeafEvidence(
  checks: ExtractionChecks,
  input: ExtractionFieldVerificationInput,
  indexes: VerificationIndexes,
  evidence: ExtractionEvidence,
): ResolvedLeafEvidence | undefined {
  const representation = indexes.representationById.get(evidence.representationArtifactId);
  if (
    !representation ||
    representation.captureId !== evidence.captureId ||
    representation.digest !== evidence.representationDigest
  ) {
    checks.fail(
      "EVIDENCE_REPRESENTATION_UNSUPPORTED",
      evidence.path,
      "Evidence does not bind to a verified immutable representation.",
    );
    return undefined;
  }
  const selection = resolveEvidenceSelector(
    {
      captureId: representation.captureId,
      representationArtifactId: representation.artifactId,
      representationDigest: representation.digest,
      selector: evidence.selector,
      content: representation.content,
    },
    input.selectorResolvers ?? [],
  );
  const replayedDigest = selection ? sha256Digest(selection.selectedContent) : undefined;
  if (
    !selection ||
    replayedDigest === undefined ||
    selection.resolution.status !== "resolved" ||
    selection.resolution.occurrenceCount !== 1 ||
    selection.resolution.selectedContentDigest !== replayedDigest ||
    (evidence.expectedSelectedContentDigest !== undefined && evidence.expectedSelectedContentDigest !== replayedDigest)
  ) {
    checks.fail(
      "EVIDENCE_RESOLUTION_FAILED",
      evidence.path,
      "Evidence selector did not uniquely resolve to the expected selected bytes.",
    );
    return undefined;
  }
  return { selection, selectedContentDigest: replayedDigest };
}

/**
 * The scalar the evidence stands for: an explicitly declared source component,
 * else the resolver's scalar value, else the selected bytes as UTF-8 text.
 * Locator metadata (objects) is never a field value.
 */
function selectedScalar(
  checks: ExtractionChecks,
  rule: ExtractionFieldRule,
  evidence: ExtractionEvidence,
  selection: EvidenceSelection,
): unknown {
  const { selectedValue } = selection.resolution;
  const component = sourceComponentValue(rule, evidence.selector, selectedValue);
  if (component.detail) {
    checks.fail("EVIDENCE_SOURCE_COMPONENT_INVALID", evidence.path, component.detail);
    return undefined;
  }
  if (component.value !== undefined) return component.value;
  if (
    selectedValue === null ||
    typeof selectedValue === "string" ||
    typeof selectedValue === "number" ||
    typeof selectedValue === "boolean"
  )
    return selectedValue;
  if (selectedValue !== undefined) {
    checks.fail(
      "EVIDENCE_VALUE_UNSUPPORTED",
      evidence.path,
      "Selector returned metadata rather than a scalar source value; geometry and locator metadata are not factual evidence.",
    );
    return undefined;
  }
  try {
    return utf8.decode(selection.selectedContent);
  } catch {
    checks.fail("EVIDENCE_VALUE_UNSUPPORTED", evidence.path, "Selected bytes are not a supported scalar source value.");
    return undefined;
  }
}

const isScalar = (value: unknown): value is ExtractionScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
