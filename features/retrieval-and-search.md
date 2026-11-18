# Retrieval and search

**What it does.** `retrieve()` in `packages/retrieval` plans a policy-scoped search, runs lexical, semantic and graph
channels, fuses them, reranks (falling back to the fused order when reranking fails), checks coverage and abstains when
evidence is thin, and returns an immutable evidence packet. Embeddings go through the Vercel AI Gateway adapter, with a
deterministic fake for offline use; vector backends are in-memory exact and PostgreSQL. The platform's search calls the
application's canonical retrieval executor. Concept: [retrieval and
evidence](../knowledge/retrieval-and-evidence.md#retrieval-and-evidence).

**Code.** `packages/retrieval/src/{search,embeddings,vector-backends,projections}`;
`packages/application/src/knowledge/retrieval/canonical-retrieval-executor.ts`;
`packages/policy/src/retrieval-policy.ts`; `apps/api/src/routes/retrieval.ts`.

**Tests.** `packages/retrieval/src/search/retrieve.test.ts` and
`src/search/{plan,lexical,semantic,rerank,graph,spaces}/*.test.ts`;
`src/vector-backends/backends/{in-memory-exact,postgres}.test.ts` (the PostgreSQL one uses mocks);
`packages/application/src/knowledge/retrieval/canonical-retrieval-executor.test.ts`.

**Reach it.**
- Platform MCP: `knowledge_retrieve_search`, `knowledge_retrieve_plan`, `knowledge_retrieve_run`,
  `knowledge_retrieve_explain`, `knowledge_retrieve_packet`, `knowledge_retrieve_citations`,
  `knowledge_retrieve_build_packet`.
- `ks knowledge retrieve plan|search|explain|run|packet|citations` (remote profile).
- HTTP: `POST /v1/retrieval-runs`, `POST /v1/retrieval-plans:validate`, `GET /v1/retrieval-runs/:id[/explanation]`,
  `GET /v1/evidence-packets/:id[/citations]`, and A2A `POST /v1/a2a/tasks`. Each binding is a row in
  `packages/application/src/operations/catalog.ts`.

**Prove it.** `./dev test retrieval src/search/retrieve.test.ts`.

**Gotchas.**
- Inside the executor's bounded read intent (`knowledge db read-intent`), a `retrieval` operation is always
  `status: "skipped"`, reason `RETRIEVAL_UNAVAILABLE` (`packages/knowledge-db/src/db-read/read-executor.ts`), and the
  command still exits 0: skipped read operations count as success. Other skip reasons there: `REF_UNRESOLVED`,
  `ARTIFACTS_UNAVAILABLE`, `ARTIFACT_BYTES_UNAVAILABLE`.
- The gateway adapter throws `AI_GATEWAY_CREDENTIAL_MISSING` unless `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is set;
  `knowledge.retrieval_run` needs that embedding configuration.
- Citation replay needs Supabase Storage (the plane's URL and secret key).
- The documentation retrieval bench (`.agent-docs/retrieval-benchmark.mjs`) measures how well agents find the concept
  docs, not this feature; it runs in `./dev check`.
