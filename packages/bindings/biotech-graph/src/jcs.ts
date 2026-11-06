import { createHash } from "node:crypto";
import type { Digest } from "@aiengineer/knowledge-operation-protocol";

/**
 * RFC 8785 (JCS) canonical JSON as BKS writes it (`bks-canonical-json.v2`, no digest profile): keys sorted by UTF-16
 * code units, no whitespace, numbers in ECMAScript Number::toString form (finite floats allowed, unsafe integers and
 * non-finite values refused), strings as `JSON.stringify` writes them, lone surrogates refused, `undefined` members
 * dropped. KS `kop-canonical-json.v1` is the same text for its value space (safe integers only); this module exists so
 * the binding reproduces native intent bytes and BKS read/marker digests that may legitimately carry floats.
 */
export class JcsError extends Error {
  readonly code: "JCS_NONFINITE" | "JCS_UNSAFE_INTEGER" | "JCS_LONE_SURROGATE" | "JCS_UNSUPPORTED";
  constructor(code: JcsError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "JcsError";
    this.code = code;
  }
}

function loneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      if (loneSurrogate(value)) throw new JcsError("JCS_LONE_SURROGATE", path || "$");
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new JcsError("JCS_NONFINITE", path || "$");
      if (Number.isInteger(value) && !Number.isSafeInteger(value))
        throw new JcsError("JCS_UNSAFE_INTEGER", path || "$");
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, index) => {
            if (item === undefined) throw new JcsError("JCS_UNSUPPORTED", `${path}[${index}] is undefined`);
            return encode(item, `${path}[${index}]`);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new JcsError("JCS_UNSUPPORTED", `${path || "$"} is not a plain object`);
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries
        .map(([key, v]) => {
          if (loneSurrogate(key)) throw new JcsError("JCS_LONE_SURROGATE", `${path}.<key>`);
          return `${JSON.stringify(key)}:${encode(v, path ? `${path}.${key}` : key)}`;
        })
        .join(",")}}`;
    }
    default:
      throw new JcsError("JCS_UNSUPPORTED", `${path || "$"} has type ${typeof value}`);
  }
}

export function jcs(value: unknown): string {
  return encode(value, "");
}

export function sha256Bytes(bytes: Uint8Array | string): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Digest;
}

/** `canonicalDigest` of BKS contracts: sha256 over the UTF-8 bytes of the canonical text. */
export function jcsDigest(value: unknown): Digest {
  return sha256Bytes(Buffer.from(jcs(value), "utf8"));
}
