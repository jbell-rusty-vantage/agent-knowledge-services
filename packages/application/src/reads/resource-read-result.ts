import type { ZodType } from "zod";

/**
 * Why a bounded read did not return a resource. Both in-process transports map the
 * same reason to the same problem code: the API adds its route titles, MCP returns
 * the code. A missing capability is `unavailable`, never a fallback to another transport.
 */
export type ResourceReadFailureReason =
  | "unavailable"
  | "not_found"
  | "pending"
  | "terminal"
  | "integrity"
  | "inconsistent"
  | "too_large";

export interface ResourceReadFailure {
  readonly reason: ResourceReadFailureReason;
  readonly status: 404 | 409 | 413 | 422 | 503;
  readonly code:
    | "NOT_FOUND"
    | "CONFLICT"
    | "INVALID_STATE_TRANSITION"
    | "LIMIT_EXCEEDED"
    | "INTERNAL_ERROR"
    | "CAPABILITY_NOT_ADMITTED";
  /** Lower-case terminal state (`failed`, `cancelled`) for `terminal` failures. */
  readonly state?: string;
}

export type ResourceReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ResourceReadFailure };

const FAILURES: Readonly<Record<ResourceReadFailureReason, Omit<ResourceReadFailure, "reason" | "state">>> = {
  unavailable: { status: 503, code: "CAPABILITY_NOT_ADMITTED" },
  not_found: { status: 404, code: "NOT_FOUND" },
  pending: { status: 409, code: "CONFLICT" },
  terminal: { status: 422, code: "INVALID_STATE_TRANSITION" },
  integrity: { status: 503, code: "INTERNAL_ERROR" },
  inconsistent: { status: 409, code: "CONFLICT" },
  too_large: { status: 413, code: "LIMIT_EXCEEDED" },
};

export function resourceReadFailure<T>(reason: ResourceReadFailureReason, state?: string): ResourceReadResult<T> {
  return { ok: false, failure: { reason, ...FAILURES[reason], ...(state === undefined ? {} : { state }) } };
}

export const DEFAULT_MAXIMUM_RESOURCE_RESPONSE_BYTES = 1_048_576;

/** Applies the serialized response bound every transport shares. */
export function boundedResourceResult<T>(
  value: T,
  maximumBytes = DEFAULT_MAXIMUM_RESOURCE_RESPONSE_BYTES,
): ResourceReadResult<T> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("INVALID_RESOURCE_RESPONSE_LIMIT");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumBytes) return resourceReadFailure("too_large");
  return { ok: true, value };
}

/** Stored canonical resources fail closed when they no longer satisfy their public schema. */
export function validatedStoredResource<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("RESOURCE_INTEGRITY_CONFLICT", { cause: result.error });
  return result.data;
}

/**
 * Classifies a failed read. `missing` services only distinguish absence; `terminal`
 * services also report non-terminal (`PENDING`) and unsuccessful terminal states.
 * Every other failure, including scope mismatches, is an integrity failure.
 */
export function classifyResourceReadError<T>(error: unknown, mode: "missing" | "terminal"): ResourceReadResult<T> {
  const code = error instanceof Error && "code" in error ? String(error.code) : "INTEGRITY";
  if (code === "NOT_FOUND") return resourceReadFailure("not_found");
  if (mode === "terminal" && code === "PENDING") return resourceReadFailure("pending");
  if (mode === "terminal" && (code === "FAILED" || code === "CANCELLED"))
    return resourceReadFailure("terminal", code.toLowerCase());
  return resourceReadFailure("integrity");
}
