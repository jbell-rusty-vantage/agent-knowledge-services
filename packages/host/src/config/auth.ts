import { createHash } from "node:crypto";
import {
  API_ACTIONS,
  API_ROLES,
  type LocalApiIdentity,
  type ResolveApiIdentity,
} from "@aiengineer/knowledge-application";
import { ActorSchema } from "@aiengineer/knowledge-contracts";
import { z } from "zod";

// Tenant action rules are application policy; host configuration resolves identities.
export {
  API_ACTIONS,
  API_ROLES,
  actorsMatch,
  isAuthorized,
  requiredSubmissionAction,
  type ApiAction,
  type ApiRole,
  type LocalApiIdentity,
  type ResolveApiIdentity,
  type TenantGrant,
} from "@aiengineer/knowledge-application";

const actionSchema = z.enum(API_ACTIONS);
const roleSchema = z.enum(API_ROLES);
const grantSchema = z.strictObject({
  tenantId: z.uuid(),
  roles: z.array(roleSchema).default([]),
  scopes: z.array(actionSchema).default([]),
});
const configuredIdentitySchema = z.strictObject({
  token: z.string().min(16),
  actor: ActorSchema,
  grants: z.array(grantSchema).min(1),
});
const configuredIdentitiesSchema = z.array(configuredIdentitySchema);

const digestToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Resolves static local bearer identities. Both HTTP and MCP must use this
 * resolver so an asserted operation actor is always bound to the bearer.
 */
export function createLocalIdentityResolver(raw = process.env.KNOWLEDGE_API_IDENTITIES): ResolveApiIdentity {
  if (!raw?.trim()) return () => undefined;
  const parsed = configuredIdentitiesSchema.parse(JSON.parse(raw));
  const byDigest = new Map<string, LocalApiIdentity>();
  for (const configured of parsed) {
    const digest = digestToken(configured.token);
    if (byDigest.has(digest)) throw new Error("DUPLICATE_KNOWLEDGE_API_TOKEN");
    byDigest.set(digest, {
      actor: configured.actor,
      grants: configured.grants,
    });
  }
  return (token) => byDigest.get(digestToken(token));
}
