import { isPlainObject } from "./guards.js";

/**
 * Iterative, allocation-bounded walk over a JSON-like value.
 *
 * The walker owns the traversal order and the point at which each limit is
 * checked so every caller trips the same limit at the same node. Callers own
 * the units (UTF-8 bytes, UTF-16 units, conservative estimates) through the
 * `measure` hooks and translate the returned violation into their own codes.
 *
 * Per node, in order: node/depth limits → scalar handling → container
 * admission → alias detection → collection size → children (keys are
 * measured as they are pushed).
 */
export interface BoundedJsonLimits {
  readonly maximumNodes: number;
  readonly maximumDepth: number;
  /** Maximum array length; also the object-entry limit unless `maximumObjectEntries` is set. */
  readonly maximumCollection: number;
  readonly maximumObjectEntries?: number;
  /** Budget shared by every measured string and object key. */
  readonly maximumStringBudget: number;
  readonly maximumKeyLength?: number;
}

export interface BoundedJsonMeasure {
  string(value: string): number;
  key(key: string): number;
  /** Optional budget contribution of `null`, booleans and numbers. */
  scalar?(value: null | boolean | number): number;
}

export interface BoundedJsonWalkOptions {
  readonly limits: BoundedJsonLimits;
  readonly measure: BoundedJsonMeasure;
  /** Reject `NaN` and infinities. */
  readonly rejectNonFiniteNumbers: boolean;
  /** Reject `undefined`, functions, symbols and bigints. */
  readonly rejectNonJsonValues: boolean;
  /** Reject objects whose prototype is not `Object.prototype`. */
  readonly plainObjectsOnly: boolean;
}

export type BoundedJsonViolation =
  | { readonly kind: "node_limit" }
  | { readonly kind: "depth_limit" }
  | { readonly kind: "non_finite_number" }
  | { readonly kind: "non_json_value" }
  | { readonly kind: "aliased_node" }
  | {
      readonly kind: "collection_limit";
      readonly container: "array" | "object";
    }
  | { readonly kind: "string_budget"; readonly at: "string" | "key" }
  | { readonly kind: "key_length" };

export function walkBoundedJson(root: unknown, options: BoundedJsonWalkOptions): BoundedJsonViolation | undefined {
  const { limits, measure } = options;
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let budget = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maximumNodes) return { kind: "node_limit" };
    if (depth > limits.maximumDepth) return { kind: "depth_limit" };
    if (typeof value === "string") {
      budget += measure.string(value);
      if (budget > limits.maximumStringBudget) return { kind: "string_budget", at: "string" };
      continue;
    }
    if (value === null || typeof value === "boolean") {
      budget += measure.scalar?.(value) ?? 0;
      continue;
    }
    if (typeof value === "number") {
      if (options.rejectNonFiniteNumbers && !Number.isFinite(value)) return { kind: "non_finite_number" };
      budget += measure.scalar?.(value) ?? 0;
      continue;
    }
    if (typeof value !== "object") {
      if (options.rejectNonJsonValues) return { kind: "non_json_value" };
      continue;
    }
    if (options.plainObjectsOnly && !Array.isArray(value) && !isPlainObject(value)) return { kind: "non_json_value" };
    if (seen.has(value)) return { kind: "aliased_node" };
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > limits.maximumCollection) return { kind: "collection_limit", container: "array" };
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(value);
    if (entries.length > (limits.maximumObjectEntries ?? limits.maximumCollection))
      return { kind: "collection_limit", container: "object" };
    for (const [key, child] of entries) {
      budget += measure.key(key);
      if (limits.maximumKeyLength !== undefined && key.length > limits.maximumKeyLength) return { kind: "key_length" };
      if (budget > limits.maximumStringBudget) return { kind: "string_budget", at: "key" };
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}
