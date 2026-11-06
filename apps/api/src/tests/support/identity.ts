import type { LocalApiIdentity } from "@aiengineer/knowledge-host/config";

export function serviceIdentity(tenantId: string, actorId: string) {
  const actor = { kind: "service" as const, id: actorId, serviceIdentity: "mission_control_client" as const };
  const identity: LocalApiIdentity = {
    actor,
    grants: [{ tenantId, roles: ["knowledge_operator"], scopes: [] }],
  };
  return { actor, identity };
}

export function tokenHeaders(token: string, tenantId: string, correlationId?: string) {
  return {
    authorization: `Bearer ${token}`,
    "x-tenant-id": tenantId,
    ...(correlationId ? { "x-correlation-id": correlationId } : {}),
  };
}
