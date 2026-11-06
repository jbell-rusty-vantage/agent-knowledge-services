import {
  type JsonDocument,
  type ProtocolError,
  type ProtocolErrorCode,
  protocolError,
} from "@aiengineer/knowledge-operation-protocol";
import {
  OperationStoreError,
  ReportAssessmentError,
  ResearchCoordinatorError,
  SealKeyRegistryError,
} from "@aiengineer/knowledge-application";
import { ZodError } from "zod";
import { AuthorizationRefusal, CredentialRefusal } from "./auth.js";
import { BackendCapabilityMissing } from "./registry.js";

/**
 * Every answer outside 2xx is a K01 `protocol-error.v2` whose HTTP status is mirrored from its code; the transport
 * status never replaces the domain outcome (a hold/rejection keeps `domainOutcome: true`). The table matches the one
 * Mission Control's parity fake serves (`tests/fixtures/knowledge_binding.py` `HTTP_STATUS`).
 */
export const HTTP_STATUS: Readonly<Record<ProtocolErrorCode, number>> = {
  ORIGIN_MISMATCH: 403,
  SCOPE_DENIED: 401,
  EFFECT_CONFLICT: 409,
  SCHEMA_UNSUPPORTED: 422,
  EXACT_REVISION_UNAVAILABLE: 409,
  REVIEW_REQUIRED: 409,
  BUDGET_EXHAUSTED: 429,
  UNSUPPORTED_MEDIA: 415,
  STALE_DECISION: 409,
  UNRESOLVED_EFFECT: 409,
  INDEPENDENCE_UNPROVEN: 409,
  INVALID_ENVELOPE: 400,
  CAPABILITY_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  CANCELLED: 409,
  INTERNAL: 500,
};

export interface Correlation {
  readonly dispatchId?: string | null;
  readonly operationId?: string | null;
  readonly effectKey?: string | null;
}

/** A typed K01 refusal raised inside the service; transports render `error` as the response body. */
export class ProtocolRefusal extends Error {
  override readonly name = "ProtocolRefusal";
  constructor(readonly error: ProtocolError) {
    super(`${error.code}: ${error.message}`);
  }
}

export function nowInstant(date = new Date()): string {
  return date.toISOString().replace(/\.(\d*?)0+Z$/, (_m, digits: string) => (digits ? `.${digits}Z` : "Z"));
}

export function refusal(
  code: ProtocolErrorCode,
  message: string,
  correlation: Correlation = {},
  details: JsonDocument | null = null,
  at = nowInstant(),
): ProtocolRefusal {
  return new ProtocolRefusal(
    protocolError({ code, message: message.slice(0, 2000) || code, occurredAt: at, correlation, details }),
  );
}

const STORE_CODES: Record<OperationStoreError["code"], ProtocolErrorCode> = {
  OPERATION_NOT_FOUND: "NOT_FOUND",
  REVISION_MISMATCH: "INTERNAL",
  ILLEGAL_TRANSITION: "INTERNAL",
  REQUEST_CONFLICT: "EFFECT_CONFLICT",
};

const COORDINATOR_CODES: Partial<Record<ResearchCoordinatorError["code"], ProtocolErrorCode>> = {
  SCHEMA_UNSUPPORTED: "SCHEMA_UNSUPPORTED",
  BODY_DIGEST_MISMATCH: "EXACT_REVISION_UNAVAILABLE",
  REPORT_MISMATCH: "EXACT_REVISION_UNAVAILABLE",
  STALE_DECISION: "STALE_DECISION",
  RUN_ALREADY_SEALED: "EFFECT_CONFLICT",
  REPORT_ALREADY_REGISTERED: "EFFECT_CONFLICT",
  TASK_MISMATCH: "SCHEMA_UNSUPPORTED",
  SUPPORT_REFUSED: "SCHEMA_UNSUPPORTED",
};

/** Map anything thrown below the transport to a typed K01 error; unknown failures are `INTERNAL` (no stack, no body). */
export function toProtocolError(error: unknown, correlation: Correlation = {}): ProtocolError {
  if (error instanceof ProtocolRefusal) return error.error;
  if (error instanceof CredentialRefusal) {
    return refusal("SCOPE_DENIED", "credential refused", correlation, { reason: error.reason }).error;
  }
  if (error instanceof AuthorizationRefusal) return refusal(error.code, error.message, correlation).error;
  if (error instanceof BackendCapabilityMissing) {
    return refusal("SCHEMA_UNSUPPORTED", `${error.binding} does not serve ${error.capability}`, correlation).error;
  }
  if (error instanceof ZodError) {
    const issues = error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`);
    return refusal("INVALID_ENVELOPE", "request outside the K01 schema", correlation, { issues }).error;
  }
  if (error instanceof SealKeyRegistryError) {
    // W1 D25: a provisioning gap (the key ceremony has not pinned the executor's seal key), typed with the key id.
    // The code class is retryable, but callers must not auto-retry: retry only after `knowledge-db seal-key`.
    return refusal("CAPABILITY_UNAVAILABLE", error.message, correlation, {
      reason: error.code === "SEAL_KEY_UNREGISTERED" ? "seal_key_unregistered" : "seal_key_inactive",
      keyId: error.keyId,
    }).error;
  }
  if (error instanceof ResearchCoordinatorError) {
    const code = COORDINATOR_CODES[error.code] ?? "INTERNAL";
    return refusal(code, error.message, correlation, { violations: [...error.violations].slice(0, 50) }).error;
  }
  if (error instanceof ReportAssessmentError) {
    const code: ProtocolErrorCode =
      error.code === "REPORT_MISMATCH"
        ? "EXACT_REVISION_UNAVAILABLE"
        : error.code === "SCOPE_DENIED"
          ? "SCOPE_DENIED"
          : error.code === "NOT_FOUND"
            ? "NOT_FOUND"
            : "EFFECT_CONFLICT";
    return refusal(code, error.message, correlation).error;
  }
  if (error instanceof OperationStoreError) return refusal(STORE_CODES[error.code], error.message, correlation).error;
  if (error instanceof SyntaxError) return refusal("INVALID_ENVELOPE", "body is not JSON", correlation).error;
  // Operator log only (error class + truncated message; never request bodies, tokens or DSNs); the caller sees INTERNAL.
  console.error(
    JSON.stringify({
      event: "knowledge_operation_internal_error",
      error: error instanceof Error ? error.name : typeof error,
      message: (error instanceof Error ? error.message : String(error))
        .replace(/postgres(?:ql)?:\/\/\S+/gi, "<dsn>")
        .slice(0, 300),
      correlation,
    }),
  );
  return refusal("INTERNAL", "internal failure", correlation).error;
}
