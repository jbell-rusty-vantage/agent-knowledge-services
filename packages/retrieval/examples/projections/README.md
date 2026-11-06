# Projections examples

Run from the repository root with Node >=24 and installed workspace dependencies:

```sh
corepack pnpm --filter @aiengineer/knowledge-retrieval examples
corepack pnpm --filter @aiengineer/knowledge-retrieval typecheck
corepack pnpm --filter @aiengineer/knowledge-retrieval test
```

Or one at a time from `packages/retrieval`: `pnpm exec tsx examples/projections/01-validate-and-build.ts`.

Fixtures build evidence with `createSourceLocator` from `@aiengineer/knowledge-preparation`
directly. This exercises projection validation independently of conversion-provider routing.

| Example | Shows |
|---|---|
| [01-validate-and-build.ts](01-validate-and-build.ts) | Evidence validates before it builds; the same evidence and text yield the same `projectionId` on replay |
| [02-source-native-fidelity.ts](02-source-native-fidelity.ts) | A `source_native_sections` projection's text must equal the ordered evidence exactly; rewritten text and derived assertions are both rejected |
| [03-classify-dispositions.ts](03-classify-dispositions.ts) | Domain dispositions map to vector spaces; `not_ingestible` stands alone; a canonical disposition is refused while its entity identity is unresolved |

These are internal algorithm examples. External agents build projections through the
platform preparation pipeline, never imports from this package.
