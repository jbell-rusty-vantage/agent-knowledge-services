import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import type { ServerOptionDependencies } from "../http/context.js";

export interface RetrievalRouteServices
  extends Pick<ServerOptionDependencies, "retrievalOperationService" | "canonicalRetrievalExecutor"> {}

export function registerRetrieval(server: FastifyInstance, context: RouteContext): void {
  const {
    MutationEnvelopeSchema,
    RetrievalPlanSchema,
    submitCanonicalRetrievalRun,
    options,
    operationService,
    retrievalOperationService,
    requireAccess,
    requireSubmissionEnvelope,
    origin,
    submit,
    collectionKinds,
    correlationId,
    problem,
  } = context;
  server.post("/v1/retrieval-plans:validate", async (request, reply) => {
    if (!(await requireAccess(request, reply, "retrieval.plan.validate"))) return;
    const body = request.body as { plan?: unknown };
    return RetrievalPlanSchema.parse(body?.plan ?? request.body);
  });
  server.post("/v1/retrieval-runs", async (request, reply) => {
    const access = await requireAccess(request, reply, "operation.submit");
    if (!access) return;
    const envelope = MutationEnvelopeSchema.parse(request.body);
    if (!requireSubmissionEnvelope(access, envelope, request, reply)) return;
    const submission = await submitCanonicalRetrievalRun(
      {
        operations: retrievalOperationService,
        ...(options.canonicalRetrievalExecutor ? { executor: options.canonicalRetrievalExecutor } : {}),
      },
      { envelope, identity: access.identity, origin: origin(request) },
    );
    if (!submission.ok && submission.reason === "retrieval_version_required")
      return reply
        .status(400)
        .type("application/problem+json")
        .send(problem(400, "INVALID_CONTRACT", "Retrieval contract version v1 is required", correlationId(request)));
    if (!submission.ok)
      return reply
        .status(503)
        .type("application/problem+json")
        .send(problem(503, "INTERNAL_ERROR", "Canonical retrieval executor unavailable", correlationId(request)));
    return reply.status(202).send(submission.accepted);
  });
  server.get("/v1/retrieval-runs", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    return {
      items: (await operationService.list(access.tenant)).filter((operation) => operation.kind === "retrieval_run"),
      nextCursor: null,
    };
  });
  for (const [collection, kind] of Object.entries(collectionKinds)) {
    server.post(`/v1/${collection}`, async (request, reply) => submit(request, reply, kind));
    server.get(`/v1/${collection}`, async (request, reply) => {
      const access = await requireAccess(request, reply, "knowledge.read");
      if (!access) return;
      return {
        items: (await operationService.list(access.tenant)).filter((operation) => operation.kind === kind),
        nextCursor: null,
      };
    });
  }
}
