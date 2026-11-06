import { type Digest, type Ref, digestCanonical, sameRef } from "@aiengineer/knowledge-operation-protocol";
import { recordRef } from "../digest.js";
import type { AssertionVersion } from "../records/assertion.js";
import type { RiskClass, Span } from "../records/common.js";
import {
  type CensusOutcome,
  CensusOutcomeSchema,
  type ScreeningFlag,
  type VerificationObservation,
} from "../records/observation.js";
import type { AssertionOccurrence, DiscoveredOccurrence } from "../records/occurrence.js";
import type { ReportRevision } from "../records/report.js";
import { verifyOccurrence } from "./ledger.js";
import { type FrozenReport, type UnitKind, quoteDigest } from "./render.js";

/**
 * Final census (design §3.2): deterministic structural coverage over every heading/block/list item/cell/caption plus
 * reconciliation of the producer ledger against the auditor's independent discovery. Structural coverage says which
 * units carry a verified occurrence; it never claims recall. Recall is a separately measured label (`censusOutcome`).
 */
export interface CoverageUnit {
  readonly path: string;
  readonly kind: UnitKind;
  readonly factual: boolean;
  readonly covered: boolean;
}

export type StructuralCoverage =
  | {
      readonly ok: true;
      readonly units: readonly CoverageUnit[];
      readonly totalUnits: number;
      readonly factualUnits: number;
      readonly coveredFactualUnits: number;
      readonly uncoveredFactual: readonly string[];
      readonly excluded: readonly { readonly path: string; readonly reason: string }[];
      /** Occurrences whose quote no longer matches or whose span falls outside their declared unit. */
      readonly misplaced: readonly string[];
    }
  | { readonly ok: false; readonly code: "BODY_DIGEST_MISMATCH"; readonly occurrences: readonly string[] };

export function structuralCoverage(
  frozen: FrozenReport,
  occurrences: readonly AssertionOccurrence[],
): StructuralCoverage {
  const stale = occurrences.filter((occurrence) => occurrence.body.digest !== frozen.bodyDigest);
  if (stale.length > 0) {
    return { ok: false, code: "BODY_DIGEST_MISMATCH", occurrences: stale.map((occurrence) => occurrence.id) };
  }
  const misplaced: string[] = [];
  const coveredPaths = new Set<string>();
  for (const occurrence of occurrences) {
    const unitSpan = frozen.units.find((unit) => unit.path === occurrence.blockPath)?.span ?? null;
    const inside = unitSpan !== null && occurrence.span.start >= unitSpan.start && occurrence.span.end <= unitSpan.end;
    if (!inside || !verifyOccurrence(frozen, occurrence).ok) {
      misplaced.push(occurrence.id);
      continue;
    }
    coveredPaths.add(occurrence.blockPath);
  }
  const units: CoverageUnit[] = frozen.units.map((unit) => ({
    path: unit.path,
    kind: unit.kind,
    factual: unit.factual,
    covered: coveredPaths.has(unit.path),
  }));
  const factual = units.filter((unit) => unit.factual);
  return {
    ok: true,
    units,
    totalUnits: units.length,
    factualUnits: factual.length,
    coveredFactualUnits: factual.filter((unit) => unit.covered).length,
    uncoveredFactual: factual.filter((unit) => !unit.covered).map((unit) => unit.path),
    excluded: frozen.units.flatMap((unit) =>
      unit.excludedReason === null ? [] : [{ path: unit.path, reason: unit.excludedReason }],
    ),
    misplaced,
  };
}

/** The section a unit path belongs to (`<section>/<block>/...`). */
export function sectionOf(path: string): string {
  return path.split("/")[0] ?? path;
}

export const FRAMING_EXCLUSION_PREFIX = "framing section" as const;

/**
 * Kind-declared framing sections (scope/as-of, limitations, search frontier, evidence summary) are non-factual: every
 * unit in them becomes excluded with an auditable reason, unless it already carries its own exclusion reason. Units
 * of every other section (headings, cells, captions included) are unchanged.
 */
export function withFramingExclusions(frozen: FrozenReport, framing: readonly string[]): FrozenReport {
  if (framing.length === 0) return frozen;
  const sections = new Set(framing);
  return {
    ...frozen,
    units: frozen.units.map((unit) =>
      sections.has(sectionOf(unit.path)) && unit.factual
        ? {
            ...unit,
            factual: false,
            excludedReason: `${FRAMING_EXCLUSION_PREFIX} ${sectionOf(unit.path)} (kind-declared non-factual)`,
          }
        : unit,
    ),
  };
}

