import { describe, expect, it } from "vitest";
import { recordRef } from "../digest.js";
import type { AssertionOccurrence } from "../records/occurrence.js";
import { OCCURRENCE_SCHEMA_VERSION } from "../records/occurrence.js";
import { TASK_SCHEMA_VERSION, type VerificationTaskContract } from "../records/task.js";
import type { CensusOutcome } from "../records/observation.js";
import type { CensusFinding } from "../report/census.js";
import {
  AT,
  BINDING,
  SCOPE,
  TENANT,
  assertion,
  authorityObservation,
  challengeObservation,
  integrityObservation,
  ref,
  supportObservation,
  supportSet,
} from "../test-support.js";
import { aggregateReport } from "./aggregate.js";

const judged = assertion("a-judged");
const selfAssessed = assertion("a-self");
const sets = [judged, selfAssessed].map((item) =>
  supportSet(`s-${item.id}`, item, [{ premise: "p", evidence: [ref("fragment", "f-1")] }]),
);
const [judgedSet, selfSet] = sets;
if (judgedSet === undefined || selfSet === undefined) throw new Error("fixture");
const observations = [
  supportObservation({ id: "o-1", set: judgedSet, target: judged, verdict: "full_support", role: "judge" }),
  supportObservation({ id: "o-2", set: selfSet, target: selfAssessed, verdict: "full_support", role: "producer" }),
];

const occurrence = (id: string, target: typeof judged, obligations: string[]): AssertionOccurrence => ({
  schemaVersion: OCCURRENCE_SCHEMA_VERSION,
  id,
  tenant: TENANT,
  binding: BINDING,
  assertion: recordRef("assertion", target),
  body: ref("artifact", "body-1"),
  span: { basis: "utf16-code-units-v1", start: 0, end: 4 },
  blockPath: "s/p",
  quoteDigest: ref("artifact", "q").digest,
  obligations,
  attribution: null,
  discoveredBy: "producer_ledger",
});

const task: VerificationTaskContract = {
  schemaVersion: TASK_SCHEMA_VERSION,
  id: "task-1",
  tenant: TENANT,
  binding: BINDING,
  domain: "engineering",
  originalTask: ref("artifact", "task-bytes"),
  use: "internal_research",
  audience: "engineers",
  obligations: [
    { id: "throughput", description: "Report throughput", weight: 5000, required: true },
    { id: "cost", description: "Report cost", weight: 3000, required: true },
    { id: "history", description: "Optional history", weight: 2000, required: false },
  ],
  asOf: AT,
  permittedMedia: ["text_html"],
  rubric: ref("rubric", "rubric-1"),
  policy: ref("policy", "policy-1"),
  minimumRisk: "medium",
  limits: { calls: 10, tokens: 100000, costUsd: "1.5", deadline: "2026-10-25T20:00:00Z" },
};

// Aggregation reads only the derived finding; the outcome body is exercised by final-census.test.ts.
const cleanCensus: CensusFinding = {
  status: "assessed",
  observation: ref("observation", "census-1"),
  holds: [],
  holdsRequiredCoverage: false,
  outcome: {} as CensusOutcome,
};

const input = {
  scope: SCOPE,
  task,
  occurrences: [occurrence("occ-1", judged, ["throughput"]), occurrence("occ-2", selfAssessed, ["cost"])],
  assertions: [judged, selfAssessed],
  supportSets: sets,
  observations,
  report: ref("report", "r-1"),
};

