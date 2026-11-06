import {
  actorsMatch,
  createLocalIdentityResolver,
  isAuthorized,
  type ApiAction,
  type LocalApiIdentity,
  type ResolveApiIdentity,
} from "@aiengineer/knowledge-host";
import type { MutationEnvelopeSchema } from "@aiengineer/knowledge-contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { problem } from "../http/problem-map.js";
import { correlationId, tenantId } from "./correlation.js";

interface AuthOptions {
  readonly resolveIdentity?: ResolveApiIdentity;
  readonly publicOrigin?: string;
}

export function createAuthGuards(options: AuthOptions) {
  const resolveIdentity = options.resolveIdentity ?? createLocalIdentityResolver();
  const resolveBearerIdentity = (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    return token ? resolveIdentity(token) : undefined;
  };
  const requireTenant = async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = tenantId(request);
    if (!tenant) {
      await reply
        .status(400)
        .type("application/problem+json")
        .send(
          problem(
            400,
            "INVALID_CONTRACT",
            "Tenant context required",
            correlationId(request),
            "x-tenant-id is required.",
          ),
        );
      return undefined;
    }
    return tenant;
  };
  const requireAccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: ApiAction,
  ): Promise<{ tenant: string; identity: LocalApiIdentity } | undefined> => {
    const identity = await resolveBearerIdentity(request);
    if (!identity) {
      await reply
        .status(401)
        .type("application/problem+json")
        .send(problem(401, "UNAUTHORIZED", "Authentication required", correlationId(request)));
      return undefined;
    }
    const tenant = await requireTenant(request, reply);
    if (!tenant) return undefined;
    if (!isAuthorized(identity, tenant, action)) {
      await reply
        .status(403)
        .type("application/problem+json")
        .send(problem(403, "FORBIDDEN", "Action is not authorized", correlationId(request)));
      return undefined;
    }
    return { tenant, identity };
  };
  const requireEnvelopeActor = (
    identity: LocalApiIdentity,
    envelope: ReturnType<typeof MutationEnvelopeSchema.parse>,
    request: FastifyRequest,
    reply: FastifyReply,
  ) =>
    actorsMatch(identity.actor, envelope.context.actor)
      ? true
      : reply
          .status(403)
          .type("application/problem+json")
          .send(
            problem(403, "FORBIDDEN", "Authenticated actor does not match operation actor", correlationId(request)),
          );
  const requireSubmissionEnvelope = (
    access: { tenant: string; identity: LocalApiIdentity },
    envelope: ReturnType<typeof MutationEnvelopeSchema.parse>,
    request: FastifyRequest,
    reply: FastifyReply,
  ): boolean => {
    if (access.tenant !== envelope.context.tenantId) {
      void reply
        .status(403)
        .type("application/problem+json")
        .send(problem(403, "FORBIDDEN", "Tenant context mismatch", correlationId(request)));
      return false;
    }
    if (requireEnvelopeActor(access.identity, envelope, request, reply) !== true) return false;
    if (envelope.context.correlationId !== correlationId(request)) {
      void reply
        .status(400)
        .type("application/problem+json")
        .send(problem(400, "INVALID_CONTRACT", "Correlation context mismatch", correlationId(request)));
      return false;
    }
    return true;
  };
  const origin = (request: FastifyRequest) =>
    options.publicOrigin ?? `${request.protocol}://${request.headers.host ?? "localhost"}`;
  return { resolveBearerIdentity, requireAccess, requireEnvelopeActor, requireSubmissionEnvelope, origin };
}
