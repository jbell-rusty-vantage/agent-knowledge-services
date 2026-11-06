import { z } from "zod";
import { DigestSchema, SafeIntSchema } from "./primitives.js";

/**
 * `knowledge.plan_preview` (Sprint OC): the read-only plan-level preview of a `knowledge.apply`. The request is the
 * same `operation-envelope.v2` the caller sends for `knowledge.apply` (same binding, tenant, native contract and inline
 * intent, `exactUse.effectKey` and `exactUse.originatingOrigin`), with `operation: "knowledge.plan_preview"`; the
 * use-decision fields (`exactUse.useDecisionId`, `exactUse.boundEffectDigest`, `exactUse.processedEpoch`,
 * `effect.boundEffectDigest`) may be absent and do not determine the previewed plan. The normalized-values digest
 * is echoed when supplied, otherwise the digest of `{}` is returned. The credential is a non-effect credential
 * granting `knowledge.plan_preview` (`effect: null`); each request consumes a fresh credential/dispatch nonce.
 *
 * The answer is synchronous: each value is exactly what `knowledge.apply`'s own planning produces for the same request
 * in the same database state. No native effect, effect binding, dispatch journal entry or use admission is written.
 */
export const KnowledgePlanPreviewSchema = z.strictObject({
  /** The native plan id `knowledge.apply` plans under (independent of the decision fields). */
  planId: z.string().min(1).max(200),
  /** Digest of the native effect bytes the native transaction binds (`knowledge-ingestion-effect.v1`). */
  semanticPayloadDigest: DigestSchema,
  /** The plan-level K01 bound effect digest the use decision must bind (and `effect`/`exactUse` must carry). */
  boundEffectDigest: DigestSchema,
  /** The normalized-values digest the native write presents, which the decision must carry. */
  normalizedValuesDigest: DigestSchema,
  /** The authoritative revocation epoch now: `exactUse.processedEpoch` must be at least this for admission. */
  processedEpoch: SafeIntSchema,
  /** The schema workspace migration head the executor plans against (`intent.contract.migrationHead`). */
  migrationHead: z.string().min(1).max(200),
});
export type KnowledgePlanPreview = z.infer<typeof KnowledgePlanPreviewSchema>;
