// Configuration and identity (absorbed from @aiengineer/knowledge-config).
export * from "./config/index.js";

// Composition root.
export * from "./create-host.js";
export * from "./server/api.js";
export * from "./server/mcp.js";
export * from "./server/worker.js";
export * from "./server/knowledge.js";
export * from "./server/verification.js";
export * from "./local/capabilities.js";
export * from "./local/catalog-profile.js";
export * from "./local/local-host.js";
export {
  assertOperationKindAdmitted,
  AgenticKnowledgeService,
  bindResolvedVerificationContext,
  createIntegrationService,
  createKnowledgeApplication,
  createKnowledgeResourceReads,
  createVerificationResourceReads,
  operationCatalog,
  OperationCapabilityUnavailableError,
  productionWorkerOperationKinds,
  submitCanonicalRetrievalRun,
  transportProblem,
  retrievalExecutionProblem,
  type CallbackReplayStore,
  type CanonicalRetrievalExecutorPort,
  type CatalogOperation,
  type Group,
  type KnowledgeOperationPort,
  type KnowledgeIntegrationService,
  type KnowledgeResourceReads,
  type ResolveVerificationContext,
  type ResourceReadResult,
  type VettedBundleInput,
  type VerificationBenchmarkComparisonReadService,
  type VerificationBenchmarkReadService,
  type VerificationContextBindingFailure,
  type VerificationResourceReadServices,
  type VerificationServiceCatalog,
  type VerificationResourceReads,
  VerificationOperationApplicationService,
} from "@aiengineer/knowledge-application";
export type { ResourceReadRepository } from "@aiengineer/knowledge-persistence";
export { DeterministicFakeEmbeddingAdapter } from "@aiengineer/knowledge-retrieval";
export type { HostEnvironment } from "./server/shared.js";
export { HostResources, constructWithResources } from "./lifecycle/resources.js";
export { startPollingLoop, type PollingLoop } from "./lifecycle/polling.js";

// Shared verification host: admission gates and ownership used by API and MCP.
export * from "./verification/host-runtime.js";
export * from "./verification/api/verification-benchmark-reads-runtime.js";
export * from "./verification/api/verification-benchmark-comparison-reads-runtime.js";
// Verification read and reconciliation construction (formerly API-injected seams).
export * from "./verification/api/verification-ownership.js";
export * from "./verification/api/verification-structured-extraction-reads-runtime.js";
export * from "./verification/api/verification-capture-reads-runtime.js";
export * from "./verification/api/verification-provider-reconciliation-runtime.js";
export * from "./verification/api/verification-benchmark-capture-profile.js";
