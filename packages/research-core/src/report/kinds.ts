import { type JsonValue, type Ref, digestCanonical, sameRef } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { recordRef } from "../digest.js";
import { QUALIFIER_PROFILES } from "../profiles/index.js";
import { ASSERTION_KINDS, type AssertionVersion } from "../records/assertion.js";
import { LocalIdSchema, LongTextSchema, ShortTextSchema, duplicates } from "../records/common.js";
import {
  type Inline,
  RENDERER_VERSION,
  STRUCTURED_BODY_SCHEMA_VERSION,
  type StructuredBody,
} from "../records/report.js";
import type { VerificationTaskContract } from "../records/task.js";

/**
 * K08 report kinds as data (design §2: "adding a report kind must not require a new engine or a new agent workflow").
 * A kind is a pinned JSON document (`catalog/research/report-kinds/*.json`) in the `research-report-kind.v1` envelope:
 * required sections and their structural constraints, obligation templates in basis points, allowed assertion kinds,
 * qualifier profiles, the body renderer and structured-body schema. Registration validates a draft against it.
 */
export const REPORT_KIND_SCHEMA_VERSION = "research-report-kind.v1" as const;

const KindIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);
const SemverSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
/** Obligation template ids are local ids without dots: a task obligation `finding.size` maps to template `finding`. */
const TemplateIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const SectionConstraintSchema = z.discriminatedUnion("type", [
  /** The section cites exactly one distinct evidence fragment: the single subject (for example, the appraised study). */
  z.strictObject({ type: z.literal("single_cited_source") }),
  /** The section holds a table whose first column lists every named value (for example, appraisal domains). */
  z.strictObject({ type: z.literal("table_first_column"), values: z.array(LocalIdSchema).min(1) }),
]);
export type SectionConstraint = z.infer<typeof SectionConstraintSchema>;

export const ReportKindSchema = z
  .strictObject({
    schemaVersion: z.literal(REPORT_KIND_SCHEMA_VERSION),
    id: KindIdSchema,
    version: SemverSchema,
    title: ShortTextSchema,
    summary: LongTextSchema,
    profiles: z.array(z.enum(["engineering", "scientific", "education"])).min(1),
    /** Qualifier profile ids (`AssertionVersion.qualifiers.profile`) an assertion in this kind may use. */
    qualifierSchemas: z.array(z.enum(QUALIFIER_PROFILES.map((entry) => entry.profile) as [string, ...string[]])).min(1),
    structuredBodySchema: z.literal(STRUCTURED_BODY_SCHEMA_VERSION),
    bodyRenderer: z.literal(RENDERER_VERSION),
    requiredSections: z
      .array(
        z.strictObject({ id: LocalIdSchema, purpose: ShortTextSchema, constraints: z.array(SectionConstraintSchema) }),
      )
      .min(1),
    forbiddenSections: z.array(LocalIdSchema),
    /**
     * Framing sections (scope/as-of, limitations, search frontier, evidence summary): non-factual by declaration of the
     * kind. The final census excludes them from the factual inventory and records each exclusion with its reason
     * (design §3.2); headings, tables and captions of every other section stay covered.
     */
    framingSections: z.array(LocalIdSchema),
    obligationTemplates: z
      .array(
        z.strictObject({
          id: TemplateIdSchema,
          description: LongTextSchema,
          weight: z.int().min(0).max(10000),
          required: z.boolean(),
          section: LocalIdSchema,
        }),
      )
      .min(1),
    assertionRules: z.strictObject({
      allowedKinds: z.array(z.enum(ASSERTION_KINDS)).min(1),
      /** When set, every assertion must use the scientific profile with one of these claim classes. */
      scientificClaimClasses: z
        .array(z.enum(["source_report", "generalized"]))
        .min(1)
        .nullable(),
    }),
    subject: z.strictObject({
      cardinality: z.enum(["single_study", "open"]),
      bodyOfEvidenceRating: z.enum(["forbidden", "permitted"]),
    }),
    extension: LongTextSchema,
  })
  .superRefine((kind, context) => {
    const total = kind.obligationTemplates.reduce((sum, template) => sum + template.weight, 0);
    if (total !== 10000) {
      context.addIssue({ code: "custom", path: ["obligationTemplates"], message: "template weights sum to 10000 bp" });
    }
    for (const id of duplicates(kind.obligationTemplates.map((template) => template.id))) {
      context.addIssue({ code: "custom", path: ["obligationTemplates"], message: `duplicate template ${id}` });
    }
    const sections = kind.requiredSections.map((section) => section.id);
    for (const id of duplicates(sections)) {
      context.addIssue({ code: "custom", path: ["requiredSections"], message: `duplicate section ${id}` });
    }
    for (const id of kind.forbiddenSections.filter((section) => sections.includes(section))) {
      context.addIssue({
        code: "custom",
        path: ["forbiddenSections"],
        message: `section ${id} is both required and forbidden`,
      });
    }
    for (const template of kind.obligationTemplates.filter((item) => !sections.includes(item.section))) {
      context.addIssue({
        code: "custom",
        path: ["obligationTemplates"],
        message: `${template.id} names unknown section`,
      });
    }
    for (const id of kind.framingSections.filter((section) => !sections.includes(section))) {
      context.addIssue({
        code: "custom",
        path: ["framingSections"],
        message: `framing section ${id} is not a required section`,
      });
    }
    if (!kind.obligationTemplates.some((template) => template.required)) {
      context.addIssue({ code: "custom", path: ["obligationTemplates"], message: "a kind has a required obligation" });
    }
  });
