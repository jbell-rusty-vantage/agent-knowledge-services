import { type Ref, sameRef } from "@aiengineer/knowledge-operation-protocol";
import {
  type JudgmentPolicyRegistry,
  type UseClass,
  authorityGateRequired,
  judgmentBasisGaps,
  judgmentPolicyFor,
  officialUse,
} from "../authority/rules.js";
import { type StoreScope, recordRef, refKey } from "../digest.js";
import { type AssertionVersion, NON_ENTAILED_KINDS, qualifiersDigest } from "../records/assertion.js";
import {
  type AuthorityObservation,
  type ChallengeObservation,
  type VerificationObservation,
  authorityAdverse,
  authorityUnknown,
} from "../records/observation.js";
import type { AssertionOccurrence } from "../records/occurrence.js";
import type { SupportSet } from "../records/support.js";
import type { VerificationTaskContract } from "../records/task.js";
import type { CensusFinding } from "../report/census.js";
import { type SupportEvaluation, evaluateSupport } from "../support/algebra.js";

/** Evaluator roles whose observations are authoritative for aggregation. Producer self-assessment never is (E03). */
export const AUTHORITATIVE_ROLES: ReadonlySet<string> = new Set([
  "judge",
  "second_family_judge",
  "auditor",
  "human_reviewer",
]);

/**
 * The observations aggregation and exact-use decisions may rely on: authoritative roles, plus every recorded L0
 * integrity observation whatever its role (mechanics fail closed; a judge never overrides a broken pointer).
 */
export function authoritativeObservations(observations: readonly VerificationObservation[]): VerificationObservation[] {
  return observations.filter(
    (observation) => AUTHORITATIVE_ROLES.has(observation.evaluator.role) || observation.property === "integrity",
  );
}

export type AggregateReason =
  | "no_occurrence"
  | "unsupported"
  | "contradicted"
  /** Authoritative evaluators disagree (or a contradiction is not grounded in retained contrary evidence): holds. */
  | "disputed_verdict"
  | "integrity_failure"
  | "producer_only_coverage"
  | "support_refused"
  | "census_not_run"
  | "census_stale"
  | "census_unexplained_difference"
  /** SV-07 gate (critical risk, or scientific profile under an official/consequential use): */
  | "authority_missing"
  | "authority_adverse"
  | "challenge_missing"
  | "challenge_unresolved"
  /** OQ4: a forecast/recommendation without an admitting judgment policy never covers for official/critical use. */
  | "non_entailed"
  /** WI-03: an admitting judgment policy exists but the assertion's typed judgment basis does not meet it. */
  | "judgment_basis_incomplete";

export interface ObligationAggregate {
  readonly id: string;
  readonly required: boolean;
  readonly weight: number;
  readonly status: "covered" | "held" | "unmet";
  /**
   * What a covered obligation rests on: `entailed` (some covering assertion is fact-entailed) or `judgment` (only
   * recommendations/forecasts admitted by a judgment policy cover it; WI-03). `null` when not covered.
   */
  readonly basis: "entailed" | "judgment" | null;
  readonly reasons: readonly AggregateReason[];
  readonly occurrences: readonly string[];
}

export interface ReportAggregate {
  readonly obligations: readonly ObligationAggregate[];
  readonly unmetRequired: readonly string[];
  readonly heldRequired: readonly string[];
  /**
   * Required obligations whose only occurrences are contradicted or fail L0 integrity. Missing evidence is not a
   * contradiction (design §1): an unmet required obligation without one of these reasons holds, it does not reject.
   */
  readonly rejectingRequired: readonly string[];
  /** Integer weights; the denominator is always every original obligation. */
  readonly coveredWeight: number;
  readonly totalWeight: number;
  readonly holdsByReason: Readonly<Partial<Record<AggregateReason, number>>>;
  readonly complete: boolean;
  /** Whether the SV-07 authority/challenge gate applied to this aggregation. */
  readonly authorityGate: boolean;
  /**
   * Obligations covered only by policy-admitted judgments (WI-03). Their use always needs a qualified review, and the
   * decision records them as `judgment_not_entailed:<id>`: judgment approval is never fact entailment.
   */
  readonly judgmentCovered: readonly string[];
  /** `<policy id>@<version>` of every judgment policy a covering judgment relied on, sorted. */
  readonly judgmentPolicies: readonly string[];
}

/** The latest authoritative, current-qualifier observation of one property on one of the given targets. */
function latestOn<T extends VerificationObservation>(
  observations: readonly VerificationObservation[],
  property: T["property"],
  targets: readonly Ref[],
  currentQualifiers: string,
): T | undefined {
  const keys = new Set(targets.map(refKey));
  const matching = observations.filter(
    (observation): observation is T =>
      observation.property === property &&
      AUTHORITATIVE_ROLES.has(observation.evaluator.role) &&
      keys.has(refKey(observation.target)) &&
      (observation.qualifiersDigest === null || observation.qualifiersDigest === currentQualifiers),
  );
  return matching[matching.length - 1];
}