export interface CensusExplanation {
  readonly occurrenceId: string;
  readonly reason: string;
}

export interface UnitExplanation {
  readonly path: string;
  readonly reason: string;
}

/**
 * What reconciliation needs from either inventory: a producer ledger entry or an auditor-discovered occurrence. An
 * auditor occurrence may name no assertion (`null`): it then matches by span only and never counts as a disagreement.
 */
export interface CensusItem {
  readonly id: string;
  readonly body: { readonly digest: string };
  readonly blockPath: string;
  readonly span: Span;
  readonly assertion: Ref<"assertion"> | null;
}

export type CensusReconciliation =
  | {
      readonly ok: true;
      readonly matched: readonly {
        readonly producer: string;
        readonly auditor: string;
        readonly assertionAgrees: boolean;
      }[];
      readonly unexplainedProducerOnly: readonly string[];
      readonly unexplainedAuditorOnly: readonly string[];
      /** Producer occurrence ids whose overlapping auditor occurrence names a different assertion. */
      readonly assertionDisagreements: readonly string[];
      readonly explained: readonly CensusExplanation[];
      /** Unexplained differences hold required coverage. */
      readonly holdsRequiredCoverage: boolean;
    }
  | { readonly ok: false; readonly code: "BODY_DIGEST_MISMATCH"; readonly occurrences: readonly string[] };

const byPosition = (a: CensusItem, b: CensusItem) =>
  a.blockPath < b.blockPath ? -1 : a.blockPath > b.blockPath ? 1 : a.span.start - b.span.start;

const sameAssertion = (a: Ref<"assertion"> | null, b: Ref<"assertion"> | null) =>
  a !== null && b !== null && sameRef(a, b);

/**
 * Match producer and auditor occurrences in the same unit with overlapping spans (same assertion preferred). Each
 * occurrence matches at most once, so a repeated sentence is two occurrences, never one. Explanations clear named
 * differences; whatever stays unexplained holds required coverage.
 */
export function reconcileCensus(
  producer: readonly CensusItem[],
  auditor: readonly CensusItem[],
  explanations: readonly CensusExplanation[] = [],
): CensusReconciliation {
  const body = producer[0]?.body.digest ?? auditor[0]?.body.digest;
  const mismatched = [...producer, ...auditor].filter((occurrence) => occurrence.body.digest !== body);
  if (mismatched.length > 0) {
    return { ok: false, code: "BODY_DIGEST_MISMATCH", occurrences: mismatched.map((occurrence) => occurrence.id) };
  }
  const remaining = [...auditor].sort(byPosition);
  const matched: { producer: string; auditor: string; assertionAgrees: boolean }[] = [];
  const disagreeing: string[] = [];
  const producerOnly: string[] = [];
  for (const occurrence of [...producer].sort(byPosition)) {
    const overlapping = remaining.filter(
      (candidate) =>
        candidate.blockPath === occurrence.blockPath &&
        candidate.span.start < occurrence.span.end &&
        occurrence.span.start < candidate.span.end,
    );
    const pick =
      overlapping.find((candidate) => sameAssertion(candidate.assertion, occurrence.assertion)) ?? overlapping[0];
    if (pick === undefined) {
      producerOnly.push(occurrence.id);
      continue;
    }
    remaining.splice(remaining.indexOf(pick), 1);
    const agrees = sameAssertion(pick.assertion, occurrence.assertion);
    matched.push({ producer: occurrence.id, auditor: pick.id, assertionAgrees: agrees });
    if (!agrees && pick.assertion !== null) disagreeing.push(occurrence.id);
  }
  const explainedIds = new Map(explanations.map((explanation) => [explanation.occurrenceId, explanation]));
  const explained: CensusExplanation[] = [];
  const unexplained = (ids: readonly string[]) =>
    ids.filter((id) => {
      const explanation = explainedIds.get(id);
      if (explanation !== undefined && !explained.includes(explanation)) explained.push(explanation);
      return explanation === undefined;
    });
  const unexplainedProducerOnly = unexplained(producerOnly);
  const unexplainedAuditorOnly = unexplained(remaining.map((occurrence) => occurrence.id));
  const assertionDisagreements = unexplained(disagreeing);
  return {
    ok: true,
    matched,
    unexplainedProducerOnly,
    unexplainedAuditorOnly,
    assertionDisagreements,
    explained,
    holdsRequiredCoverage:
      unexplainedProducerOnly.length + unexplainedAuditorOnly.length + assertionDisagreements.length > 0,
  };
}

