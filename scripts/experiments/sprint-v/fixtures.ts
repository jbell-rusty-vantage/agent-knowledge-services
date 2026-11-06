import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Origin, type Ref, digestBytes } from "../../../packages/knowledge-operation-protocol/dist/index.js";
import {
  APPRAISAL_DOMAINS,
  ASSERTION_SCHEMA_VERSION,
  type AssertionVersion,
  AssertionVersionSchema,
  type AuthScope,
  DecimalSchema,
  ENGINEERING_RUBRIC_VERSION,
  type EvidenceFragment,
  EvidenceFragmentSchema,
  FRAGMENT_SCHEMA_VERSION,
  type Inline,
  SCIENTIFIC_RUBRIC_VERSION,
  SUPPORT_SET_SCHEMA_VERSION,
  type StructuredBody,
  type SupportSet,
  SupportSetSchema,
  TASK_SCHEMA_VERSION,
  type VerificationTaskContract,
  VerificationTaskContractSchema,
  qualifiersDigest,
  recordRef,
} from "../../../packages/research-core/dist/index.js";
import { FIXTURES_DIR, type FixtureManifest, verifyManifest } from "./manifest.js";

/** SV-09 locked fixture corpus: loading (manifest-verified) and deterministic compilation of a producer draft. */
export const SOURCE_FILES: Readonly<Record<string, string>> = {
  S1: "sources/S1-orion-model-card",
  S2: "sources/S2-halcyon-evaluation",
  S3: "sources/S3-data-statement",
  S4: "sources/S4-deployment-guide",
  S5: "sources/S5-release-notes",
  S6: "sources/S6-pair26-abstract",
  S7: "sources/S7-hosting-faq",
};

export type KindId = "evidence_report" | "study_appraisal";

export interface TaskSpec {
  readonly schemaVersion: "sv09-task-spec.v1";
  readonly id: string;
  readonly kind: KindId;
  readonly domain: "engineering" | "scientific";
  readonly question: string;
  readonly use: string;
  readonly audience: string;
  readonly minimumRisk: "low" | "medium" | "high" | "critical";
  readonly obligations: readonly { id: string; description: string; weight: number; required: boolean }[];
  readonly sources: readonly string[];
  readonly qualifierGuidance: Readonly<Record<string, string>>;
  readonly mapping: {
    readonly id: string;
    readonly targetSchema: string;
    readonly rules: readonly {
      ruleId: string;
      assertionKinds: readonly string[];
      target: string;
      includeValue: boolean;
      qualifierFields: readonly string[];
      requiresEntity: boolean;
      requiresTime: boolean;
    }[];
    readonly entityResolutions: readonly { surface: string; entityId: string }[];
  };
  readonly limits: { calls: number; tokens: number; costUsd: string; deadline: string };
}

export interface DraftQuote {
  readonly source: string;
  readonly quote: string;
}

export interface DraftAssertion {
  readonly key: string;
  readonly obligations: readonly string[];
  readonly sentence: string;
  readonly kind: string;
  readonly subject: string | null;
  readonly value: {
    readonly valueType: "none" | "quantity" | "categorical" | "boolean" | "text";
    readonly amount: string | null;
    readonly unit: string | null;
    readonly text: string | null;
    readonly bool: boolean | null;
  };
  readonly qualifiers: Readonly<Record<string, string | number | boolean | null>>;
  readonly evidence: readonly DraftQuote[];
  readonly contrary: readonly DraftQuote[];
}

/** One producer draft (the recorded reference draft or a live producer response, same shape). */
export interface ProducerDraft {
  readonly schemaVersion?: string;
  readonly findingsHeading?: string;
  readonly findingsHeadingFactual?: boolean;
  readonly scope?: string;
  readonly studyHeading?: string;
  readonly assertions: readonly DraftAssertion[];
  readonly evidenceSummary?: string;
  readonly domains?: readonly { domain: string; assertionKey: string | null }[];
  readonly limitations: readonly string[];
}

