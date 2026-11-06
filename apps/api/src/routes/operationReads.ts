import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { createRouteRegistrar } from "../http/route.js";
import type { ServerOptionDependencies } from "../http/context.js";

export interface OperationReadRouteServices extends Pick<ServerOptionDependencies, "operationService"> {}

export function registerOperationReads(server: FastifyInstance, context: RouteContext): void {
  const {
    ApplyProviderReconciliationRequestSchema,
    UuidSchema,
    z,
    operationService,
    requireAccess,
    verificationReads,
    sendVerificationRead,
    reconciliationTitles,
  } = context;
  const route = createRouteRegistrar({ server, requireAccess });
  route({
    method: "GET",
    url: "/v1/operations",
    access: "knowledge.read",
    call: async ({ access }) => ({ items: await operationService.list(access.tenant), nextCursor: null }),
  });
  for (const method of ["GET", "POST"] as const) {
    route({
      method,
      url: "/v1/verification/extractions/:operationId/provider-attempts/:providerAttemptId/reconciliation",
      access: method === "GET" ? "knowledge.read" : "operation.submit",
      params: z.strictObject({ operationId: z.string(), providerAttemptId: z.string() }),
      query: z.strictObject({}),
      call: async ({ access, params, request, reply }) => {
        const scoped = {
          tenantId: access.tenant,
          actor: access.identity.actor,
          operationId: UuidSchema.parse(params.operationId),
          providerAttemptId: UuidSchema.parse(params.providerAttemptId),
        };
        const body = method === "POST" ? ApplyProviderReconciliationRequestSchema.parse(request.body) : undefined;
        return sendVerificationRead(
          request,
          reply,
          await verificationReads.providerReconciliation({
            ...scoped,
            ...(body ? { artifact: body.artifact } : {}),
          }),
          reconciliationTitles,
        );
      },
    });
  }
}
