import { digestBytes } from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import { recordRef } from "../digest.js";
import type { AssertionOccurrence } from "../records/occurrence.js";
import {
  REPORT_SCHEMA_VERSION,
  type ReportRevision,
  STRUCTURED_BODY_SCHEMA_VERSION,
  type StructuredBody,
} from "../records/report.js";
import { AT, BINDING, TENANT, assertion, evaluator, qualifiers, ref } from "../test-support.js";
import {
  type CensusOutcome,
  OBSERVATION_SCHEMA_VERSION,
  type VerificationObservation,
} from "../records/observation.js";
import { DISCOVERED_OCCURRENCE_SCHEMA_VERSION, type DiscoveredOccurrence } from "../records/occurrence.js";
import {
  assessCensus,
  censusInputDigest,
  findCensus,
  reconcileCensus,
  screenOccurrence,
  structuralCoverage,
} from "./census.js";
import { buildLedger, verifyFrozenBody, verifyOccurrence } from "./ledger.js";
import { type FrozenReport, normalizeForFreeze, quoteDigest, renderReport } from "./render.js";

const a1 = assertion("a-1");
const a2 = assertion("a-2");
const a1Ref = recordRef("assertion", a1);
const a2Ref = recordRef("assertion", a2);
const f1 = ref("fragment", "f-1");

const claim = (occurrenceId: string, text: string, target = a1Ref, obligations = ["o-1"]) =>
  ({ type: "claim", occurrenceId, assertion: target, text, obligations, attribution: null }) as const;

function body(overrides: Partial<StructuredBody> = {}): StructuredBody {
  return {
    schemaVersion: STRUCTURED_BODY_SCHEMA_VERSION,
    sections: [
      {
        id: "results",
        heading: [{ type: "text", text: "Results 🧪 for café" }],
        headingExcludedReason: null,
        blocks: [
          {
            type: "paragraph",
            id: "p1",
            inlines: [
              claim("occ-1", "Throughput reached 1200 tokens/s 🚀"),
              { type: "citation", label: "c1", fragment: f1 },
              { type: "text", text: " on *one* GPU_x.\r\nSee [notes] | é stays decomposed.   " },
            ],
            excludedReason: null,
          },
          {
            type: "table",
            id: "t1",
            header: [[{ type: "text", text: "Metric" }], [{ type: "text", text: "Value" }]],
            rows: [
              [[{ type: "text", text: "p50 latency" }], [claim("occ-2", "41 ms", a2Ref)]],
              [[{ type: "text", text: "p99 latency" }], [{ type: "text", text: "90 ms" }]],
              [[{ type: "text", text: "notes" }], []],
            ],
            caption: [{ type: "text", text: "Latency on one A100" }],
            excludedReason: null,
            headerExcludedReason: "column labels",
          },
          {
            type: "paragraph",
            id: "p2",
            inlines: [
              claim("occ-3", "Throughput reached 1200 tokens/s"),
              { type: "text", text: ". Again: " },
              claim("occ-4", "Throughput reached 1200 tokens/s"),
            ],
            excludedReason: null,
          },
          { type: "code", id: "k1", language: "sh", text: "vllm serve --tp 1", excludedReason: "command listing" },
        ],
      },
    ],
    ...overrides,
  };
}

function occurrences(frozen: FrozenReport): AssertionOccurrence[] {
  const bodyRef = ref("artifact", "body-1", { digest: frozen.bodyDigest });
  return buildLedger({ frozen, body: bodyRef, id: "ledger-1", tenant: TENANT, binding: BINDING }).entries.map(
    (entry) => ({
      ...entry,
    }),
  );
}

const auditorCopy = (occurrence: AssertionOccurrence, id: string): AssertionOccurrence => ({
  ...occurrence,
  id,
  discoveredBy: "auditor_discovery",
});

