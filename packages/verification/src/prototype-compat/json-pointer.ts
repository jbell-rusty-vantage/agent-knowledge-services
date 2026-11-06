import { prototypeSha256 } from "./digest.js";
import type { PrototypeResolvedTextLocator } from "./text-locator.js";

export interface PrototypeResolvedJsonPointer extends Omit<PrototypeResolvedTextLocator, "matchMode"> {
  readonly matchMode: "json_pointer" | "not_found" | "parse_error";
  readonly value: unknown;
}

function unresolved(matchMode: "not_found" | "parse_error"): PrototypeResolvedJsonPointer {
  return {
    matchMode,
    start: null,
    end: null,
    selectedContentSha256: null,
    occurrenceCount: 0,
    value: undefined,
  };
}

/** Preserves the prototype JSON pointer behavior, including JSON.stringify bytes. */
export function resolvePrototypeJsonPointer(content: string, pointer: string): PrototypeResolvedJsonPointer {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return unresolved("parse_error");
  }
  for (const token of pointer
    .slice(1)
    .split("/")
    .map((item) => item.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (Array.isArray(value)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= value.length) return unresolved("not_found");
      value = value[index];
    } else if (value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else return unresolved("not_found");
  }
  return {
    matchMode: "json_pointer",
    start: null,
    end: null,
    selectedContentSha256: prototypeSha256(JSON.stringify(value)),
    occurrenceCount: 1,
    value,
  };
}
