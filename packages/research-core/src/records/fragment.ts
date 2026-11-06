import {
  DigestSchema,
  IdSchema,
  SafeIntSchema,
  SchemaVersionSchema,
  refOf,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { LongTextSchema, ShortTextSchema, identityShape } from "./common.js";

export const FRAGMENT_SCHEMA_VERSION = "research-core.fragment.v2" as const;

export const SELECTOR_KINDS = [
  "text_quote",
  "text_position",
  "table_cell",
  "page_region",
  "xpath",
  "repository_file",
] as const;

/**
 * `EvidenceFragment` (design §3, VERIFICATION.md §3): immutable capture and representation references (their digests
 * travel in the refs), exact selector and resolver version, context, parser lineage, completeness and rights.
 * `originFamily` groups reports of one underlying study; `null` stays unknown and is never guessed.
 */
export const EvidenceFragmentSchema = z.strictObject({
  ...identityShape(FRAGMENT_SCHEMA_VERSION),
  sourceVersion: IdSchema,
  capture: refOf("artifact"),
  representation: refOf("artifact"),
  selector: z.strictObject({
    kind: z.enum(SELECTOR_KINDS),
    value: LongTextSchema,
    resolverVersion: SchemaVersionSchema,
    normalizationVersion: SchemaVersionSchema,
  }),
  selectedDigest: DigestSchema,
  selectedSize: SafeIntSchema,
  context: z.strictObject({
    header: ShortTextSchema.nullable(),
    footnotes: z.array(ShortTextSchema),
    surroundingDigest: DigestSchema.nullable(),
  }),
  parserLineage: z.array(SchemaVersionSchema).min(1),
  captureCompleteness: z.enum(["complete", "partial", "truncated", "unknown"]),
  access: z.strictObject({
    rights: z.enum(["public", "licensed", "restricted", "private"]),
    limits: z.array(ShortTextSchema),
  }),
  originFamily: IdSchema.nullable(),
});
export type EvidenceFragment = z.infer<typeof EvidenceFragmentSchema>;
