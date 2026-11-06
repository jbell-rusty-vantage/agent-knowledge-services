import type { Digest, Ref } from "@aiengineer/knowledge-operation-protocol";
import { type StoreScope, inScope, recordRef, refKey, uniqueRefs } from "../digest.js";
import { type AssertionVersion, NON_ENTAILED_KINDS, qualifiersDigest } from "../records/assertion.js";
import type { SupportObservation, VerificationObservation } from "../records/observation.js";
import type { SupportSet } from "../records/support.js";

/**
 * Support algebra (design §3, VERIFICATION.md §3 "Support-set rule"):
 *  - required premises are conjunctive within a set; a missing or unsupported premise fails the set (no averaging);
 *  - separate sets are alternatives; an assertion passes when at least one set is fully supported;
 *  - contrary evidence from every set and every contradicting observation is retained, never dropped by selection;
 *  - an observation made against different qualifiers is stale and is not reused;
 *  - ungrounded derivation cycles and refs outside the evaluation scope refuse the whole evaluation.
 */
export type PremiseStatus =
  | "supported"
  | "qualified"
  | "unassessed"
  | "unsupported"
  /** Authoritative evaluators disagree, or a contradiction cites no retained contrary fragment: holds, never rejects. */
  | "disputed"
  | "contradicted"
  | "integrity_failed"
  | "ungrounded";
export type SetStatus =
  | "supported"
  | "qualified"
  | "failed"
  | "disputed"
  | "contradicted"
  | "integrity_failed"
  | "invalidated";

export interface PremiseEvaluation {
  readonly premise: string;
  readonly status: PremiseStatus;
  readonly observations: readonly Ref<"observation">[];
  readonly reasons: readonly string[];
}

export interface SetEvaluation {
  readonly set: Ref<"support_set">;
  readonly status: SetStatus;
  readonly premises: readonly PremiseEvaluation[];
  readonly reasons: readonly string[];
}

export type SupportEvaluation =
  | {
      readonly ok: true;
      readonly assertion: Ref<"assertion">;
      readonly qualifiersDigest: Digest;
      /** False for recommendations and forecasts: `passes` then means "premises supported", not entailment. */
      readonly factEntailed: boolean;
      readonly passes: boolean;
      readonly selected: Ref<"support_set"> | null;
      readonly selectedStatus: "supported" | "qualified" | null;
      readonly sets: readonly SetEvaluation[];
      readonly contraryRetained: readonly Ref<"fragment">[];
      /** Contradictions grounded in a retained contrary fragment of the judged set: the only semantic rejection. */
      readonly contradictingObservations: readonly Ref<"observation">[];
      /**
       * Disputes (SV-09 integrator decision): a `conflict` verdict, or a `contradiction` citing no fragment the set
       * retains as contrary. They hold (`disputed_verdict`) and never reject on their own.
       */
      readonly disputedObservations: readonly Ref<"observation">[];
      readonly staleObservations: readonly Ref<"observation">[];
      /** L0 integrity failures that voided a premise; judge or human support never overrides them. */
      readonly integrityFailures: readonly Ref<"observation">[];
      /** A grounded contradiction exists (rejecting); a dispute alone is never a material conflict. */
      readonly materialConflict: boolean;
      readonly reasons: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: "UNGROUNDED_CYCLE" | "FOREIGN_SCOPE_REF";
      readonly reason: string;
      readonly refs: readonly Ref[];
    };

export interface SupportInput {
  readonly scope: StoreScope;
  readonly assertion: AssertionVersion;
  /** Every assertion a derivation may name as a premise. */
  readonly assertions: readonly AssertionVersion[];
  readonly supportSets: readonly SupportSet[];
  readonly observations: readonly VerificationObservation[];
}

const SEVERITY: Record<PremiseStatus, number> = {
  supported: 0,
  qualified: 1,
  unassessed: 2,
  unsupported: 3,
  disputed: 4,
  contradicted: 5,
  integrity_failed: 6,
  ungrounded: 7,
};

function worst(statuses: readonly PremiseStatus[]): PremiseStatus {
  return statuses.reduce<PremiseStatus>(
    (acc, status) => (SEVERITY[status] > SEVERITY[acc] ? status : acc),
    "supported",
  );
}

