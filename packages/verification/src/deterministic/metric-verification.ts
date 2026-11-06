import type {
  MetricMechanicalResult,
  VerificationCheck,
  VerificationMetricObservation,
} from "@aiengineer/knowledge-contracts";
import {
  compareFractions,
  formatRoundedDecimal,
  parseDecimal,
  replayDecimalOperation,
  withinTolerance,
} from "../decimal/index.js";
import { CHECK, Checks } from "./checks.js";
import type { EvidenceEdgeResult, EvidenceEdgeVerifier } from "./evidence-edge.js";
import type { RuntimeSeparation } from "./runtime-separation.js";

export interface MetricGraphInput {
  readonly observations: readonly VerificationMetricObservation[];
  readonly separation: RuntimeSeparation;
  readonly verifyEvidence: EvidenceEdgeVerifier;
}

export interface MetricGraphResult {
  readonly duplicateChecks: readonly VerificationCheck[];
  readonly metrics: readonly MetricMechanicalResult[];
}

type FacetBinding = VerificationMetricObservation["evidenceBindings"][number];
type Calculation = NonNullable<VerificationMetricObservation["calculation"]>;

interface MetricContext {
  readonly observations: ReadonlyMap<string, VerificationMetricObservation>;
  readonly cyclicObservationIds: ReadonlySet<string>;
  readonly separation: RuntimeSeparation;
  readonly verifyEvidence: EvidenceEdgeVerifier;
  readonly resolveOperand: (observationId: string) => MetricMechanicalResult | undefined;
}

/**
 * Verifies every metric observation, replaying calculations through their
 * operand observations. Operands are resolved once and memoized; cycles are
 * detected up front so a cyclic operand is never resolved recursively.
 */
export function verifyMetricGraph(input: MetricGraphInput): MetricGraphResult {
  const observations = new Map(input.observations.map((metric) => [metric.observationId, metric]));
  const duplicateChecks = new Checks();
  if (observations.size !== input.observations.length)
    duplicateChecks.fail(CHECK.OBSERVATION_IDS_UNIQUE, "Metric observation IDs must be unique.");
  const memo = new Map<string, MetricMechanicalResult>();
  const context: MetricContext = {
    observations,
    cyclicObservationIds: findCyclicObservations(observations),
    separation: input.separation,
    verifyEvidence: input.verifyEvidence,
    resolveOperand: (observationId) => {
      const cached = memo.get(observationId);
      if (cached) return cached;
      const metric = observations.get(observationId);
      if (!metric) return undefined;
      const result = verifyMetric(context, metric);
      memo.set(observationId, result);
      return result;
    },
  };
  return {
    duplicateChecks: duplicateChecks.items,
    metrics: input.observations.map((metric) => context.resolveOperand(metric.observationId)!),
  };
}

/** Ids of every observation that sits on a calculation-operand cycle. */
function findCyclicObservations(observations: ReadonlyMap<string, VerificationMetricObservation>): ReadonlySet<string> {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  const visit = (observationId: string): void => {
    if (state.get(observationId) === "visited") return;
    if (state.get(observationId) === "visiting") {
      for (const id of stack.slice(stack.indexOf(observationId))) cyclic.add(id);
      return;
    }
    state.set(observationId, "visiting");
    stack.push(observationId);
    for (const operand of observations.get(observationId)?.calculation?.operands ?? [])
      if (observations.has(operand.observationId)) visit(operand.observationId);
    stack.pop();
    state.set(observationId, "visited");
  };
  for (const observationId of observations.keys()) visit(observationId);
  return cyclic;
}