export type ReportKind = z.infer<typeof ReportKindSchema>;

export class ReportKindError extends Error {
  readonly code = "SCHEMA_UNSUPPORTED" as const;
  constructor(message: string) {
    super(`SCHEMA_UNSUPPORTED: ${message}`);
    this.name = "ReportKindError";
  }
}

/** Parse one pinned kind document; anything outside the envelope refuses with `SCHEMA_UNSUPPORTED`. */
export function loadReportKind(json: unknown): ReportKind {
  const parsed = ReportKindSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ReportKindError(`${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid report kind"}`.trim());
  }
  return parsed.data;
}

/**
 * The `Ref<"report_kind">` a revision binds: id `<kind>@<semver>`, version the envelope schema, digest the canonical
 * bytes of the exact kind document. Tenant/binding name the scope that adopted the catalog entry.
 */
export function reportKindRef(kind: ReportKind, scope: { tenant: string; binding: string }): Ref<"report_kind"> {
  return {
    kind: "report_kind",
    id: `${kind.id}@${kind.version}`,
    version: kind.schemaVersion,
    digest: digestCanonical(kind as unknown as JsonValue),
    tenant: scope.tenant,
    binding: scope.binding,
  };
}

/** The template a task obligation maps to: its id up to the first dot. */
export function obligationTemplate(obligationId: string): string {
  return obligationId.split(".")[0] ?? obligationId;
}

export type KindCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "SCHEMA_UNSUPPORTED"; readonly violations: readonly string[] };

const inlineText = (items: readonly Inline[]) =>
  items
    .map((item) => (item.type === "citation" ? "" : item.text))
    .join("")
    .trim();

/**
 * Validate a report draft against its kind before anything is frozen: the task's domain is a kind profile; required
 * sections exist and satisfy their constraints; forbidden sections are absent; every task obligation maps to a kind
 * template and every required template has a required task obligation; claims name declared assertions and known task
 * obligations; every assertion uses an allowed kind, qualifier profile and (when set) scientific claim class.
 */
