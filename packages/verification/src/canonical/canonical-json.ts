const compareUtf16 = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("canonical JSON rejects lone UTF-16 surrogates");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("canonical JSON rejects lone UTF-16 surrogates");
  }
}

/** RFC 8785-compatible canonical JSON for schema-admitted JSON values. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not admit non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("canonical JSON only admits plain objects");
    const keys = Object.keys(record);
    for (const key of keys) assertUnicodeScalarString(key);
    return `{${keys
      .sort(compareUtf16)
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}