/**
 * Design §3.1 judgments 2 (authority, fitness, revision frontier) and bounded challenge, as gate reasons for one
 * covering assertion: an authoritative non-adverse authority observation on the assertion or its selected support set,
 * and an authoritative completed challenge without an unresolved material conflict. Empty = the gate passes.
 */
export function authorityChallengeReasons(input: {
  readonly assertion: AssertionVersion;
  readonly selectedSet: Ref<"support_set"> | null;
  readonly observations: readonly VerificationObservation[];
}): AggregateReason[] {
  const assertionRef = recordRef("assertion", input.assertion);
  const current = qualifiersDigest(input.assertion.qualifiers);
  const targets: Ref[] = input.selectedSet === null ? [assertionRef] : [assertionRef, input.selectedSet];
  const reasons: AggregateReason[] = [];
  const authority = latestOn<AuthorityObservation>(input.observations, "authority", targets, current);
  if (authority === undefined || authorityUnknown(authority.outcome)) reasons.push("authority_missing");
  else if (authorityAdverse(authority.outcome)) reasons.push("authority_adverse");
  const challenge = latestOn<ChallengeObservation>(input.observations, "challenge", [assertionRef], current);
  if (challenge === undefined || challenge.outcome.status === "not_searched") reasons.push("challenge_missing");
  else if (challenge.outcome.materialConflict) reasons.push("challenge_unresolved");
  return reasons;
}

type Judgment =
  | { readonly status: "covered"; readonly basis: "entailed" | "judgment"; readonly policy?: string }
  | { readonly status: "gated"; readonly reasons: readonly AggregateReason[] }
  | { readonly status: "failed"; readonly reason: AggregateReason };

/**
 * Report-level aggregation, computed after authoritative semantic observations (finding E03): an obligation is covered
 * only when an occurrence mapped to it names an assertion that passes the support algebra on non-producer observations.
 * Passing on producer observations alone holds (`producer_only_coverage`). Unexplained census differences hold
 * required obligations. When the SV-07 gate applies (critical risk, or the scientific profile under an official or
 * consequential use class), a passing assertion also needs non-adverse authority and a completed bounded challenge from
 * authoritative roles, and a non-entailed assertion (forecast/recommendation) never covers for official use. The
 * original obligation denominator is never reduced.
 */
