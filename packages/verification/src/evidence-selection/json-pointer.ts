export type JsonPointerLookup = { readonly found: true; readonly value: unknown } | { readonly found: false };

const POINTER_SYNTAX = /^(?:\/(?:[^~/]|~[01])*)*$/;
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

export function isJsonPointerSyntax(pointer: string): boolean {
  return POINTER_SYNTAX.test(pointer);
}

/** RFC 6901 lookup. Malformed pointers and missing paths are both "not found"; the pointer is a locator, not a query. */
export function evaluateJsonPointer(pointer: string, document: unknown): JsonPointerLookup {
  if (!isJsonPointerSyntax(pointer)) return { found: false };
  if (pointer === "") return { found: true, value: document };
  let current = document;
  for (const token of pointer.slice(1).split("/").map(unescapeToken)) {
    const next = step(current, token);
    if (!next.found) return next;
    current = next.value;
  }
  return { found: true, value: current };
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function step(current: unknown, token: string): JsonPointerLookup {
  if (Array.isArray(current)) {
    if (!ARRAY_INDEX.test(token) || Number(token) >= current.length) return { found: false };
    return { found: true, value: current[Number(token)] };
  }
  if (current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, token)) {
    return { found: true, value: (current as Record<string, unknown>)[token] };
  }
  return { found: false };
}
