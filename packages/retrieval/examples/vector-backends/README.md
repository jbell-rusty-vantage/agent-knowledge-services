# Vector-backends examples

Run from the repository root with Node >=24 and installed workspace dependencies:

```sh
corepack pnpm --filter @aiengineer/knowledge-retrieval examples
corepack pnpm --filter @aiengineer/knowledge-retrieval typecheck
corepack pnpm --filter @aiengineer/knowledge-retrieval test
```

Or one at a time from `packages/retrieval`: `pnpm exec tsx examples/vector-backends/01-exact-search.ts`.

One example per concern this package owns: exact search isolation, verified
publish/rollback, and reconciliation drift classification. Each `NN-*.ts`
module exports a small async function over the shared fixtures in
[fixtures.ts](fixtures.ts); `NN-*.test.ts` runs the same fixtures in the
ordinary package test suite with one behavior per `it`.

What is real and what is mocked: `InMemoryExactCosineBackend` and
`InMemoryPublicationRepository` are the real, shipped implementations — no
part of them is faked for these examples. `PublicationInspector` is a stub
(`StubPublicationInspector` in `fixtures.ts`); a real inspector would read the
store a publication host just wrote, which these examples never do. No
database is touched, and `PostgresVectorSearchBackend` has no example here —
see `src/vector-backends/backends/postgres.test.ts` for its stubbed-client behavior.

| Example | Shows |
|---|---|
| [01-exact-search.ts](01-exact-search.ts) | Tenant, vector-space version, and lifecycle isolation are filter predicates over one map; search is deterministic across repeated calls |
| [02-publish-and-rollback.ts](02-publish-and-rollback.ts) | A publish is verified against the stub inspection before the pointer moves; a replay of the same request is idempotent; rollback switches the pointer to an intact predecessor without deleting it |
| [03-reconcile-drift.ts](03-reconcile-drift.ts) | Reconciliation classifies drift by cause: a manifest mismatch and an orphan active pointer are `security_critical`, an evaluation regression is `review_required` |

Expected output: JSON on stdout. 01 lists `visibleItemIds` and `deterministic: true`;
02 prints `idempotentReplay: true` and the pointer after rollback; 03 prints
three `[code, classification]` lists, one per drift shape.

These are internal algorithm examples. External agents use the platform
`space publish` and `space rollback` commands (or their MCP equivalents)
taught by the `vector-store-management` skill, never imports from this package.
