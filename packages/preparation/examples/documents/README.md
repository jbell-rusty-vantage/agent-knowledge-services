# Documents examples

Run from the repository root with Node >=24 and installed workspace dependencies:

```sh
corepack pnpm --filter @aiengineer/knowledge-preparation examples
corepack pnpm --filter @aiengineer/knowledge-preparation typecheck
corepack pnpm --filter @aiengineer/knowledge-preparation test
```

Or one at a time from `packages/preparation`: `pnpm exec tsx examples/documents/01-build-nodes-and-verify-locators.ts`.

Each `NN-*.ts` module exports a small function over the readable converter output in
[fixtures.ts](fixtures.ts); `NN-*.test.ts` runs the same fixture in the ordinary package
test suite with one behavior per `it`. Nothing is mocked: the node builder, locator
construction and verification are the real ones, and no converter process runs (the
fixture stands in for its output).

| Stage | Example | Shows |
|---|---|---|
| nodes, locators | [01-build-nodes-and-verify-locators.ts](01-build-nodes-and-verify-locators.ts) | `convertStructuralDocument` seals frozen nodes with content-derived ids and normalized text; `verifyNodeLocators` returns no issues; `reconstructNodeSpan` slices the sealed text |
| rejection | [02-reject-cycle-and-invalid-span.ts](02-reject-cycle-and-invalid-span.ts) | a parent cycle and an unknown parent fail the whole document; an out-of-range or empty span is a `RangeError`; an edited node is reported as a quote digest mismatch |

Expected output: JSON on stdout. 01 prints `deterministic: true`, `locatorIssues: []` and
`span: "Workers"`; 02 prints one error message per rejected input and one locator issue.

These are internal algorithm examples. External agents obtain nodes through the platform
`document convert` command (or its MCP equivalent) taught by the
`knowledge-preparation-and-promotion` skill, never imports from this package.
