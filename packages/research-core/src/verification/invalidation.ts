import type { Ref, RefKind } from "@aiengineer/knowledge-operation-protocol";
import { refKey, uniqueRefs } from "../digest.js";

/**
 * Dependency closure (design §7): capture -> fragment -> assertion/support -> observation -> report -> run ->
 * use decision -> effect. An edge points from the upstream record to the record that depends on it and may never point
 * back up the chain.
 */
export const DEPENDENCY_RANK: Partial<Record<RefKind, number>> = {
  artifact: 0,
  fragment: 1,
  support_set: 2,
  assertion: 2,
  observation: 3,
  report: 4,
  verification_run: 5,
  use_decision: 6,
  effect: 7,
};

export interface DependencyEdge {
  readonly from: Ref;
  readonly to: Ref;
}

export type InvalidationResult =
  | {
      readonly ok: true;
      readonly affected: readonly Ref[];
      readonly holdDecisions: readonly Ref<"use_decision">[];
      readonly recheck: {
        readonly assertions: readonly Ref[];
        readonly supportSets: readonly Ref[];
        readonly reports: readonly Ref[];
      };
      readonly effects: readonly Ref[];
      readonly untouchedDecisions: readonly Ref<"use_decision">[];
      /** The new authoritative revocation epoch: advanced by one when anything was affected. */
      readonly authoritativeEpoch: number;
    }
  | { readonly ok: false; readonly code: "INVALID_EDGE"; readonly edge: DependencyEdge };

/**
 * Explicit correction or revocation of `corrected` immediately invalidates every downstream record; unrelated branches
 * are untouched. Rechecking appends new observations; nothing here rewrites history.
 */
export function invalidate(
  edges: readonly DependencyEdge[],
  corrected: readonly Ref[],
  currentEpoch: number,
): InvalidationResult {
  const downstream = new Map<string, Ref[]>();
  const all = new Map<string, Ref>();
  for (const edge of edges) {
    const fromRank = DEPENDENCY_RANK[edge.from.kind];
    const toRank = DEPENDENCY_RANK[edge.to.kind];
    const fromKey = refKey(edge.from);
    const toKey = refKey(edge.to);
    if (fromRank === undefined || toRank === undefined || fromRank > toRank || fromKey === toKey) {
      return { ok: false, code: "INVALID_EDGE", edge };
    }
    downstream.set(fromKey, [...(downstream.get(fromKey) ?? []), edge.to]);
    all.set(fromKey, edge.from);
    all.set(toKey, edge.to);
  }
  const affected = new Map<string, Ref>();
  const queue = [...corrected];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const child of downstream.get(refKey(next)) ?? []) {
      const key = refKey(child);
      if (affected.has(key)) continue;
      affected.set(key, child);
      queue.push(child);
    }
  }
  const affectedRefs = uniqueRefs([...affected.values()]);
  const ofKind = <K extends RefKind>(refs: readonly Ref[], kind: K) =>
    refs.filter((ref): ref is Ref<K> => ref.kind === kind);
  const decisions = ofKind([...all.values()], "use_decision");
  return {
    ok: true,
    affected: affectedRefs,
    holdDecisions: ofKind(affectedRefs, "use_decision"),
    recheck: {
      assertions: ofKind(affectedRefs, "assertion"),
      supportSets: ofKind(affectedRefs, "support_set"),
      reports: ofKind(affectedRefs, "report"),
    },
    effects: ofKind(affectedRefs, "effect"),
    untouchedDecisions: uniqueRefs(decisions.filter((decision) => !affected.has(refKey(decision)))),
    authoritativeEpoch: affectedRefs.length > 0 ? currentEpoch + 1 : currentEpoch,
  };
}