export type { ScreeningFlag };
/** Deterministic negation cue list (English); a cue is a reason to compare, never a verdict. */
export const NEGATION_PATTERN = /\b(not|no|never|none|neither|nor|without|cannot)\b|n't\b/i;

export function isNegatedText(text: string): boolean {
  return NEGATION_PATTERN.test(text);
}

export function isInterrogativeText(text: string): boolean {
  return text.trimEnd().endsWith("?");
}

/** A letter outside ASCII: the English cue lists cannot vouch for the quote's polarity or modality. */
const NON_ASCII_LETTER = /(?=\P{ASCII})\p{L}/u;

/**
 * Whether the deterministic cues can screen the text (R1 F5, OQ3): only detectably English (ASCII-letter) text. This is
 * a cheap guard, not language identification; accented English is reported unscreenable too and an auditor
 * explanation clears it.
 */
export function isScreenableText(text: string): boolean {
  return !NON_ASCII_LETTER.test(text);
}

/** Risk classes at which an unscreenable quote is itself a flag. */
const SCREEN_REQUIRED_RISK: ReadonlySet<RiskClass> = new Set(["high", "critical"]);

/**
 * Deterministic screen of an occurrence's quoted text against its assertion's polarity and modality. A flag is a
 * reason to hold for review, not a verdict. For a high/critical task (`minimumRisk`) a quote the cues cannot screen is
 * flagged `unable_to_screen`.
 */
export function screenOccurrence(
  frozen: Pick<FrozenReport, "text">,
  occurrence: AssertionOccurrence,
  assertion: AssertionVersion,
  minimumRisk?: RiskClass,
): ScreeningFlag[] {
  const quote = frozen.text.slice(occurrence.span.start, occurrence.span.end);
  const flags: ScreeningFlag[] = [];
  if (minimumRisk !== undefined && SCREEN_REQUIRED_RISK.has(minimumRisk) && !isScreenableText(quote)) {
    flags.push("unable_to_screen");
  }
  if (isNegatedText(quote) !== assertion.qualifiers.negation) flags.push("negation_mismatch");
  if (isInterrogativeText(quote) && assertion.qualifiers.modality !== "interrogative") {
    flags.push("question_as_assertion");
  }
  return flags;
}

export type DiscoveryCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "DISCOVERY_INVALID";
      readonly occurrences: readonly { readonly id: string; readonly reason: string }[];
    };

/** Every discovered occurrence must bind the frozen body, quote its exact bytes and lie inside its declared unit. */
export function verifyDiscovery(frozen: FrozenReport, discovered: readonly DiscoveredOccurrence[]): DiscoveryCheck {
  const invalid: { id: string; reason: string }[] = [];
  for (const occurrence of discovered) {
    const unit = frozen.units.find((candidate) => candidate.path === occurrence.blockPath);
    if (occurrence.body.digest !== frozen.bodyDigest) invalid.push({ id: occurrence.id, reason: "body_digest" });
    else if (occurrence.span.end > frozen.text.length) invalid.push({ id: occurrence.id, reason: "span_out_of_range" });
    else if (quoteDigest(frozen.text, occurrence.span) !== occurrence.quoteDigest) {
      invalid.push({ id: occurrence.id, reason: "quote_digest" });
    } else if (
      unit?.span === null ||
      unit === undefined ||
      occurrence.span.start < unit.span.start ||
      occurrence.span.end > unit.span.end
    ) {
      invalid.push({ id: occurrence.id, reason: "outside_unit" });
    }
  }
  return invalid.length === 0 ? { ok: true } : { ok: false, code: "DISCOVERY_INVALID", occurrences: invalid };
}

/** The observation `inputDigest` of a census: exact body bytes, producer inventory and auditor inventory. */
export function censusInputDigest(input: {
  readonly bodyDigest: string;
  readonly producerInventory: string;
  readonly auditorInventory: string;
}): Digest {
  return digestCanonical({
    schema: "research-core.census_input.v1",
    body: input.bodyDigest,
    producerInventory: input.producerInventory,
    auditorInventory: input.auditorInventory,
  });
}

export type CensusAssessment =
  | { readonly ok: true; readonly outcome: CensusOutcome; readonly holds: readonly CensusHoldReason[] }
  | {
      readonly ok: false;
      readonly code: "BODY_DIGEST_MISMATCH" | "DISCOVERY_INVALID";
      readonly detail: readonly string[];
    };

