import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recordRef } from "../digest.js";
import type { ScientificQualifiers } from "../profiles/scientific.js";
import { STRUCTURED_BODY_SCHEMA_VERSION, type StructuredBody } from "../records/report.js";
import { TASK_SCHEMA_VERSION, type VerificationTaskContract } from "../records/task.js";
import { AT, BINDING, SCOPE, TENANT, assertion, ref } from "../test-support.js";
import { ReportKindError, checkReportAgainstKind, loadReportKind, reportKindRef } from "./kinds.js";

const CATALOG = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds");
const read = (name: string) => JSON.parse(readFileSync(resolve(CATALOG, `${name}.json`), "utf8")) as unknown;
const evidenceReport = loadReportKind(read("evidence_report"));
const studyAppraisal = loadReportKind(read("study_appraisal"));

const scientific = (claimClass: "source_report" | "generalized"): ScientificQualifiers => ({
  profile: "scientific.v2",
  entity: "trial-1",
  population: "adults",
  time: null,
  unit: null,
  jurisdiction: null,
  baseline: null,
  negation: false,
  modality: "asserted",
  comparison: null,
  claimClass,
  studyDesign: "randomized_controlled_trial",
  species: "human",
  intervention: "drug a",
  comparator: "placebo",
  endpoint: null,
  sampleSize: 120,
  effectMeasure: null,
  followUp: null,
  causalClaim: "none",
  appraisalDomain: null,
  appraisalJudgment: null,
});

const design = assertion("a-design", { kind: "source_report", qualifiers: scientific("source_report") });
const designRef = recordRef("assertion", design);
const study = ref("fragment", "f-study");

function task(domain: VerificationTaskContract["domain"], ids: [string, boolean][]): VerificationTaskContract {
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: "task-k",
    tenant: TENANT,
    binding: BINDING,
    domain,
    originalTask: ref("artifact", "task-bytes"),
    use: "internal_research",
    audience: "engineers",
    obligations: ids.map(([id, required], index) => ({
      id,
      description: `obligation ${id}`,
      weight: index === 0 ? 10000 - 100 * (ids.length - 1) : 100,
      required,
    })),
    asOf: AT,
    permittedMedia: ["text_markdown"],
    rubric: ref("rubric", "rubric-1"),
    policy: ref("policy", "policy-1"),
    minimumRisk: "medium",
    limits: { calls: 1, tokens: 1, costUsd: "0", deadline: AT },
  };
}

const text = (value: string) => ({ type: "text", text: value }) as const;
const row = (domain: string) => [[text(domain)], [text("low concern")]];

function appraisalBody(overrides: { citations?: number; domains?: string[]; extra?: string } = {}): StructuredBody {
  const citations = Array.from({ length: overrides.citations ?? 1 }, (_, index) => ({
    type: "citation" as const,
    label: `s${index}`,
    fragment: index === 0 ? study : ref("fragment", `f-other-${index}`),
  }));
  const sections: StructuredBody["sections"] = [
    {
      id: "study",
      heading: [text("Study")],
      headingExcludedReason: "section title",
      blocks: [
        {
          type: "paragraph",
          id: "p1",
          inlines: [
            {
              type: "claim",
              occurrenceId: "occ-design",
              assertion: designRef,
              text: "Trial 1 was a randomized controlled trial of 120 adults.",
              obligations: ["design"],
              attribution: "trial 1",
            },
            ...citations,
          ],
          excludedReason: null,
        },
      ],
    },
    {
      id: "domains",
      heading: [text("Appraisal domains")],
      headingExcludedReason: "section title",
      blocks: [
        {
          type: "table",
          id: "t1",
          header: [[text("Domain")], [text("Reported")]],
          rows: (overrides.domains ?? ["selection", "performance", "detection", "attrition", "reporting"]).map(row),
          caption: null,
          excludedReason: "appraisal labels",
          headerExcludedReason: null,
        },
      ],
    },
    { id: "limitations", heading: [text("Limits")], headingExcludedReason: "section title", blocks: [] },
  ];
  if (overrides.extra !== undefined) {
    sections.push({ id: overrides.extra, heading: [text("Extra")], headingExcludedReason: "x", blocks: [] });
  }
  return { schemaVersion: STRUCTURED_BODY_SCHEMA_VERSION, sections };
}

describe("K08 report kinds as data", () => {
  it("loads both pinned catalog kinds into the research-report-kind.v1 envelope with a content-addressed ref", () => {
    expect(evidenceReport.profiles).toEqual(["engineering", "scientific"]);
    expect(studyAppraisal.profiles).toEqual(["scientific"]);
    expect(studyAppraisal.subject).toEqual({ cardinality: "single_study", bodyOfEvidenceRating: "forbidden" });
    const kindRef = reportKindRef(studyAppraisal, SCOPE);
    expect(kindRef).toMatchObject({ id: "study_appraisal@1.0.0", version: "research-report-kind.v1" });
    expect(reportKindRef(loadReportKind(read("study_appraisal")), SCOPE)).toEqual(kindRef);
    expect(() => loadReportKind({ ...(read("evidence_report") as object), unknownField: true })).toThrow(
      ReportKindError,
    );
    const reweighted = read("evidence_report") as { obligationTemplates: { weight: number }[] };
    reweighted.obligationTemplates[0] = { ...reweighted.obligationTemplates[0], weight: 1 } as { weight: number };
    expect(() => loadReportKind(reweighted)).toThrow(/10000/);
  });

  it("accepts a study appraisal about one study with every appraisal domain", () => {
    const check = checkReportAgainstKind({
      kind: studyAppraisal,
      task: task("scientific", [
        ["design", true],
        ["domain.selection", true],
      ]),
      body: appraisalBody(),
      declared: [designRef],
      assertions: [design],
    });
    expect(check).toEqual({ ok: true });
  });

  it("refuses a second study, a missing domain, a body-of-evidence section and a generalized claim", () => {
    const generalized = assertion("a-design", { kind: "source_report", qualifiers: scientific("generalized") });
    const check = checkReportAgainstKind({
      kind: studyAppraisal,
      task: task("engineering", [["finding.size", true]]),
      body: appraisalBody({ citations: 2, domains: ["selection"], extra: "body_of_evidence" }),
      declared: [recordRef("assertion", generalized)],
      assertions: [generalized],
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.violations).toEqual(
      expect.arrayContaining([
        "profile_unsupported:engineering",
        "section_constraint:study:single_cited_source:2",
        "section_constraint:domains:table_first_column:attrition",
        "forbidden_section:body_of_evidence",
        "obligation_unmapped:finding.size",
        "obligation_template_missing:design",
        "obligation_template_missing:domain",
        "obligation_unknown:occ-design:design",
        "assertion_undeclared:occ-design",
        "claim_class:a-design",
      ]),
    );
  });

  it("refuses an evidence report missing required sections or using an unknown assertion", () => {
    const check = checkReportAgainstKind({
      kind: evidenceReport,
      task: task("engineering", [["finding.throughput", true]]),
      body: appraisalBody(),
      declared: [designRef, ref("assertion", "a-missing")],
      assertions: [design],
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.violations).toEqual(
      expect.arrayContaining([
        "missing_section:scope",
        "missing_section:findings",
        "missing_section:evidence",
        "assertion_unknown:a-missing",
        "obligation_unknown:occ-design:design",
      ]),
    );
  });
});
