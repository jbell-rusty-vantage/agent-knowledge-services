import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import type { ServerOptionDependencies } from "../http/context.js";

export interface OperationMutationRouteServices extends Pick<ServerOptionDependencies, "operationService"> {}
type Params = { id: string };

export function registerOperationMutations(server: FastifyInstance, context: RouteContext): void {
  const {
    MutationEnvelopeSchema,
    OperationKindSchema,
    requiredSubmissionAction,
    operationService,
    requireAccess,
    requireEnvelopeActor,
    origin,
    correlationId,
    problem,
  } = context;
  server.post("/v1/operations", async (request, reply) => {
    const body = request.body as { kind?: unknown; envelope?: unknown };
    const kind = OperationKindSchema.parse(body?.kind);
    const access = await requireAccess(request, reply, requiredSubmissionAction(kind));
    if (!access) return;
    const envelope = MutationEnvelopeSchema.parse(body?.envelope);
    if (access.tenant !== envelope.context.tenantId)
      return reply.status(403).send(problem(403, "FORBIDDEN", "Tenant context mismatch", correlationId(request)));
    if (requireEnvelopeActor(access.identity, envelope, request, reply) !== true) return;
    if (correlationId(request) !== envelope.context.correlationId)
      return reply
        .status(400)
        .send(problem(400, "INVALID_CONTRACT", "Correlation context mismatch", correlationId(request)));
    return reply.status(202).send(await operationService.submit(kind, envelope, origin(request)));
  });
  server.get<{ Params: Params }>("/v1/operations/:id", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    const item = await operationService.get(request.params.id, access.tenant);
    return item ?? reply.status(404).send(problem(404, "NOT_FOUND", "Operation not found", correlationId(request)));
  });
  server.get<{ Params: Params }>("/v1/operations/:id/events", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    const after = Number((request.query as { after?: string }).after ?? 0);
    const items = await operationService.events(
      request.params.id,
      access.tenant,
      Number.isSafeInteger(after) && after >= 0 ? after : 0,
    );
    return items
      ? { items, nextCursor: null }
      : reply.status(404).send(problem(404, "NOT_FOUND", "Operation not found", correlationId(request)));
  });
  server.post<{ Params: { target: string } }>("/v1/operations/:target", async (request, reply) => {
    const access = await requireAccess(request, reply, "operation.control");
    if (!access) return;
    const match = /^(.*):(cancel|retry|reconcile)$/.exec(request.params.target);
    if (!match)
      return reply.status(404).send(problem(404, "NOT_FOUND", "Operation action not found", correlationId(request)));
    const envelope = MutationEnvelopeSchema.parse(request.body);
    if (access.tenant !== envelope.context.tenantId)
      return reply.status(403).send(problem(403, "FORBIDDEN", "Tenant context mismatch", correlationId(request)));
    if (requireEnvelopeActor(access.identity, envelope, request, reply) !== true) return;
    if (correlationId(request) !== envelope.context.correlationId)
      return reply
        .status(400)
        .send(problem(400, "INVALID_CONTRACT", "Correlation context mismatch", correlationId(request)));
    if (match[1] !== envelope.context.operationId)
      return reply
        .status(400)
        .type("application/problem+json")
        .send(problem(400, "INVALID_CONTRACT", "Operation context mismatch", correlationId(request)));
    const action = match[2] as "cancel" | "retry" | "reconcile";
    const result = await operationService[action](match[1]!, envelope.context.tenantId, envelope.context);
    return result ?? reply.status(404).send(problem(404, "NOT_FOUND", "Operation not found", correlationId(request)));
  });
}
