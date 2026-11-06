import { defineConfig } from "vitest/config";

// Under Turbo's parallel package execution, fixture-heavy tests in this package
// (offline demo assets, attestation envelopes, in-process API servers) approach
// the Vitest 5 s default and intermittently time out with no behavioural change.
// Raising the ceiling keeps every assertion intact; tests that declare their own
// timeout are unaffected. See docs/workspaces/verification-module/stabilization-20260908/.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
