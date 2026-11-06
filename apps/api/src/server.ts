import type { FastifyInstance } from "fastify";
import { createRouteContext, type ServerOptionDependencies } from "./http/context.js";
import type { A2ARouteServices } from "./a2a-http.js";
import { registerSystem } from "./routes/system.js";
import { registerOperationReads, type OperationReadRouteServices } from "./routes/operationReads.js";
import { registerVerification, type VerificationRouteServices } from "./routes/verification.js";
import { registerOperationMutations, type OperationMutationRouteServices } from "./routes/operationMutations.js";
import { registerRetrieval, type RetrievalRouteServices } from "./routes/retrieval.js";
import { registerKnowledge, type KnowledgeRouteServices } from "./routes/knowledge.js";

type RouteServices = A2ARouteServices &
  OperationReadRouteServices &
  VerificationRouteServices &
  OperationMutationRouteServices &
  RetrievalRouteServices &
  KnowledgeRouteServices;
export type ServerOptions = Omit<ServerOptionDependencies, keyof RouteServices> & RouteServices;
export type { RouteContext } from "./http/context.js";
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const context = createRouteContext(options);
  registerSystem(context.server, context);
  registerOperationReads(context.server, context);
  registerVerification(context.server, context);
  registerOperationMutations(context.server, context);
  registerRetrieval(context.server, context);
  registerKnowledge(context.server, context);
  return context.server;
}
