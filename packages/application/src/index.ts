import type { ServiceStatus } from "@aiengineer/knowledge-contracts";
import { KNOWLEDGE_SERVICE_NAME } from "@aiengineer/knowledge-core";

export interface KnowledgeApplication {
  getStatus(): Promise<ServiceStatus>;
}

export function createKnowledgeApplication(): KnowledgeApplication {
  return {
    async getStatus() {
      return {
        service: KNOWLEDGE_SERVICE_NAME,
        status: "ready",
        contractVersion: "v1",
        runtime: "node",
      };
    },
  };
}

// Shared transport-neutral access rules, read results and problem mapping.
export * from "./access/api-access.js";
export * from "./reads/resource-read-result.js";
export * from "./errors/transport-problem.js";

// Operations: durable operation surface, admission and A2A callback signing (the task binding lives in apps/api).
export * from "./operations/surface.js";
export * from "./operations/catalog.js";
export * from "./operations/a2a-callbacks.js";

// Knowledge tool group: preparation, source discovery, checkpoints, promotion selection, retrieval and reads.
export * from "./knowledge/preparation/preparation.js";
export * from "./knowledge/preparation/knowledge.js";
export * from "./knowledge/source-discovery/source-discovery.js";
export * from "./knowledge/checkpoints/checkpoints-ports.js";
export * from "./knowledge/checkpoints/checkpoints.js";
export * from "./knowledge/promotion-selection/promotion-selection.js";
export * from "./knowledge/retrieval/canonical-retrieval-ports.js";
export * from "./knowledge/retrieval/canonical-retrieval-executor.js";
export * from "./knowledge/retrieval/canonical-retrieval-run.js";
export * from "./knowledge/reads/knowledge-resource-reads.js";

// Verification tool group (the `verify` group).
export * from "./verification/admission/verification-admission.js";
export * from "./verification/operations/verification-provider.js";
export * from "./verification/benchmark/verification-benchmark.js";
export * from "./verification/benchmark/verification-benchmark-inputs.js";
export * from "./verification/benchmark/verification-benchmark-registered-profile.js";
export * from "./verification/benchmark/verification-benchmark-registered-replay.js";
export * from "./verification/benchmark/verification-benchmark-source-import.js";
export * from "./verification/benchmark/verification-benchmark-offline-executor.js";
export * from "./verification/benchmark/verification-benchmark-publication.js";
export * from "./verification/benchmark/verification-benchmark-runtime-config.js";
export * from "./verification/benchmark/verification-benchmark-observations.js";
export * from "./verification/benchmark/verification-benchmark-projections.js";
export * from "./verification/benchmark/verification-benchmark-response-replay.js";
export * from "./verification/operations/verification-service.js";
export * from "./verification/operations/verification-transport.js";
export * from "./verification/operations/verification-ownership.js";
export * from "./verification/operations/verification-read-public-keys.js";
export * from "./verification/operations/verification-parse.js";
export * from "./verification/benchmark/verification-benchmark-reads.js";
export * from "./verification/benchmark/verification-benchmark-comparison.js";
export * from "./verification/benchmark/verification-benchmark-comparison-publication.js";
export * from "./verification/benchmark/verification-benchmark-comparison-runtime-config.js";
export * from "./verification/benchmark/verification-benchmark-comparison-reads.js";
export * from "./verification/admission/verification-seal-policy.js";
export * from "./verification/operations/verification-structured-extraction-profile.js";
export * from "./verification/operations/verification-provider-transport.js";
export * from "./verification/operations/verification-structured-extraction-replay.js";
export * from "./verification/operations/verification-structured-extraction-candidate.js";
export * from "./verification/operations/verification-structured-extraction-publication.js";
export * from "./verification/operations/verification-structured-extraction-failure.js";
export * from "./verification/operations/verification-structured-extraction-result.js";
export * from "./verification/operations/verification-structured-extraction-failure-result.js";
export * from "./verification/operations/verification-structured-extraction-reads.js";
export * from "./verification/operations/verification-structured-extraction-runtime.js";
export * from "./verification/operations/verification-provider-reconciliation.js";
export * from "./verification/source-acquisition/verification-source-acquisition.js";
export * from "./verification/benchmark/verification-benchmark-version-diff.js";
export * from "./verification/benchmark/verification-benchmark-refresh-proposal.js";
export * from "./verification/operations/verification-capture-reads.js";
export * from "./verification/reads/verification-resource-reads.js";
export * from "./verification/benchmark/verification-benchmark-capture-profile.js";
export * from "./verification/operations/verification-context-binding.js";

// Diagnostics: quarantined offline demo and fixture helpers; export names kept for the CLI and scripts.
export * from "./diagnostics/verification-diagnostics-offline-catalog.js";
export * from "./diagnostics/verification-diagnostics-provider-grant.js";
export * from "./diagnostics/verification-diagnostics-adversarial.js";
export * from "./diagnostics/verification-diagnostics-mutation-report.js";
export * from "./diagnostics/verification-diagnostics-report-coverage.js";
export * from "./diagnostics/verification-diagnostics-quality-gates.js";

// Research coordination (Sprint V K04): one run writer, sealer and exact-use oracle over a research binding.
export * from "./research/index.js";
