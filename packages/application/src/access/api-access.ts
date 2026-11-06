import type { Actor, OperationKind } from "@aiengineer/knowledge-contracts";

/**
 * Tenant action rules shared by every in-process transport. Identity resolution
 * (bearer parsing, configured identities) stays in host configuration; these rules
 * decide what an already-resolved identity may do for one tenant.
 */
export const API_ACTIONS = [
  "system.read",
  "knowledge.read",
  "operation.submit",
  "operation.control",
  "decision.record",
  "publication.execute",
  "callback.receive",
  "retrieval.plan.validate",
  "demo.evaluate",
] as const;
export type ApiAction = (typeof API_ACTIONS)[number];

export const requiredSubmissionAction = (kind: OperationKind): ApiAction =>
  ["representation_decision", "promotion_decision", "review_decision"].includes(kind)
    ? "decision.record"
    : ["space_publication", "publication_rollback"].includes(kind)
      ? "publication.execute"
      : "operation.submit";

export const API_ROLES = ["knowledge_reader", "knowledge_operator", "knowledge_evaluator", "knowledge_admin"] as const;
export type ApiRole = (typeof API_ROLES)[number];

export interface TenantGrant {
  readonly tenantId: string;
  readonly roles: readonly ApiRole[];
  readonly scopes: readonly ApiAction[];
}

export interface LocalApiIdentity {
  readonly actor: Actor;
  readonly grants: readonly TenantGrant[];
}

export type ResolveApiIdentity = (
  token: string,
) => LocalApiIdentity | undefined | Promise<LocalApiIdentity | undefined>;

const ROLE_ACTIONS: Readonly<Record<ApiRole, readonly ApiAction[]>> = {
  knowledge_reader: ["system.read", "knowledge.read", "retrieval.plan.validate"],
  knowledge_operator: [
    "system.read",
    "knowledge.read",
    "retrieval.plan.validate",
    "operation.submit",
    "operation.control",
    "callback.receive",
  ],
  knowledge_evaluator: ["system.read", "knowledge.read", "retrieval.plan.validate", "demo.evaluate"],
  knowledge_admin: API_ACTIONS,
};

export function isAuthorized(identity: LocalApiIdentity, tenantId: string, action: ApiAction): boolean {
  const grant = identity.grants.find((candidate) => candidate.tenantId === tenantId);
  if (!grant) return false;
  const actions = new Set<ApiAction>(grant.scopes);
  for (const role of grant.roles) for (const roleAction of ROLE_ACTIONS[role]) actions.add(roleAction);
  return actions.has(action);
}

export function actorsMatch(authenticated: Actor, asserted: Actor): boolean {
  if (authenticated.kind !== asserted.kind || authenticated.id !== asserted.id) return false;
  if (authenticated.kind === "service" && asserted.kind === "service")
    return authenticated.serviceIdentity === asserted.serviceIdentity;
  if (authenticated.kind === "model" && asserted.kind === "model")
    return (
      authenticated.serviceIdentity === asserted.serviceIdentity &&
      authenticated.model === asserted.model &&
      authenticated.providerRunId === asserted.providerRunId
    );
  return true;
}
