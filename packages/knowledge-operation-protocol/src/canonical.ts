import { createHash } from "node:crypto";

/**
 * `kop-canonical-json.v1`: the byte form every protocol digest is computed over.
 *
 * Rules (identical to `bks-canonical-json.v2` / RFC 8785 JCS for this value space):
 *  - object keys sorted by UTF-16 code units, no whitespace;
 *  - `undefined` properties are omitted; `undefined` array members are an error;
 *  - numbers must be safe integers (the protocol carries no floats; money and ratios are strings or scaled integers);
 *  - strings are written exactly as `JSON.stringify` writes them: no Unicode normalization, ever;
 *  - a string or key with a lone (unpaired) surrogate is refused: it has no UTF-8 encoding, hence no digest.
 *
 * The algorithm identifier travels with every digest-bearing record so a consumer never guesses how bytes were formed.
 */
export const CANONICALIZATION = "kop-canonical-json.v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };

export class CanonicalizationError extends Error {
  readonly code: "CANONICAL_NUMBER_UNSUPPORTED" | "CANONICAL_VALUE_UNSUPPORTED";
  constructor(code: CanonicalizationError["code"], message: string) {
    super(message);
    this.name = "CanonicalizationError";
    this.code = code;
  }
}

/** A string with an unpaired surrogate has no UTF-8 bytes (Buffer would substitute U+FFFD), so it has no digest. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function canonicalString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalizationError("CANONICAL_VALUE_UNSUPPORTED", `lone surrogate is not canonical at ${path}`);
  }
  return JSON.stringify(value);
}

function canonicalize(value: JsonValue | undefined, path: string): string {
  if (value === undefined) {
    throw new CanonicalizationError("CANONICAL_VALUE_UNSUPPORTED", `undefined is not a canonical value at ${path}`);
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return canonicalString(value, path);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalizationError(
          "CANONICAL_NUMBER_UNSUPPORTED",
          `only safe integers are canonical; got ${String(value)} at ${path}`,
        );
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(",")}]`;
      }
      const keys = Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${canonicalString(key, `${path}.<key>`)}:${canonicalize(value[key], `${path}.${key}`)}`).join(",")}}`;
    }
    default:
      throw new CanonicalizationError("CANONICAL_VALUE_UNSUPPORTED", `unsupported ${typeof value} at ${path}`);
  }
}

/** Canonical bytes (as a UTF-8 string) of a JSON value. */
export function canonicalJson(value: JsonValue): string {
  return canonicalize(value, "$");
}

export type Digest = `sha256:${string}`;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<hex>` of exact bytes. */
export function digestBytes(bytes: Uint8Array | string): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** `sha256:<hex>` of the canonical bytes of a JSON value. */
export function digestCanonical(value: JsonValue): Digest {
  return digestBytes(Buffer.from(canonicalJson(value), "utf8"));
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}
