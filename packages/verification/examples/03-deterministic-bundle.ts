import { verifyDeterministicBundle, type DeterministicVerificationResult } from "../src/index.js";
import { corruptedInput, passingInput } from "./bundle-fixture.js";

/**
 * Stage 1 — capture integrity, then mechanical assertion checks. The engine
 * never trusts a declared digest: it re-hashes the supplied bytes. A
 * same-length corruption therefore fails `CAPTURE_DIGEST_MATCH`, and because
 * deterministic failure is monotonic the bundle loses semantic eligibility.
 */
export interface DeterministicBundleExample {
  readonly passing: DeterministicVerificationResult;
  readonly corrupted: DeterministicVerificationResult;
}

export function deterministicBundleExample(): DeterministicBundleExample {
  return {
    passing: verifyDeterministicBundle(passingInput()),
    corrupted: verifyDeterministicBundle(corruptedInput()),
  };
}

export function summarize(result: DeterministicVerificationResult) {
  return {
    status: result.status,
    semanticEligibility: result.semanticEligibility,
    failedCheckCodes: result.summary.failedCheckCodes,
    assertions: result.assertions.map((assertion) => ({
      assertionId: assertion.assertionId,
      status: assertion.status,
      semanticEligibility: assertion.semanticEligibility,
    })),
  };
}