function verifyMetric(context: MetricContext, metric: VerificationMetricObservation): MetricMechanicalResult {
  const evidence = new Map(metric.evidence.map((edge) => [edge.evidenceId, context.verifyEvidence(edge)]));
  const checks = new Checks(metric.observationId);
  checks.require(CHECK.PRODUCER_VERIFIER_INDEPENDENT, context.separation.established, {
    pass: "Metric producer and verifier are separated.",
    fail: "Metric deployment separation is not established.",
  });
  checkDeclaration(checks, metric);
  for (const binding of metric.evidenceBindings)
    checkFacetBinding(checks, metric, binding, evidence.get(binding.evidenceId));
  const replayedValue = metric.calculation ? checkCalculation(checks, context, metric, metric.calculation) : undefined;
  if (!metric.calculation)
    checks.pass(CHECK.DIRECT_OBSERVATION_DECLARED, "Metric is a source-bound direct observation.");
  const status = checks.status();
  return {
    observationId: metric.observationId,
    status,
    semanticEligibility: status === "passed",
    checks: [...checks.items],
    ...(replayedValue === undefined ? {} : { replayedValue }),
  };
}

/** Entity, canonical value, unit, period and comparability group are all explicit and well formed. */
function checkDeclaration(checks: Checks, metric: VerificationMetricObservation): void {
  checks.require(
    CHECK.ENTITY_ID_EXPLICIT,
    metric.entity.canonicalId.trim() !== "" && metric.entity.label.trim() !== "",
    `Entity is ${metric.entity.kind}:${metric.entity.canonicalId}.`,
  );
  checks.require(
    CHECK.CANONICAL_NUMBER_VALID,
    parsesAsDecimal(metric.canonicalValue),
    `Canonical value is ${metric.canonicalValue}.`,
  );
  checks.require(
    CHECK.UNIT_EXPLICIT_AND_VALID,
    isPositiveDecimal(metric.unit.scaleToCanonical),
    `Unit is ${metric.unit.symbol} (${metric.unit.dimension}).`,
  );
  const periodOrdered =
    metric.period.start === undefined ||
    metric.period.end === undefined ||
    Date.parse(metric.period.start) <= Date.parse(metric.period.end);
  checks.require(CHECK.OBSERVATION_PERIOD_VALID, periodOrdered, {
    pass: "Observation period is ordered.",
    fail: "Observation period ends before it starts.",
  });
  checks.require(
    CHECK.COMPARABILITY_GROUP_PRESENT,
    metric.comparabilityGroup.trim() !== "",
    `Comparability group is ${metric.comparabilityGroup}.`,
  );
}

/** The binding's expected literal must match the declared observation facet and the verified source bytes. */
function checkFacetBinding(
  checks: Checks,
  metric: VerificationMetricObservation,
  binding: FacetBinding,
  evidence: EvidenceEdgeResult | undefined,
): void {
  checks.require(
    CHECK.METRIC_BINDING_DECLARATION_MATCH,
    declaredFacetLiterals(metric, binding.facet).includes(binding.expectedLiteral),
    `${binding.facet} binding must match the canonical observation.`,
  );
  const selected = evidence?.selection;
  const rawSelected = selected?.selectedValue ?? selected?.selectedText;
  const sourceMatches =
    rawSelected !== undefined &&
    facetLiteralMatches(
      binding.comparison,
      typeof rawSelected === "string" ? rawSelected.trim() : String(rawSelected),
      binding.expectedLiteral,
    );
  checks.require(
    CHECK.METRIC_FACET_SOURCE_BOUND,
    evidence?.contract.status === "passed" && sourceMatches,
    `${binding.facet} must resolve from verified source bytes to ${binding.expectedLiteral}.`,
  );
}

function declaredFacetLiterals(
  metric: VerificationMetricObservation,
  facet: FacetBinding["facet"],
): readonly (string | undefined)[] {
  switch (facet) {
    case "value":
      return [metric.canonicalValue];
    case "unit":
      return [metric.unit.symbol];
    case "identity":
      return [metric.entity.canonicalId, metric.entity.label];
    case "period_start":
      return [metric.period.start];
    case "period_end":
      return [metric.period.end];
  }
}

/**
 * Metric facet comparison. This is intentionally not shared with extraction's
 * `compareValue`: extraction's `exact` compares canonical JSON (not raw strings)
 * and its `decimal` applies a stricter literal grammar plus declared ranges.
 */
