import { defineConfig } from "vitest/config";

// Verification fixture tests copy and rehash multi-megabyte sealed fixtures on disk.
// Under Turbo's parallel package execution they approach the Vitest 5 s default and
// intermittently time out without any behavioural change (see
// docs/workspaces/verification-module/swarm-plan-20260906/SW-00-FULL-VERIFY-REGRESSION.md).
// Raising the ceiling keeps every assertion intact; tests that declare their own
// timeout are unaffected.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
