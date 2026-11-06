/** Non-null, non-array object of any prototype. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Non-null, non-array object whose prototype is exactly `Object.prototype`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
