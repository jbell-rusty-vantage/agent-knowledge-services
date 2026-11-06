import type { EvidenceOracle } from "./facts.js";
import type { IngestionIntent } from "./intent.js";

/**
 * The production evidence oracle after SV-17. The executor-hosted file-store oracle is retired; the only admission
 * authority is the verification component's exact-use decision, admitted inside the native ingestion transaction by
 * `admitExactUseWithin` (the code path shared with the PostgreSQL research binding).
 *
 * A cited claim is eligible only when the intent carries an `exactUse` binding and declares the cited run; its text
 * is the intent's inline claim, bound by the decision's bound effect digest. Without `exactUse` no claim is eligible
 * (fail closed). The oracle never returns an `authoritative` claim, so no legacy verification.v1 provenance is
 * projected.
 */
export function exactUseEvidenceOracle(intent: IngestionIntent): EvidenceOracle {
  const declared = new Set(intent.exactUse ? intent.evidence.verificationRuns.map((run) => run.runId) : []);
  return {
    runSealed: async (runId) => declared.has(runId),
    claimEligible: async (runId) =>
      declared.has(runId) ? { eligible: true, verdict: "exact_use_bound", fixtureOnly: true } : { eligible: false },
  };
}