describe("deterministic rendering and freezing", () => {
  const frozen = renderReport(body());

  it("is byte-identical across renders and digests exact UTF-8 bytes", () => {
    const again = renderReport(body());
    expect(again.text).toBe(frozen.text);
    expect(frozen.bodyDigest).toBe(digestBytes(Buffer.from(frozen.text, "utf8")));
    expect(frozen.renderer).toBe("research-report-renderer.v2");
    expect(verifyFrozenBody(frozen.text, frozen.bodyDigest)).toEqual({ ok: true });
  });

  it("normalizes CRLF and trailing whitespace before freezing but never Unicode", () => {
    expect(frozen.text).not.toContain("\r");
    expect(frozen.text).not.toMatch(/[ \t]\n/);
    expect(frozen.text.endsWith("\n")).toBe(true);
    expect(frozen.text.endsWith("\n\n")).toBe(false);
    expect(frozen.text).toContain("é");
    expect(frozen.text).not.toContain("é stays");
    expect(frozen.text).toContain("café");
    expect(normalizeForFreeze("a \r\nb\rc\t\n\n").text).toBe("a\nb\nc\n");
  });

  it("escapes Markdown in authored text", () => {
    expect(frozen.text).toContain("\\*one\\* GPU\\_x.");
    expect(frozen.text).toContain("\\[notes\\] \\| e");
    expect(frozen.text).toContain("[^c1]");
    expect(frozen.text).toMatch(/\[\^c1\]: fragment tenant-a\/aiengineer-postgres\/f-1 sha256:/);
  });

  it("records claim spans in UTF-16 code units whose quote digest covers UTF-8 bytes", () => {
    const first = frozen.claims[0];
    if (first === undefined) throw new Error("missing claim");
    const quote = frozen.text.slice(first.span.start, first.span.end);
    expect(quote).toBe("Throughput reached 1200 tokens/s 🚀");
    expect(first.span.end - first.span.start).toBe(quote.length);
    expect(quote.length).toBe(35); // the rocket is two UTF-16 code units
    expect(Buffer.byteLength(quote, "utf8")).toBe(37); // and four UTF-8 bytes
    expect(first.quoteDigest).toBe(digestBytes(Buffer.from(quote, "utf8")));
    expect(first.span.basis).toBe("utf16-code-units-v1");
  });

  it("renders tables with cell, header and caption units", () => {
    const paths = frozen.units.map((unit) => unit.path);
    expect(paths).toEqual(
      expect.arrayContaining(["results/heading", "results/t1/h/c0", "results/t1/r0/c1", "results/t1/caption"]),
    );
    expect(frozen.text).toContain("| Metric | Value |\n| --- | --- |\n| p50 latency | 41 ms |");
    expect(frozen.units.find((unit) => unit.path === "results/t1/r2/c1")?.span).toBeNull();
  });
});