function foreignRefs(input: SupportInput): Ref[] {
  const refs: Ref[] = [recordRef("assertion", input.assertion)];
  for (const assertion of input.assertions) refs.push(recordRef("assertion", assertion), ...assertion.premises);
  for (const set of input.supportSets) {
    refs.push(set.assertion, ...set.contrary);
    for (const premise of set.required) refs.push(...premise.evidence, ...premise.derivedFrom);
  }
  for (const observation of input.observations) {
    refs.push(observation.target, ...observation.evidence);
    if (observation.property === "support") {
      refs.push(...observation.outcome.citedFragments, ...observation.outcome.contradictingFragments);
    }
    if (observation.property === "challenge" && observation.outcome.status === "searched") {
      refs.push(...observation.outcome.counterevidence);
    }
  }
  return refs.filter((ref) => !inScope(ref, input.scope));
}

interface InternalResult {
  readonly evaluation: Extract<SupportEvaluation, { ok: true }>;
  readonly cycle: boolean;
}

/**
 * A contradiction is grounded when it cites a fragment the support set retains as contrary evidence; only that rejects.
 * Any other `contradiction` or `conflict` (including one authoritative evaluator disagreeing with another) is a dispute.
 */
function groundedContradiction(observation: SupportObservation, contrary: ReadonlySet<string>): boolean {
  return (
    observation.outcome.verdict === "contradiction" &&
    observation.outcome.contradictingFragments.some((fragment) => contrary.has(refKey(fragment)))
  );
}

/** One evaluator: role plus the identity that produced the judgement (method/prompt digests are not identity). */
function evaluatorKey(observation: SupportObservation): string {
  const e = observation.evaluator;
  return [e.role, e.kind, e.provider, e.family, e.model, e.deployment, e.reviewerId].join("|");
}

const ACCEPTING: ReadonlySet<string> = new Set(["full_support", "qualified_support"]);

/**
 * R1 F3: an accepting verdict never outvotes a non-accepting one from a different evaluator. When two or more distinct
 * evaluators judged the premise and at least one accepted while another did not (partial, insufficient, unable), the
 * premise is disputed and holds (`disputed_verdict`); a single evaluator's own observations keep the ordinary ranking.
 */
function evaluatorsDisagree(observations: readonly SupportObservation[]): boolean {
  const accepting = new Set<string>();
  const declining = new Set<string>();
  for (const observation of observations) {
    (ACCEPTING.has(observation.outcome.verdict) ? accepting : declining).add(evaluatorKey(observation));
  }
  if (accepting.size === 0 || declining.size === 0) return false;
  return [...accepting].some((a) => [...declining].some((d) => a !== d));
}

function judgePremise(observations: readonly SupportObservation[], contrary: ReadonlySet<string>): PremiseStatus {
  if (observations.length === 0) return "unassessed";
  const verdicts = observations.map((observation) => observation.outcome.verdict);
  if (observations.some((observation) => groundedContradiction(observation, contrary))) return "contradicted";
  if (verdicts.some((verdict) => verdict === "contradiction" || verdict === "conflict")) return "disputed";
  if (evaluatorsDisagree(observations)) return "disputed";
  if (verdicts.includes("full_support")) return "supported";
  if (verdicts.includes("qualified_support")) return "qualified";
  return "unsupported";
}

