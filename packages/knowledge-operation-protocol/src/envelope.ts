import { z } from "zod";
import { CANONICALIZATION, digestCanonical } from "./canonical.js";
import type { Digest, JsonValue } from "./canonical.js";
import { EffectBindingSchema } from "./effect.js";
import { OperationHandleSchema } from "./handle.js";
import {
  DigestSchema,
  IdSchema,
  InstantSchema,
  JsonDocumentSchema,
  NameSchema,
  PositiveIntSchema,
  ProtocolVersionSchema,
  RefSchema,
  SafeIntSchema,
  SchemaVersionSchema,
  ScopeIdSchema,
  UsdSchema,
} from "./primitives.js";

/**
 * The operations of `ks.knowledge_operation.v2` (design §4 and §8). `report.publish` is binding-internal and selected by
 * the tool adapter; it is deliberately not a protocol operation.
 */
export const OPERATIONS = [
  "knowledge.describe",
  "knowledge.read",
  "knowledge.apply",
  "knowledge.plan_preview",
  "knowledge.read_intent",
  "report.register",
  "report.assess",
  "report.derive",
  "verify.claims",
  "report.observe",
  "report.seal",
  "report.decide",
  "report.review",
  "decision.resolve",
  "operation.get",
  "operation.cancel",
  "receipt.get",
] as const;
export const OperationNameSchema = z.enum(OPERATIONS);
export type OperationName = z.infer<typeof OperationNameSchema>;

/** Operations that produce a domain effect and therefore require an effect binding and an effectful credential. */
export const EFFECTFUL_OPERATIONS: ReadonlySet<OperationName> = new Set(["knowledge.apply", "report.register"]);
/**
 * Operations whose `invoke` answers an `operation-receipt.v2` in the same call (integrator decision 2026-10-25): the
 * effectful operations, whose native write (or durable admission + outbox enqueue) is synchronous. For
 * `knowledge.apply` the envelope's `effect.boundEffectDigest` is the plan-level canonical digest of the native proposal
 * bytes including the originating origin (what the use decision binds and EFFECT_CONFLICT compares); the
 * `semanticPayloadDigest` over the intent bytes is diagnostic only.
 */
export const RECEIPT_OPERATIONS: ReadonlySet<OperationName> = new Set(["knowledge.apply", "report.register"]);
/**
 * Read-only operations that describe an effect without producing it (Sprint OC `knowledge.plan_preview`): the envelope
 * may carry the effectful operation's effect binding (its `boundEffectDigest` is ignored) and declared use/audience, so
 * the caller sends the same envelope it will send for `knowledge.apply`. They take a non-effect credential.
 */
export const EFFECT_DESCRIBING_OPERATIONS: ReadonlySet<OperationName> = new Set(["knowledge.plan_preview"]);
/**
 * Operations whose `invoke` answers their result document in the same call (no handle, no receipt):
 * `knowledge.plan_preview` (`knowledge-plan-preview.v1`) and `knowledge.read_intent` (`knowledge-read-intent-result.v1`,
 * recorded as an operation row; not an evaluator operation).
 */
export const RESULT_OPERATIONS: ReadonlySet<OperationName> = new Set([
  "knowledge.plan_preview",
  "knowledge.read_intent",
]);
/** Operations that return a handle (asynchronous) rather than a terminal receipt in the same call. */
export const HANDLE_OPERATIONS: ReadonlySet<OperationName> = new Set([
  "knowledge.read",
  "report.assess",
  "report.derive",
  "verify.claims",
  "report.observe",
  "report.seal",
  "report.decide",
  "report.review",
  "decision.resolve",
]);
/**
 * The trusted assessment operations (Sprint OC WI-03): an evaluator credential (`evaluation` claim) may be granted only
 * these plus status/read lookups; `report.observe` needs an observer role and `report.review` a `human_reviewer`.
 */
export const EVALUATOR_OPERATIONS: ReadonlySet<OperationName> = new Set([
  "report.observe",
  "report.review",
  "decision.resolve",
  "knowledge.read",
  "operation.get",
]);

/** A required capability: an operation name, `report_kind:<kind>`, `media:<type>` or `<guarantee>:<value>`. */
export const CapabilityNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}(:[a-zA-Z0-9_./+-]{1,80})?$/);

export const GovernorsSchema = z.strictObject({
  deadline: InstantSchema,
  maxItems: PositiveIntSchema,
  partialResults: z.enum(["forbid", "allow"]),
  budget: z.strictObject({ calls: SafeIntSchema, tokens: SafeIntSchema, costUsd: UsdSchema }),
});

export const NativeInputSchema = z.strictObject({
  /** Native contract name and version (`knowledge-ingestion-intent.v1`, `biotech-knowledge-intent.v2`, `research-report.v2`). */
  nativeContract: z.strictObject({ name: NameSchema, version: z.string().regex(/^v[0-9]+$/) }),
  /** sha256 of the exact native payload bytes; the payload itself travels out of band (artifact ref) or inline. */
  payloadDigest: DigestSchema,
  payloadBytes: SafeIntSchema,
  payloadRef: RefSchema.nullable(),
  /** Inline payload for small requests (reads, polling); bytes must digest to payloadDigest. */
  inlinePayload: JsonDocumentSchema.nullable(),
  /** Upstream handles this request depends on (reports, assertions, captures); exact, never bare ids. */
  upstream: z.array(RefSchema),
});

