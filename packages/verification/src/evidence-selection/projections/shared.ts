import { canonicalizeJson, isSha256Digest } from "../../canonical/index.js";
import { isPlainRecord, isSafeInteger } from "../../internal/guards.js";

/**
 * Validation primitives shared by every canonical projection parser.
 *
 * Every rejection throws `Error("PROJECTION_INVALID:<CODE>")`. The codes are part of the
 * retained contract; parsers must keep their code and the order in which checks run.
 */

export type UnknownRecord = Record<string, unknown>;

/** Single-projection byte limit for every kind except native DOM and geometry. */
export const MAX_BYTES = 1_000_000;
/**
 * Native DOM and geometry projections can exceed 1MB while their combined
 * parser output remains within 4MB. Preserve that envelope at this boundary;
 * structural, depth, item and string limits still apply per parser.
 */
export const MAX_NATIVE_PROJECTION_BYTES = 4_000_000;
export const MAX_ITEMS = 10_000;
export const MAX_STRING = 100_000;

export function fail(code: string): never {
  throw new Error(`PROJECTION_INVALID:${code}`);
}

export const isRecord = isPlainRecord;
export const string = (value: unknown): value is string => typeof value === "string";
export const integer = isSafeInteger;
export const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
export const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
export const positiveInteger = (value: unknown): value is number => integer(value) && value > 0;
export const digest = isSha256Digest;
export const nonEmptyString = (value: unknown): value is string => string(value) && value.length > 0;

export function required<T>(value: T | undefined, field: string): T {
  return value === undefined ? fail(`MISSING_${field}`) : value;
}

export function array(value: unknown, field: string): unknown[] {
  return Array.isArray(value) ? value : fail(`ARRAY_${field}`);
}

export function boundedArray(value: unknown, field: string): unknown[] {
  const values = array(value, field);
  return values.length <= MAX_ITEMS ? values : fail(`TOO_MANY_${field}`);
}

export function boundedString(value: unknown): value is string {
  return string(value) && value.length <= MAX_STRING;
}

export function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) fail(`DUPLICATE_${field}`);
}

/** Rejects any key outside `keys` with `<field>_EXTRA_KEY`. */
export function only(value: UnknownRecord, keys: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(`${field}_EXTRA_KEY`);
}

export function json(value: unknown, field: string): unknown {
  try {
    canonicalizeJson(value);
    return value;
  } catch {
    return fail(`JSON_${field}`);
  }
}

export type Range = {
  readonly start: number;
  readonly end: number;
  readonly coordinateSpace: string;
};
