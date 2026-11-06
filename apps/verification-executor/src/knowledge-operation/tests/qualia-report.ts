import { digestBytes, digestCanonical, type Origin, type Ref } from "@aiengineer/knowledge-operation-protocol";
import {
  AssertionVersionSchema,
  EvidenceFragmentSchema,
  EngineeringQualifiersSchema,
  ScientificQualifiersSchema,
  StructuredBodySchema,
  SupportSetSchema,
  VerificationTaskContractSchema,
  recordRef,
} from "@aiengineer/knowledge-research-core";
import { selectQualiaCapture, type CapturedSource } from "./qualia-captures.js";
export type { CapturedSource } from "./qualia-captures.js";
export interface AuthoredReport {
  id: string;
  title: string;
  summary: string;
  use?: string;
  claims: Array<{
    id: string;
    statement: string;
    sourceUrl: string;
    capture_id?: string;
    quote: string;
    additional_quotes?: string[];
    /** One proposition and polarity per claim. Null/safety results remain separate sourced assertions. */
    qualifiers: Record<string, unknown> & { negation: boolean };
  }>;
  limitations: string[];
}
/** One domain's bounded source-report policy: binding, uses, qualifier profile and scope wording. */
export interface SourceReportProfile {
  binding: string;
  uses: readonly string[];
  defaultUse: string;
  policySchema: string;
  scope: string;
  domain: "scientific" | "engineering";
  rubric: { schemaVersion: string; profile: "scientific.v2" | "engineering.v2"; preserve: readonly string[] };
  accessLimit: string;
  scopeText(title: string): string;
}

export const QUALIA_REPORT_PROFILE: SourceReportProfile = {
  binding: "biotech-graph",
  uses: ["label_reference.ingredients", "research.summary"],
  defaultUse: "research.summary",
  policySchema: "research-policy.qualia-source-report.v1",
  scope: "Attributed, bounded source reports; no clinical recommendation or certainty rating",
  domain: "scientific",
  rubric: {
    schemaVersion: "research-rubric.scientific.v2",
    profile: "scientific.v2",
    preserve: [
      "studyDesign",
      "population",
      "intervention",
      "comparator",
      "endpoint",
      "sampleSize",
      "followUp",
      "causalClaim",
    ],
  },
  accessLimit: "Only captured source content is evidence; missing full text and trial methods remain limitations",
  scopeText: (title) =>
    `Task: ${title}. Attributed source reports for internal research reference; no clinical recommendation or body-of-evidence certainty assessment.`,
};

export const AIENG_REPORT_PROFILE: SourceReportProfile = {
  binding: "aiengineer-postgres",
  uses: ["knowledge_ingestion.ai_engineer", "research.summary"],
  defaultUse: "knowledge_ingestion.ai_engineer",
  policySchema: "research-policy.aieng-source-report.v1",
  scope:
    "Attributed, bounded engineering source reports; no capability ranking, benchmark leaderboard or vendor recommendation",
  domain: "engineering",
  rubric: {
    schemaVersion: "research-rubric.engineering.v2",
    profile: "engineering.v2",
    preserve: [
      "runtime",
      "softwareVersion",
      "configuration",
      "benchmarkEnvironment",
      "denominator",
      "repositoryCommit",
    ],
  },
  accessLimit:
    "Only captured source content is evidence; unread source files, unpinned branches and unreported evaluation settings remain limitations",
  scopeText: (title) =>
    `Task: ${title}. Attributed engineering source reports for internal knowledge ingestion; no capability ranking or vendor recommendation.`,
};

