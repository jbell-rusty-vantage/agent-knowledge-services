import { canonicalizeJson } from "../canonical/index.js";
import { compareFractions, parseDecimal } from "../decimal/index.js";
import type { ExtractionFieldRule, ExtractionNormalizationRule, FieldComparison } from "./field-rules.js";

export interface ComparisonOutcome {
  readonly passed: boolean;
  readonly detail: string;
}

export interface FieldComparisonInput {
  readonly rule: ExtractionFieldRule;
  readonly candidate: unknown;
  readonly evidence: unknown;
  readonly normalizations: ReadonlyMap<string, ExtractionNormalizationRule>;
}

type Comparator = (input: FieldComparisonInput) => ComparisonOutcome;

/**
 * Compares a candidate leaf against the scalar selected from verified evidence
 * under the rule's comparison. Every comparator is strict: no locale inference,
 * no implicit coercion, bounded literal grammars only.
 */
export function compareFieldValue(input: FieldComparisonInput): ComparisonOutcome {
  return comparators[input.rule.comparison](input);
}

const comparators: Record<FieldComparison, Comparator> = {
  exact: ({ candidate, evidence }) => ({
    passed: canonicalizeJson(candidate) === canonicalizeJson(evidence),
    detail: "Candidate equals selected evidence exactly.",
  }),
  normalized_text: compareNormalizedText,
  decimal: compareDecimal,
  percentage: comparePercentage,
  currency: compareCurrency,
  unit: ({ rule, candidate, evidence }) => ({
    passed:
      typeof candidate === "string" &&
      typeof evidence === "string" &&
      Boolean(rule.allowedValues?.includes(candidate)) &&
      candidate === evidence,
    detail: "Unit is an explicit allowed token and matches evidence.",
  }),
  date: ({ candidate, evidence }) => {
    const left = validDate(candidate),
      right = validDate(evidence);
    return {
      passed: left !== undefined && left === right,
      detail: "Calendar date is valid and matches evidence.",
    };
  },
  datetime: ({ candidate, evidence }) => {
    const left = validDateTime(candidate),
      right = validDateTime(evidence);
    return {
      passed: left !== undefined && left === right,
      detail: "RFC3339 datetime with explicit timezone resolves to the same instant.",
    };
  },
  enum: ({ rule, candidate, evidence }) => ({
    passed:
      rule.allowedValues !== undefined &&
      typeof candidate === "string" &&
      rule.allowedValues.includes(candidate) &&
      canonicalizeJson(candidate) === canonicalizeJson(evidence),
    detail: "Explicit enum membership and evidence equality were checked.",
  }),
  identifier: ({ rule, candidate, evidence }) => ({
    passed:
      identifierValid(candidate, rule.identifierKind) && canonicalizeJson(candidate) === canonicalizeJson(evidence),
    detail: "Supported identifier format and evidence equality were checked.",
  }),
  checksum: ({ rule, candidate, evidence }) => ({
    passed: typeof candidate === "string" && checksumValid(candidate, rule.checksum) && candidate === evidence,
    detail: "Declared checksum and evidence equality were checked.",
  }),
};

function compareNormalizedText({ rule, candidate, evidence, normalizations }: FieldComparisonInput): ComparisonOutcome {
  const normalization = rule.normalizationId ? normalizations.get(rule.normalizationId) : undefined;
  if (!normalization || typeof candidate !== "string" || typeof evidence !== "string")
    return {
      passed: false,
      detail: "Normalized text requires an explicit normalization rule and strings.",
    };
  const left = normalizeAscii(candidate, normalization),
    right = normalizeAscii(evidence, normalization);
  return {
    passed: left !== undefined && left === right,
    detail: "Candidate and selected evidence match under the declared normalization.",
  };
}

function compareDecimal({ rule, candidate, evidence }: FieldComparisonInput): ComparisonOutcome {
  const left = strictDecimal(candidate),
    right = strictDecimal(evidence);
  if (!left || !right)
    return {
      passed: false,
      detail: "Decimal values must be bounded canonical decimal strings.",
    };
  try {
    const actual = parseDecimal(left),
      selected = parseDecimal(right);
    const rangeOk =
      (!rule.minimum || compareFractions(actual, parseDecimal(rule.minimum)) >= 0) &&
      (!rule.maximum || compareFractions(actual, parseDecimal(rule.maximum)) <= 0);
    return {
      passed: compareFractions(actual, selected) === 0 && rangeOk,
      detail: "Exact decimal comparison and declared range were replayed.",
    };
  } catch {
    return { passed: false, detail: "Decimal rule bounds are invalid." };
  }
}

