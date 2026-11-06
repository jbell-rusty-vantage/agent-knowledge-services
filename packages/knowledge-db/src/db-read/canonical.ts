import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Digest = `sha256:${string}`;

/**
 * RFC 8785 (JCS) canonical JSON: members sorted by code point, no insignificant
 * whitespace, shortest round-trip numbers, NFC strings. `undefined` members are dropped,
 * non-finite numbers are rejected because JCS has no representation for them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "boolean":
      return String(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot encode a non-finite number");
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(Number(value));
    case "object":
      break;
    default:
      throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => compareCodePoints(a, b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(item)}`).join(",")}}`;
}

function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const diff = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

export const sha256Hex = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
export const digestOf = (value: unknown): Digest => `sha256:${sha256Hex(canonicalJson(value))}`;
export const digestHexOf = (value: unknown): string => sha256Hex(canonicalJson(value));
export const isDigest = (value: string): value is Digest => /^sha256:[0-9a-f]{64}$/.test(value);
