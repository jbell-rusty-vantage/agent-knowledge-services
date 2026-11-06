import { OperationCapabilityUnavailableError, retrievalExecutionProblem } from "@aiengineer/knowledge-host";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { problem } from "../http/problem-map.js";
import { correlationId } from "./correlation.js";

export interface UnexpectedErrorRecord {
  readonly correlationId: string;
  readonly error: { readonly name: string };
}

const defaultUnexpectedErrorLogger = (record: UnexpectedErrorRecord): void => {
  console.error(JSON.stringify({ event: "api_unexpected_error", ...record }));
};

export function registerProblemHandler(
  server: FastifyInstance,
  logUnexpectedError: (record: UnexpectedErrorRecord) => void = defaultUnexpectedErrorLogger,
): void {
  server.setErrorHandler((error, request, reply) => {
    const correlation = correlationId(request);
    if (error instanceof OperationCapabilityUnavailableError)
      return reply
        .status(503)
        .type("application/problem+json")
        .send(problem(503, "CAPABILITY_NOT_ADMITTED", "Operation capability unavailable", correlation));
    if (error instanceof ZodError)
      return reply
        .status(400)
        .type("application/problem+json")
        .send(
          problem(
            400,
            "INVALID_CONTRACT",
            "Request contract validation failed",
            correlation,
            "The request does not match the v1 contract.",
            error.issues.slice(0, 25).map((issue) => ({
              path: issue.path.join(".") || "$",
              message: issue.message,
            })),
          ),
        );
    const message = error instanceof Error ? error.message : "Internal error";
    if (message === "IDEMPOTENCY_CONFLICT")
      return reply
        .status(409)
        .type("application/problem+json")
        .send(problem(409, "IDEMPOTENCY_CONFLICT", "Idempotency conflict", correlation));
    if (message === "INVALID_STATE_TRANSITION")
      return reply
        .status(409)
        .type("application/problem+json")
        .send(problem(409, "INVALID_STATE_TRANSITION", "Invalid state transition", correlation));
    if (message === "RESOURCE_INTEGRITY_CONFLICT")
      return reply
        .status(409)
        .type("application/problem+json")
        .send(problem(409, "CONFLICT", "Stored resource failed its integrity checks", correlation));
    if (message === "RESOURCE_RESPONSE_LIMIT_EXCEEDED")
      return reply
        .status(413)
        .type("application/problem+json")
        .send(problem(413, "LIMIT_EXCEEDED", "Stored resource exceeds the bounded response contract", correlation));
    const retrieval = retrievalExecutionProblem(error);
    if (retrieval?.status === 422) return reply.status(422).type("application/json").send(retrieval.response);
    if (retrieval)
      return reply
        .status(retrieval.status)
        .type("application/problem+json")
        .send(
          problem(
            retrieval.status,
            retrieval.code,
            retrieval.status === 409
              ? "Retrieval request is not executable under the active policy"
              : "Retrieval embedding provider unavailable",
            correlation,
          ),
        );
    try {
      logUnexpectedError({
        correlationId: correlation,
        error: { name: error instanceof Error ? error.name : typeof error },
      });
    } catch {
      // Logging must not replace the stable INTERNAL_ERROR response.
    }
    return reply
      .status(500)
      .type("application/problem+json")
      .send(problem(500, "INTERNAL_ERROR", "Internal service error", correlation));
  });
}
