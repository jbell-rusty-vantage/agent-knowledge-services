# Chunking examples

Run from the repository root with Node >=24 and installed workspace dependencies:

```sh
corepack pnpm --filter @aiengineer/knowledge-preparation examples
corepack pnpm --filter @aiengineer/knowledge-preparation typecheck
corepack pnpm --filter @aiengineer/knowledge-preparation test
```

Or one at a time from `packages/preparation`: `pnpm exec tsx examples/chunking/01-select-profiles-for-space.ts`.

One example per stage of the select → preview → QA loop in
[`docs/operations/conversion-and-chunking.md`](../../../../docs/operations/conversion-and-chunking.md).
Each `NN-*.ts` module exports a small function over the readable fixtures in
[fixtures.ts](fixtures.ts); `NN-*.test.ts` runs the same fixtures in the ordinary
package test suite with one behavior per `it`. Nothing is mocked: the fixtures are
sealed trees built with `convertStructuralDocument`, and the registry, chunker and
QA are the real ones.

| Stage | Example | Shows |
|---|---|---|
| select | [01-select-profiles-for-space.ts](01-select-profiles-for-space.ts) | `forSpace` ∩ observed node kinds via `forSpaceAndNodeKinds`; `table-row-groups-v1` is skipped for a tree without tables |
| preview | [02-chunk-and-reconstruct.ts](02-chunk-and-reconstruct.ts) | `chunkDocument` with `heading-sections-v1`; every span reconstructs to `sourceText`, repeated boilerplate is omitted, `outputDigest` is deterministic |
| QA | [03-qa-failure-next-profile.ts](03-qa-failure-next-profile.ts) | `atomic-claims-v1` fails `qa.valid` on a run-on transcript turn; the next profile admitted for `engineering_claims` and `transcript_segment` passes |

Expected output: JSON on stdout. 01 lists `selected` and `skipped` profiles; 02 prints
`everySpanReconstructs: true` and `deterministic: true`; 03 prints two attempts, the
first invalid with an `exceeds maximum source tokens` issue, then `accepted`.

These are internal algorithm examples. External agents use the platform `chunk preview`
and `chunk build` commands (or their MCP equivalents) taught by the
`knowledge-preparation-and-promotion` skill, never imports from this package.