export function evaluateSupport(input: SupportInput): SupportEvaluation {
  const foreign = foreignRefs(input);
  if (foreign.length > 0) {
    return {
      ok: false,
      code: "FOREIGN_SCOPE_REF",
      reason: `refs outside ${input.scope.tenant}/${input.scope.binding}`,
      refs: uniqueRefs(foreign),
    };
  }
  const assertionsByKey = new Map<string, AssertionVersion>();
  for (const assertion of [input.assertion, ...input.assertions]) {
    assertionsByKey.set(refKey(recordRef("assertion", assertion)), assertion);
  }
  const setsByAssertion = new Map<string, SupportSet[]>();
  for (const set of input.supportSets) {
    const key = refKey(set.assertion);
    setsByAssertion.set(key, [...(setsByAssertion.get(key) ?? []), set]);
  }
  // Bounded-challenge counterevidence (SV-07) is retained beside the sets' own contrary fragments, whatever set is
  // selected: a challenge never disappears because an alternative support set passes.
  const challengeContrary = new Map<string, Ref<"fragment">[]>();
  for (const observation of input.observations) {
    if (observation.property !== "challenge" || observation.outcome.status !== "searched") continue;
    const key = refKey(observation.target);
    challengeContrary.set(key, [...(challengeContrary.get(key) ?? []), ...observation.outcome.counterevidence]);
  }
  const observationsBySet = new Map<string, SupportObservation[]>();
  for (const observation of input.observations) {
    if (observation.property !== "support") continue;
    const key = refKey(observation.target);
    observationsBySet.set(key, [...(observationsBySet.get(key) ?? []), observation]);
  }
  // L0 mechanics fail closed (VERIFICATION.md §4): a recorded integrity failure on a set, its assertion or one of its
  // premise fragments voids that premise whatever any judge or reviewer concluded about support.
  const integrityFailures = input.observations.filter(
    (observation): observation is Extract<VerificationObservation, { property: "integrity" }> =>
      observation.property === "integrity" && observation.outcome.result === "fail",
  );
  const memo = new Map<string, InternalResult>();

  const evaluate = (assertion: AssertionVersion, stack: ReadonlySet<string>): InternalResult => {
    const assertionRef = recordRef("assertion", assertion);
    const key = refKey(assertionRef);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const currentQualifiers = qualifiersDigest(assertion.qualifiers);
    const declaredPremises = new Set(assertion.premises.map(refKey));
    // Cycles are tracked by logical identity: content addressing makes a digest cycle unconstructible, but a newer
    // version of A may still rest on B, which rests on an older version of A.
    const nextStack = new Set([...stack, assertion.logicalId]);
    const sets = [...(setsByAssertion.get(key) ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const contrary: Ref<"fragment">[] = [...(challengeContrary.get(key) ?? [])];
    const contradictions: Ref<"observation">[] = [];
    const disputes: Ref<"observation">[] = [];
    const stale: Ref<"observation">[] = [];
    const voiding: Ref<"observation">[] = [];
    const setEvaluations: SetEvaluation[] = [];
    let cycle = false;

    for (const set of sets) {
      const setRef = recordRef("support_set", set);
      contrary.push(...set.contrary);
      const setContrary = new Set(set.contrary.map(refKey));
      const all = observationsBySet.get(refKey(setRef)) ?? [];
      const current: SupportObservation[] = [];
      for (const observation of all) {
        const ref = recordRef("observation", observation);
        if (observation.qualifiersDigest !== currentQualifiers) {
          stale.push(ref);
          continue;
        }
        current.push(observation);
        const verdict = observation.outcome.verdict;
        if (verdict === "contradiction" || verdict === "conflict") {
          if (groundedContradiction(observation, setContrary)) contradictions.push(ref);
          else disputes.push(ref);
          contrary.push(...observation.outcome.contradictingFragments);
        }
      }
      if (set.qualifiersDigest !== currentQualifiers) {
        setEvaluations.push({ set: setRef, status: "invalidated", premises: [], reasons: ["qualifier_change"] });
        continue;
      }
      const whole = current.filter((observation) => observation.outcome.premise === null);
      const setKey = refKey(setRef);
      const failuresFor = (evidence: readonly Ref<"fragment">[]) =>
        integrityFailures.filter((failure) => {
          const target = refKey(failure.target);
          if (target === setKey || target === key)
            return (
              failure.evidence.length === 0 ||
              failure.evidence.some((f) => evidence.some((e) => refKey(e) === refKey(f)))
            );
          return failure.evidence.some((fragment) => evidence.some((item) => refKey(item) === refKey(fragment)));
        });
      const premises: PremiseEvaluation[] = set.required.map((premise) => {
        const statuses: PremiseStatus[] = [];
        const reasons: string[] = [];
        let used: SupportObservation[] = [];
        for (const derived of premise.derivedFrom) {
          const derivedKey = refKey(derived);
          if (!declaredPremises.has(derivedKey)) {
            statuses.push("unsupported");
            reasons.push(`undeclared_premise:${derived.id}`);
          } else {
            const target = assertionsByKey.get(derivedKey);
            if (target === undefined) {
              statuses.push("unsupported");
              reasons.push(`premise_assertion_unavailable:${derived.id}`);
            } else if (nextStack.has(target.logicalId)) {
              cycle = true;
              statuses.push("ungrounded");
              reasons.push(`derivation_cycle:${target.logicalId}`);
            } else {
              const sub = evaluate(target, nextStack);
              cycle ||= sub.cycle;
              if (!sub.evaluation.passes) {
                statuses.push(sub.cycle ? "ungrounded" : "unsupported");
                reasons.push(`premise_assertion_unsupported:${derived.id}`);
              } else {
                statuses.push(sub.evaluation.selectedStatus === "qualified" ? "qualified" : "supported");
              }
            }
          }
        }
        const failures = failuresFor(premise.evidence);
        if (failures.length > 0) {
          statuses.push("integrity_failed");
          reasons.push(`premise_integrity_failed:${premise.premise}`);
          voiding.push(...failures.map((failure) => recordRef("observation", failure)));
        }
        if (premise.evidence.length > 0) {
          const specific = current.filter((observation) => observation.outcome.premise === premise.premise);
          used = specific.length > 0 ? specific : whole;
          const status = judgePremise(used, setContrary);
          statuses.push(status);
          if (status === "disputed") disputes.push(...used.map((observation) => recordRef("observation", observation)));
          if (status !== "supported" && status !== "qualified") reasons.push(`premise_${status}:${premise.premise}`);
        }
        return {
          premise: premise.premise,
          status: worst(statuses),
          observations: used.map((observation) => recordRef("observation", observation)),
          reasons,
        };
      });
      const failing = premises.filter((premise) => premise.status !== "supported" && premise.status !== "qualified");
      const status: SetStatus = premises.some((premise) => premise.status === "integrity_failed")
        ? "integrity_failed"
        : premises.some((premise) => premise.status === "contradicted")
          ? "contradicted"
          : premises.some((premise) => premise.status === "disputed")
            ? "disputed"
            : failing.length > 0
              ? "failed"
              : premises.some((premise) => premise.status === "qualified")
                ? "qualified"
                : "supported";
      setEvaluations.push({ set: setRef, status, premises, reasons: failing.flatMap((premise) => premise.reasons) });
    }

    const supported = setEvaluations.find((set) => set.status === "supported");
    const qualified = setEvaluations.find((set) => set.status === "qualified");
    const selected = supported ?? qualified ?? null;
    const reasons: string[] = [];
    if (sets.length === 0) reasons.push("no_support_set");
    if (selected === null && sets.length > 0) reasons.push("no_alternative_fully_supported");
    const evaluation: Extract<SupportEvaluation, { ok: true }> = {
      ok: true,
      assertion: assertionRef,
      qualifiersDigest: currentQualifiers,
      factEntailed: !NON_ENTAILED_KINDS.has(assertion.kind),
      passes: selected !== null,
      selected: selected?.set ?? null,
      selectedStatus: selected === null ? null : selected.status === "supported" ? "supported" : "qualified",
      sets: setEvaluations,
      contraryRetained: uniqueRefs(contrary),
      contradictingObservations: uniqueRefs(contradictions),
      disputedObservations: uniqueRefs(disputes),
      staleObservations: uniqueRefs(stale),
      integrityFailures: uniqueRefs(voiding),
      materialConflict: contradictions.length > 0,
      reasons,
    };
    const result = { evaluation, cycle };
    if (!cycle) memo.set(key, result);
    return result;
  };

  const result = evaluate(input.assertion, new Set());
  if (result.cycle && !result.evaluation.passes) {
    return {
      ok: false,
      code: "UNGROUNDED_CYCLE",
      reason: "derivation premises form a cycle with no grounded alternative",
      refs: [result.evaluation.assertion],
    };
  }
  return result.evaluation;
}