export function checkReportAgainstKind(input: {
  readonly kind: ReportKind;
  readonly task: VerificationTaskContract;
  readonly body: StructuredBody;
  readonly declared: readonly Ref<"assertion">[];
  readonly assertions: readonly AssertionVersion[];
}): KindCheck {
  const { kind, task, body } = input;
  const violations: string[] = [];
  if (!kind.profiles.includes(task.domain)) violations.push(`profile_unsupported:${task.domain}`);
  const sections = new Map(body.sections.map((section) => [section.id, section]));
  for (const required of kind.requiredSections) {
    const section = sections.get(required.id);
    if (section === undefined) {
      violations.push(`missing_section:${required.id}`);
      continue;
    }
    for (const constraint of required.constraints) {
      if (constraint.type === "single_cited_source") {
        const cited = new Set<string>();
        const visit = (items: readonly Inline[]) => {
          for (const item of items) if (item.type === "citation") cited.add(item.fragment.digest);
        };
        visit(section.heading);
        for (const block of section.blocks) {
          if (block.type === "paragraph") visit(block.inlines);
          if (block.type === "list") for (const item of block.items) visit(item);
          if (block.type === "table") {
            for (const cell of block.header) visit(cell);
            for (const row of block.rows) for (const cell of row) visit(cell);
            if (block.caption !== null) visit(block.caption);
          }
        }
        if (cited.size !== 1) violations.push(`section_constraint:${required.id}:single_cited_source:${cited.size}`);
      } else {
        const listed = new Set(
          section.blocks.flatMap((block) =>
            block.type === "table" ? block.rows.map((row) => inlineText(row[0] ?? [])) : [],
          ),
        );
        for (const value of constraint.values.filter((item) => !listed.has(item))) {
          violations.push(`section_constraint:${required.id}:table_first_column:${value}`);
        }
      }
    }
  }
  for (const id of kind.forbiddenSections.filter((section) => sections.has(section))) {
    violations.push(`forbidden_section:${id}`);
  }
  const templates = new Set(kind.obligationTemplates.map((template) => template.id));
  for (const obligation of task.obligations) {
    if (!templates.has(obligationTemplate(obligation.id))) violations.push(`obligation_unmapped:${obligation.id}`);
  }
  for (const template of kind.obligationTemplates.filter((item) => item.required)) {
    const covered = task.obligations.some(
      (obligation) => obligation.required && obligationTemplate(obligation.id) === template.id,
    );
    if (!covered) violations.push(`obligation_template_missing:${template.id}`);
  }
  const taskObligations = new Set(task.obligations.map((obligation) => obligation.id));
  const claims: Extract<Inline, { type: "claim" }>[] = [];
  const collect = (items: readonly Inline[]) => {
    for (const item of items) if (item.type === "claim") claims.push(item);
  };
  for (const section of body.sections) {
    collect(section.heading);
    for (const block of section.blocks) {
      if (block.type === "paragraph") collect(block.inlines);
      if (block.type === "list") for (const item of block.items) collect(item);
      if (block.type === "table") {
        for (const cell of block.header) collect(cell);
        for (const row of block.rows) for (const cell of row) collect(cell);
        if (block.caption !== null) collect(block.caption);
      }
    }
  }
  for (const claim of claims) {
    for (const id of claim.obligations.filter((item) => !taskObligations.has(item))) {
      violations.push(`obligation_unknown:${claim.occurrenceId}:${id}`);
    }
    if (!input.declared.some((ref) => sameRef(ref, claim.assertion))) {
      violations.push(`assertion_undeclared:${claim.occurrenceId}`);
    }
  }
  for (const ref of input.declared) {
    const assertion = input.assertions.find((candidate) => sameRef(recordRef("assertion", candidate), ref));
    if (assertion === undefined) {
      violations.push(`assertion_unknown:${ref.id}`);
      continue;
    }
    if (!kind.assertionRules.allowedKinds.includes(assertion.kind)) {
      violations.push(`assertion_kind:${assertion.id}:${assertion.kind}`);
    }
    if (!kind.qualifierSchemas.includes(assertion.qualifiers.profile)) {
      violations.push(`qualifier_schema:${assertion.id}:${assertion.qualifiers.profile}`);
    }
    const classes = kind.assertionRules.scientificClaimClasses;
    if (classes !== null) {
      const qualifiers = assertion.qualifiers;
      if (qualifiers.profile !== "scientific.v2" || !classes.includes(qualifiers.claimClass)) {
        violations.push(`claim_class:${assertion.id}`);
      }
    }
  }
  // SV-07 study appraisal: a single-study kind appraises ONE study (one named entity and one design across its
  // scientific assertions); appraisal-domain qualifiers belong only to single-study kinds.
  const studies = new Set<string>();
  for (const assertion of input.assertions) {
    const q = assertion.qualifiers;
    if (q.profile !== "scientific.v2") continue;
    if (kind.subject.cardinality === "single_study")
      studies.add(`${q.entity ?? "<unknown>"}|${q.studyDesign ?? "<unknown>"}`);
    else if (q.appraisalDomain !== null) violations.push(`appraisal_outside_single_study:${assertion.id}`);
  }
  if (studies.size > 1 || [...studies].some((study) => study.includes("<unknown>"))) {
    violations.push(`single_study:${[...studies].sort().join(",")}`);
  }
  return violations.length === 0 ? { ok: true } : { ok: false, code: "SCHEMA_UNSUPPORTED", violations };
}
