import type {
  Actor,
  CompareBenchmarkRunsRequest,
  ExternalExecutionContext,
  OperationContext,
  ParseArtifactRequest,
  RunBenchmarkRequest,
  VerificationOperationContextHints,
} from "@aiengineer/knowledge-contracts";
import { OperationContextSchema } from "@aiengineer/knowledge-contracts";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import type { parseVerificationBenchmarkComparisonRuntimeConfig } from "../benchmark/verification-benchmark-comparison-runtime-config.js";
import type { parseVerificationBenchmarkRuntimeConfig } from "../benchmark/verification-benchmark-runtime-config.js";
import type { VerificationServiceCatalog } from "./verification-service.js";

export interface VerificationContextRequest {
  readonly headers: Record<string, unknown>;
  readonly body: unknown;
}

export interface VerificationContextResolutionInput {
  readonly request?: VerificationContextRequest;
  readonly tenantId: string;
  readonly identity: { readonly actor: Actor };
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly useCase: string;
  readonly hints: VerificationOperationContextHints;
}

export type ResolveVerificationContext = (
  input: VerificationContextResolutionInput,
) => OperationContext | undefined | Promise<OperationContext | undefined>;

export interface VerificationOwnershipQueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: T[];
}

export interface VerificationOwnershipQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<VerificationOwnershipQueryResult<T>>;
}

export interface VerificationOwnershipStore {
  transaction<T>(tenantId: string, run: (client: VerificationOwnershipQueryClient) => Promise<T>): Promise<T>;
}

export interface StaticVerificationContextBindings {
  readonly attemptId: string;
  readonly workItemId?: string;
  readonly missionId?: string;
  readonly causationId?: string;
  readonly externalExecution?: ExternalExecutionContext;
  readonly capabilityVersion: string;
}

function hintsConflictWithBindings(
  hints: VerificationOperationContextHints,
  bindings: StaticVerificationContextBindings,
): boolean {
  return Boolean(
    (hints.attemptId && hints.attemptId !== bindings.attemptId) ||
      (hints.workItemId && hints.workItemId !== bindings.workItemId) ||
      (hints.missionId && hints.missionId !== bindings.missionId) ||
      (hints.causationId && hints.causationId !== bindings.causationId) ||
      (hints.externalExecution &&
        JSON.stringify(hints.externalExecution) !== JSON.stringify(bindings.externalExecution)),
  );
}

function parseStaticVerificationContext(input: {
  readonly bindings: StaticVerificationContextBindings;
  readonly tenantId: string;
  readonly identity: { readonly actor: Actor };
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly useCase: string;
}): OperationContext {
  const { bindings } = input;
  return OperationContextSchema.parse({
    tenantId: input.tenantId,
    operationId: deterministicUuid(
      "verification-http-operation",
      `${input.tenantId}:${input.useCase}:${input.idempotencyKey}`,
    ),
    attemptId: bindings.attemptId,
    ...(bindings.workItemId ? { workItemId: bindings.workItemId } : {}),
    ...(bindings.missionId ? { missionId: bindings.missionId } : {}),
    ...(bindings.causationId ? { causationId: bindings.causationId } : {}),
    ...(bindings.externalExecution ? { externalExecution: bindings.externalExecution } : {}),
    correlationId: input.correlationId,
    actor: input.identity.actor,
    capabilityVersion: bindings.capabilityVersion,
    idempotencyKey: input.idempotencyKey,
    reason: `authenticated ${input.useCase} request`,
    contractVersion: "v1" as const,
  });
}

export function createStaticVerificationContextResolver(
  bindings: StaticVerificationContextBindings,
): ResolveVerificationContext {
  return (input) => {
    if (hintsConflictWithBindings(input.hints, bindings)) return undefined;
    return parseStaticVerificationContext({ bindings, ...input });
  };
}

export function createParseArtifactRequestAdmission(catalog: VerificationServiceCatalog) {
  return (tenantId: string, request: ParseArtifactRequest) =>
    request.sourceArtifact.tenantId === tenantId && catalog.admitsParseArtifact(request);
}

function admitsWhenGrantResolves(resolve: () => void, requiredCode: string): boolean {
  try {
    resolve();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === requiredCode) return false;
    throw error;
  }
}

export function createBenchmarkRequestAdmission(config: ReturnType<typeof parseVerificationBenchmarkRuntimeConfig>) {
  return (tenantId: string, request: RunBenchmarkRequest) =>
    admitsWhenGrantResolves(() => {
      config.inputs.resolve(tenantId, request);
    }, "BENCHMARK_INPUT_TRUSTED_GRANT_REQUIRED");
}

export function createBenchmarkComparisonRequestAdmission(
  config: ReturnType<typeof parseVerificationBenchmarkComparisonRuntimeConfig>,
) {
  return (tenantId: string, request: CompareBenchmarkRunsRequest) =>
    admitsWhenGrantResolves(() => {
      config.catalog.resolve(tenantId, request.comparisonProfile);
    }, "BENCHMARK_COMPARISON_PROFILE_TRUSTED_GRANT_REQUIRED");
}
