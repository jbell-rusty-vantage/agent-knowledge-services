import type { FastifyReply, FastifyRequest } from "fastify";
import type { ResourceReadResult } from "@aiengineer/knowledge-host";
import { correlationId } from "../plugins/correlation.js";
import { problem } from "./problem-map.js";
/** Maps a shared knowledge read onto this route family's historical replies. */
export const sendKnowledgeRead = <T>(
  request: FastifyRequest,
  reply: FastifyReply,
  result: ResourceReadResult<T>,
  notFound: string,
  inconsistent?: string,
) => {
  if (result.ok) return result.value;
  const { reason } = result.failure;
  if (reason === "too_large")
    return reply
      .status(413)
      .type("application/problem+json")
      .send(
        problem(413, "LIMIT_EXCEEDED", "Stored resource exceeds the bounded response contract", correlationId(request)),
      );
  if (reason === "inconsistent" && inconsistent)
    return reply.status(409).send(problem(409, "CONFLICT", inconsistent, correlationId(request)));
  if (reason === "unavailable")
    return reply
      .status(503)
      .type("application/problem+json")
      .send(problem(503, "INTERNAL_ERROR", "Canonical resource store unavailable", correlationId(request)));
  return reply.status(404).send(problem(404, "NOT_FOUND", notFound, correlationId(request)));
};
/** Maps a shared verification read onto the route's historical problem titles. */
export const sendVerificationRead = (
  request: FastifyRequest,
  reply: FastifyReply,
  result: ResourceReadResult<unknown>,
  titles: {
    readonly unavailable: string;
    readonly notFound: string;
    readonly integrity: string;
    readonly pending?: string;
    readonly terminal?: (state: string) => string;
  },
) => {
  if (result.ok) return result.value;
  const { failure } = result;
  const title =
    failure.reason === "unavailable"
      ? titles.unavailable
      : failure.reason === "not_found"
        ? titles.notFound
        : failure.reason === "pending" && titles.pending
          ? titles.pending
          : failure.reason === "terminal" && titles.terminal
            ? titles.terminal(failure.state ?? "")
            : failure.reason === "too_large"
              ? "Stored resource exceeds the bounded response contract"
              : titles.integrity;
  return reply
    .status(failure.status)
    .type("application/problem+json")
    .send(problem(failure.status, failure.code, title, correlationId(request)));
};
export const reconciliationTitles = {
  unavailable: "Reconciliation unavailable",
  notFound: "Reconciliation not found",
  integrity: "Reconciliation unavailable",
};
