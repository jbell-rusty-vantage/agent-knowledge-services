import { z } from "zod";
import { EffectIdentitySchema } from "./effect.js";
import { ProtocolErrorSchema } from "./errors.js";
import { OperationHandleSchema } from "./handle.js";
import { DigestSchema, IdSchema, InstantSchema, JsonDocumentSchema, RefSchema, SafeIntSchema } from "./primitives.js";

/**
 * Outcome vocabulary of an effect; `uncertain` never appears in a receipt, only in the host journal.
 * `pending_dispatch`: admitted and durably enqueued for a `marker_plus_outbox` target store (Biotech graph) that has not
 * acknowledged yet. It is never `applied`: the host keeps the effect unresolved and reconciles by receipt lookup.
 */
export const RECEIPT_OUTCOMES = ["applied", "noop", "partial", "rejected", "pending_dispatch"] as const;
export const ReceiptOutcomeSchema = z.enum(RECEIPT_OUTCOMES);
export type ReceiptOutcome = z.infer<typeof ReceiptOutcomeSchema>;

/**
 * `OperationReceipt`: the binding's durable record of one effect. Receipt lookup by the ORIGINAL scoped effect identity
 * precedes any uncertain repeat; a missing receipt is not evidence that no write occurred.
 */
export const OperationReceiptSchema = z.strictObject({
  handle: OperationHandleSchema,
  effect: EffectIdentitySchema,
  outcome: ReceiptOutcomeSchema,
  /** The binding's native receipt (AI Engineer `orchestration.operation_receipt`, Biotech executor receipt). */
  nativeReceiptRef: RefSchema,
  affectedRefs: z.array(RefSchema),
  /** Native concurrency token before and after; its meaning is the binding's (knowledge head, graph revision). */
  concurrencyToken: z.strictObject({ before: z.string().max(400).nullable(), after: z.string().max(400).nullable() }),
  /** Revocation epoch the admission checked under (design §7). */
  processedRevocationEpoch: SafeIntSchema,
  /** For `rejected`/`partial`: typed reasons per item; never provider prose as control. */
  itemOutcomes: z.array(
    z.strictObject({
      itemId: IdSchema,
      outcome: z.enum(["admitted", "held", "rejected", "superseded", "duplicate"]),
      reason: z.string().max(400).nullable(),
      ref: RefSchema.nullable(),
    }),
  ),
  appliedAt: InstantSchema,
  details: JsonDocumentSchema.nullable(),
  /** Digest of this receipt's canonical bytes without the digest field; computed by the binding. */
  digest: DigestSchema,
});
export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;

/**
 * Delivery state of a `pending_dispatch` effect, composed at read time from the component outbox acknowledgment record
 * (the receipt itself stays immutable). `applied` only after a verified acknowledgment (ack digest = the expected
 * marker digest); `revoked` is terminal not-applied (revoked or refused by the target). The host settles the effect
 * only on `applied` or `revoked`; `pending`, `dispatched` and `failed` (retryable delivery failure) stay unresolved.
 */
export const DELIVERY_STATES = ["pending", "dispatched", "applied", "revoked", "failed"] as const;
export const DeliverySchema = z.strictObject({
  state: z.enum(DELIVERY_STATES),
  dispatchId: IdSchema,
  targetBinding: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
  /** The component's raw outbox state (`pending`, `dispatched`, `acknowledged`, `failed`, `revoked`, `refused`). */
  nativeState: z.string().regex(/^[a-z_]{1,40}$/),
  ackDigest: DigestSchema.nullable(),
  ackedAt: InstantSchema.nullable(),
  graphTxRef: z.string().min(1).max(400).nullable(),
  checkedAt: InstantSchema,
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const ReceiptLookupSchema = z.discriminatedUnion("disposition", [
  z.strictObject({
    disposition: z.literal("found"),
    receipt: OperationReceiptSchema,
    /** Present only for a `pending_dispatch` receipt (marker_plus_outbox bindings). */
    delivery: DeliverySchema.optional(),
  }),
  /** No receipt for this exact identity; the effect may still have been applied if dispatch was uncertain. */
  z.strictObject({ disposition: z.literal("not_found"), checkedAt: InstantSchema }),
  /** Lookup could not be completed; the effect stays unresolved. */
  z.strictObject({ disposition: z.literal("unresolved"), error: ProtocolErrorSchema }),
]);
export type ReceiptLookup = z.infer<typeof ReceiptLookupSchema>;
