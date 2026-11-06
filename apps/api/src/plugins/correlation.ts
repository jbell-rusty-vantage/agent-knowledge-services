import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
export function correlationId(request: FastifyRequest) {
  const value = request.headers["x-correlation-id"];
  return typeof value === "string" && value.trim() ? value.slice(0, 255) : randomUUID();
}
export function tenantId(request: FastifyRequest) {
  const value = request.headers["x-tenant-id"];
  return typeof value === "string" ? value : undefined;
}
export function registerCorrelation(server: FastifyInstance): void {
  server.addHook("onRequest", async (request, reply) => {
    const id = correlationId(request);
    request.headers["x-correlation-id"] = id;
    reply.header("x-correlation-id", id);
  });
}