describe("final census (design §9 final-census seam)", () => {
  const frozen = renderReport(body());
  const producer = occurrences(frozen);

  it("reports uncited heading, table cell and caption as uncovered factual units", () => {
    const coverage = structuralCoverage(frozen, producer);
    if (!coverage.ok) throw new Error("unexpected refusal");
    expect(coverage.uncoveredFactual).toEqual(
      expect.arrayContaining(["results/heading", "results/t1/r0/c0", "results/t1/r1/c1", "results/t1/caption"]),
    );
    expect(coverage.uncoveredFactual).not.toContain("results/t1/h/c0");
    expect(coverage.uncoveredFactual).not.toContain("results/t1/r2/c1");
    expect(coverage.excluded).toEqual(
      expect.arrayContaining([
        { path: "results/t1/h/c0", reason: "column labels" },
        { path: "results/k1", reason: "command listing" },
      ]),
    );
    expect(coverage.misplaced).toEqual([]);
    expect(coverage.coveredFactualUnits).toBe(3);
  });

  it("keeps repeated occurrences distinct and flags a missing repeat", () => {
    const repeats = producer.filter((occurrence) => occurrence.blockPath === "results/p2");
    expect(repeats).toHaveLength(2);
    expect(repeats[0]?.quoteDigest).toBe(repeats[1]?.quoteDigest);
    expect(repeats[0]?.span.start).not.toBe(repeats[1]?.span.start);
    const ledgerMissingRepeat = producer.filter((occurrence) => occurrence.id !== "occ-4");
    const auditor = producer.map((occurrence) => auditorCopy(occurrence, `aud-${occurrence.id}`));
    const result = reconcileCensus(ledgerMissingRepeat, auditor);
    if (!result.ok) throw new Error("unexpected refusal");
    expect(result.unexplainedAuditorOnly).toEqual(["aud-occ-4"]);
    expect(result.holdsRequiredCoverage).toBe(true);
  });

  it("holds a duplicate paraphrase the producer did not list until it is explained", () => {
    const paraphrase: AssertionOccurrence = {
      ...auditorCopy(producer[0] as AssertionOccurrence, "aud-paraphrase"),
      blockPath: "results/t1/caption",
    };
    const auditor = [...producer.map((occurrence) => auditorCopy(occurrence, `aud-${occurrence.id}`)), paraphrase];
    const held = reconcileCensus(producer, auditor);
    expect(held.ok && held.unexplainedAuditorOnly).toEqual(["aud-paraphrase"]);
    const explained = reconcileCensus(producer, auditor, [
      { occurrenceId: "aud-paraphrase", reason: "caption restates the cited table" },
    ]);
    expect(explained.ok && explained.holdsRequiredCoverage).toBe(false);
    expect(explained.ok && explained.explained).toHaveLength(1);
  });

  it("flags missing negation and a question restated as an assertion", () => {
    const negated = renderReport(
      body({
        sections: [
          {
            id: "s",
            heading: [{ type: "text", text: "Limits" }],
            headingExcludedReason: "section title",
            blocks: [
              {
                type: "paragraph",
                id: "p",
                inlines: [claim("n-1", "It does not scale past 8 GPUs")],
                excludedReason: null,
              },
              {
                type: "paragraph",
                id: "q",
                inlines: [claim("q-1", "Does it scale past 8 GPUs?")],
                excludedReason: null,
              },
            ],
          },
        ],
      }),
    );
    const [neg, question] = occurrences(negated);
    if (neg === undefined || question === undefined) throw new Error("missing occurrences");
    expect(screenOccurrence(negated, neg, a1)).toEqual(["negation_mismatch"]);
    expect(screenOccurrence(negated, neg, assertion("a-1", { qualifiers: qualifiers({ negation: true }) }))).toEqual(
      [],
    );
    expect(screenOccurrence(negated, question, a1)).toEqual(["question_as_assertion"]);
    // The auditor maps the negated sentence to a different assertion: an unexplained disagreement.
    const result = reconcileCensus([neg], [{ ...auditorCopy(neg, "aud-n"), assertion: a2Ref }]);
    expect(result.ok && result.assertionDisagreements).toEqual(["n-1"]);
    expect(result.ok && result.holdsRequiredCoverage).toBe(true);
  });

  it("refuses occurrences bound to the body before a post-verification edit", () => {
    const edited = body();
    const section = edited.sections[0];
    if (section === undefined) throw new Error("missing section");
    const changed = renderReport({
      ...edited,
      sections: [{ ...section, heading: [{ type: "text", text: "Results 🧪 for café (revised)" }] }],
    });
    expect(changed.bodyDigest).not.toBe(frozen.bodyDigest);
    expect(verifyFrozenBody(changed.text, frozen.bodyDigest).ok).toBe(false);
    const coverage = structuralCoverage(changed, producer);
    expect(coverage.ok).toBe(false);
    expect(verifyOccurrence(changed, producer[0] as AssertionOccurrence)).toEqual({
      ok: false,
      code: "BODY_DIGEST_MISMATCH",
    });
    // Forged rebinding to the new digest still fails the quote check.
    const rebound = {
      ...(producer[0] as AssertionOccurrence),
      body: ref("artifact", "b", { digest: changed.bodyDigest }),
    };
    const shifted = { ...rebound, span: { ...rebound.span, start: rebound.span.start + 3, end: rebound.span.end + 3 } };
    expect(verifyOccurrence(changed, shifted).ok).toBe(false);
  });

  it("keeps recall labels separate from structural coverage", () => {
    const discovered = producer.map((occurrence) => discover(occurrence, `aud-${occurrence.id}`));
    const run = (recall: CensusOutcome["recall"]) => {
      const result = assessCensus({ ...censusBase(frozen, producer), discovered, recall });
      if (!result.ok) throw new Error("unexpected refusal");
      return result.outcome;
    };
    const unmeasured = run({ label: "unmeasured", reason: "no calibrated census slice" });
    const measured = run({ label: "measured", numerator: 47, denominator: 50, calibration: ref("artifact", "cal-1") });
    expect(unmeasured.structuralCoverage).toEqual(measured.structuralCoverage);
    expect(unmeasured.recall.label).toBe("unmeasured");
    expect(measured.reconciliation.matched).toBe(4);
  });
});

