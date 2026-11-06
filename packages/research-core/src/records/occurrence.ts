import { DigestSchema, IdSchema, refOf } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { ShortTextSchema, SpanSchema, identityShape } from "./common.js";

export const OCCURRENCE_SCHEMA_VERSION = "research-core.occurrence.v2" as const;

/**
 * `AssertionOccurrence` (design §3). It binds the frozen body artifact, not the report revision: the report revision
 * references the ledger that lists producer occurrences, so naming the revision here would be a digest cycle.
 * `blockPath` names a unit: `section/heading`, `section/block`, `section/block/iN` (list item),
 * `section/block/h/cN` (header cell), `section/block/rN/cM` (table cell), `section/block/caption`.
 */
export const AssertionOccurrenceSchema = z.strictObject({
  ...identityShape(OCCURRENCE_SCHEMA_VERSION),
  assertion: refOf("assertion"),
  body: refOf("artifact"),
  span: SpanSchema,
  blockPath: IdSchema,
  quoteDigest: DigestSchema,
  obligations: z.array(IdSchema),
  attribution: ShortTextSchema.nullable(),
  discoveredBy: z.enum(["producer_ledger", "auditor_discovery"]),
});
export type AssertionOccurrence = z.infer<typeof AssertionOccurrenceSchema>;

export const DISCOVERED_OCCURRENCE_SCHEMA_VERSION = "research-core.discovered_occurrence.v1" as const;
export const AUDITOR_INVENTORY_SCHEMA_VERSION = "research-core.auditor_inventory.v1" as const;

/**
 * One occurrence the independent auditor discovered in the exact frozen body bytes (design §3.2). Unlike a producer
 * ledger entry it may name no assertion: `candidateAssertion` is the auditor's own reading, and `assertion` is set only
 * when the auditor mapped the span to one of the comparison assertions. `negated`/`interrogative` are the auditor's
 * polarity/modality reading of the quoted text; the census compares them with the mapped assertion's qualifiers.
 */
export const DiscoveredOccurrenceSchema = z.strictObject({
  schemaVersion: z.literal(DISCOVERED_OCCURRENCE_SCHEMA_VERSION),
  id: IdSchema,
  body: refOf("artifact"),
  span: SpanSchema,
  blockPath: IdSchema,
  quoteDigest: DigestSchema,
  candidateAssertion: z.string().min(1).max(4000),
  assertion: refOf("assertion").nullable(),
  negated: z.boolean(),
  interrogative: z.boolean(),
});
export type DiscoveredOccurrence = z.infer<typeof DiscoveredOccurrenceSchema>;

/** An authoritative (auditor-supplied) explanation that clears one named census difference. */
export const CensusExplanationSchema = z.strictObject({ occurrenceId: IdSchema, reason: ShortTextSchema });
export const UnitExplanationSchema = z.strictObject({ path: IdSchema, reason: ShortTextSchema });

/**
 * The auditor's complete discovered inventory, frozen into custody as canonical JSON. The census observation binds its
 * digest; the inventory never names the producer ledger it will be compared with (independence of the discovery pass).
 */
export const AuditorInventorySchema = z
  .strictObject({
    ...identityShape(AUDITOR_INVENTORY_SCHEMA_VERSION),
    body: refOf("artifact"),
    occurrences: z.array(DiscoveredOccurrenceSchema),
    explanations: z.array(CensusExplanationSchema),
    unitExplanations: z.array(UnitExplanationSchema),
  })
  .superRefine((inventory, context) => {
    if (inventory.occurrences.some((occurrence) => occurrence.body.digest !== inventory.body.digest)) {
      context.addIssue({
        code: "custom",
        path: ["occurrences"],
        message: "every discovered occurrence binds the body",
      });
    }
    const ids = inventory.occurrences.map((occurrence) => occurrence.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["occurrences"], message: "duplicate discovered occurrence id" });
    }
  });
export type AuditorInventory = z.infer<typeof AuditorInventorySchema>;