function facetLiteralMatches(comparison: FacetBinding["comparison"], selected: string, expected: string): boolean {
  switch (comparison) {
    case "decimal":
      return decimalsEqual(selected, expected);
    case "iso_datetime":
      return Number.isFinite(Date.parse(selected)) && Date.parse(selected) === Date.parse(expected);
    default:
      return selected === expected;
  }
}

/** Replays the calculation from its declared operands; returns the rounded replayed value when replay succeeded. */
function checkCalculation(
  checks: Checks,
  context: MetricContext,
  metric: VerificationMetricObservation,
  calculation: Calculation,
): string | undefined {
  const cyclic = context.cyclicObservationIds.has(metric.observationId);
  checks.require(CHECK.CALCULATION_GRAPH_ACYCLIC, !cyclic, {
    pass: "Calculation dependency graph is acyclic.",
    fail: "Calculation dependency graph contains a cycle.",
  });
  for (const operand of calculation.operands) checkOperand(checks, context, operand, cyclic);
  // The replayed value is retained even when a later parse fails, so it is
  // assigned before the expected/tolerance literals are parsed.
  let replayedValue: string | undefined;
  try {
    replayedValue = formatRoundedDecimal(
      replayDecimalOperation(
        calculation.operation,
        calculation.operands.map((operand) => operand.value),
      ),
      calculation.rounding.decimalPlaces,
      calculation.rounding.mode,
    );
    const expected = parseDecimal(calculation.expectedResult);
    const tolerance = parseDecimal(calculation.tolerance);
    const replayMatches = withinTolerance(parseDecimal(replayedValue), expected, tolerance);
    const observationMatches = withinTolerance(parseDecimal(metric.canonicalValue), expected, tolerance);
    checks.require(
      CHECK.CALCULATION_REPLAYS,
      replayMatches,
      `Replayed result is ${replayedValue}; expected ${calculation.expectedResult}.`,
    );
    checks.require(
      CHECK.OBSERVED_VALUE_MATCHES_CALCULATION,
      observationMatches,
      `Observed value is ${metric.canonicalValue}.`,
    );
  } catch (error) {
    checks.fail(CHECK.CALCULATION_REPLAYS, error instanceof Error ? error.message : "Calculation replay failed.");
  }
  return replayedValue;
}

/** An operand must exist, carry its observation's canonical value, and itself have passed. */
function checkOperand(
  checks: Checks,
  context: MetricContext,
  operand: Calculation["operands"][number],
  cyclic: boolean,
): void {
  const referenced = context.observations.get(operand.observationId);
  const referencedResult = cyclic ? undefined : context.resolveOperand(operand.observationId);
  checks.require(CHECK.CALCULATION_OPERAND_PRESENT, referenced !== undefined, {
    pass: `Operand ${operand.observationId} exists.`,
    fail: `Operand ${operand.observationId} is missing.`,
  });
  checks.require(
    CHECK.CALCULATION_OPERAND_VALUE_BOUND,
    referenced !== undefined && decimalsEqual(operand.value, referenced.canonicalValue),
    referenced
      ? `Operand ${operand.observationId} must equal its canonical observation value.`
      : "A missing operand cannot bind a value.",
  );
  checks.require(CHECK.CALCULATION_OPERAND_VERIFIED, referencedResult?.status === "passed", {
    pass: `Operand ${operand.observationId} passed deterministic verification.`,
    fail: `Operand ${operand.observationId} is not mechanically eligible.`,
  });
}

function parsesAsDecimal(literal: string): boolean {
  try {
    parseDecimal(literal);
    return true;
  } catch {
    return false;
  }
}

function isPositiveDecimal(literal: string): boolean {
  try {
    return compareFractions(parseDecimal(literal), parseDecimal("0")) > 0;
  } catch {
    return false;
  }
}

/** Numeric equality of two decimal literals; unparsable literals never match. */
function decimalsEqual(left: string, right: string): boolean {
  try {
    return compareFractions(parseDecimal(left), parseDecimal(right)) === 0;
  } catch {
    return false;
  }
}
