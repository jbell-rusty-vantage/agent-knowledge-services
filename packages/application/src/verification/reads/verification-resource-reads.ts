import {
  VerificationBenchmarkComparisonResourceSchema,
  VerificationBenchmarkRunManifestResourceSchema,
  VerificationBenchmarkRunSummaryResourceSchema,
  VerificationCaptureTerminalResourceSchema,
  VerificationProviderReconciliationResourceSchema,
  VerificationStructuredExtractionResourceSchema,
  type Actor,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import type { ZodType } from "zod";
import {
  boundedResourceResult,
  classifyResourceReadError,
  resourceReadFailure,
  type ResourceReadResult,
} from "../../reads/resource-read-result.js";

/** An authenticated actor reading one tenant-owned verification operation. */
export interface OwnedOperationRead {
  readonly tenantId: string;
  readonly operationId: string;
  readonly actor: Actor;
}

export interface ProviderAttemptScope extends OwnedOperationRead {
  readonly providerAttemptId: string;
}

interface ProviderReconciliationService<TScope> {
  applyDecision(input: TScope & { readonly artifact: VerificationArtifactHandle }): Promise<unknown>;
  getDecision(input: TScope): Promise<unknown>;
}

/**
 * Composed verification read services. Each owns its ownership authorization,
 * signature policy and trusted storage; absent services mean the capability is not admitted.
 */
export interface VerificationResourceReadServices {
  readonly structuredExtractionReads?: { getExtraction(input: OwnedOperationRead): Promise<unknown> };
  readonly captureReads?: { getCapture(input: OwnedOperationRead): Promise<unknown> };
  readonly benchmarkComparisonReads?: {
    getComparison(input: { tenantId: string; comparisonId: string }): Promise<unknown>;
  };
  readonly benchmarkReads?: {
    getRun(input: { tenantId: string; runId: string }): Promise<unknown>;
    getManifest(input: { tenantId: string; runId: string }): Promise<unknown>;
  };
  readonly providerReconciliation?: ProviderReconciliationService<ProviderAttemptScope>;
  readonly maximumResponseBytes?: number;
}

export type VerificationResourceReads = ReturnType<typeof createVerificationResourceReads>;

/**
 * Verification resource reads shared by the API routes and MCP tools. The caller has
 * authorized `knowledge.read` (or `operation.submit` for reconciliation apply) for the
 * tenant and supplies the bearer-bound actor. Every result is schema-validated and must
 * name exactly the requested tenant and resource; otherwise it fails closed as integrity.
 */
export function createVerificationResourceReads(services: VerificationResourceReadServices) {
  const read = async <T>(
    mode: "missing" | "terminal",
    load: (() => Promise<unknown>) | undefined,
    schema: ZodType<T>,
    inScope: (resource: T) => boolean,
  ): Promise<ResourceReadResult<T>> => {
    if (!load) return resourceReadFailure("unavailable");
    try {
      const resource = schema.parse(await load());
      if (!inScope(resource)) throw new Error("VERIFICATION_READ_SCOPE_MISMATCH");
      return boundedResourceResult(resource, services.maximumResponseBytes);
    } catch (error) {
      return classifyResourceReadError(error, mode);
    }
  };
  const owned = (input: OwnedOperationRead) => (resource: { tenantId: string; operationId: string }) =>
    resource.tenantId === input.tenantId && resource.operationId === input.operationId;
  const bind = <S>(service: S | undefined, call: (service: S) => Promise<unknown>) =>
    service ? () => call(service) : undefined;
  const reconciliation = <S extends ProviderAttemptScope>(
    service: ProviderReconciliationService<S> | undefined,
    input: S & { readonly artifact?: VerificationArtifactHandle },
  ) => {
    const { artifact, ...scope } = input;
    return read(
      "missing",
      bind(service, (candidate) =>
        artifact
          ? candidate.applyDecision({ ...(scope as unknown as S), artifact })
          : candidate.getDecision(scope as unknown as S),
      ),
      VerificationProviderReconciliationResourceSchema,
      (resource) =>
        resource.tenantId === input.tenantId &&
        resource.operationId === input.operationId &&
        resource.providerAttemptId === input.providerAttemptId,
    );
  };
  return {
    structuredExtraction: (input: OwnedOperationRead) =>
      read(
        "missing",
        bind(services.structuredExtractionReads, (service) => service.getExtraction(input)),
        VerificationStructuredExtractionResourceSchema,
        owned(input),
      ),
    capture: (input: OwnedOperationRead) =>
      read(
        "terminal",
        bind(services.captureReads, (service) => service.getCapture(input)),
        VerificationCaptureTerminalResourceSchema,
        owned(input),
      ),
    benchmarkComparison: (input: { tenantId: string; comparisonId: string }) =>
      read(
        "missing",
        bind(services.benchmarkComparisonReads, (service) => service.getComparison(input)),
        VerificationBenchmarkComparisonResourceSchema,
        (resource) => resource.tenantId === input.tenantId && resource.comparisonId === input.comparisonId,
      ),
    benchmarkRun: (input: { tenantId: string; runId: string }) =>
      read(
        "missing",
        bind(services.benchmarkReads, (service) => service.getRun(input)),
        VerificationBenchmarkRunSummaryResourceSchema,
        (resource) => resource.tenantId === input.tenantId && resource.runId === input.runId,
      ),
    benchmarkManifest: (input: { tenantId: string; runId: string }) =>
      read(
        "missing",
        bind(services.benchmarkReads, (service) => service.getManifest(input)),
        VerificationBenchmarkRunManifestResourceSchema,
        (resource) => resource.tenantId === input.tenantId && resource.runId === input.runId,
      ),
    /** Reads, or with `artifact` applies, a signed extraction accounting decision; never redispatches. */
    providerReconciliation: (input: ProviderAttemptScope & { readonly artifact?: VerificationArtifactHandle }) =>
      reconciliation(services.providerReconciliation, input),
  };
}
