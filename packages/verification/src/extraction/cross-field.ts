import { canonicalizeJson } from "../canonical/index.js";
import { parseDecimal, replayDecimalOperation, withinTolerance } from "../decimal/index.js";
import { getAtBoundedPointer, isBoundedJsonPointer, type ExtractionChecks } from "./checks.js";
import { strictDecimal } from "./field-comparators.js";
import type { CrossFieldTotalRule, DuplicateRecordRule } from "./field-rules.js";

const MAX_DUPLICATE_KEY_PATHS = 16;
const MAX_DUPLICATE_WORK = 100_000;
const MAX_TOTAL_OPERANDS = 64;
const MAX_TOTAL_OPERAND_WORK = 10_000;

const totalOperations = new Set<CrossFieldTotalRule["operation"]>([
  "identity",
  "sum",
  "difference",
  "product",
  "ratio",
  "percent_change",
]);

/** Every record in each declared array must have a unique tuple of non-null scalar keys. Work is budgeted across rules. */
export function checkDuplicateRecords(
  checks: ExtractionChecks,
  candidate: unknown,
  rules: readonly DuplicateRecordRule[],
): void {
  let duplicateWork = 0;
  for (const rule of rules) {
    const array = getAtBoundedPointer(candidate, rule.arrayPath);
    if (
      !Array.isArray(array.value) ||
      rule.keyPaths.length === 0 ||
      rule.keyPaths.length > MAX_DUPLICATE_KEY_PATHS ||
      rule.keyPaths.some((path) => !isBoundedJsonPointer(path))
    ) {
      checks.fail(
        "DUPLICATE_RULE_INVALID",
        rule.arrayPath,
        "Duplicate rule requires bounded RFC 6901 key paths and an array.",
      );
      continue;
    }
    duplicateWork += array.value.length * rule.keyPaths.length;
    if (duplicateWork > MAX_DUPLICATE_WORK) {
      checks.fail(
        "DUPLICATE_WORK_EXCEEDED",
        rule.arrayPath,
        "Duplicate key comparison exceeds the aggregate deterministic work budget.",
      );
      continue;
    }
    checks.record(
      "RECORD_KEYS_UNIQUE",
      rule.arrayPath,
      recordKeysUnique(array.value, rule.keyPaths),
      "Record key tuples are unique and non-null scalar values.",
    );
  }
}

function recordKeysUnique(records: readonly unknown[], keyPaths: readonly string[]): boolean {
  const keys = new Set<string>();
  for (const record of records) {
    const values = keyPaths.map((path) => getAtBoundedPointer(record, path));
    if (values.some((value) => !value.found || value.value === null || typeof value.value === "object")) return false;
    const key = canonicalizeJson(values.map((value) => value.value));
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

/** Each declared total is replayed with the exact decimal core from its operand leaves. Work is budgeted across rules. */
export function replayCrossFieldTotals(
  checks: ExtractionChecks,
  candidate: unknown,
  rules: readonly CrossFieldTotalRule[],
): void {
  let operandWork = 0;
  for (const rule of rules) {
    if (
      rule.operandPaths.length === 0 ||
      rule.operandPaths.length > MAX_TOTAL_OPERANDS ||
      rule.operandPaths.some((path) => !isBoundedJsonPointer(path)) ||
      !isBoundedJsonPointer(rule.resultPath)
    ) {
      checks.fail(
        "TOTAL_RULE_RESOURCE_INVALID",
        rule.resultPath,
        "Total rule paths and operand count exceed deterministic bounds.",
      );
      continue;
    }
    operandWork += rule.operandPaths.length;
    if (operandWork > MAX_TOTAL_OPERAND_WORK) {
      checks.fail(
        "TOTAL_WORK_EXCEEDED",
        rule.resultPath,
        "Total operand replay exceeds the aggregate deterministic work budget.",
      );
      continue;
    }
    replayTotal(checks, candidate, rule);
  }
}

function replayTotal(checks: ExtractionChecks, candidate: unknown, rule: CrossFieldTotalRule): void {
  const result = getAtBoundedPointer(candidate, rule.resultPath);
  const resultDecimal = result.found ? strictDecimal(result.value) : undefined;
  const operandDecimals = rule.operandPaths.map((path) => {
    const operand = getAtBoundedPointer(candidate, path);
    return operand.found ? strictDecimal(operand.value) : undefined;
  });
  if (
    !resultDecimal ||
    !operandDecimals.every((item): item is string => item !== undefined) ||
    !operandCardinalityValid(rule)
  ) {
    checks.fail(
      "CROSS_FIELD_TOTAL_INPUT_INVALID",
      rule.resultPath,
      "Total operation/cardinality and operands must be supported canonical decimal values.",
    );
    return;
  }
  try {
    const replayed = replayDecimalOperation(rule.operation, operandDecimals);
    const toleranceText = rule.tolerance === undefined ? "0" : strictDecimal(rule.tolerance);
    if (!toleranceText) throw new TypeError("invalid tolerance");
    const tolerance = parseDecimal(toleranceText);
    if (tolerance.numerator < 0n) throw new TypeError("negative tolerance");
    checks.record(
      "CROSS_FIELD_TOTAL_REPLAY",
      rule.resultPath,
      withinTolerance(parseDecimal(resultDecimal), replayed, tolerance),
      "Exact decimal core replayed the declared total operation.",
    );
  } catch {
    checks.fail(
      "CROSS_FIELD_TOTAL_RULE_INVALID",
      rule.resultPath,
      "Total operation, cardinality, or tolerance is invalid.",
    );
  }
}

function operandCardinalityValid(rule: CrossFieldTotalRule): boolean {
  if (!totalOperations.has(rule.operation)) return false;
  const count = rule.operandPaths.length;
  switch (rule.operation) {
    case "identity":
      return count === 1;
    case "ratio":
    case "percent_change":
      return count === 2;
    default:
      return count >= 1;
  }
}
