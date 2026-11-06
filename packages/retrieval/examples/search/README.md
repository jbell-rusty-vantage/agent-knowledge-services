# Retrieval examples

Run from the repository root with Node >=24 and installed workspace dependencies:

```sh
corepack pnpm --filter @aiengineer/knowledge-retrieval examples
corepack pnpm --filter @aiengineer/knowledge-retrieval typecheck
corepack pnpm --filter @aiengineer/knowledge-retrieval test
```

Or one at a time from `packages/retrieval`: `pnpm exec tsx examples/search/01-plan-and-admission.ts`.

Each `NN-*.ts` module exports a small function over the readable fixtures in
[fixtures.ts](fixtures.ts); `NN-*.test.ts` runs the same fixtures in the ordinary
package test suite with one behavior per `it`. Nothing is mocked: the records are
in-memory fixtures built by hand, and `buildRetrievalPlan`/`retrieve` are the real
pipeline functions.

| Stage | Example | Shows |
|---|---|---|
| plan and admission | [01-plan-and-admission.ts](01-plan-and-admission.ts) | policy-scoped plan decomposition; `SPACE_NOT_ADMITTED` for a space the policy never admitted; `FILTER_NOT_ALLOWED` for an unlisted filter field |
| fuse channels | [02-fuse-channels.ts](02-fuse-channels.ts) | exact/trigram/fts/semantic channels fusing into one ranked candidate; a verified graph edge expanding to its neighbor; an identical evidence-packet digest across two identical calls |
| abstain and omit | [03-abstain-and-omit.ts](03-abstain-and-omit.ts) | reasoned coverage abstention for a query nothing satisfies; tenant, promotion, visibility and retraction omissions each recorded by reason |

Expected output: JSON on stdout. 01 prints `subqueryCount`, `intents` and the two
denial messages; 02 prints `sameDigestTwice: true` and the top record's channels;
03 prints the abstention reason and the four omission reasons.

These are internal algorithm examples. External callers use the platform retrieval
HTTP/CLI contract (`apps/api`'s canonical retrieval path, `apps/cli`) taught by the
`knowledge-retrieval-and-evidence` skill, never an import from this package.