function discover(
  occurrence: AssertionOccurrence,
  id: string,
  overrides: Partial<DiscoveredOccurrence> = {},
): DiscoveredOccurrence {
  return {
    schemaVersion: DISCOVERED_OCCURRENCE_SCHEMA_VERSION,
    id,
    body: occurrence.body,
    span: occurrence.span,
    blockPath: occurrence.blockPath,
    quoteDigest: occurrence.quoteDigest,
    candidateAssertion: "auditor reading",
    assertion: occurrence.assertion,
    negated: false,
    interrogative: false,
    ...overrides,
  };
}

function censusBase(frozen: FrozenReport, producer: AssertionOccurrence[]) {
  return {
    frozen,
    producer,
    assertions: [a1, a2],
    explanations: [] as { occurrenceId: string; reason: string }[],
    unitExplanations: [] as { path: string; reason: string }[],
    producerInventory: ref("artifact", "ledger-1"),
    auditorInventory: ref("artifact", "inventory-1"),
    recall: { label: "unmeasured", reason: "fixture" } as CensusOutcome["recall"],
  };
}

describe("independent auditor census (SV-06, OQ3 default)", () => {
  const frozen = renderReport(body());
  const producer = occurrences(frozen);
  const mirrored = producer.map((occurrence) => discover(occurrence, `aud-${occurrence.id}`));
  const coverage = structuralCoverage(frozen, producer);
  if (!coverage.ok) throw new Error("fixture");
  const allUnits = coverage.uncoveredFactual.map((path) => ({ path, reason: "label or restatement" }));

  it("holds uncited headings, cells and captions until the auditor explains each unit", () => {
    const held = assessCensus({ ...censusBase(frozen, producer), discovered: mirrored });
    if (!held.ok) throw new Error("unexpected refusal");
    expect(held.holds).toEqual(["uncovered_factual_unit"]);
    expect(held.outcome.structuralCoverage.uncoveredFactual).toEqual(
      expect.arrayContaining(["results/heading", "results/t1/caption", "results/t1/r1/c1"]),
    );
    const partly = assessCensus({
      ...censusBase(frozen, producer),
      discovered: mirrored,
      unitExplanations: allUnits.slice(1),
    });
    expect(partly.ok && partly.holds).toEqual(["uncovered_factual_unit"]);
    const clean = assessCensus({ ...censusBase(frozen, producer), discovered: mirrored, unitExplanations: allUnits });
    expect(clean.ok && clean.holds).toEqual([]);
    expect(clean.ok && clean.outcome.structuralCoverage.explainedUnits).toHaveLength(allUnits.length);
  });

  it("holds an auditor-only occurrence that names no assertion until it is explained", () => {
    const captionUnit = frozen.units.find((unit) => unit.path === "results/t1/caption");
    if (captionUnit?.span == null) throw new Error("fixture");
    const unlisted: DiscoveredOccurrence = {
      ...discover(producer[0] as AssertionOccurrence, "aud-caption"),
      span: captionUnit.span,
      blockPath: "results/t1/caption",
      quoteDigest: quoteDigest(frozen.text, captionUnit.span),
      candidateAssertion: "Latency was measured on one A100",
      assertion: null,
    };
    const result = assessCensus({
      ...censusBase(frozen, producer),
      discovered: [...mirrored, unlisted],
      unitExplanations: allUnits,
    });
    if (!result.ok) throw new Error("unexpected refusal");
    expect(result.outcome.reconciliation.unexplainedAuditorOnly).toEqual(["aud-caption"]);
    expect(result.holds).toEqual(["unexplained_auditor_only"]);
    const explained = assessCensus({
      ...censusBase(frozen, producer),
      discovered: [...mirrored, unlisted],
      unitExplanations: allUnits,
      explanations: [{ occurrenceId: "aud-caption", reason: "caption restates the measured table" }],
    });
    expect(explained.ok && explained.holds).toEqual([]);
  });

  it("an unmapped auditor reading matches by span and is never an assertion disagreement", () => {
    const unmapped = mirrored.map((occurrence) => ({ ...occurrence, assertion: null }));
    const result = assessCensus({ ...censusBase(frozen, producer), discovered: unmapped, unitExplanations: allUnits });
    expect(result.ok && result.outcome.reconciliation.assertionDisagreements).toEqual([]);
    expect(result.ok && result.holds).toEqual([]);
  });

  it("holds a quote the English cues cannot screen for a high/critical task (R1 F5)", () => {
    const german = renderReport(
      body({
        sections: [
          {
            id: "s",
            heading: [{ type: "text", text: "Grenzen" }],
            headingExcludedReason: "section title",
            blocks: [
              {
                type: "paragraph",
                id: "p",
                inlines: [claim("g-1", "Es skaliert über 8 GPUs nicht")],
                excludedReason: null,
              },
            ],
          },
        ],
      }),
    );
    const producerG = occurrences(german);
    const [quoted] = producerG;
    if (quoted === undefined) throw new Error("fixture");
    // The negation is invisible to the English cues; only the risk-gated flag catches the unscreened quote.
    expect(screenOccurrence(german, quoted, a1)).toEqual([]);
    expect(screenOccurrence(german, quoted, a1, "medium")).toEqual([]);
    expect(screenOccurrence(german, quoted, a1, "high")).toEqual(["unable_to_screen"]);
    expect(screenOccurrence(frozen, producer[0] as AssertionOccurrence, a1, "critical")).toEqual([]);
    const units = structuralCoverage(german, producerG);
    if (!units.ok) throw new Error("fixture");
    const base = {
      ...censusBase(german, producerG),
      discovered: producerG.map((occurrence) => discover(occurrence, `aud-${occurrence.id}`)),
      unitExplanations: units.uncoveredFactual.map((path) => ({ path, reason: "label" })),
    };
    const low = assessCensus(base);
    expect(low.ok && low.holds).toEqual([]);
    const critical = assessCensus({ ...base, minimumRisk: "critical" });
    if (!critical.ok) throw new Error("unexpected refusal");
    expect(critical.outcome.screening).toEqual([
      { occurrenceId: quoted.id, flags: ["unable_to_screen"], explained: null },
    ]);
    expect(critical.holds).toEqual(["screening_flag"]);
    // An auditor who read the quote clears it, as for any other screening flag.
    const read = assessCensus({
      ...base,
      minimumRisk: "critical",
      explanations: [{ occurrenceId: `aud-${quoted.id}`, reason: "auditor read the German: negated, see a-1" }],
    });
    expect(read.ok && read.holds).toEqual([]);
  });

  it("holds negation and question readings without an authoritative explanation", () => {
    const negatedReading = mirrored.map((occurrence) =>
      occurrence.id === "aud-occ-1" ? { ...occurrence, negated: true } : occurrence,
    );
    const negation = assessCensus({
      ...censusBase(frozen, producer),
      discovered: negatedReading,
      unitExplanations: allUnits,
    });
    if (!negation.ok) throw new Error("unexpected refusal");
    expect(negation.outcome.screening).toEqual([
      { occurrenceId: "occ-1", flags: ["negation_mismatch"], explained: null },
    ]);
    expect(negation.holds).toEqual(["screening_flag"]);
    // The auditor never sees producer ids: its explanation names its own matched occurrence.
    const byAuditorId = assessCensus({
      ...censusBase(frozen, producer),
      discovered: negatedReading,
      unitExplanations: allUnits,
      explanations: [{ occurrenceId: "aud-occ-1", reason: "unit suffix, not a negation" }],
    });
    expect(byAuditorId.ok && byAuditorId.holds).toEqual([]);
    const questionReading = mirrored.map((occurrence) =>
      occurrence.id === "aud-occ-2" ? { ...occurrence, interrogative: true } : occurrence,
    );
    const question = assessCensus({
      ...censusBase(frozen, producer),
      discovered: questionReading,
      unitExplanations: allUnits,
      explanations: [{ occurrenceId: "occ-2", reason: "the cell answers the stated question" }],
    });
    expect(question.ok && question.outcome.screening[0]).toMatchObject({
      occurrenceId: "occ-2",
      flags: ["question_as_assertion"],
      explained: "the cell answers the stated question",
    });
    expect(question.ok && question.holds).toEqual([]);
  });

  it("refuses a discovered occurrence that does not quote the frozen bytes", () => {
    const forged = mirrored.map((occurrence, index) =>
      index === 0 ? { ...occurrence, quoteDigest: ref("artifact", "forged").digest } : occurrence,
    );
    const result = assessCensus({ ...censusBase(frozen, producer), discovered: forged });
    expect(result).toMatchObject({ ok: false, code: "DISCOVERY_INVALID" });
  });

  it("derives the census from the latest auditor observation and treats an edited body as stale", () => {
    const revision: ReportRevision = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      id: "report-1-r1",
      tenant: TENANT,
      binding: BINDING,
      kind: ref("report_kind", "evidence_report@1.0.0", { version: "research-report-kind.v1" }),
      task: ref("task", "task-1"),
      structuredBody: ref("artifact", "structured-1"),
      body: ref("artifact", "body-1", { digest: frozen.bodyDigest }),
      bodyDigest: frozen.bodyDigest,
      renderer: "research-report-renderer.v2",
      normalization: "research-report-normalization.v1",
      ledger: ref("artifact", "ledger-1"),
      assertions: [a1Ref, a2Ref],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      derivationCandidates: [],
      supersedes: null,
    };
    const assessed = assessCensus({
      ...censusBase(frozen, producer),
      discovered: mirrored,
      unitExplanations: allUnits,
    });
    if (!assessed.ok) throw new Error("unexpected refusal");
    const censusObservation = (
      id: string,
      role: "auditor" | "producer",
      outcome: CensusOutcome = assessed.outcome,
    ): VerificationObservation => ({
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      id,
      tenant: TENANT,
      binding: BINDING,
      target: recordRef("report", revision),
      inputDigest: censusInputDigest({
        bodyDigest: outcome.bodyDigest,
        producerInventory: outcome.producerInventory.digest,
        auditorInventory: outcome.auditorInventory.digest,
      }),
      qualifiersDigest: null,
      method: ref("method", "final-census"),
      evaluator: evaluator(role),
      rationale: "fixture census",
      limitations: ["recall measured, not proven"],
      evidence: [],
      rawResponse: null,
      usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
      recordedAt: AT,
      property: "census",
      outcome,
    });
    expect(findCensus({ report: revision, observations: [] })).toEqual({ status: "not_run" });
    // A producer cannot supply its own census.
    expect(findCensus({ report: revision, observations: [censusObservation("c-p", "producer")] }).status).toBe(
      "not_run",
    );
    expect(findCensus({ report: revision, observations: [censusObservation("c-1", "auditor")] })).toMatchObject({
      status: "assessed",
      holdsRequiredCoverage: false,
      holds: [],
    });
    const heldOutcome: CensusOutcome = {
      ...assessed.outcome,
      structuralCoverage: { ...assessed.outcome.structuralCoverage, explainedUnits: [] },
    };
    expect(
      findCensus({
        report: revision,
        observations: [censusObservation("c-1", "auditor"), censusObservation("c-2", "auditor", heldOutcome)],
      }),
    ).toMatchObject({ status: "assessed", holds: ["uncovered_factual_unit"] });
    // A census over edited bytes (a post-verification edit) never applies to this revision's frozen body.
    const edited = renderReport({
      ...body(),
      sections: [
        { ...(body().sections[0] as StructuredBody["sections"][number]), heading: [{ type: "text", text: "Edited" }] },
      ],
    });
    expect(edited.bodyDigest).not.toBe(frozen.bodyDigest);
    expect(
      findCensus({
        report: revision,
        observations: [censusObservation("c-e", "auditor", { ...assessed.outcome, bodyDigest: edited.bodyDigest })],
      }),
    ).toMatchObject({ status: "stale", reason: "census binds a different body digest" });
    // An edited revision is a different report ref: the old census does not target it at all.
    expect(
      findCensus({
        report: { ...revision, bodyDigest: edited.bodyDigest },
        observations: [censusObservation("c-1", "auditor")],
      }).status,
    ).toBe("not_run");
    const tampered = { ...censusObservation("c-3", "auditor"), inputDigest: ref("artifact", "other").digest };
    expect(findCensus({ report: revision, observations: [tampered] })).toMatchObject({
      status: "stale",
      reason: "census input digest does not recompute",
    });
  });
});
