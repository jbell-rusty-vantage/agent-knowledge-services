import { OperationCapabilityUnavailableError } from "../operations/surface.js";
import { retrievalExecutionProblem } from "../knowledge/retrieval/canonical-retrieval-run.js";

export interface TransportProblem {
  readonly status: 400 | 409 | 413 | 422 | 500 | 503;
  readonly code: string;
  /** Typed body for problems that carry one (unsupported retrieval capabilities). */
  readonly response?: unknown;
}

/**
 * The problem code the API's error handler assigns to an application failure. MCP maps
 * uncaught use-case failures with it so no transport returns raw internal messages;
 * the API keeps its own titles. Unknown failures are sanitized to INTERNAL_ERROR.
 */
export function transportProblem(error: unknown): TransportProblem {
  if (error instanceof OperationCapabilityUnavailableError) return { status: 503, code: "CAPABILITY_NOT_ADMITTED" };
  if (error instanceof Error && error.name === "ZodError") return { status: 400, code: "INVALID_CONTRACT" };
  const message = error instanceof Error ? error.message : "";
  if (message === "IDEMPOTENCY_CONFLICT") return { status: 409, code: "IDEMPOTENCY_CONFLICT" };
  if (message === "INVALID_STATE_TRANSITION") return { status: 409, code: "INVALID_STATE_TRANSITION" };
  if (message === "RESOURCE_INTEGRITY_CONFLICT") return { status: 409, code: "CONFLICT" };
  if (message === "RESOURCE_RESPONSE_LIMIT_EXCEEDED") return { status: 413, code: "LIMIT_EXCEEDED" };
  const retrieval = retrievalExecutionProblem(error);
  if (retrieval) return retrieval;
  return { status: 500, code: "INTERNAL_ERROR" };
}