describe("report aggregation after authoritative observations (E03)", () => {
  it("never counts producer-only coverage and keeps the full obligation denominator", () => {
    const result = aggregateReport({ ...input, census: cleanCensus });
    const status = Object.fromEntries(result.obligations.map((o) => [o.id, [o.status, ...o.reasons]]));
    expect(status).toEqual({
      throughput: ["covered"],
      cost: ["held", "producer_only_coverage"],
      history: ["unmet", "no_occurrence"],
    });
    expect(result.heldRequired).toEqual(["cost"]);
    expect(result.coveredWeight).toBe(5000);
    expect(result.totalWeight).toBe(10000);
    expect(result.complete).toBe(false);
  });

  it("holds required coverage while the census is missing or has unexplained differences", () => {
    expect(aggregateReport({ ...input, census: { status: "not_run" } }).holdsByReason.census_not_run).toBe(1);
    const stale = aggregateReport({
      ...input,
      census: { status: "stale", observation: ref("observation", "census-0"), reason: "different body" },
    });
    expect(stale.obligations[0]).toMatchObject({ status: "held", reasons: ["census_stale"] });
    const disputed = aggregateReport({
      ...input,
      census: { ...cleanCensus, holds: ["screening_flag"], holdsRequiredCoverage: true },
    });
    expect(disputed.obligations[0]).toMatchObject({ status: "held", reasons: ["census_unexplained_difference"] });
  });

  it("missing evidence holds; only a contradiction or an L0 integrity failure rejects a required obligation", () => {
    const unsupported = aggregateReport({ ...input, observations: [], census: cleanCensus });
    expect(unsupported.unmetRequired).toEqual(["throughput", "cost"]);
    expect(unsupported.rejectingRequired).toEqual([]);
    // A rejecting contradiction is grounded in a fragment the support set retains as contrary evidence.
    const groundedSet = { ...judgedSet, contrary: [ref("fragment", "f-contra")] };
    const contradicted = aggregateReport({
      ...input,
      supportSets: [groundedSet, selfSet],
      observations: [
        supportObservation({
          id: "o-c",
          set: groundedSet,
          target: judged,
          verdict: "contradiction",
          role: "judge",
          contradicting: [ref("fragment", "f-contra")],
        }),
      ],
      census: cleanCensus,
    });
    expect(contradicted.obligations[0]).toMatchObject({ status: "unmet", reasons: ["contradicted"] });
    expect(contradicted.rejectingRequired).toEqual(["throughput"]);
    // SV-09: a second-family conflict against the primary judge's support holds as disputed_verdict, never rejects.
    const disputed = aggregateReport({
      ...input,
      observations: [
        supportObservation({ id: "o-j", set: judgedSet, target: judged, verdict: "qualified_support", role: "judge" }),
        supportObservation({
          id: "o-s",
          set: judgedSet,
          target: judged,
          verdict: "conflict",
          role: "second_family_judge",
        }),
      ],
      census: cleanCensus,
    });
    expect(disputed.obligations[0]).toMatchObject({ status: "held", reasons: ["disputed_verdict"] });
    expect(disputed.rejectingRequired).toEqual([]);
    // R1 F3: Luna (judge) finds only partial support, Sonnet (second-family judge) full support. Full support does
    // not outvote the other authoritative evaluator: the obligation holds as disputed_verdict.
    const lunaPartialSonnetFull = aggregateReport({
      ...input,
      observations: [
        supportObservation({
          id: "o-luna",
          set: judgedSet,
          target: judged,
          verdict: "partial_or_context_only",
          role: "judge",
        }),
        supportObservation({
          id: "o-sonnet",
          set: judgedSet,
          target: judged,
          verdict: "full_support",
          role: "second_family_judge",
        }),
      ],
      census: cleanCensus,
    });
    expect(lunaPartialSonnetFull.obligations[0]).toMatchObject({ status: "held", reasons: ["disputed_verdict"] });
    expect(lunaPartialSonnetFull.rejectingRequired).toEqual([]);
    // Both accepting is no dispute.
    const bothAccept = aggregateReport({
      ...input,
      observations: [
        supportObservation({ id: "o-luna2", set: judgedSet, target: judged, verdict: "full_support", role: "judge" }),
        supportObservation({
          id: "o-sonnet2",
          set: judgedSet,
          target: judged,
          verdict: "full_support",
          role: "second_family_judge",
        }),
      ],
      census: cleanCensus,
    });
    expect(bothAccept.obligations[0]?.reasons).not.toContain("disputed_verdict");
    // A producer-recorded integrity failure still fails closed against the judge's support.
    const broken = aggregateReport({
      ...input,
      observations: [...observations, integrityObservation({ id: "i-1", target: recordRef("support_set", judgedSet) })],
      census: cleanCensus,
    });
    expect(broken.obligations[0]).toMatchObject({ status: "unmet", reasons: ["integrity_failure"] });
    expect(broken.rejectingRequired).toEqual(["throughput"]);
  });

  it("an L0 failure recorded against the report voids every obligation, whatever the judges found (R1 F4)", () => {
    const report = ref("report", "r-1");
    const passing = integrityObservation({ id: "i-pass", target: report, result: "pass" });
    const clean = aggregateReport({ ...input, observations: [...observations, passing], census: cleanCensus });
    expect(clean.obligations[0]?.status).toBe("covered");
    const failed = aggregateReport({
      ...input,
      observations: [...observations, integrityObservation({ id: "i-report", target: report })],
      census: cleanCensus,
    });
    expect(failed.obligations.map((o) => [o.id, o.status, ...o.reasons])).toEqual([
      ["throughput", "unmet", "integrity_failure"],
      ["cost", "unmet", "integrity_failure"],
      ["history", "unmet", "integrity_failure"],
    ]);
    expect(failed.rejectingRequired).toEqual(["throughput", "cost"]);
    expect(failed.coveredWeight).toBe(0);
    // A failure on some other report revision does not touch this one.
    const other = aggregateReport({
      ...input,
      observations: [...observations, integrityObservation({ id: "i-other", target: ref("report", "r-2") })],
      census: cleanCensus,
    });
    expect(other.obligations[0]?.status).toBe("covered");
  });
});