/**
 * `OperationEnvelope`: one authorized transmission. The envelope never contains credential bytes; the host binds
 * origin/scope from the credential and verifies these fields against it. Unknown fields are refused (strict).
 */
export const OperationEnvelopeSchema = z
  .strictObject({
    protocolVersion: ProtocolVersionSchema,
    requestId: IdSchema,
    dispatchId: IdSchema,
    tenant: ScopeIdSchema,
    application: NameSchema,
    binding: NameSchema,
    operation: OperationNameSchema,
    /** Required for effectful operations; null otherwise. */
    effect: EffectBindingSchema.nullable(),
    /** For operation.get/operation.cancel/receipt.get: the handle or effect being addressed. */
    target: z.strictObject({ handle: OperationHandleSchema.nullable(), effectKey: IdSchema.nullable() }),
    /** For operation.cancel: idempotency key of the cancel request. */
    cancelRequestId: IdSchema.nullable(),
    input: NativeInputSchema.nullable(),
    governors: GovernorsSchema,
    /** Capabilities the caller requires (operation names, `report_kind:<kind>`, `media:<type>`, `<guarantee>:<value>`). */
    requiredCapabilities: z.array(CapabilityNameSchema),
    pinnedSchema: z.strictObject({ name: NameSchema, version: SchemaVersionSchema, digest: DigestSchema }).nullable(),
    issuedAt: InstantSchema,
    /**
     * Effectful operations only: the declared use and audience of the effect (K08 use class), so the use is explicit and
     * never a silent default. Both or neither; a binding with a use-class policy refuses an effect that declares none.
     */
    use: NameSchema.optional(),
    audience: NameSchema.optional(),
  })
  .superRefine((envelope, context) => {
    const effectful = EFFECTFUL_OPERATIONS.has(envelope.operation);
    const describing = EFFECT_DESCRIBING_OPERATIONS.has(envelope.operation);
    if (effectful && envelope.effect === null) {
      context.addIssue({
        code: "custom",
        path: ["effect"],
        message: `${envelope.operation} requires an effect binding`,
      });
    }
    if (!effectful && !describing && envelope.effect !== null) {
      context.addIssue({
        code: "custom",
        path: ["effect"],
        message: `${envelope.operation} carries no effect binding`,
      });
    }
    if ((envelope.use === undefined) !== (envelope.audience === undefined)) {
      context.addIssue({ code: "custom", path: ["audience"], message: "use and audience are declared together" });
    }
    if (!effectful && !describing && (envelope.use !== undefined || envelope.audience !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["use"],
        message: `${envelope.operation} carries no declared use (effectful operations only)`,
      });
    }
    if (envelope.effect !== null) {
      if (envelope.effect.originatingOrigin.tenantId !== envelope.tenant) {
        context.addIssue({ code: "custom", path: ["effect"], message: "effect tenant differs from envelope tenant" });
      }
      if (envelope.input === null) {
        context.addIssue({ code: "custom", path: ["input"], message: "an effect needs its native input" });
      } else if (envelope.input.payloadDigest !== envelope.effect.semanticPayloadDigest) {
        context.addIssue({ code: "custom", path: ["input", "payloadDigest"], message: "payload digest differs" });
      }
    }
    const addressing = envelope.operation === "operation.get" || envelope.operation === "operation.cancel";
    if (addressing && envelope.target.handle === null) {
      context.addIssue({ code: "custom", path: ["target", "handle"], message: `${envelope.operation} needs a handle` });
    }
    if (envelope.operation === "receipt.get" && envelope.target.effectKey === null) {
      context.addIssue({ code: "custom", path: ["target", "effectKey"], message: "receipt.get needs the effect key" });
    }
    if (envelope.operation === "operation.cancel" && envelope.cancelRequestId === null) {
      context.addIssue({ code: "custom", path: ["cancelRequestId"], message: "cancel is idempotent by request id" });
    }
    if (envelope.operation !== "operation.cancel" && envelope.cancelRequestId !== null) {
      context.addIssue({
        code: "custom",
        path: ["cancelRequestId"],
        message: "only cancel carries a cancel request id",
      });
    }
    if (envelope.input?.inlinePayload !== null && envelope.input?.inlinePayload !== undefined) {
      if (digestCanonical(envelope.input.inlinePayload as JsonValue) !== envelope.input.payloadDigest) {
        context.addIssue({
          code: "custom",
          path: ["input", "inlinePayload"],
          message: "inline payload canonical digest differs from payloadDigest",
        });
      }
    }
  });
export type OperationEnvelope = z.infer<typeof OperationEnvelopeSchema>;

/** The envelope digest identifies this transmission; it is computed over the validated envelope, credential excluded. */
export function envelopeDigest(envelope: OperationEnvelope): Digest {
  return digestCanonical({ canonicalization: CANONICALIZATION, envelope: envelope as unknown as JsonValue });
}

export function parseEnvelope(value: unknown): OperationEnvelope {
  return OperationEnvelopeSchema.parse(value);
}
