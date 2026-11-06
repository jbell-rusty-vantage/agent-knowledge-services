import { type Digest, type Ref, digestBytes } from "@aiengineer/knowledge-operation-protocol";
import {
  type AssertionOccurrence,
  AssertionOccurrenceSchema,
  OCCURRENCE_SCHEMA_VERSION,
} from "../records/occurrence.js";
import { LEDGER_SCHEMA_VERSION, RENDERER_VERSION, type ReportLedger, ReportLedgerSchema } from "../records/report.js";
import { type FrozenReport, quoteDigest, utf8 } from "./render.js";

export type BodyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "BODY_DIGEST_MISMATCH"; readonly actual: Digest };

/** Re-digest exact UTF-8 bytes; any post-verification edit changes the digest and voids every binding to it. */
export function verifyFrozenBody(text: string, expected: Digest): BodyCheck {
  const actual = digestBytes(utf8(text));
  return actual === expected ? { ok: true } : { ok: false, code: "BODY_DIGEST_MISMATCH", actual };
}

export type OccurrenceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "BODY_DIGEST_MISMATCH" | "SPAN_OUT_OF_RANGE" | "QUOTE_DIGEST_MISMATCH" };

/** An occurrence is valid for a frozen body only when it binds that body and its span still yields the quoted bytes. */
export function verifyOccurrence(
  frozen: Pick<FrozenReport, "text" | "bodyDigest">,
  occurrence: AssertionOccurrence,
): OccurrenceCheck {
  if (occurrence.body.digest !== frozen.bodyDigest) return { ok: false, code: "BODY_DIGEST_MISMATCH" };
  if (occurrence.span.end > frozen.text.length) return { ok: false, code: "SPAN_OUT_OF_RANGE" };
  if (quoteDigest(frozen.text, occurrence.span) !== occurrence.quoteDigest) {
    return { ok: false, code: "QUOTE_DIGEST_MISMATCH" };
  }
  return { ok: true };
}

/** Build the producer ledger from the renderer's claim spans. The body ref must name the frozen bytes exactly. */
export function buildLedger(input: {
  readonly frozen: FrozenReport;
  readonly body: Ref<"artifact">;
  readonly id: string;
  readonly tenant: string;
  readonly binding: string;
}): ReportLedger {
  if (input.body.digest !== input.frozen.bodyDigest) {
    throw new Error("BODY_DIGEST_MISMATCH: the body ref does not name the frozen bytes");
  }
  const entries: AssertionOccurrence[] = input.frozen.claims.map((claim) =>
    AssertionOccurrenceSchema.parse({
      schemaVersion: OCCURRENCE_SCHEMA_VERSION,
      id: claim.occurrenceId,
      tenant: input.tenant,
      binding: input.binding,
      assertion: claim.assertion,
      body: input.body,
      span: claim.span,
      blockPath: claim.blockPath,
      quoteDigest: claim.quoteDigest,
      obligations: claim.obligations,
      attribution: claim.attribution,
      discoveredBy: "producer_ledger",
    }),
  );
  return ReportLedgerSchema.parse({
    schemaVersion: LEDGER_SCHEMA_VERSION,
    id: input.id,
    tenant: input.tenant,
    binding: input.binding,
    body: input.body,
    renderer: RENDERER_VERSION,
    entries,
  });
}