export function aggregateReport(input: {
  readonly scope: StoreScope;
  readonly task: VerificationTaskContract;
  readonly occurrences: readonly AssertionOccurrence[];
  readonly assertions: readonly AssertionVersion[];
  readonly supportSets: readonly SupportSet[];
  readonly observations: readonly VerificationObservation[];
  /** Derived from recorded auditor census observations (`findCensus`), never supplied by the caller. */
  readonly census: CensusFinding;
  /**
   * The report revision under aggregation (R1 F4). A recorded L0 integrity `fail` targeted at it, from any role, voids
   * every obligation as `integrity_failure` (rejecting when required). Null only when no revision exists yet.
   */
  readonly report: Ref<"report"> | null;
  /** The K08 use class of the task's use/audience (`useClassOf`); defaults to `internal`. */
  readonly useClass?: UseClass;
  /** The use and audience being decided (default: the task's own); judgment policies are use-specific. */
  readonly use?: string;
  readonly audience?: string;
  /** K08 judgment policies (WI-03); `null`/absent keeps the OQ4 exclusion for every non-entailed assertion. */
  readonly judgmentPolicies?: JudgmentPolicyRegistry | null;
}): ReportAggregate {
  const useClass = input.useClass ?? "internal";
  const gate = authorityGateRequired(input.task, useClass);
  const official = officialUse(input.task, useClass);
  const authoritative = authoritativeObservations(input.observations);
  const reportKey = input.report === null ? null : refKey(input.report);
  const reportIntegrityFailed =
    reportKey !== null &&
    input.observations.some(
      (observation) =>
        observation.property === "integrity" &&
        observation.outcome.result === "fail" &&
        refKey(observation.target) === reportKey,
    );
  const judge = (occurrence: AssertionOccurrence): Judgment => {
    const assertion = input.assertions.find((candidate) =>
      sameRef(recordRef("assertion", candidate), occurrence.assertion),
    );
    if (assertion === undefined) return { status: "failed", reason: "unsupported" };
    const base = { scope: input.scope, assertion, assertions: input.assertions, supportSets: input.supportSets };
    const strict: SupportEvaluation = evaluateSupport({ ...base, observations: authoritative });
    if (!strict.ok) return { status: "failed", reason: "support_refused" };
    if (strict.passes) {
      const reasons: AggregateReason[] = [];
      let basis: "entailed" | "judgment" = "entailed";
      let policyRef: string | undefined;
      if (NON_ENTAILED_KINDS.has(assertion.kind)) {
        basis = "judgment";
        if (official) {
          const policy = judgmentPolicyFor(input.judgmentPolicies ?? null, {
            use: input.use ?? input.task.use,
            audience: input.audience ?? input.task.audience,
            useClass,
            kind: assertion.kind,
          });
          if (policy === null) reasons.push("non_entailed");
          else if (judgmentBasisGaps(policy, assertion).length > 0) reasons.push("judgment_basis_incomplete");
          else policyRef = `${policy.id}@${policy.version}`;
        }
      }
      if (gate)
        reasons.push(
          ...authorityChallengeReasons({ assertion, selectedSet: strict.selected, observations: authoritative }),
        );
      if (reasons.length > 0) return { status: "gated", reasons };
      return policyRef === undefined ? { status: "covered", basis } : { status: "covered", basis, policy: policyRef };
    }
    if (strict.integrityFailures.length > 0) return { status: "failed", reason: "integrity_failure" };
    if (strict.materialConflict) return { status: "failed", reason: "contradicted" };
    if (strict.disputedObservations.length > 0) return { status: "failed", reason: "disputed_verdict" };
    const lenient = evaluateSupport({ ...base, observations: input.observations });
    return lenient.ok && lenient.passes
      ? { status: "failed", reason: "producer_only_coverage" }
      : { status: "failed", reason: "unsupported" };
  };

  const policies = new Set<string>();
  const obligations: ObligationAggregate[] = input.task.obligations.map((obligation) => {
    const mapped = input.occurrences.filter((occurrence) => occurrence.obligations.includes(obligation.id));
    const outcomes = mapped.map(judge);
    const reasons = new Set<AggregateReason>();
    let status: ObligationAggregate["status"];
    const covering = outcomes.filter(
      (outcome): outcome is Extract<Judgment, { status: "covered" }> => outcome.status === "covered",
    );
    if (reportIntegrityFailed) {
      // Mechanics fail closed: no judge, reviewer or alternative support set covers anything in a report whose own
      // L0 integrity failed.
      status = "unmet";
      reasons.add("integrity_failure");
    } else if (mapped.length === 0) {
      status = "unmet";
      reasons.add("no_occurrence");
    } else if (outcomes.some((outcome) => outcome.status === "covered")) {
      status = "covered";
    } else if (outcomes.some((outcome) => outcome.status === "gated")) {
      status = "held";
      for (const outcome of outcomes) {
        if (outcome.status === "gated") for (const reason of outcome.reasons) reasons.add(reason);
      }
    } else {
      for (const outcome of outcomes) if (outcome.status === "failed") reasons.add(outcome.reason);
      status =
        reasons.has("producer_only_coverage") || reasons.has("support_refused") || reasons.has("disputed_verdict")
          ? "held"
          : "unmet";
    }
    if (obligation.required && status === "covered") {
      if (input.census.status === "not_run") {
        status = "held";
        reasons.add("census_not_run");
      } else if (input.census.status === "stale") {
        status = "held";
        reasons.add("census_stale");
      } else if (input.census.holdsRequiredCoverage) {
        status = "held";
        reasons.add("census_unexplained_difference");
      }
    }
    const basis =
      status !== "covered"
        ? null
        : covering.some((outcome) => outcome.basis === "entailed")
          ? ("entailed" as const)
          : ("judgment" as const);
    if (basis === "judgment") {
      for (const outcome of covering) if (outcome.policy !== undefined) policies.add(outcome.policy);
    }
    return {
      id: obligation.id,
      required: obligation.required,
      weight: obligation.weight,
      status,
      basis,
      reasons: [...reasons].sort(),
      occurrences: mapped.map((occurrence) => occurrence.id),
    };
  });
  const holdsByReason: Partial<Record<AggregateReason, number>> = {};
  for (const obligation of obligations) {
    for (const reason of obligation.reasons) holdsByReason[reason] = (holdsByReason[reason] ?? 0) + 1;
  }
  const unmetRequired = obligations.filter((o) => o.required && o.status === "unmet").map((o) => o.id);
  const heldRequired = obligations.filter((o) => o.required && o.status === "held").map((o) => o.id);
  const rejectingRequired = obligations
    .filter((o) => o.required && o.status === "unmet")
    .filter((o) => o.reasons.includes("contradicted") || o.reasons.includes("integrity_failure"))
    .map((o) => o.id);
  return {
    obligations,
    unmetRequired,
    heldRequired,
    rejectingRequired,
    coveredWeight: obligations.filter((o) => o.status === "covered").reduce((sum, o) => sum + o.weight, 0),
    totalWeight: obligations.reduce((sum, o) => sum + o.weight, 0),
    holdsByReason,
    complete: unmetRequired.length === 0 && heldRequired.length === 0,
    authorityGate: gate,
    judgmentCovered: obligations.filter((o) => o.basis === "judgment").map((o) => o.id),
    judgmentPolicies: [...policies].sort(),
  };
}
