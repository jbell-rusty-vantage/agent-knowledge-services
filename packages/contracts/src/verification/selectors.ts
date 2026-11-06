import { z } from "zod";
import { JsonValueSchema, NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationIdSchema } from "./primitives.js";

export const TextNormalizationSchema = z.enum([
  "none",
  "lf",
  "lf_whitespace_collapsed",
  "casefold_whitespace_filler_removed",
]);
export const TextOffsetBasisSchema = z.enum(["utf8_bytes", "utf16_code_units", "unicode_code_points"]);

export const TextQuoteSelectorSchema = z.strictObject({
  kind: z.literal("text_quote"),
  quote: z.string().min(1),
  prefix: z.string().min(1).optional(),
  suffix: z.string().min(1).optional(),
  normalization: TextNormalizationSchema,
});

export const CharacterPositionSelectorSchema = z
  .strictObject({
    kind: z.literal("character_position"),
    start: z.int().nonnegative(),
    end: z.int().positive(),
    offsetBasis: TextOffsetBasisSchema,
    normalization: TextNormalizationSchema,
  })
  .refine((value) => value.end > value.start, { path: ["end"], message: "end must be greater than start" });

const OrderedTextFragmentSchema = z.discriminatedUnion("kind", [
  TextQuoteSelectorSchema,
  CharacterPositionSelectorSchema,
]);
export const MultiFragmentTextSelectorSchema = z
  .strictObject({
    kind: z.literal("multi_fragment_text"),
    fragments: z.array(OrderedTextFragmentSchema).min(2),
    joiner: z.literal(" … "),
  })
  .superRefine((selector, context) => {
    const normalizations = new Set(selector.fragments.map((fragment) => fragment.normalization));
    if (normalizations.size !== 1)
      context.addIssue({
        code: "custom",
        path: ["fragments"],
        message: "multi-fragment text selectors require one normalization basis",
      });
    const positionBases = new Set(
      selector.fragments
        .filter((fragment) => fragment.kind === "character_position")
        .map((fragment) => fragment.offsetBasis),
    );
    if (positionBases.size > 1)
      context.addIssue({ code: "custom", path: ["fragments"], message: "position fragments require one offset basis" });
  });

export const JsonPointerSelectorSchema = z.strictObject({
  kind: z.literal("json_pointer"),
  pointer: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/),
});

export const HtmlSelectorSchema = z
  .strictObject({
    kind: z.literal("html"),
    css: NonEmptyStringSchema.optional(),
    xpath: NonEmptyStringSchema.optional(),
    domPath: NonEmptyStringSchema.optional(),
    canonicalTextFallback: TextQuoteSelectorSchema.optional(),
    /** Half-open UTF-16 offsets within the uniquely selected DOM node's text, before normalization. */
    textRange: z
      .strictObject({
        start: z.int().nonnegative(),
        end: z.int().positive(),
      })
      .refine((value) => value.end > value.start, { path: ["end"], message: "end must be greater than start" })
      .optional(),
  })
  .refine((value) => value.css !== undefined || value.xpath !== undefined || value.domPath !== undefined, {
    message: "an HTML selector requires css, xpath, or domPath",
  });

export const PdfTextSelectorSchema = z
  .strictObject({
    kind: z.literal("pdf_text"),
    page: z.int().positive(),
    start: z.int().nonnegative(),
    end: z.int().positive(),
    offsetBasis: TextOffsetBasisSchema,
    textLayerDigest: Sha256DigestSchema,
  })
  .refine((value) => value.end > value.start, { path: ["end"], message: "end must be greater than start" });

export const BoundingBoxSelectorSchema = z
  .strictObject({
    kind: z.literal("bounding_box"),
    page: z.int().positive().optional(),
    coordinateSpace: z.enum(["normalized", "pixels"]),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
    imageWidth: z.int().positive().optional(),
    imageHeight: z.int().positive().optional(),
  })
  .superRefine((value, context) => {
    if (value.coordinateSpace === "normalized" && (value.x + value.width > 1 || value.y + value.height > 1)) {
      context.addIssue({ code: "custom", message: "normalized bounding boxes must fit within [0,1]" });
    }
    if (value.coordinateSpace === "pixels" && (value.imageWidth === undefined || value.imageHeight === undefined)) {
      context.addIssue({ code: "custom", message: "pixel bounding boxes require image dimensions" });
    }
    if (
      value.coordinateSpace === "pixels" &&
      value.imageWidth !== undefined &&
      value.imageHeight !== undefined &&
      (value.x + value.width > value.imageWidth || value.y + value.height > value.imageHeight)
    ) {
      context.addIssue({ code: "custom", message: "pixel bounding boxes must fit within image dimensions" });
    }
  });

