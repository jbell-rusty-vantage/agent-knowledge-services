import { describeReference, DescribeInputSchema, guidePage } from "@aiengineer/knowledge-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "../server.js";

// SV-17 retired the internal verification drift revalidation queue (its AIDB outbox was withdrawn).

export function registerSystem(server: FastifyInstance, context: RouteContext): void {
  const { application, options, requireAccess, resolveBearerIdentity, correlationId, problem } = context;
  // The service status, with the AI Engineer database release the process started on when it has persistence.
  const status = async () => ({
    ...(await application.getStatus()),
    ...(options.databaseRelease ? { databaseRelease: options.databaseRelease } : {}),
  });
  server.get("/health", async () => ({ status: "ok" }));
  server.get("/readiness", status);
  server.get("/v1/system", async (request, reply) =>
    (await requireAccess(request, reply, "system.read")) ? status() : undefined,
  );
  // The guidance pages as Markdown text: the start page without a topic, a skill by its name, one of its files by
  // <skill>/<path>. They are the pages the MCP tool knowledge_guide and `ks guide` return, read no tenant data
  // and need a bearer and no tenant.
  const guide = async (request: FastifyRequest, reply: FastifyReply, topic?: string) => {
    if (!(await resolveBearerIdentity(request)))
      return reply
        .status(401)
        .type("application/problem+json")
        .send(problem(401, "UNAUTHORIZED", "Authentication required", correlationId(request)));
    const result = guidePage(topic);
    if (result.ok) return reply.type("text/markdown; charset=utf-8").send(result.markdown);
    return reply
      .status(404)
      .type("application/problem+json")
      .send(
        problem(404, "NOT_FOUND", "Guide topic not found", correlationId(request), result.refusal.message, [
          { path: "topic", message: `Valid topics: ${result.refusal.valid.join(", ")}` },
        ]),
      );
  };
  server.get("/v1/guide", async (request, reply) => guide(request, reply));
  server.get<{ Params: { "*": string } }>("/v1/guide/*", async (request, reply) =>
    guide(request, reply, request.params["*"]),
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
