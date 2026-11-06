/**
 * Freezes a value and every object reachable through its own enumerable
 * properties (arrays included). Already-frozen subtrees are left untouched,
 * which also terminates on cyclic graphs.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
