/** Explicit synthetic compatibility fixture; never imported by production composition. */
export function declaredRunsOracle(intent) {
  const declared = new Set(intent.evidence.verificationRuns.map((run) => run.runId));
  return {
    runSealed: async (runId) => declared.has(runId),
    claimEligible: async (runId) =>
      declared.has(runId) ? { eligible: true, verdict: "declared_run", fixtureOnly: true } : { eligible: false },
  };
}
