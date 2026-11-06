import type { ProblemDetails } from "@aiengineer/knowledge-contracts";
import type { FastifyReply } from "fastify";

export function sendProblem(reply: FastifyReply, body: ProblemDetails) {
  return reply.status(body.status).type("application/problem+json").send(body);
}
export function problem(
  status: number,
  code: ProblemDetails["code"],
  title: string,
  correlation: string,
  detail?: string,
  issues?: ProblemDetails["issues"],
): ProblemDetails {
  return {
    type: `https://knowledge.aiengineer.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    correlationId: correlation,
    ...(detail ? { detail } : {}),
    ...(issues?.length ? { issues } : {}),
  };
}
