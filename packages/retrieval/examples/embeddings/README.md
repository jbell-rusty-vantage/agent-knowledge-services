# Embeddings examples

Run from the repository root with Node >=24 and installed workspace dependencies:

```sh
corepack pnpm --filter @aiengineer/knowledge-retrieval examples
corepack pnpm --filter @aiengineer/knowledge-retrieval typecheck
corepack pnpm --filter @aiengineer/knowledge-retrieval test
```

Or one at a time from `packages/retrieval`: `pnpm exec tsx examples/embeddings/01-deterministic-batch.ts`.

| Example | Shows |
|---|---|
| [01-deterministic-batch.ts](01-deterministic-batch.ts) | `DeterministicFakeEmbeddingAdapter`: stable input ordering and an identical output manifest digest across two runs |
| [02-cache-and-retry.ts](02-cache-and-retry.ts) | `VercelAiGatewayEmbeddingAdapter`: one idempotency key survives a `503` retry; a repeat request for the same `vectorSpaceVersionId` is served from the cache instead of calling out again |
| [03-reject-bad-output.ts](03-reject-bad-output.ts) | Reordered, partial, wrong-dimension and non-finite provider responses are each rejected before reaching the caller |

**No example and no test makes a live provider call.** Examples 02 and 03 pass a stub
`fetch` function to `VercelAiGatewayEmbeddingAdapter`; it never reaches
`https://ai-gateway.vercel.sh`. `gateway.test.ts` follows the same rule. External agents
embed through the platform `embed run` / `embed verify` / `embed status` commands (or
their MCP equivalents) taught by the `knowledge-preparation-and-promotion` skill, never
imports from this package.
