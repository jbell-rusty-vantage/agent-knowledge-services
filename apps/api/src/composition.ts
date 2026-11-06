import type { ApiHost } from "@aiengineer/knowledge-host";
import type { ServerOptions } from "./server.js";

/** Maps host-composed services onto the HTTP server's existing option names. */
export function apiServerOptions(host: ApiHost): ServerOptions {
  const { knowledge, operations, verify } = host;
  const { runtime } = verify;
  return {
    ...(verify.benchmarkReads ? { verificationBenchmarkReads: verify.benchmarkReads } : {}),
    ...(verify.benchmarkComparisonReads
      ? { verificationBenchmarkComparisonReads: verify.benchmarkComparisonReads }
      : {}),
    ...(verify.providerReconciliation ? { verificationProviderReconciliation: verify.providerReconciliation } : {}),
    ...(verify.structuredExtractionReads
      ? { verificationStructuredExtractionReads: verify.structuredExtractionReads }
      : {}),
    ...(verify.captureReads ? { verificationCaptureReads: verify.captureReads } : {}),
    ...(verify.resolveBenchmarkCaptureProfile
      ? { resolveVerificationBenchmarkCaptureProfile: verify.resolveBenchmarkCaptureProfile }
      : {}),
    ...(host.publicOrigin ? { publicOrigin: host.publicOrigin } : {}),
    ...(operations
      ? {
          operationService: operations.service,
          retrievalOperationService: operations.retrieval,
          callbackReplayStore: operations.callbackReplay,
          ...(knowledge.resources ? { resourceReader: knowledge.resources } : {}),
          ...(runtime.verificationConfigured
            ? {
                ...(runtime.verificationOperationService
                  ? { verificationOperationService: runtime.verificationOperationService }
                  : {}),
                ...(runtime.verificationCaptureCatalog
                  ? { verificationCaptureCatalog: runtime.verificationCaptureCatalog }
                  : {}),
                ...(runtime.isParseArtifactRequestAdmitted
                  ? { isParseArtifactRequestAdmitted: runtime.isParseArtifactRequestAdmitted }
                  : {}),
                ...(runtime.isStructuredExtractionRequestAdmitted
                  ? { isStructuredExtractionRequestAdmitted: runtime.isStructuredExtractionRequestAdmitted }
                  : {}),
                ...(runtime.isBenchmarkRequestAdmitted
                  ? { isBenchmarkRequestAdmitted: runtime.isBenchmarkRequestAdmitted }
                  : {}),
                ...(runtime.isBenchmarkComparisonRequestAdmitted
                  ? { isBenchmarkComparisonRequestAdmitted: runtime.isBenchmarkComparisonRequestAdmitted }
                  : {}),
                ...(runtime.resolveVerificationContext
                  ? { resolveVerificationContext: runtime.resolveVerificationContext }
                  : {}),
              }
            : {}),
          ...(knowledge.canonicalRetrievalExecutor
            ? { canonicalRetrievalExecutor: knowledge.canonicalRetrievalExecutor }
            : {}),
          ...(knowledge.replayEvidencePacketCitations
            ? { replayEvidencePacketCitations: knowledge.replayEvidencePacketCitations }
            : {}),
          ...(knowledge.getEvidencePacket ? { getEvidencePacket: knowledge.getEvidencePacket } : {}),
        }
      : {}),
  };
}