export interface LabelOccurrence {
  readonly id: string;
  readonly path: string;
  readonly quote: string;
  readonly assertionKey: string | null;
  readonly note: string | null;
}

export interface Labels {
  readonly schemaVersion: "sv09-labels.v1";
  readonly task: string;
  readonly obligations: Readonly<
    Record<
      string,
      {
        expected: "supported" | "must_hold" | "optional";
        sources: readonly string[];
        negation?: boolean;
        keyFacts: readonly string[];
        judgments?: readonly string[];
      }
    >
  >;
  readonly expectedReportDecision: readonly string[];
  readonly census: {
    readonly occurrences: readonly LabelOccurrence[];
    readonly expectedUnitExplanations: readonly string[];
    readonly expectedHolds: readonly string[];
  };
  readonly t0Expected: {
    readonly reportDisposition: string;
    readonly censusHolds: readonly string[];
    readonly assertionDispositions: Readonly<Record<string, string>>;
    readonly nativeAdmitted: number;
    readonly nativeRefused: number;
  };
}

export interface SourceProvenance {
  readonly id: string;
  readonly authorityFake: {
    verifiedOriginFamily: string | null;
    doi: string | null;
    sourceKind: string | null;
    studyDesign: string | null;
    directness: "direct" | "indirect" | "unknown";
    freshness: "current" | "stale" | "superseded" | "unknown";
    qualifiers: Record<string, string | null>;
  };
  readonly revisionFrontierFake: { status: number; body: unknown } | null;
}

export interface SourceDoc {
  readonly id: string;
  readonly path: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly provenance: SourceProvenance;
}

export interface FixtureCase {
  readonly kind: KindId;
  readonly spec: TaskSpec;
  readonly specBytes: Buffer;
  readonly labels: Labels;
  readonly reference: ProducerDraft;
}

export interface LoadedFixtures {
  readonly manifest: FixtureManifest;
  readonly sources: ReadonlyMap<string, SourceDoc>;
  readonly cases: readonly FixtureCase[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(FIXTURES_DIR, path), "utf8")) as T;

export function loadFixtures(): LoadedFixtures {
  const manifest = verifyManifest();
  const sources = new Map<string, SourceDoc>();
  for (const [id, base] of Object.entries(SOURCE_FILES)) {
    const bytes = readFileSync(join(FIXTURES_DIR, `${base}.md`));
    sources.set(id, {
      id,
      path: `${base}.md`,
      bytes,
      text: bytes.toString("utf8"),
      provenance: readJson<SourceProvenance>(`${base}.provenance.json`),
    });
  }
  const cases = (["evidence_report", "study_appraisal"] as const).map((kind) => ({
    kind,
    spec: readJson<TaskSpec>(`tasks/${kind}.task.json`),
    specBytes: readFileSync(join(FIXTURES_DIR, `tasks/${kind}.task.json`)),
    labels: readJson<Labels>(`labels/${kind}.labels.json`),
    reference: readJson<ProducerDraft>(`recorded/${kind}.reference-draft.json`),
  }));
  return { manifest, sources, cases };
}

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 10);
const localKey = (key: string) =>
  (key.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z0-9]+/, "") || "a").slice(0, 40);
const nullIfEmpty = <T>(value: T): T | null => (value === "" || value === undefined ? null : value);

