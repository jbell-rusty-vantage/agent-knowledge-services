import { sha256Hex } from "./canonical.js";

export type Row = Record<string, unknown>;

/** Makes a pg row JSON-stable: dates → RFC 3339, byte columns → digests, undefined → null. */
export function jsonSafeRow(row: Row): Row {
  const safe: Row = {};
  for (const [column, value] of Object.entries(row)) safe[column] = jsonSafeValue(value);
  return safe;
}

function jsonSafeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `sha256:${sha256Hex(value)}`;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Row).map(([key, item]) => [key, jsonSafeValue(item)]));
  return value;
}