function comparePercentage({ candidate, evidence }: FieldComparisonInput): ComparisonOutcome {
  const left = strictPercent(candidate),
    right = strictPercent(evidence);
  if (!left || !right)
    return {
      passed: false,
      detail: "Percentages require canonical decimal strings with a literal percent sign.",
    };
  try {
    return {
      passed: compareFractions(parseDecimal(left), parseDecimal(right)) === 0,
      detail: "Percentage values match without locale inference.",
    };
  } catch {
    return { passed: false, detail: "Percentage parse failed." };
  }
}

function compareCurrency({ rule, candidate, evidence }: FieldComparisonInput): ComparisonOutcome {
  const left = strictCurrency(candidate, rule.allowedValues),
    right = strictCurrency(evidence, rule.allowedValues);
  if (!left || !right)
    return {
      passed: false,
      detail: "Currency requires an allowed ISO code and `CODE decimal` spelling; symbols/locales are unsupported.",
    };
  try {
    return {
      passed: left.code === right.code && compareFractions(parseDecimal(left.amount), parseDecimal(right.amount)) === 0,
      detail: "Currency code and exact amount match.",
    };
  } catch {
    return { passed: false, detail: "Currency amount parse failed." };
  }
}

// ---------------------------------------------------------------------------
// Literal grammars. Each returns the accepted literal (or its parsed form) or
// `undefined`; nothing here throws.
// ---------------------------------------------------------------------------

/** Canonical decimal: optional sign, no leading zeros, ≤128 chars, ≤36 fraction digits. */
export const strictDecimal = (value: unknown): string | undefined =>
  typeof value === "string" &&
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) &&
  value.length <= 128 &&
  (value.split(".")[1]?.length ?? 0) <= 36
    ? value
    : undefined;

const strictPercent = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.endsWith("%")) return undefined;
  return strictDecimal(value.slice(0, -1));
};

const strictCurrency = (
  value: unknown,
  allowed: readonly string[] | undefined,
): { code: string; amount: string } | undefined => {
  if (!allowed || allowed.length === 0 || typeof value !== "string") return undefined;
  const match = /^([A-Z]{3}) (-?(?:0|[1-9]\d*)(?:\.\d+)?)$/u.exec(value);
  return match && allowed.includes(match[1]!) && strictDecimal(match[2]!)
    ? { code: match[1]!, amount: match[2]! }
    : undefined;
};

/** ASCII-only normalization; collapsing refuses strings with other control characters. */
const normalizeAscii = (value: string, rule: ExtractionNormalizationRule): string | undefined => {
  if (rule.operation === "trim_ascii") return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
  if (/[\u0000-\u001f\u007f]/u.test(value.replace(/[\t\r\n]/gu, ""))) return undefined;
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "").replace(/[ \t\r\n]+/gu, " ");
};

const validDate = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match || match[1] === "0000") return undefined;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
    ? value
    : undefined;
};

/** RFC 3339 with an explicit zone; returns the UTC instant in milliseconds. */
const validDateTime = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || match[1] === "0000") return undefined;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]),
    hour = Number(match[4]),
    minute = Number(match[5]),
    second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, Number((match[7] ?? "").padEnd(3, "0")));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day)
    return undefined;
  const zone = match[8]!;
  const base = probe.getTime();
  if (zone === "Z") return base;
  const sign = zone[0] === "+" ? 1 : -1;
  const offsetHours = Number(zone.slice(1, 3)),
    offsetMinutes = Number(zone.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  return base - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
};

const identifierValid = (value: unknown, kind: ExtractionFieldRule["identifierKind"]): boolean => {
  if (typeof value !== "string" || !kind) return false;
  if (kind === "uuid") return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
  if (kind === "sha256") return /^sha256:[0-9a-f]{64}$/u.test(value);
  if (kind === "cve") return /^CVE-\d{4}-\d{4,}$/u.test(value);
  return /^[A-Z]{3}$/u.test(value);
};

const checksumValid = (value: string, checksum: ExtractionFieldRule["checksum"]): boolean =>
  checksum === "luhn" ? luhn(value) : checksum === "isbn13" ? isbn13(value) : false;

const luhn = (value: string): boolean => {
  if (!/^\d{2,64}$/u.test(value)) return false;
  let sum = 0;
  for (let index = value.length - 1, factor = 1; index >= 0; index -= 1, factor = factor === 1 ? 2 : 1) {
    let digit = Number(value[index]) * factor;
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
};

const isbn13 = (value: string): boolean => {
  if (!/^\d{13}$/u.test(value)) return false;
  const total = [...value]
    .slice(0, 12)
    .reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (total % 10)) % 10 === Number(value[12]);
};