export function buildTask(spec: TaskSpec, scope: AuthScope, originalTask: Ref<"artifact">): VerificationTaskContract {
  const rubricVersion = spec.domain === "engineering" ? ENGINEERING_RUBRIC_VERSION : SCIENTIFIC_RUBRIC_VERSION;
  const ref = <K extends Ref["kind"]>(kind: K, id: string, version: string): Ref<K> =>
    ({
      kind,
      id,
      version,
      digest: digestBytes(`${kind}:${id}:${version}`),
      tenant: scope.tenant,
      binding: scope.binding,
    }) as Ref<K>;
  return VerificationTaskContractSchema.parse({
    schemaVersion: TASK_SCHEMA_VERSION,
    id: spec.id,
    tenant: scope.tenant,
    binding: scope.binding,
    domain: spec.domain,
    originalTask,
    use: spec.use,
    audience: spec.audience,
    obligations: spec.obligations.map((obligation) => ({ ...obligation })),
    asOf: "2026-10-25T00:00:00Z",
    permittedMedia: ["text_markdown"],
    rubric: ref("rubric", `rubric-${spec.domain}`, rubricVersion),
    policy: ref("policy", "policy-ai-engineer", "research-policy.ai-engineer.v2"),
    minimumRisk: spec.minimumRisk,
    limits: { ...spec.limits },
  });
}

export interface CompileIssue {
  readonly assertion: string | null;
  readonly code:
    | "quote_not_found"
    | "quote_not_unique"
    | "unknown_source"
    | "source_not_in_task"
    | "invalid_assertion"
    | "invalid_value"
    | "unknown_obligation"
    | "no_evidence"
    | "duplicate_key"
    | "unplaced_domain";
  readonly detail: string;
}

export interface CompiledDraft {
  readonly fragments: EvidenceFragment[];
  readonly assertions: AssertionVersion[];
  readonly supportSets: SupportSet[];
  readonly body: StructuredBody;
  /** draft key -> registered assertion (only assertions that compiled). */
  readonly byKey: ReadonlyMap<string, AssertionVersion>;
  /** fragment id -> exact quoted text and source (for judges). */
  readonly quotes: ReadonlyMap<string, { source: string; quote: string; header: string | null }>;
  readonly issues: CompileIssue[];
}

