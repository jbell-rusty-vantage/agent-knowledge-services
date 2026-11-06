# Unit 0: establish the cleanup baseline

> Current continuation: [NEXT-PACKAGE-CLEANUP.md](./NEXT-PACKAGE-CLEANUP.md) records the merged Jev starting point and the exact Unit 1 missing-fixture exception; it supersedes the earlier green-only prerequisite for that failure only.

Status: ready to execute. Parent: [final layout](./FINAL-LAYOUT.md). Findings: [R7–R8](./FINAL-REVIEW.md).

This prerequisite does not change the seven-unit target. Its purpose is to make the first mechanical merge measurable from a clean checkout.

## Work

1. Record source SHA, clean/dirty status, Node/pnpm versions and platform. Create an isolated branch/worktree when implementation starts. Read the testkit/source-specific guides before fixes. Do not overwrite another agent's edits.
2. Run `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify`. Capture separate typecheck/test/build/examples outcomes; a failure in an early stage means later stages were not run. Retain concise failure identities and exact commands in the ledger; keep raw logs outside committed docs.
   The preparation run also encountered a local Vitest worker-process failure and test failures under full-suite concurrency. Worker and executor coverage checks passed in focused limited-concurrency reruns. Diagnose test resource limits separately from the remote missing-fixture issue; preserve assertions and require a complete repeatable gate, not just isolated successes.
3. Resolve the known embedding fixture dependency in a small, separate prerequisite change. Inspect `packages/testkit/src/embedding-bundles.ts` and its two failing test files. Supply a repository-owned, appropriately scoped fixture or deterministic, digest-pinned CI setup. Validate the required `outputs/catalog.json` marker and all requested bundle files together. Do not copy private research content blindly, depend on a sibling checkout, skip tests, or synthesize weaker assertions. If the necessary content is unavailable, record the exact missing input and keep unit 1 queued.
4. Re-run the failure-specific tests, then the full gate in an isolated checkout without sibling research fixtures. Keep genuine integration tests on isolated disposable services; do not target the populated shared database. Never load local environment files merely to make tests pass.
5. Capture unit 1's before evidence for all thirteen source packages: test file/test identities, passed/failed/skipped totals and runtime export names. Resolve public type exports through TypeScript's symbol/declaration graph, including re-exports and aliases. Record export collisions per destination group. Record the frozen-lockfile install result and acyclic declared package graph.
6. Include preparation and retrieval example checks and current executor build/`pack:sandbox` smoke test in the baseline. Check installed CLI help and one offline example outside the workspace. Record unavailable checks precisely; do not equate a skipped integration suite with a pass.

## Acceptance and handoff

- A clean-checkout `verify` passes. Any baseline repair is reviewed as a distinct change before package moves; update the baseline SHA to include it.
- Evidence is recoverable: commit compact test/export inventories or attach an immutable CI artifact and record its URL and digest. Scratch paths alone are not a cross-agent handoff.
- Record commands, environment, counts, failures/skips, and evidence location in `workspace/PROGRESS.md`; enter the baseline commit, next package group, and exact next command.
- Unit 1 remains behavior-preserving. Its first merge is `knowledge-db`, followed by retrieval, preparation, core, and documentation. No new permission round is required for routine implementation already authorized by the developer.
