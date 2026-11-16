import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import type { ServerOptionDependencies } from "../http/context.js";

export interface KnowledgeRouteServices
  extends Pick<
    ServerOptionDependencies,
    "resourceReader" | "maximumResourceResponseBytes" | "replayEvidencePacketCitations" | "getEvidencePacket"
  > {}
import type { OperationKind } from "@aiengineer/knowledge-contracts";
type Params = { id: string };

export function registerKnowledge(server: FastifyInstance, context: RouteContext): void {
  const {
    UuidSchema,
    options,
    requireAccess,
    requireResourceReader,
    knowledgeReads,
    sendKnowledgeRead,
    submit,
    correlationId,
    problem,
  } = context;
  const mutationRoutes: [string, OperationKind][] = [
    ["/v1/transformations", "transformation"],
    ["/v1/chunk-previews", "chunk_preview"],
    ["/v1/chunk-comparisons", "chunk_comparison"],
    ["/v1/chunk-sets", "chunk_set"],
  ];
  for (const [path, kind] of mutationRoutes) server.post(path, async (request, reply) => submit(request, reply, kind));
  server.post<{ Params: Params }>("/v1/vector-stores/:id/documents", async (request, reply) =>
    submit(request, reply, "vector_store_documents", request.params.id),
  );
  server.post<{ Params: Params }>("/v1/vector-stores/:id/ingestion-jobs", async (request, reply) =>
    submit(request, reply, "vector_store_ingestion", request.params.id),
  );
  server.post<{ Params: { sourceAction: string } }>("/v1/:sourceAction", async (request, reply) => {
    const kind = {
      "sources:discover": "source_discovery",
      "sources:resolve": "source_resolution",
    }[request.params.sourceAction] as OperationKind | undefined;
    return kind
      ? submit(request, reply, kind)
      : reply.status(404).send(problem(404, "NOT_FOUND", "Action not found", correlationId(request)));
  });
  const resourceActions: Record<string, Record<string, OperationKind>> = {
    "vector-stores": { evaluate: "vector_store_evaluation" },
    captures: { vet: "source_vetting" },
    representations: {
      compare: "representation_comparison",
      decide: "representation_decision",
    },
    "space-publications": {
      verify: "publication_verification",
      rollback: "publication_rollback",
    },
  };
  for (const [resource, actions] of Object.entries(resourceActions))
    server.post<{ Params: { target: string } }>(`/v1/${resource}/:target`, async (request, reply) => {
      const match = /^(.*):([a-z-]+)$/.exec(request.params.target);
      const kind = match ? actions[match[2]!] : undefined;
      return kind
        ? submit(request, reply, kind)
        : reply.status(404).send(problem(404, "NOT_FOUND", "Resource action not found", correlationId(request)));
    });
  server.get<{ Params: Params }>("/v1/evidence-packets/:id", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    const packet = await knowledgeReads.evidencePacket(access.tenant, request.params.id);
    return packet.ok
      ? packet.value
      : reply.status(404).send(problem(404, "NOT_FOUND", "Evidence packet not found", correlationId(request)));
  });
  server.get<{ Params: Params }>("/v1/evidence-packets/:id/citations", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    if (!options.replayEvidencePacketCitations)
      return reply
        .status(503)
        .type("application/problem+json")
        .send(problem(503, "INTERNAL_ERROR", "Citation replay custody unavailable", correlationId(request)));
    const replay = await knowledgeReads.citationReplay(access.tenant, UuidSchema.parse(request.params.id));
    return replay.ok
      ? replay.value
      : reply
          .status(404)
          .type("application/problem+json")
          .send(problem(404, "NOT_FOUND", "Evidence packet not found", correlationId(request)));
  });
  server.get<{ Params: Params }>("/v1/retrieval-runs/:id", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    if (!requireResourceReader(request, reply)) return;
    return sendKnowledgeRead(
      request,
      reply,
      await knowledgeReads.retrievalRun(access.tenant, UuidSchema.parse(request.params.id)),
      "Retrieval run not found",
    );
  });
  server.get<{ Params: Params }>("/v1/vector-stores/:id", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    if (!requireResourceReader(request, reply)) return;
    return sendKnowledgeRead(
      request,
      reply,
      await knowledgeReads.vectorStore(access.tenant, UuidSchema.parse(request.params.id)),
      "Vector store not found",
    );
  });
  server.get<{ Params: Params }>("/v1/retrieval-runs/:id/explanation", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    if (!requireResourceReader(request, reply)) return;
    return sendKnowledgeRead(
      request,
      reply,
      await knowledgeReads.retrievalExplanation(access.tenant, UuidSchema.parse(request.params.id)),
      "Retrieval explanation not found",
    );
  });
  server.get<{ Params: Params }>("/v1/eval-runs/:id/report", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    if (!requireResourceReader(request, reply)) return;
    return sendKnowledgeRead(
      request,
      reply,
      await knowledgeReads.evaluationReport(access.tenant, UuidSchema.parse(request.params.id)),
      "Evaluation report not found",
    );
  });
  server.get<{ Params: Params }>("/v1/eval-runs/:id/failures", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    if (!requireResourceReader(request, reply)) return;
    return sendKnowledgeRead(
      request,
      reply,
      await knowledgeReads.evaluationFailures(access.tenant, UuidSchema.parse(request.params.id)),
      "Evaluation run not found",
    );
  });
  server.get<{ Params: Params }>("/v1/artifacts/:id", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    if (!requireResourceReader(request, reply)) return;
    return sendKnowledgeRead(
      request,
      reply,
      await knowledgeReads.artifact(access.tenant, UuidSchema.parse(request.params.id)),
      "Artifact not found",
    );
  });
  server.get<{ Params: Params }>("/v1/receipts/:id", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    if (!requireResourceReader(request, reply)) return;
    return sendKnowledgeRead(
      request,
      reply,
      await knowledgeReads.receipt(access.tenant, UuidSchema.parse(request.params.id)),
      "Receipt not found",
    );
  });
  server.get<{ Params: { id: string; operationId: string } }>(
    "/v1/vector-stores/:id/operations/:operationId",
    async (request, reply) => {
      const access = await requireAccess(request, reply, "knowledge.read");
      if (!access) return;
      if (!requireResourceReader(request, reply)) return;
      return sendKnowledgeRead(
        request,
        reply,
        await knowledgeReads.vectorStoreOperation(
          access.tenant,
          UuidSchema.parse(request.params.id),
          UuidSchema.parse(request.params.operationId),
        ),
        "Vector-store operation not found",
        "Vector-store operation metadata is inconsistent",
      );
    },
  );
  server.get("/v1/chunking-procedures", async (request, reply) =>
    (await requireAccess(request, reply, "knowledge.read"))
      ? {
          items: [
            { id: "heading-sections-v1", version: "1.0.0", admitted: true },
            { id: "transcript-topics-v1", version: "1.0.0", admitted: true },
          ],
          nextCursor: null,
        }
      : undefined,
  );
}