/** Real captured bytes plus producer-authored propositions. This performs structure/quote checks, never entailment. */
export async function prepareQualiaReport(input: {
  authored: AuthoredReport;
  sources: CapturedSource[];
  origin: Origin;
  put(bytes: Uint8Array, mediaType: string): Promise<Ref<"artifact">>;
  bindFragment?(fragment: Ref<"fragment">, source: CapturedSource): void;
  profile?: SourceReportProfile;
}) {
  const { authored, origin } = input;
  const profile = input.profile ?? QUALIA_REPORT_PROFILE;
  if (!authored.claims?.length || authored.claims.length > 24)
    throw new Error("A bounded report requires 1..24 authored claims");
  if (new Set(authored.claims.map((claim) => claim.id)).size !== authored.claims.length)
    throw new Error("Authored claim ids must be unique");
  for (const claim of authored.claims) {
    if (typeof claim.qualifiers?.negation !== "boolean")
      throw new Error(
        "Every atomic claim requires explicit boolean qualifiers.negation; split mixed-polarity propositions rather than defaulting polarity",
      );
  }
  const now = new Date().toISOString().replace(/\.(\d*?)0+Z$/, (_m, d: string) => (d ? `.${d}Z` : "Z"));
  const tenant = origin.tenantId,
    binding = profile.binding;
  const identity = (schemaVersion: string, id: string) => ({ schemaVersion, id, tenant, binding });
  const use = authored.use ?? profile.defaultUse;
  if (!profile.uses.includes(use)) throw new Error("Unsupported bounded source-report use");
  const policyDocument = {
    schemaVersion: profile.policySchema,
    use,
    audience: "internal",
    profile: profile.rubric.profile,
    scope: profile.scope,
    requirements: [
      "captured_bytes",
      "exact_selectors",
      "independent_support",
      "independent_census",
      "sealed_exact_use",
    ],
  };
  const rubricDocument = {
    schemaVersion: profile.rubric.schemaVersion,
    profile: profile.rubric.profile,
    preserve: [...profile.rubric.preserve],
    unknown: null,
  };
  const policyArtifact = await input.put(Buffer.from(JSON.stringify(policyDocument)), "application/json");
  const rubricArtifact = await input.put(Buffer.from(JSON.stringify(rubricDocument)), "application/json");
  const originalTask = await input.put(
    Buffer.from(
      JSON.stringify({ title: authored.title, summary: authored.summary, limitations: authored.limitations }),
    ),
    "application/json",
  );
  const policy = { ...policyArtifact, kind: "policy" as const, version: policyDocument.schemaVersion };
  const rubric = { ...rubricArtifact, kind: "rubric" as const, version: rubricDocument.schemaVersion };
  const task = VerificationTaskContractSchema.parse({
    ...identity("research-core.task.v2", `${authored.id}-task`),
    domain: profile.domain,
    originalTask,
    use: policyDocument.use,
    audience: policyDocument.audience,
    obligations: authored.claims.map((c, i) => ({
      id: `finding.${c.id}`,
      description: c.statement,
      weight: Math.floor(10000 / authored.claims.length) + (i < 10000 % authored.claims.length ? 1 : 0),
      required: true,
    })),
    asOf: now,
    permittedMedia: ["text_markdown"],
    rubric,
    policy,
    minimumRisk: "medium",
    limits: {
      calls: 24,
      tokens: 100000,
      costUsd: "100",
      deadline: new Date(Date.now() + 86400000)
        .toISOString()
        .replace(/\.(\d*?)0+Z$/, (_m, d: string) => (d ? `.${d}Z` : "Z")),
    },
  });
  const fragments = [],
    assertions = [],
    supportSets = [],
    findings = [],
    citations = [];
  const fragmentIds = new Set<string>();
  for (const [i, claim] of authored.claims.entries()) {
    const source = selectQualiaCapture(input.sources, claim.sourceUrl, claim.capture_id);
    const additionalQuotes = claim.additional_quotes === undefined ? [] : claim.additional_quotes;
    if (
      !Array.isArray(additionalQuotes) ||
      additionalQuotes.length > 3 ||
      additionalQuotes.some((quote) => typeof quote !== "string" || !quote)
    )
      throw new Error(`Additional quotes require at most 3 nonempty strings for ${claim.id}`);
    const quotes = [claim.quote, ...additionalQuotes];
    if (quotes.some((quote) => typeof quote !== "string" || !quote))
      throw new Error(`Quote does not uniquely resolve for ${claim.id}`);
    if (new Set(quotes).size !== quotes.length) throw new Error(`Duplicate quote for ${claim.id}`);
    if (quotes.reduce((total, quote) => total + quote.length, 0) > 8000)
      throw new Error(`Combined quotes exceed 8000 characters for ${claim.id}`);
    const claimFragments = quotes.map((quote, quoteIndex) => {
      if (!source.text.includes(quote) || source.text.indexOf(quote) !== source.text.lastIndexOf(quote))
        throw new Error(`Quote does not uniquely resolve for ${claim.id}`);
      const fragmentId = `${authored.id}-fragment-${claim.id}${quoteIndex ? `-additional-${quoteIndex}` : ""}`;
      if (fragmentIds.has(fragmentId)) throw new Error(`Duplicate fragment id ${fragmentId}`);
      fragmentIds.add(fragmentId);
      return EvidenceFragmentSchema.parse({
        ...identity("research-core.fragment.v2", fragmentId),
        sourceVersion: `source-${digestBytes(source.text).slice(7, 31)}`,
        capture: source.ref,
        representation: source.ref,
        selector: {
          kind: "text_quote",
          value: quote,
          resolverVersion: "qualia-text-quote.v1",
          normalizationVersion: "retained-utf8.v1",
        },
        selectedDigest: digestBytes(quote),
        selectedSize: Buffer.byteLength(quote),
        context: {
          header: source.title?.slice(0, 500) ?? null,
          footnotes: [],
          surroundingDigest: digestBytes(source.text),
        },
        parserLineage: ["qualia-retained-utf8.v1"],
        captureCompleteness: source.completeness ?? "unknown",
        access: {
          rights: "public",
          limits: [profile.accessLimit],
        },
        originFamily: null,
      });
    });
    for (const fragment of claimFragments) input.bindFragment?.(recordRef("fragment", fragment), source);
    const q = claim.qualifiers ?? {};
    const qualifiers =
      profile.rubric.profile === "engineering.v2"
        ? engineeringQualifiers(q)
        : ScientificQualifiersSchema.parse({
            profile: "scientific.v2",
            entity: q.entity ?? q.study ?? null,
            population: q.population ?? null,
            time: q.time ?? null,
            unit: q.unit ?? null,
            jurisdiction: q.jurisdiction ?? null,
            baseline: q.baseline ?? null,
            negation: q.negation,
            modality: q.modality ?? "asserted",
            comparison: q.comparison ?? null,
            claimClass: "source_report",
            studyDesign: q.studyDesign ?? null,
            species: q.species ?? null,
            intervention: q.intervention ?? null,
            comparator: q.comparator ?? null,
            endpoint: q.endpoint ?? q.outcome ?? null,
            sampleSize: q.sampleSize ?? null,
            effectMeasure: q.effectMeasure ?? null,
            followUp: q.followUp ?? null,
            causalClaim: q.causalClaim ?? "unknown",
            appraisalDomain: null,
            appraisalJudgment: null,
          });
    const assertion = AssertionVersionSchema.parse({
      ...identity("research-core.assertion.v2", `${authored.id}-assertion-${claim.id}`),
      logicalId: `${authored.id}-${claim.id}`,
      proposition: claim.statement,
      kind: "source_report",
      value: { type: "text", value: claim.statement },
      subject: qualifiers.entity,
      object: null,
      qualifiers,
      riskReasons: [],
      producer: origin,
      premises: [],
    });
    const support = SupportSetSchema.parse({
      ...identity("research-core.support_set.v2", `${authored.id}-support-${claim.id}`),
      assertion: recordRef("assertion", assertion),
      qualifiersDigest: digestCanonical(qualifiers),
      provenance: "declared_citation",
      required: [
        {
          premise: `${claim.id}-source`,
          evidence: claimFragments.map((fragment) => recordRef("fragment", fragment)),
          derivedFrom: [],
        },
      ],
      contrary: [],
    });
    const claimCitations = claimFragments.map((fragment, quoteIndex) => ({
      type: "citation",
      label: `S${i + 1}${quoteIndex ? `_${quoteIndex + 1}` : ""}`,
      fragment: recordRef("fragment", fragment),
    }));
    fragments.push(...claimFragments);
    assertions.push(assertion);
    supportSets.push(support);
    findings.push({
      type: "paragraph",
      id: `finding-${i}`,
      inlines: [
        {
          type: "claim",
          occurrenceId: `${authored.id}-occ-${claim.id}`,
          assertion: recordRef("assertion", assertion),
          text: claim.statement,
          obligations: [`finding.${claim.id}`],
          attribution: claim.sourceUrl,
        },
        ...claimCitations,
      ],
      excludedReason: null,
    });
    citations.push({
      type: "paragraph",
      id: `citation-${i}`,
      inlines: [{ type: "text", text: `[S${i + 1}] ${claim.sourceUrl}` }, ...claimCitations],
      excludedReason: "Bibliographic reference; no additional world proposition",
    });
  }
  const section = (id: string, heading: string, blocks: unknown[]) => ({
    id,
    heading: [{ type: "text", text: heading }],
    headingExcludedReason: "Section framing",
    blocks,
  });
  const structuredBody = StructuredBodySchema.parse({
    schemaVersion: "research-core.structured_body.v2",
    sections: [
      section("scope", "Scope", [
        {
          type: "paragraph",
          id: "scope",
          inlines: [
            {
              type: "text",
              text: profile.scopeText(authored.title),
            },
          ],
          excludedReason: "Research-task scope and intended use",
        },
      ]),
      section("findings", "Findings", findings),
      section("evidence", "Evidence", citations),
      section("limitations", "Limitations", [
        {
          type: "paragraph",
          id: "limits",
          inlines: [
            {
              type: "text",
              text: authored.limitations.length
                ? authored.limitations.join("; ")
                : "Search is bounded to supplied captured sources; omitted evidence remains unknown.",
            },
          ],
          excludedReason:
            "Producer-declared search limitations; auditor must flag any factual proposition requiring its own assertion",
        },
      ]),
    ],
  });
  return {
    task,
    fragments,
    assertions,
    supportSets,
    report: {
      reportId: authored.id,
      revision: 1,
      kind: "evidence_report",
      structuredBody,
      timeCoverage: { world: null, observed: { from: now, to: now }, knowledgeHead: null },
      supersedes: null,
    },
  };
}

/** engineering.v2 qualifiers from authored values; unreported qualifiers stay null (unknown), never invented. */
function engineeringQualifiers(q: Record<string, unknown>) {
  return EngineeringQualifiersSchema.parse({
    profile: "engineering.v2",
    entity: q.entity ?? null,
    population: q.population ?? null,
    time: q.time ?? null,
    unit: q.unit ?? null,
    jurisdiction: q.jurisdiction ?? null,
    baseline: q.baseline ?? null,
    negation: q.negation,
    modality: q.modality ?? "asserted",
    comparison: q.comparison ?? null,
    runtime: q.runtime ?? null,
    softwareVersion: q.softwareVersion ?? null,
    configuration: q.configuration ?? null,
    benchmarkEnvironment: q.benchmarkEnvironment ?? null,
    denominator: q.denominator ?? null,
    repositoryCommit: q.repositoryCommit ?? null,
  });
}