/**
 * The complete final census over one frozen body (OQ3 default): structural coverage of every unit, reconciliation of
 * the producer ledger with the auditor's discovered inventory, and polarity/modality screening of every producer
 * occurrence (deterministic cues plus the auditor's reading of matched spans). Only auditor explanations clear a
 * difference; the producer cannot explain its own omissions.
 */
export function assessCensus(input: {
  readonly frozen: FrozenReport;
  readonly producer: readonly AssertionOccurrence[];
  readonly assertions: readonly AssertionVersion[];
  readonly discovered: readonly DiscoveredOccurrence[];
  readonly explanations: readonly CensusExplanation[];
  readonly unitExplanations: readonly UnitExplanation[];
  readonly producerInventory: Ref<"artifact">;
  readonly auditorInventory: Ref<"artifact">;
  readonly recall: CensusOutcome["recall"];
  /** Framing section ids the report kind declares (`ReportKind.framingSections`). */
  readonly framing?: readonly string[];
  /** The task's minimum risk; high/critical flags quotes the deterministic cues cannot screen (`unable_to_screen`). */
  readonly minimumRisk?: RiskClass;
}): CensusAssessment {
  const framing = new Set(input.framing ?? []);
  const frozen = withFramingExclusions(input.frozen, [...framing]);
  // Occurrences in framing sections (either inventory) are explained by the kind declaration, recorded with reasons.
  const declared = new Set(input.explanations.map((explanation) => explanation.occurrenceId));
  const framingExplanations: CensusExplanation[] = [...input.producer, ...input.discovered]
    .filter((occurrence) => framing.has(sectionOf(occurrence.blockPath)) && !declared.has(occurrence.id))
    .map((occurrence) => ({
      occurrenceId: occurrence.id,
      reason: `${FRAMING_EXCLUSION_PREFIX} ${sectionOf(occurrence.blockPath)} (kind-declared non-factual)`,
    }));
  const explanations = [...input.explanations, ...framingExplanations];
  const coverage = structuralCoverage(frozen, input.producer);
  if (!coverage.ok) return { ok: false, code: "BODY_DIGEST_MISMATCH", detail: coverage.occurrences };
  const discovery = verifyDiscovery(frozen, input.discovered);
  if (!discovery.ok) {
    return { ok: false, code: "DISCOVERY_INVALID", detail: discovery.occurrences.map((o) => `${o.id}:${o.reason}`) };
  }
  const reconciliation = reconcileCensus(input.producer, input.discovered, explanations);
  if (!reconciliation.ok) return { ok: false, code: "BODY_DIGEST_MISMATCH", detail: reconciliation.occurrences };

  const explanationFor = new Map(explanations.map((explanation) => [explanation.occurrenceId, explanation]));
  const auditorFor = new Map(reconciliation.matched.map((match) => [match.producer, match.auditor]));
  const discoveredById = new Map(input.discovered.map((occurrence) => [occurrence.id, occurrence]));
  const screening: CensusOutcome["screening"] = [];
  for (const occurrence of input.producer) {
    const assertion = input.assertions.find((candidate) =>
      sameRef(recordRef("assertion", candidate), occurrence.assertion),
    );
    if (assertion === undefined) continue; // aggregation reports an unknown assertion as unsupported
    const flags = new Set<ScreeningFlag>(screenOccurrence(frozen, occurrence, assertion, input.minimumRisk));
    const reading = discoveredById.get(auditorFor.get(occurrence.id) ?? "");
    if (reading !== undefined) {
      if (reading.negated !== assertion.qualifiers.negation) flags.add("negation_mismatch");
      if (reading.interrogative && assertion.qualifiers.modality !== "interrogative") {
        flags.add("question_as_assertion");
      }
    }
    if (flags.size === 0) continue;
    screening.push({
      occurrenceId: occurrence.id,
      flags: [...flags].sort(),
      // The auditor never sees producer ids, so it may explain the reading by its own matched occurrence id.
      explained: explanationFor.get(occurrence.id)?.reason ?? explanationFor.get(reading?.id ?? "")?.reason ?? null,
    });
  }
  const uncovered = new Set(coverage.uncoveredFactual);
  const outcome = CensusOutcomeSchema.parse({
    bodyDigest: frozen.bodyDigest,
    producerInventory: input.producerInventory,
    auditorInventory: input.auditorInventory,
    discoveredOccurrences: input.discovered.map((occurrence) => occurrence.id),
    structuralCoverage: {
      totalUnits: coverage.totalUnits,
      factualUnits: coverage.factualUnits,
      coveredFactualUnits: coverage.coveredFactualUnits,
      uncoveredFactual: coverage.uncoveredFactual,
      excluded: coverage.excluded,
      misplaced: coverage.misplaced,
      explainedUnits: input.unitExplanations.filter((explanation) => uncovered.has(explanation.path)),
    },
    reconciliation: {
      matched: reconciliation.matched.length,
      unexplainedProducerOnly: reconciliation.unexplainedProducerOnly,
      unexplainedAuditorOnly: reconciliation.unexplainedAuditorOnly,
      assertionDisagreements: reconciliation.assertionDisagreements,
      explained: reconciliation.explained,
    },
    screening,
    recall: input.recall,
  });
  return { ok: true, outcome, holds: censusHoldReasons(outcome) };
}

