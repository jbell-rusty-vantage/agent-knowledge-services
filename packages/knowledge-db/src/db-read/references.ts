import type { OperationResult } from "./read-intent.js";

/**
 * `$<opId>.rows[<n>].<column>` and `$<opId>.value.<path>` references between operations
 * of one read intent. Resolution is deterministic and never throws: an unresolvable
 * reference reports the path so the caller marks the operation `skipped`.
 */
const REFERENCE = /^\$([a-z0-9][a-z0-9._-]{0,63})\.(rows\[(\d+)\]|value)((?:\.[A-Za-z0-9_]+)*)$/;

export interface ResolvedParams {
  readonly params: Record<string, unknown>;
  readonly resolvedFrom: Record<string, string>;
  readonly unresolved: readonly string[];
}

function walk(root: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (cursor, key) =>
        cursor !== null && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined,
      root,
    );
}

function resolveOne(reference: string, completed: ReadonlyMap<string, OperationResult>): unknown {
  const match = REFERENCE.exec(reference);
  if (!match) return undefined;
  const [, opId, selector, rowIndex, tail] = match;
  const result = completed.get(opId!);
  if (!result || result.status === "skipped" || result.status === "error") return undefined;
  const root = selector === "value" ? result.value : result.rows?.[Number(rowIndex)];
  return root === undefined ? undefined : walk(root, tail ?? "");
}

export function resolveReferences(
  params: Record<string, unknown>,
  completed: ReadonlyMap<string, OperationResult>,
): ResolvedParams {
  const resolved: Record<string, unknown> = {};
  const resolvedFrom: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string" || !value.startsWith("$")) {
      resolved[key] = value;
      continue;
    }
    const target = resolveOne(value, completed);
    if (target === undefined) unresolved.push(`${key} ← ${value}`);
    else {
      resolved[key] = target;
      resolvedFrom[key] = value;
    }
  }
  return { params: resolved, resolvedFrom, unresolved };
}