describe("SV-07 authority and bounded-challenge gate (design §3.1 judgments 2-3)", () => {
  const judgeOnly = observations.slice(0, 1);
  const gated = { ...input, observations: judgeOnly, census: cleanCensus };
  const throughput = (result: ReturnType<typeof aggregateReport>) => result.obligations[0];
  const authority = (id: string, extra: Partial<Parameters<typeof authorityObservation>[0]> = {}) =>
    authorityObservation({ id, target: recordRef("support_set", judgedSet), ...extra });
  const challenge = (id: string, extra: Partial<Parameters<typeof challengeObservation>[0]> = {}) =>
    challengeObservation({ id, target: judged, ...extra });

  it("does not apply below critical risk for a non-scientific profile", () => {
    const result = aggregateReport({ ...gated, useClass: "official" });
    expect(result.authorityGate).toBe(false);
    expect(throughput(result)?.status).toBe("covered");
  });

  it("holds a critical task with authority_missing and challenge_missing until both observations exist", () => {
    const critical = { ...gated, task: { ...task, minimumRisk: "critical" as const } };
    const missing = aggregateReport(critical);
    expect(missing.authorityGate).toBe(true);
    expect(throughput(missing)).toMatchObject({ status: "held", reasons: ["authority_missing", "challenge_missing"] });
    const both = aggregateReport({
      ...critical,
      observations: [...critical.observations, authority("au-1"), challenge("ch-1")],
    });
    expect(throughput(both)?.status).toBe("covered");
  });

  it("applies to the scientific profile under an official or consequential use, not an internal one", () => {
    const scientific = { ...gated, task: { ...task, domain: "scientific" as const } };
    expect(aggregateReport({ ...scientific, useClass: "internal" }).authorityGate).toBe(false);
    expect(aggregateReport({ ...scientific, useClass: "consequential" }).authorityGate).toBe(true);
    expect(throughput(aggregateReport({ ...scientific, useClass: "official" }))?.status).toBe("held");
  });

  it("holds on adverse or unknown authority, an unsearched or unresolved challenge; producer observations never count", () => {
    const critical = { ...gated, task: { ...task, minimumRisk: "critical" as const } };
    const run = (...extra: ReturnType<typeof authority>[]) =>
      throughput(aggregateReport({ ...critical, observations: [...critical.observations, ...extra] }))?.reasons;
    expect(run(authority("au-u", { fitness: "unfit" }), challenge("ch-1"))).toEqual(["authority_adverse"]);
    expect(run(authority("au-r", { revision: "retracted" }), challenge("ch-1"))).toEqual(["authority_adverse"]);
    expect(run(authority("au-n", { applicability: "not_applicable" }), challenge("ch-1"))).toEqual([
      "authority_adverse",
    ]);
    expect(run(authority("au-k", { fitness: "unknown" }), challenge("ch-1"))).toEqual(["authority_missing"]);
    expect(run(authority("au-1"), challenge("ch-n", { status: "not_searched" }))).toEqual(["challenge_missing"]);
    const conflict = challenge("ch-c", { materialConflict: true, counterevidence: [ref("fragment", "f-contra")] });
    expect(run(authority("au-1"), conflict)).toEqual(["challenge_unresolved"]);
    // A later challenge resolves the conflict (latest authoritative observation wins).
    expect(run(authority("au-1"), conflict, challenge("ch-2"))).toEqual([]);
    expect(run(authority("au-p", { role: "producer" }), challenge("ch-p", { role: "producer" }))).toEqual([
      "authority_missing",
      "challenge_missing",
    ]);
    // An authority observation made against other qualifiers is stale and not reused.
    expect(
      run(
        authority("au-s", { qualifiersDigest: ref("artifact", "other-q").digest as `sha256:${string}` }),
        challenge("ch-1"),
      ),
    ).toEqual(["authority_missing"]);
  });

  it("never lets a forecast or recommendation cover an obligation for official use (OQ4)", () => {
    const forecast = { ...judged, kind: "forecast" as const };
    const forecastSet = supportSet("s-forecast", forecast, [{ premise: "p", evidence: [ref("fragment", "f-1")] }]);
    const forecastInput = {
      ...gated,
      occurrences: [occurrence("occ-f", forecast, ["throughput"])],
      assertions: [forecast],
      supportSets: [forecastSet],
      observations: [supportObservation({ id: "o-f", set: forecastSet, target: forecast, verdict: "full_support" })],
    };
    expect(throughput(aggregateReport({ ...forecastInput, useClass: "internal" }))?.status).toBe("covered");
    expect(throughput(aggregateReport({ ...forecastInput, useClass: "official" }))).toMatchObject({
      status: "held",
      reasons: ["non_entailed"],
    });
  });

  it("covers an official use through an admitting judgment policy, typed basis and independent support, never as entailment (WI-03)", () => {
    const premise = assertion("a-premise");
    const forecast = {
      ...judged,
      kind: "forecast" as const,
      premises: [recordRef("assertion", premise)],
      judgment: {
        rationale: "Throughput follows the measured batch-size curve.",
        assumptions: ["the hardware stays fixed"],
        uncertainty: { level: "medium" as const, statement: "one benchmark series" },
        horizon: { from: "2026-11-01T00:00:00Z", to: "2027-01-01T00:00:00Z" },
      },
    };
    const forecastSet = supportSet("s-forecast", forecast, [{ premise: "p", evidence: [ref("fragment", "f-1")] }]);
    const registry = {
      schemaVersion: "research-judgment-policies.v1" as const,
      id: "judgment-policies" as const,
      version: "1.0.0",
      policies: [
        {
          id: "governed-judgment",
          version: "1.0.0",
          kinds: ["forecast" as const],
          uses: [],
          audiences: [],
          useClasses: ["official" as const],
          minimumAssumptions: 1,
          horizonRequired: false,
          uncertaintyLevels: ["low" as const, "medium" as const, "high" as const],
        },
      ],
    };
    const base = {
      ...gated,
      occurrences: [occurrence("occ-f", forecast, ["throughput"])],
      assertions: [premise, forecast],
      supportSets: [forecastSet],
      observations: [supportObservation({ id: "o-f", set: forecastSet, target: forecast, verdict: "full_support" })],
      useClass: "official" as const,
    };
    const admitted = aggregateReport({ ...base, judgmentPolicies: registry });
    expect(throughput(admitted)).toMatchObject({ status: "covered", basis: "judgment" });
    expect(admitted.judgmentCovered).toContain("throughput");
    expect(admitted.judgmentPolicies).toEqual(["governed-judgment@1.0.0"]);
    // Without a typed basis the policy cannot admit it: held, not a contradiction.
    const { judgment: _judgment, ...bare } = forecast;
    const bareSet = supportSet("s-forecast", bare, [{ premise: "p", evidence: [ref("fragment", "f-1")] }]);
    const incomplete = aggregateReport({
      ...base,
      assertions: [premise, bare],
      occurrences: [occurrence("occ-f", bare, ["throughput"])],
      supportSets: [bareSet],
      observations: [supportObservation({ id: "o-b", set: bareSet, target: bare, verdict: "full_support" })],
      judgmentPolicies: registry,
    });
    expect(throughput(incomplete)).toMatchObject({ status: "held", reasons: ["judgment_basis_incomplete"] });
    // Producer-only support never covers, policy or not (independent assessment is required).
    const producerOnly = aggregateReport({
      ...base,
      observations: [
        supportObservation({
          id: "o-p",
          set: forecastSet,
          target: forecast,
          verdict: "full_support",
          role: "producer",
        }),
      ],
      judgmentPolicies: registry,
    });
    expect(throughput(producerOnly)?.status).not.toBe("covered");
  });
});
