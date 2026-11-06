import {
  ActorSchema,
  ExternalExecutionContextSchema,
  OperationContextSchema,
  type Actor,
  type OperationContext,
  type VerificationOperationContextHints,
} from "@aiengineer/knowledge-contracts";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { actorsMatch } from "../../access/api-access.js";
import type {
  ResolveVerificationContext,
  VerificationContextResolutionInput,
  VerificationOwnershipStore,
} from "./verification-transport.js";

const OWNERSHIP_CONFIG_MAX_BYTES = 262_144;
const OWNED_ATTEMPT_SQL = `select a.id from orchestration.attempt a
        join orchestration.work_item w on w.id=a.work_item_id and w.tenant_id=a.tenant_id
        join orchestration.mission m on m.id=w.mission_id and m.tenant_id=w.tenant_id
        where a.tenant_id=$1 and a.id=$2 and w.id=$3 and m.id=$4 and a.agent_deployment_id=$5`;
const OWNED_OPERATION_READ_SQL = `select o.mission_id,a.agent_deployment_id,
        o.request->'authenticatedContext'->>'capabilityVersion' capability_version,o.request->'authenticatedContext'->'externalExecution' external_execution
        from knowledge_service.operation o join orchestration.attempt a on a.tenant_id=o.tenant_id and a.id=o.attempt_id
        join orchestration.work_item w on w.tenant_id=a.tenant_id and w.id=a.work_item_id and w.id=o.work_item_id and w.mission_id=o.mission_id
        where o.tenant_id=$1 and o.id=$2 and o.operation_kind=any($3::text[])`;

const grantSchema = z.strictObject({
  tenantId: z.uuid(),
  actor: ActorSchema,
  missionId: z.uuid(),
  agentDeploymentId: z.string().min(1).max(255),
  capabilityVersion: z.string().min(1).max(255),
  externalExecution: ExternalExecutionContextSchema.optional(),
});
type OwnershipGrant = z.infer<typeof grantSchema>;
function assertUniqueKeys(keys: readonly string[], duplicateCode: string): void {
  if (new Set(keys).size !== keys.length) throw new Error(duplicateCode);
}

function parseOwnershipGrants(rawGrants: string): OwnershipGrant[] {
  if (Buffer.byteLength(rawGrants) > OWNERSHIP_CONFIG_MAX_BYTES)
    throw new Error("VERIFICATION_OWNERSHIP_CONFIG_TOO_LARGE");
  const grants = z.array(grantSchema).min(1).max(256).parse(JSON.parse(rawGrants));
  assertUniqueKeys(
    grants.map((grant) => `${grant.tenantId}:${grant.actor.kind}:${grant.actor.id}:${grant.missionId}`),
    "DUPLICATE_VERIFICATION_OWNERSHIP_GRANT",
  );
  return grants;
}

function grantMatchesOwnedOperation(
  grant: OwnershipGrant,
  row: {
    readonly mission_id: string;
    readonly agent_deployment_id: string;
    readonly capability_version: string;
    readonly external_execution: unknown;
  },
): boolean {
  return (
    grant.missionId === row.mission_id &&
    grant.agentDeploymentId === row.agent_deployment_id &&
    grant.capabilityVersion === row.capability_version &&
    (!grant.externalExecution || isDeepStrictEqual(grant.externalExecution, row.external_execution))
  );
}

/** Authenticated mission readers must match the same server-owned deployment and original attempt. */
export function createVerificationOperationReadAuthorizer(
  store: VerificationOwnershipStore,
  rawGrants: string,
  operationKinds: readonly string[] = ["verification_structured_extraction"],
) {
  const grants = parseOwnershipGrants(rawGrants);
  if (operationKinds.length < 1 || operationKinds.length > 16 || operationKinds.some((kind) => !kind.trim()))
    throw new Error("VERIFICATION_READ_OPERATION_KINDS_INVALID");
  return async (input: { tenantId: string; operationId: string; actor: Actor }) => {
    const matches = grants.filter(
      (grant) => grant.tenantId === input.tenantId && actorsMatch(grant.actor, input.actor),
    );
    if (matches.length === 0) return false;
    return store.transaction(input.tenantId, async (client) => {
      const rows = (
        await client.query<{
          mission_id: string;
          agent_deployment_id: string;
          capability_version: string;
          external_execution: unknown;
        }>(OWNED_OPERATION_READ_SQL, [input.tenantId, input.operationId, [...operationKinds]])
      ).rows;
      return rows.length === 1 && matches.some((grant) => grantMatchesOwnedOperation(grant, rows[0]!));
    });
  };
}

function operationIdFor(input: { tenantId: string; useCase: string; idempotencyKey: string }): string {
  return deterministicUuid("verification-http-operation", `${input.tenantId}:${input.useCase}:${input.idempotencyKey}`);
}

function findMatchingGrant(
  grants: readonly OwnershipGrant[],
  input: VerificationContextResolutionInput,
): OwnershipGrant | undefined {
  const { hints } = input;
  return grants.find(
    (item) =>
      item.tenantId === input.tenantId &&
      item.missionId === hints.missionId &&
      actorsMatch(item.actor, input.identity.actor),
  );
}

async function attemptIsOwned(input: {
  readonly store: VerificationOwnershipStore;
  readonly tenantId: string;
  readonly attemptId: string;
  readonly workItemId: string;
  readonly missionId: string;
  readonly agentDeploymentId: string;
}): Promise<boolean> {
  return input.store.transaction(input.tenantId, async (client) => {
    const result = await client.query(OWNED_ATTEMPT_SQL, [
      input.tenantId,
      input.attemptId,
      input.workItemId,
      input.missionId,
      input.agentDeploymentId,
    ]);
    return result.rows.length === 1;
  });
}

function parseOwnedOperationContext(input: {
  readonly resolution: VerificationContextResolutionInput;
  readonly grant: OwnershipGrant;
  readonly hints: VerificationOperationContextHints;
}): OperationContext {
  const { resolution, grant, hints } = input;
  return OperationContextSchema.parse({
    tenantId: resolution.tenantId,
    actor: resolution.identity.actor,
    attemptId: hints.attemptId,
    missionId: grant.missionId,
    workItemId: hints.workItemId,
    operationId: operationIdFor(resolution),
    correlationId: resolution.correlationId,
    idempotencyKey: resolution.idempotencyKey,
    capabilityVersion: grant.capabilityVersion,
    reason: `authenticated ${resolution.useCase} request`,
    contractVersion: "v1",
    ...(hints.causationId ? { causationId: hints.causationId } : {}),
    ...(grant.externalExecution ? { externalExecution: grant.externalExecution } : {}),
  });
}

/** Server configuration grants mission access; request headers never create grants. */
export function createVerificationOwnershipResolver(
  store: VerificationOwnershipStore,
  rawGrants: string,
): ResolveVerificationContext {
  const grants = parseOwnershipGrants(rawGrants);
  return async (input) => {
    const { hints } = input;
    if (!hints.attemptId || !hints.missionId || !hints.workItemId) return undefined;
    const grant = findMatchingGrant(grants, input);
    if (!grant) return undefined;
    if (hints.externalExecution && !isDeepStrictEqual(hints.externalExecution, grant.externalExecution))
      return undefined;
    const owned = await attemptIsOwned({
      store,
      tenantId: input.tenantId,
      attemptId: hints.attemptId,
      workItemId: hints.workItemId,
      missionId: grant.missionId,
      agentDeploymentId: grant.agentDeploymentId,
    });
    if (!owned) return undefined;
    return parseOwnedOperationContext({ resolution: input, grant, hints });
  };
}
