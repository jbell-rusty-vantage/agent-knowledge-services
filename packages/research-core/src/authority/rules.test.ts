import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EvidenceSynthesisAssessmentSchema,
  ScientificQualifiersSchema,
  includedStudySetDigest,
} from "../profiles/scientific.js";
import { assertion, evaluator, ref } from "../test-support.js";
import {
  type SourceDescription,
  appraiseSource,
  loadSourceAuthorityRules,
  loadUseClassRegistry,
  useClassOf,
  useClassPolicy,
} from "./rules.js";

const catalog = new URL("../../../../catalog/research/source-authority/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, catalog), "utf8")) as unknown;

const scientific = {
  profile: "scientific.v2" as const,
  entity: "trial-alpha",
  population: "adults",
  time: null,
  unit: null,
  jurisdiction: null,
  baseline: null,
  negation: false,
  modality: "asserted" as const,
  comparison: null,
  claimClass: "generalized" as const,
  studyDesign: null,
  species: "human",
  intervention: "drug a",
  comparator: "placebo",
  endpoint: null,
  sampleSize: null,
  effectMeasure: null,
  followUp: null,
  causalClaim: "causal" as const,
  appraisalDomain: null,
  appraisalJudgment: null,
};

const source = (overrides: Partial<SourceDescription> = {}): SourceDescription => ({
  verifiedOriginFamily: "trial-alpha",
  doi: "10.1000/alpha",
  sourceKind: "peer_reviewed_article",
  studyDesign: "randomized_controlled_trial",
  directness: "direct",
  freshness: "current",
  qualifiers: { species: "human", population: "adults" },
  ...overrides,
});

describe("K08 source authority rules are pinned data (SV-07)", () => {
  const rules = loadSourceAuthorityRules(load("scientific.json"));
  const claim = assertion("a-sci", { qualifiers: scientific });

  it("rates fitness by the first matching rule over the verified source design and the claim class", () => {
    expect(appraiseSource(rules, claim, source())).toMatchObject({ fitness: "fit", applicability: "applicable" });
    expect(appraiseSource(rules, claim, source({ studyDesign: "cohort" })).fitness).toBe("fit_with_limitations");
    expect(appraiseSource(rules, claim, source({ studyDesign: "animal" })).fitness).toBe("unfit");
    // Unknown stays unknown: no verified design, no rule match for a causal generalization.
    expect(appraiseSource(rules, claim, source({ studyDesign: null })).fitness).toBe("unknown");
    const report = assertion("a-rep", { qualifiers: { ...scientific, claimClass: "source_report" } });
    expect(appraiseSource(rules, report, source({ studyDesign: "animal" })).fitness).toBe("fit");
  });

  it("compares qualifiers for applicability without inventing a reported value", () => {
    expect(
      appraiseSource(rules, claim, source({ qualifiers: { species: "mouse", population: "adults" } })).applicability,
    ).toBe("partially_applicable");
    expect(
      appraiseSource(rules, claim, source({ qualifiers: { species: "mouse", population: "pups" } })).applicability,
    ).toBe("not_applicable");
    expect(appraiseSource(rules, claim, source({ qualifiers: {} })).applicability).toBe("unknown");
  });

  it("classifies use/audience strings through the registry and names review risks", () => {
    const registry = loadUseClassRegistry(load("../use-classes.json"));
    expect(
      useClassOf(registry, { use: "knowledge_ingestion.fact_assert_state", audience: "official", risk: "medium" }),
    ).toEqual({ useClass: "official", reviewRequired: false });
    expect(
      useClassOf(registry, { use: "knowledge_ingestion.fact_assert_state", audience: "official", risk: "high" }),
    ).toEqual({ useClass: "official", reviewRequired: true });
    expect(useClassOf(registry, { use: "internal_research", audience: "engineers", risk: "critical" }).useClass).toBe(
      "internal",
    );
    expect(useClassOf(null, { use: "x", audience: "official", risk: "critical" })).toEqual({
      useClass: "internal",
      reviewRequired: false,
    });
  });

  it("serves the same registry to the ingestion executor as a use-class policy (R1 F9)", () => {
    const registry = loadUseClassRegistry(load("../use-classes.json"));
    const policy = useClassPolicy(registry);
    expect(policy.registry).toMatchObject({ id: "use-classes", version: registry.version });
    expect(policy.classOf({ use: "knowledge_ingestion.fact_assert_state", audience: "engineers" })).toBe(
      "consequential",
    );
    expect(policy.classOf({ use: "internal_research", audience: "official" })).toBe("official");
    expect(policy.classOf({ use: "internal_research", audience: "engineers" })).toBe("internal");
    expect(policy.classOf(null)).toBe(registry.defaultClass);
  });
});

describe("study appraisal qualifiers and evidence synthesis (SV-07)", () => {
  it("validates appraisal domains as scientific qualifiers about one named study", () => {
    const appraisal = {
      ...scientific,
      claimClass: "source_report" as const,
      studyDesign: "randomized_controlled_trial" as const,
    };
    expect(
      ScientificQualifiersSchema.safeParse({ ...appraisal, appraisalDomain: "selection", appraisalJudgment: "low" })
        .success,
    ).toBe(true);
    expect(ScientificQualifiersSchema.safeParse({ ...appraisal, appraisalJudgment: "low" }).success).toBe(false);
    expect(
      ScientificQualifiersSchema.safeParse({ ...appraisal, studyDesign: null, appraisalDomain: "selection" }).success,
    ).toBe(false);
    expect(ScientificQualifiersSchema.safeParse({ ...scientific, appraisalDomain: "selection" }).success).toBe(false);
  });

  it("keys a synthesis by included studies: three reports of one study are one study; unknown never merges", () => {
    const three = includedStudySetDigest([
      { report: "r-1", originFamily: "trial-alpha" },
      { report: "r-2", originFamily: "trial-alpha" },
      { report: "r-3", originFamily: "trial-alpha" },
    ]);
    expect(three.studies).toBe(1);
    expect(includedStudySetDigest([{ report: "r-1", originFamily: "trial-alpha" }]).digest).not.toBe(three.digest);
    const unknown = includedStudySetDigest([
      { report: "r-4", originFamily: null },
      { report: "r-5", originFamily: null },
    ]);
    expect(unknown.studies).toBe(2);
    expect(
      includedStudySetDigest([
        { report: "r-3", originFamily: "trial-alpha" },
        { report: "r-1", originFamily: "trial-alpha" },
        { report: "r-2", originFamily: "trial-alpha" },
      ]).digest,
    ).toBe(three.digest);
  });

  it("never accepts an automatic body-of-evidence rating: a human reviewer and every domain assessed", () => {
    const judged = {
      state: "assessed" as const,
      value: { judgment: "serious" as const, reasons: ["r"] },
      observations: [ref("observation", "o-1")],
    };
    const base = {
      schemaVersion: "research-core.evidence_synthesis.v2" as const,
      id: "syn-1",
      tenant: "tenant-a",
      binding: "aiengineer-postgres",
      outcome: "mortality",
      comparison: "drug a vs placebo",
      population: "adults",
      includedStudySetDigest: includedStudySetDigest([{ report: "r-1", originFamily: "trial-alpha" }]).digest,
      domains: {
        riskOfBias: judged,
        inconsistency: judged,
        indirectness: judged,
        imprecision: judged,
        publicationBias: judged,
      },
      overall: "low" as const,
      rationale: "fixture",
      reviewer: { ...evaluator("human_reviewer"), kind: "human" as const, reviewerId: "rev-1" },
    };
    expect(EvidenceSynthesisAssessmentSchema.safeParse(base).success).toBe(true);
    expect(EvidenceSynthesisAssessmentSchema.safeParse({ ...base, reviewer: evaluator("judge") }).success).toBe(false);
    expect(EvidenceSynthesisAssessmentSchema.safeParse({ ...base, reviewer: null }).success).toBe(false);
    const missing = {
      ...base,
      domains: { ...base.domains, imprecision: { state: "not_assessed", reason: "no data" } },
    };
    expect(EvidenceSynthesisAssessmentSchema.safeParse(missing).success).toBe(false);
    expect(
      EvidenceSynthesisAssessmentSchema.safeParse({ ...missing, overall: "not_assessed", reviewer: null }).success,
    ).toBe(true);
  });
});