export const TableSelectorSchema = z.strictObject({
  kind: z.literal("table"),
  tableId: VerificationIdSchema,
  row: z.int().nonnegative(),
  column: z.int().nonnegative(),
  headerPath: z.array(NonEmptyStringSchema),
  expectedCellValue: z.string().optional(),
});

export const MediaTimecodeSelectorSchema = z
  .strictObject({
    kind: z.literal("media_timecode"),
    startMs: z.int().nonnegative(),
    endMs: z.int().positive(),
    speaker: NonEmptyStringSchema.optional(),
    channel: NonEmptyStringSchema.optional(),
  })
  .refine((value) => value.endMs > value.startMs, { path: ["endMs"], message: "endMs must be greater than startMs" });

export const RepositorySelectorSchema = z
  .strictObject({
    kind: z.literal("repository"),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    path: NonEmptyStringSchema,
    rangeKind: z.enum(["lines", "bytes"]),
    start: z.int().nonnegative(),
    end: z.int().positive(),
  })
  .refine((value) => value.end > value.start, { path: ["end"], message: "end must be greater than start" });

export const DatasetSelectorSchema = z.strictObject({
  kind: z.literal("dataset"),
  datasetVersionId: VerificationIdSchema,
  rowKey: NonEmptyStringSchema,
  column: NonEmptyStringSchema.optional(),
});

export const ApiRecordSelectorSchema = z.strictObject({
  kind: z.literal("api_record"),
  pageKey: NonEmptyStringSchema.optional(),
  recordKey: NonEmptyStringSchema,
  fieldPointer: z
    .string()
    .regex(/^(?:\/(?:[^~/]|~[01])*)*$/)
    .optional(),
});

export const VerificationSelectorSchema = z.discriminatedUnion("kind", [
  TextQuoteSelectorSchema,
  CharacterPositionSelectorSchema,
  MultiFragmentTextSelectorSchema,
  JsonPointerSelectorSchema,
  HtmlSelectorSchema,
  PdfTextSelectorSchema,
  BoundingBoxSelectorSchema,
  TableSelectorSchema,
  MediaTimecodeSelectorSchema,
  RepositorySelectorSchema,
  DatasetSelectorSchema,
  ApiRecordSelectorSchema,
]);
export type VerificationSelector = z.infer<typeof VerificationSelectorSchema>;

export const VerificationSelectorKindSchema = z.enum([
  "text_quote",
  "character_position",
  "multi_fragment_text",
  "json_pointer",
  "html",
  "pdf_text",
  "bounding_box",
  "table",
  "media_timecode",
  "repository",
  "dataset",
  "api_record",
]);

export const ResolvedSelectorSchema = z
  .strictObject({
    captureId: VerificationIdSchema,
    representationArtifactId: UuidSchema,
    representationDigest: Sha256DigestSchema,
    selectorDigest: Sha256DigestSchema,
    selectorKind: VerificationSelectorKindSchema,
    status: z.enum(["resolved", "not_found", "ambiguous", "invalid", "parse_error"]),
    occurrenceCount: z.int().nonnegative(),
    selectedContentDigest: Sha256DigestSchema.optional(),
    selectedValue: JsonValueSchema.optional(),
    resolvedRanges: z.array(
      z.strictObject({
        start: z.number().nonnegative(),
        end: z.number().positive(),
        coordinateSpace: NonEmptyStringSchema,
      }),
    ),
    normalization: TextNormalizationSchema,
    resolverVersion: NonEmptyStringSchema,
  })
  .superRefine((value, context) => {
    if (value.status === "resolved" && value.occurrenceCount !== 1)
      context.addIssue({
        code: "custom",
        path: ["occurrenceCount"],
        message: "resolved selectors require exactly one occurrence",
      });
    if (value.status !== "resolved" && (value.selectedContentDigest !== undefined || value.selectedValue !== undefined))
      context.addIssue({ code: "custom", message: "unresolved selectors cannot declare selected content or value" });
  });
export type ResolvedSelector = z.infer<typeof ResolvedSelectorSchema>;
