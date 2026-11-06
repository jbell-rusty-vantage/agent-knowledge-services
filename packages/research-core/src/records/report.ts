import { DigestSchema, IdSchema, refOf } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { IntervalSchema, LocalIdSchema, ShortTextSchema, duplicates, identityShape } from "./common.js";
import { AssertionOccurrenceSchema } from "./occurrence.js";

export const REPORT_SCHEMA_VERSION = "research-report.v2" as const;
export const STRUCTURED_BODY_SCHEMA_VERSION = "research-core.structured_body.v2" as const;
export const LEDGER_SCHEMA_VERSION = "research-core.report_ledger.v2" as const;
export const RENDERER_VERSION = "research-report-renderer.v2" as const;
/**
 * Freeze normalization, applied once to rendered Markdown before the body is frozen and never to retained bytes:
 * CRLF and lone CR become LF; spaces/tabs before every line end are removed; the body ends with exactly one LF.
 * There is no Unicode normalization of any form (no NFC/NFD/NFKC): combining sequences stay as authored.
 */
export const NORMALIZATION_VERSION = "research-report-normalization.v1" as const;

export const InlineSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(20000) }),
  /** A producer-declared assertion occurrence; the renderer records its exact span in the ledger. */
  z.strictObject({
    type: z.literal("claim"),
    occurrenceId: IdSchema,
    assertion: refOf("assertion"),
    text: z.string().min(1).max(20000),
    obligations: z.array(IdSchema),
    attribution: ShortTextSchema.nullable(),
  }),
  z.strictObject({ type: z.literal("citation"), label: LocalIdSchema, fragment: refOf("fragment") }),
]);
export type Inline = z.infer<typeof InlineSchema>;
const Inlines = z.array(InlineSchema);

/** `excludedReason: null` means factual: nonfactual exclusions always carry an auditable reason. */
const Exclusion = ShortTextSchema.nullable();

export const BlockSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("paragraph"),
    id: LocalIdSchema,
    inlines: Inlines.min(1),
    excludedReason: Exclusion,
  }),
  z.strictObject({
    type: z.literal("list"),
    id: LocalIdSchema,
    ordered: z.boolean(),
    items: z.array(Inlines.min(1)).min(1),
    excludedReason: Exclusion,
  }),
  z
    .strictObject({
      type: z.literal("table"),
      id: LocalIdSchema,
      header: z.array(Inlines).min(1),
      rows: z.array(z.array(Inlines)),
      caption: Inlines.min(1).nullable(),
      excludedReason: Exclusion,
      headerExcludedReason: Exclusion,
    })
    .refine((table) => table.rows.every((row) => row.length === table.header.length), {
      path: ["rows"],
      message: "every row has one cell per header column",
    }),
  z.strictObject({
    type: z.literal("code"),
    id: LocalIdSchema,
    language: LocalIdSchema.nullable(),
    text: z.string().min(1).max(20000),
    excludedReason: Exclusion,
  }),
]);
export type Block = z.infer<typeof BlockSchema>;

export const SectionSchema = z
  .strictObject({
    id: LocalIdSchema,
    heading: Inlines.min(1),
    headingExcludedReason: Exclusion,
    blocks: z.array(BlockSchema),
  })
  .superRefine((section, context) => {
    for (const id of duplicates(section.blocks.map((block) => block.id))) {
      context.addIssue({ code: "custom", path: ["blocks"], message: `duplicate block id ${id}` });
    }
  });

/** Structured body: sections -> blocks -> inline text, claims and citations. Rendered deterministically. */
export const StructuredBodySchema = z
  .strictObject({ schemaVersion: z.literal(STRUCTURED_BODY_SCHEMA_VERSION), sections: z.array(SectionSchema).min(1) })
  .superRefine((body, context) => {
    for (const id of duplicates(body.sections.map((section) => section.id))) {
      context.addIssue({ code: "custom", path: ["sections"], message: `duplicate section id ${id}` });
    }
  });
export type StructuredBody = z.infer<typeof StructuredBodySchema>;

/** Producer ledger: every declared occurrence with exact span, block path, quote digest and obligations. */
export const ReportLedgerSchema = z
  .strictObject({
    ...identityShape(LEDGER_SCHEMA_VERSION),
    body: refOf("artifact"),
    renderer: z.literal(RENDERER_VERSION),
    entries: z.array(AssertionOccurrenceSchema),
  })
  .superRefine((ledger, context) => {
    if (ledger.entries.some((entry) => entry.body.digest !== ledger.body.digest)) {
      context.addIssue({ code: "custom", path: ["entries"], message: "every entry binds the ledger body" });
    }
    for (const id of duplicates(ledger.entries.map((entry) => entry.id))) {
      context.addIssue({ code: "custom", path: ["entries"], message: `duplicate occurrence ${id}` });
    }
  });
export type ReportLedger = z.infer<typeof ReportLedgerSchema>;

/**
 * `ReportRevision` (design §3). It embeds neither its assessment nor its current use decision (digest cycle); status
 * views are derived joins. `bodyDigest` is the SHA-256 of the exact UTF-8 body bytes and equals `body.digest`.
 */
export const ReportRevisionSchema = z
  .strictObject({
    ...identityShape(REPORT_SCHEMA_VERSION),
    kind: refOf("report_kind"),
    task: refOf("task"),
    structuredBody: refOf("artifact"),
    body: refOf("artifact"),
    bodyDigest: DigestSchema,
    renderer: z.literal(RENDERER_VERSION),
    normalization: z.literal(NORMALIZATION_VERSION),
    ledger: refOf("artifact"),
    assertions: z.array(refOf("assertion")),
    timeCoverage: z.strictObject({
      world: IntervalSchema.nullable(),
      observed: IntervalSchema.nullable(),
      knowledgeHead: IdSchema.nullable(),
    }),
    derivationCandidates: z.array(refOf("artifact")),
    supersedes: refOf("report").nullable(),
  })
  .superRefine((report, context) => {
    if (report.body.digest !== report.bodyDigest) {
      context.addIssue({ code: "custom", path: ["bodyDigest"], message: "bodyDigest must equal the body ref digest" });
    }
  });
export type ReportRevision = z.infer<typeof ReportRevisionSchema>;
