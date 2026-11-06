# Package cleanup inventory evidence

## Unit 2 evidence

`unit2-inventory.mjs` collects runtime exports of config/host/persistence, the declared manifest graph and sequential Vitest identities for API, MCP, worker, persistence and host, then compares them with explicit moved-test mapping. `unit2-before.json` is from `0d73dac` (dirty only with new, unimported host files and this script); `unit2-after.json` is from `e036bf0` with pending documentation edits. `unit2-validation.json` records the complete command outcomes and the fixture reassessment.

```powershell
node docs/operations/package-cleanup/workspace/evidence/unit2-inventory.mjs compare docs/operations/package-cleanup/workspace/evidence/unit2-before.json docs/operations/package-cleanup/workspace/evidence/unit2-after.json
```

## Unit 1 evidence

The `unit1-*` captures use integrated Jev baseline `99aeaa61483cec0ba720f21bce25b659cb302aab`, not the historical isolated checkout. Initial source status was clean. A forced build of all thirteen source packages and nine dependencies passed before capture (22/22 tasks, zero cached). Node was `v24.18.0` and pnpm `10.34.5`. Captures report dirty=true because coordinator documentation was being authored; no production-source change preceded the before captures. Per-group after captures precede their implementation commits; the [ledger](../PROGRESS.md) associates them with the reviewed commits.

- `unit1-before.json` and `unit1-before-tests.json` record the combined baseline.
- `unit1-<group>-after.json` and `unit1-<group>-after-tests.json` record each sequential merge; groups are `knowledge-db`, `retrieval`, `preparation` and `core`.
- `unit1-<group>-consumer-probe-before/after.ts` and matching JSON files record compiler probes against built declarations. Before captures name the baseline commit; later captures distinguish baseline/current commit and dirty state.
- `unit1-after.json` and `unit1-after-tests.json` are the final all-group captures after the four implementation commits.
- `unit1-validation.json` records command outcomes, full graph totals, the retained missing-fixture failure, packaging checks and temporary diagnostic log locations. `unit1-live-reference-audit.json` records the bounded live-source/navigation audit and preserved data identities.
- A package inventory is not a full-suite or database-integration pass. Temporary logs are diagnostic convenience; structured captures and the ledger are the durable evidence.

The consumer probes check that every public symbol resolves with its type/value use from built declarations. They do not prove full type-signature assignability equivalence. Runtime export lists compare names, not behavior. Mechanical source-diff review and existing behavioral tests provide complementary evidence. Do not infer a clean source tree solely from a capture's HEAD or build digest.

Group collection/comparison extends the same runners without changing the full comparison. For example, from the repository root:

```powershell
node docs/operations/package-cleanup/workspace/evidence/inventory.mjs compare-group knowledge-db docs/operations/package-cleanup/workspace/evidence/unit1-before.json docs/operations/package-cleanup/workspace/evidence/unit1-knowledge-db-after.json
node docs/operations/package-cleanup/workspace/evidence/test-inventory.mjs compare-group knowledge-db docs/operations/package-cleanup/workspace/evidence/unit1-before-tests.json docs/operations/package-cleanup/workspace/evidence/unit1-knowledge-db-after-tests.json
node docs/operations/package-cleanup/workspace/evidence/type-consumer-probe.mjs knowledge-db after
```

The exact missing historical judge checkpoint remains an explicit Unit 1 exception. No capture waives other failures, changes skip predicates, or proves later cleanup/Eve/release acceptance.

## Historical Unit 0 evidence

`inventory.mjs` records the thirteen source packages named in unit 1. It reads tracked test-file paths through `git ls-files`, resolves public exports through the installed TypeScript 7 compiler's symbol graph, imports each built `dist/index.js` to record actual runtime names, and checks the declared workspace manifest graph for cycles. Built files are untracked: their SHA-256 digests identify the bytes inspected but do not prove which source commit produced them.

`pending-before-exports.json` and `pending-before-tests.json` are observed captures from commit `82965b3c2087784297728bbaac42717a266cf23e` after the 28-package build passed. They remain **pending**, because the full baseline verification gate still has a missing-judge failure outside these thirteen packages. Both captures record a dirty working tree. The built runtime exports are identified by byte digests, but the build output is untracked, so the digests alone do not prove source provenance. Do not treat these captures as a green Unit 0 acceptance or rename them to `before*.json` until the coordinator resolves the full gate.

The pending export capture has 422 compiler-resolved source names and 189 imported runtime names across thirteen packages, no merge-group name collisions, and no manifest cycles. The pending test capture covers all 78 tracked test files, including 18 example tests: 684 test identities, with 652 passed, 32 skipped, and none failed. Every test run exited zero. File identities agree between the two captures.

From the repository root, after the baseline gate:

```powershell
node docs/operations/package-cleanup/workspace/evidence/inventory.mjs collect before docs/operations/package-cleanup/workspace/evidence/before.json
```

After unit 1's four packages are built:

```powershell
node docs/operations/package-cleanup/workspace/evidence/inventory.mjs collect after docs/operations/package-cleanup/workspace/evidence/after.json
node docs/operations/package-cleanup/workspace/evidence/inventory.mjs compare docs/operations/package-cleanup/workspace/evidence/before.json docs/operations/package-cleanup/workspace/evidence/after.json
```

The comparison exits nonzero for missing or added source/runtime names, type/value classification changes, missing or extra tracked test files (including example tests), or unavailable runtime exports. Inspect `collisions` and `manifestGraph.cycles` in each capture; collection exits nonzero if the declared graph has a cycle or built runtime imports fail.

`test-inventory.mjs` runs packages sequentially with at most two Vitest workers per package and stores test names and outcomes, while keeping raw Vitest JSON in a disposable OS temporary directory. Run it only after the coordinator releases test execution:

```powershell
node docs/operations/package-cleanup/workspace/evidence/test-inventory.mjs collect before docs/operations/package-cleanup/workspace/evidence/before-tests.json
node docs/operations/package-cleanup/workspace/evidence/test-inventory.mjs collect after docs/operations/package-cleanup/workspace/evidence/after-tests.json
node docs/operations/package-cleanup/workspace/evidence/test-inventory.mjs compare docs/operations/package-cleanup/workspace/evidence/before-tests.json docs/operations/package-cleanup/workspace/evidence/after-tests.json
```

The pending test capture was run sequentially at a maximum of two Vitest workers per package. The script reports skipped tests as skipped and records package failures independently; it does not substitute for the full `verify` gate.
