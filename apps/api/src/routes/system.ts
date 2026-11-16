import { describeReference, DescribeInputSchema } from "@aiengineer/knowledge-contracts";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";

// SV-17 retired the internal verification drift revalidation queue (its AIDB outbox was withdrawn).

export function registerSystem(server: FastifyInstance, context: RouteContext): void {
  const { application, requireAccess, resolveBearerIdentity, correlationId, problem } = context;
  server.get("/health", async () => ({ status: "ok" }));
  server.get("/readiness", async () => application.getStatus());
  server.get("/v1/system", async (request, reply) =>
    (await requireAccess(request, reply, "system.read")) ? application.getStatus() : undefined,
  );
  // Everything about one tool, operation or skill, from the operation contracts: the answer the MCP tool
  // knowledge_describe and `ks describe` return. It reads no tenant data, so it needs a bearer and no tenant.
  server.get("/v1/describe", async (request, reply) => {
    if (!(await resolveBearerIdentity(request)))
      return reply
        .status(401)
        .type("application/problem+json")
        .send(problem(401, "UNAUTHORIZED", "Authentication required", correlationId(request)));
    const result = describeReference(DescribeInputSchema.parse(request.query).ref);
    if (result.ok) return result.description;
    const { message, validPrefixes, valid } = result.refusal;
    return reply
      .status(404)
      .type("application/problem+json")
      .send(
        problem(
          404,
          "NOT_FOUND",
          "Reference not found",
          correlationId(request),
          `${message} Valid prefixes: ${validPrefixes.join(", ")}`,
          valid.length ? [{ path: "ref", message: `Valid names: ${valid.join(", ")}` }] : undefined,
        ),
      );
  });
}