export const CENSUS_HOLD_REASONS = [
  "unexplained_producer_only",
  "unexplained_auditor_only",
  "assertion_disagreement",
  "uncovered_factual_unit",
  "misplaced_occurrence",
  "screening_flag",
] as const;
export type CensusHoldReason = (typeof CENSUS_HOLD_REASONS)[number];

/** Derive, from the recorded outcome alone, why the census holds required coverage (empty: it does not). */
export function censusHoldReasons(outcome: CensusOutcome): CensusHoldReason[] {
  const reasons: CensusHoldReason[] = [];
  const explainedUnits = new Set(outcome.structuralCoverage.explainedUnits.map((explanation) => explanation.path));
  if (outcome.reconciliation.unexplainedProducerOnly.length > 0) reasons.push("unexplained_producer_only");
  if (outcome.reconciliation.unexplainedAuditorOnly.length > 0) reasons.push("unexplained_auditor_only");
  if (outcome.reconciliation.assertionDisagreements.length > 0) reasons.push("assertion_disagreement");
  if (outcome.structuralCoverage.uncoveredFactual.some((path) => !explainedUnits.has(path))) {
    reasons.push("uncovered_factual_unit");
  }
  if (outcome.structuralCoverage.misplaced.length > 0) reasons.push("misplaced_occurrence");
  if (outcome.screening.some((entry) => entry.explained === null)) reasons.push("screening_flag");
  return reasons;
}

/** What report-level aggregation knows about the census: derived from recorded auditor observations only. */
export type CensusFinding =
  | { readonly status: "not_run" }
  | { readonly status: "stale"; readonly observation: Ref<"observation">; readonly reason: string }
  | {
      readonly status: "assessed";
      readonly observation: Ref<"observation">;
      readonly holds: readonly CensusHoldReason[];
      readonly holdsRequiredCoverage: boolean;
      readonly outcome: CensusOutcome;
    };

/**
 * Find the current census of one report revision among a run's observations. Only `auditor` census observations on
 * this exact report count (a producer cannot supply its own census); the latest one (append order) wins. It is stale
 * unless it binds this revision's body digest and ledger digest and its `inputDigest` recomputes from its outcome.
 */
export function findCensus(input: {
  readonly report: ReportRevision;
  readonly observations: readonly VerificationObservation[];
}): CensusFinding {
  const reportRef = recordRef("report", input.report);
  const census = input.observations.filter(
    (observation): observation is Extract<VerificationObservation, { property: "census" }> =>
      observation.property === "census" &&
      observation.evaluator.role === "auditor" &&
      sameRef(observation.target, reportRef),
  );
  const latest = census[census.length - 1];
  if (latest === undefined) return { status: "not_run" };
  const observation = recordRef("observation", latest);
  const outcome = latest.outcome;
  if (outcome.bodyDigest !== input.report.bodyDigest) {
    return { status: "stale", observation, reason: "census binds a different body digest" };
  }
  if (!sameRef(outcome.producerInventory, input.report.ledger)) {
    return { status: "stale", observation, reason: "census binds a different producer inventory" };
  }
  const expected = censusInputDigest({
    bodyDigest: outcome.bodyDigest,
    producerInventory: outcome.producerInventory.digest,
    auditorInventory: outcome.auditorInventory.digest,
  });
  if (latest.inputDigest !== expected) {
    return { status: "stale", observation, reason: "census input digest does not recompute" };
  }
  const holds = censusHoldReasons(outcome);
  return { status: "assessed", observation, holds, holdsRequiredCoverage: holds.length > 0, outcome };
}
