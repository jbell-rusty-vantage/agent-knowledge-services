import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";

// SV-17 retired the internal verification drift revalidation queue (its AIDB outbox was withdrawn).

export function registerSystem(server: FastifyInstance, context: RouteContext): void {
  const { application, requireAccess } = context;
  server.get("/health", async () => ({ status: "ok" }));
  server.get("/readiness", async () => application.getStatus());
  server.get("/v1/system", async (request, reply) =>
    (await requireAccess(request, reply, "system.read")) ? application.getStatus() : undefined,
  );
}
