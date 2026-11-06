import {
  OperationContextSchema,
  type OperationContext,
  type VerificationOperationContextHints,
} from "@aiengineer/knowledge-contracts";
import { actorsMatch } from "../../access/api-access.js";

export type VerificationContextBindingFailure =
  | "ownership_denied"
  | "context_mismatch"
  | "ownership_binding_mismatch"
  | "external_execution_mismatch";

export type VerificationContextBinding =
  | { readonly ok: true; readonly context: OperationContext }
  | { readonly ok: false; readonly failure: VerificationContextBindingFailure };

/**
 * Accepts a resolved verification context only when it is bound to the authenticated
 * submission: same tenant, correlation, idempotency key and actor, and every caller
 * ownership hint and external execution binding unchanged. Caller hints never become
 * authority; only the trusted resolver's context is returned. Shared by API and MCP.
 */
export function bindResolvedVerificationContext(input: {
  readonly resolved: OperationContext | undefined;
  readonly tenantId: string;
  readonly actor: OperationContext["actor"];
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly hints: VerificationOperationContextHints;
}): VerificationContextBinding {
  if (!input.resolved) return { ok: false, failure: "ownership_denied" };
  const context = OperationContextSchema.parse(input.resolved);
  if (
    context.tenantId !== input.tenantId ||
    context.correlationId !== input.correlationId ||
    context.idempotencyKey !== input.idempotencyKey ||
    !actorsMatch(input.actor, context.actor)
  )
    return { ok: false, failure: "context_mismatch" };
  for (const key of ["attemptId", "workItemId", "missionId", "causationId"] as const)
    if (input.hints[key] !== undefined && context[key] !== input.hints[key])
      return { ok: false, failure: "ownership_binding_mismatch" };
  if (
    input.hints.externalExecution !== undefined &&
    JSON.stringify(context.externalExecution) !== JSON.stringify(input.hints.externalExecution)
  )
    return { ok: false, failure: "external_execution_mismatch" };
  return { ok: true, context };
}
