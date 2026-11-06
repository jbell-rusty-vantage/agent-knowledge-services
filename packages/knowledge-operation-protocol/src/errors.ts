import { z } from "zod";
import { IdSchema, InstantSchema, JsonDocumentSchema, ProtocolVersionSchema } from "./primitives.js";

/**
 * Every operation returns schema-versioned typed errors; provider text is never a control channel (design §4).
 * `domainOutcome` separates a domain hold/rejection from an infrastructure failure; `retryable` is the infrastructure
 * retry classifier's input, never a semantic verdict.
 */
export const PROTOCOL_ERROR_CODES = [
  "ORIGIN_MISMATCH",
  "SCOPE_DENIED",
  "EFFECT_CONFLICT",
  "SCHEMA_UNSUPPORTED",
  "EXACT_REVISION_UNAVAILABLE",
  "REVIEW_REQUIRED",
  "BUDGET_EXHAUSTED",
  "UNSUPPORTED_MEDIA",
  "STALE_DECISION",
  "UNRESOLVED_EFFECT",
  "INDEPENDENCE_UNPROVEN",
  "INVALID_ENVELOPE",
  "CAPABILITY_UNAVAILABLE",
  "NOT_FOUND",
  "CANCELLED",
  "INTERNAL",
] as const;
export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

const ERROR_CLASSES: Record<ProtocolErrorCode, { retryable: boolean; domainOutcome: boolean }> = {
  ORIGIN_MISMATCH: { retryable: false, domainOutcome: false },
  SCOPE_DENIED: { retryable: false, domainOutcome: false },
  EFFECT_CONFLICT: { retryable: false, domainOutcome: false },
  SCHEMA_UNSUPPORTED: { retryable: false, domainOutcome: false },
  EXACT_REVISION_UNAVAILABLE: { retryable: false, domainOutcome: true },
  REVIEW_REQUIRED: { retryable: false, domainOutcome: true },
  BUDGET_EXHAUSTED: { retryable: false, domainOutcome: true },
  UNSUPPORTED_MEDIA: { retryable: false, domainOutcome: true },
  STALE_DECISION: { retryable: false, domainOutcome: true },
  UNRESOLVED_EFFECT: { retryable: false, domainOutcome: false },
  INDEPENDENCE_UNPROVEN: { retryable: false, domainOutcome: true },
  INVALID_ENVELOPE: { retryable: false, domainOutcome: false },
  CAPABILITY_UNAVAILABLE: { retryable: true, domainOutcome: false },
  NOT_FOUND: { retryable: false, domainOutcome: false },
  CANCELLED: { retryable: false, domainOutcome: false },
  INTERNAL: { retryable: true, domainOutcome: false },
};

export const ProtocolErrorSchema = z
  .strictObject({
    protocolVersion: ProtocolVersionSchema,
    code: ProtocolErrorCodeSchema,
    message: z.string().min(1).max(2000),
    retryable: z.boolean(),
    domainOutcome: z.boolean(),
    /** Correlation only: dispatch id, operation id, effect key. Never tokens, secrets or source bodies. */
    correlation: z.strictObject({
      dispatchId: IdSchema.nullable(),
      operationId: IdSchema.nullable(),
      effectKey: IdSchema.nullable(),
    }),
    details: JsonDocumentSchema.nullable(),
    occurredAt: InstantSchema,
  })
  .superRefine((error, context) => {
    const expected = ERROR_CLASSES[error.code];
    if (error.retryable !== expected.retryable || error.domainOutcome !== expected.domainOutcome) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: `${error.code} is classified retryable=${expected.retryable} domainOutcome=${expected.domainOutcome}`,
      });
    }
  });
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export function protocolError(input: {
  code: ProtocolErrorCode;
  message: string;
  occurredAt: string;
  correlation?: Partial<ProtocolError["correlation"]>;
  details?: ProtocolError["details"];
}): ProtocolError {
  const klass = ERROR_CLASSES[input.code];
  return ProtocolErrorSchema.parse({
    protocolVersion: "ks.knowledge_operation.v2",
    code: input.code,
    message: input.message,
    retryable: klass.retryable,
    domainOutcome: klass.domainOutcome,
    correlation: {
      dispatchId: input.correlation?.dispatchId ?? null,
      operationId: input.correlation?.operationId ?? null,
      effectKey: input.correlation?.effectKey ?? null,
    },
    details: input.details ?? null,
    occurredAt: input.occurredAt,
  });
}

export function errorClass(code: ProtocolErrorCode) {
  return ERROR_CLASSES[code];
}
