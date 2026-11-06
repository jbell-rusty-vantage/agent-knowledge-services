const KIND_PREFIX = /^(service|human|model|agent):/;

export interface ActorIdentitySqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** Strip a durable kind:id prefix so raw uuid and service:<uuid> name the same actor. */
export function actorIdentityKey(identity: string): string {
  const match = KIND_PREFIX.exec(identity);
  return match ? identity.slice(match[0].length) : identity;
}

export function sameActorIdentity(left: string, right: string): boolean {
  const leftKey = actorIdentityKey(left);
  return leftKey.length > 0 && leftKey === actorIdentityKey(right);
}

/** Persist the operation's kind:id form after confirming it names the claimed actor. */
export async function operationActorIdentity(input: {
  readonly client: ActorIdentitySqlClient;
  readonly tenantId: string;
  readonly operationId: string;
  readonly claimedIdentity: string;
}): Promise<string> {
  const row = (
    await input.client.query<{ actor_identity: string }>(
      "select actor_identity from knowledge_service.operation where tenant_id=$1 and id=$2",
      [input.tenantId, input.operationId],
    )
  ).rows[0];
  if (!row || !sameActorIdentity(String(row.actor_identity), input.claimedIdentity)) {
    throw new Error("ACTOR_IDENTITY_MISMATCH");
  }
  return String(row.actor_identity);
}