function headerBefore(text: string, index: number): string | null {
  const lines = text
    .slice(0, index)
    .split("\n")
    .filter((line) => line.startsWith("#"));
  const last = lines[lines.length - 1];
  return last === undefined ? null : last.replace(/^#+\s*/, "").slice(0, 200) || null;
}

function qualifiersFor(spec: TaskSpec, q: DraftAssertion["qualifiers"]) {
  const text = (name: string) => {
    const value = q[name];
    return typeof value === "string" ? nullIfEmpty(value.trim()) : null;
  };
  const base = {
    entity: text("entity"),
    population: spec.domain === "scientific" ? text("population") : null,
    time: null,
    unit: text("unit"),
    jurisdiction: null,
    baseline: null,
    negation: q.negation === true,
    modality: text("modality") ?? "asserted",
    comparison: null,
  };
  if (spec.domain === "engineering") {
    return {
      profile: "engineering.v2",
      ...base,
      runtime: null,
      softwareVersion: text("softwareVersion"),
      configuration: text("configuration"),
      benchmarkEnvironment: text("benchmarkEnvironment"),
      denominator: null,
      repositoryCommit: null,
    };
  }
  const sample = q.sampleSize;
  return {
    profile: "scientific.v2",
    ...base,
    unit: null,
    claimClass: "source_report",
    studyDesign: text("studyDesign"),
    species: text("species"),
    intervention: text("intervention"),
    comparator: text("comparator"),
    endpoint: text("endpoint"),
    sampleSize: typeof sample === "number" && Number.isSafeInteger(sample) && sample >= 0 ? sample : null,
    effectMeasure: null,
    followUp: null,
    causalClaim: "none",
    appraisalDomain: text("appraisalDomain"),
    appraisalJudgment: text("appraisalJudgment"),
  };
}

function valueFor(value: DraftAssertion["value"], issues: CompileIssue[], key: string) {
  switch (value.valueType) {
    case "quantity":
      if (value.amount !== null && DecimalSchema.safeParse(value.amount).success && value.unit) {
        return { type: "quantity", amount: value.amount, unit: value.unit } as const;
      }
      issues.push({
        assertion: key,
        code: "invalid_value",
        detail: `quantity ${value.amount ?? "null"} ${value.unit ?? ""}`,
      });
      return { type: "none" } as const;
    case "categorical":
      return value.text
        ? ({ type: "categorical", value: value.text.slice(0, 500) } as const)
        : ({ type: "none" } as const);
    case "boolean":
      return value.bool === null ? ({ type: "none" } as const) : ({ type: "boolean", value: value.bool } as const);
    case "text":
      return value.text ? ({ type: "text", value: value.text.slice(0, 4000) } as const) : ({ type: "none" } as const);
    default:
      return { type: "none" } as const;
  }
}

/**
 * Deterministic compilation of one producer draft into K02 records and a K08-shaped structured body. Quotes become
 * `text_quote` fragments only when they occur exactly once in the cited locked source (producer-side locator, as in the
 * model-card instrument); anything that does not compile is recorded as an issue, never repaired by guessing.
 */
export function compileDraft(input: {
  readonly spec: TaskSpec;
  readonly draft: ProducerDraft;
  readonly sources: ReadonlyMap<string, SourceDoc>;
  readonly captures: ReadonlyMap<string, Ref<"artifact">>;
  readonly scope: AuthScope;
  readonly producer: Origin;
  readonly chain: string;
}): CompiledDraft {
  const { spec, draft, scope } = input;
  const issues: CompileIssue[] = [];
  const fragments = new Map<string, EvidenceFragment>();
  const quotes = new Map<string, { source: string; quote: string; header: string | null }>();
  const taskObligations = new Set(spec.obligations.map((obligation) => obligation.id));
  const prefix = `${input.chain}-${spec.kind === "evidence_report" ? "er" : "sa"}`;

  const fragmentFor = (key: string, entry: DraftQuote): EvidenceFragment | null => {
    const source = input.sources.get(entry.source);
    if (source === undefined) {
      issues.push({ assertion: key, code: "unknown_source", detail: entry.source });
      return null;
    }
    if (!spec.sources.includes(entry.source)) {
      issues.push({ assertion: key, code: "source_not_in_task", detail: entry.source });
      return null;
    }
    const first = source.text.indexOf(entry.quote);
    if (entry.quote.length === 0 || first < 0) {
      issues.push({ assertion: key, code: "quote_not_found", detail: `${entry.source}: ${entry.quote.slice(0, 120)}` });
      return null;
    }
    if (source.text.indexOf(entry.quote, first + 1) >= 0) {
      issues.push({
        assertion: key,
        code: "quote_not_unique",
        detail: `${entry.source}: ${entry.quote.slice(0, 120)}`,
      });
      return null;
    }
    const id = `${prefix}-${entry.source}-q${short(entry.quote)}`;
    const existing = fragments.get(id);
    if (existing !== undefined) return existing;
    const capture = input.captures.get(entry.source) as Ref<"artifact">;
    const header = headerBefore(source.text, first);
    const fragment = EvidenceFragmentSchema.parse({
      schemaVersion: FRAGMENT_SCHEMA_VERSION,
      id,
      tenant: scope.tenant,
      binding: scope.binding,
      sourceVersion: `${entry.source}-locked-v1`,
      capture,
      representation: capture,
      selector: {
        kind: "text_quote",
        value: entry.quote.slice(0, 4000),
        resolverVersion: "text-quote.v3",
        normalizationVersion: "text-norm.v1",
      },
      selectedDigest: digestBytes(entry.quote),
      selectedSize: Buffer.byteLength(entry.quote, "utf8"),
      context: { header, footnotes: [], surroundingDigest: null },
      parserLineage: ["markdown-parser.v2"],
      captureCompleteness: "complete",
      access: { rights: "public", limits: [] },
      originFamily: source.provenance.authorityFake.verifiedOriginFamily,
    } satisfies EvidenceFragment);
    fragments.set(id, fragment);
    quotes.set(id, { source: entry.source, quote: entry.quote, header });
    return fragment;
  };

  const assertions: AssertionVersion[] = [];
  const supportSets: SupportSet[] = [];
  const byKey = new Map<string, AssertionVersion>();
  const evidenceByKey = new Map<string, EvidenceFragment[]>();
  const claimObligations = new Map<string, string[]>();
  for (const entry of draft.assertions) {
    const key = localKey(entry.key);
    if (byKey.has(key)) {
      issues.push({ assertion: key, code: "duplicate_key", detail: entry.key });
      continue;
    }
    const obligations = entry.obligations.filter((id) => {
      if (taskObligations.has(id)) return true;
      issues.push({ assertion: key, code: "unknown_obligation", detail: id });
      return false;
    });
    const candidate = {
      schemaVersion: ASSERTION_SCHEMA_VERSION,
      id: `${prefix}-${key}`,
      tenant: scope.tenant,
      binding: scope.binding,
      logicalId: `${spec.id}.${key}`,
      proposition: entry.sentence.trim().slice(0, 4000),
      kind: entry.kind,
      value: valueFor(entry.value, issues, key),
      subject: nullIfEmpty(entry.subject),
      object: null,
      qualifiers: qualifiersFor(spec, entry.qualifiers),
      riskReasons: [],
      producer: input.producer,
      premises: [],
    };
    const parsed = AssertionVersionSchema.safeParse(candidate);
    if (!parsed.success) {
      issues.push({
        assertion: key,
        code: "invalid_assertion",
        detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      });
      continue;
    }
    const assertion = parsed.data;
    const evidence = entry.evidence
      .map((quote) => fragmentFor(key, quote))
      .filter((f): f is EvidenceFragment => f !== null);
    const contrary = entry.contrary
      .map((quote) => fragmentFor(key, quote))
      .filter((f): f is EvidenceFragment => f !== null);
    assertions.push(assertion);
    byKey.set(key, assertion);
    evidenceByKey.set(key, evidence);
    claimObligations.set(key, obligations);
    if (evidence.length === 0) {
      issues.push({ assertion: key, code: "no_evidence", detail: "no cited quote resolved; no support set" });
      continue;
    }
    supportSets.push(
      SupportSetSchema.parse({
        schemaVersion: SUPPORT_SET_SCHEMA_VERSION,
        id: `ss-${assertion.id}`,
        tenant: scope.tenant,
        binding: scope.binding,
        assertion: recordRef("assertion", assertion),
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
        provenance: "declared_citation",
        required: [{ premise: "cited", evidence: evidence.map((f) => recordRef("fragment", f)), derivedFrom: [] }],
        contrary: contrary.map((f) => recordRef("fragment", f)),
      } satisfies SupportSet),
    );
  }

  const text = (value: string): Inline => ({ type: "text", text: value });
  let citeIndex = 0;
  const cite = (fragment: EvidenceFragment): Inline => {
    citeIndex += 1;
    return { type: "citation", label: `c${citeIndex}`, fragment: recordRef("fragment", fragment) };
  };
  const claim = (key: string, assertion: AssertionVersion): Inline => ({
    type: "claim",
    occurrenceId: `occ-${key}`,
    assertion: recordRef("assertion", assertion),
    text: assertion.proposition,
    obligations: claimObligations.get(key) ?? [],
    attribution: null,
  });
  const limitations = draft.limitations.filter((item) => item.trim().length > 0);
  const limitationsSection = {
    id: "limitations",
    heading: [text("Limitations")],
    headingExcludedReason: "section title",
    blocks: [
      {
        type: "list" as const,
        id: "l1",
        ordered: false,
        items: (limitations.length > 0 ? limitations : ["No further limitation was stated."]).map((item) => [
          text(item.trim()),
        ]),
        excludedReason: "limitation statement",
      },
    ],
  };

  let body: StructuredBody;
  if (spec.kind === "evidence_report") {
    const cited = [...fragments.values()];
    body = {
      schemaVersion: "research-core.structured_body.v2",
      sections: [
        {
          id: "scope",
          heading: [text("Scope")],
          headingExcludedReason: "section title",
          blocks: [
            {
              type: "paragraph",
              id: "p1",
              inlines: [text(draft.scope?.trim() || "Scope as frozen in the task.")],
              excludedReason: "scope statement",
            },
          ],
        },
        {
          id: "findings",
          heading: [text(draft.findingsHeading?.trim() || "Findings")],
          headingExcludedReason: draft.findingsHeadingFactual === true ? null : "section title",
          blocks: [...byKey.entries()].map(([key, assertion], index) => ({
            type: "paragraph" as const,
            id: `p${index + 1}`,
            inlines: [claim(key, assertion), ...(evidenceByKey.get(key) ?? []).flatMap((f) => [text(" "), cite(f)])],
            excludedReason: null,
          })),
        },
        {
          id: "evidence",
          heading: [text("Evidence")],
          headingExcludedReason: "section title",
          blocks: [
            {
              type: "paragraph",
              id: "p1",
              inlines: [
                text(draft.evidenceSummary?.trim() || "Citations follow."),
                ...cited.flatMap((f) => [text(" "), cite(f)]),
              ],
              excludedReason: "citation summary",
            },
          ],
        },
        limitationsSection,
      ],
    };
  } else {
    const placed = new Set<string>();
    const design = [...byKey.entries()].find(
      ([, assertion]) =>
        assertion.qualifiers.profile === "scientific.v2" && assertion.qualifiers.appraisalDomain === null,
    );
    if (design) placed.add(design[0]);
    const designEvidence = design ? (evidenceByKey.get(design[0]) ?? [])[0] : undefined;
    const domainRow = (domain: string): Inline[][] => {
      const mapped = draft.domains?.find((entry) => entry.domain === domain)?.assertionKey ?? null;
      const key = mapped === null ? null : localKey(mapped);
      const assertion = key === null ? undefined : byKey.get(key);
      if (key === null || assertion === undefined) {
        if (mapped !== null) issues.push({ assertion: mapped, code: "unplaced_domain", detail: domain });
        return [[text(domain)], [text("not reported")]];
      }
      placed.add(key);
      const first = (evidenceByKey.get(key) ?? [])[0];
      return [[text(domain)], [claim(key, assertion), ...(first ? [text(" "), cite(first)] : [])]];
    };
    const rows = APPRAISAL_DOMAINS.map(domainRow);
    const leftovers = [...byKey.entries()].filter(([key]) => !placed.has(key));
    body = {
      schemaVersion: "research-core.structured_body.v2",
      sections: [
        {
          id: "study",
          heading: [text(draft.studyHeading?.trim() || "Study")],
          headingExcludedReason: "section title",
          blocks: [
            design
              ? {
                  type: "paragraph" as const,
                  id: "p1",
                  inlines: [claim(design[0], design[1]), ...(designEvidence ? [text(" "), cite(designEvidence)] : [])],
                  excludedReason: null,
                }
              : {
                  type: "paragraph" as const,
                  id: "p1",
                  inlines: [text("The producer stated no study design.")],
                  excludedReason: "producer omission",
                },
          ],
        },
        {
          id: "domains",
          heading: [text("Appraisal domains")],
          headingExcludedReason: "section title",
          blocks: [
            {
              type: "table" as const,
              id: "t1",
              header: [[text("Domain")], [text("What the study reported")]],
              rows,
              caption: null,
              excludedReason: null,
              headerExcludedReason: "column labels",
            },
          ],
        },
        ...(leftovers.length > 0
          ? [
              {
                id: "notes",
                heading: [text("Other reported items")],
                headingExcludedReason: "section title",
                blocks: leftovers.map(([key, assertion], index) => ({
                  type: "paragraph" as const,
                  id: `p${index + 1}`,
                  inlines: [claim(key, assertion)],
                  excludedReason: null,
                })),
              },
            ]
          : []),
        limitationsSection,
      ],
    };
  }
  return { fragments: [...fragments.values()], assertions, supportSets, body, byKey, quotes, issues };
}
