# Knowledge Services feature map

One file per user-visible feature (SPEC-03 K5): what it does, where its code and tests are, how a user or agent reaches
it, one command that proves it, and its gotchas. Facts come from live source on 2026-11-18. Every proof command runs
offline: no database, no network, no model call. Run it from the repository root after `corepack pnpm build`, because
package exports point at `dist`. `./dev test <package> <file>` is the same command through the front door.

| Feature | What a user gets | Proof |
| --- | --- | --- |
| [Capture and registration](capture-and-registration.md#capture-and-registration) | Fetch or upload a source, keep it as an immutable capture, make it quotable | `./dev test knowledge-db src/capture/register.test.ts` |
| [Verification and admission](verification-and-admission.md#verification-and-admission) | Deterministic and semantic verification, policy admission, the governed claim chain | `./dev test verification examples/05-semantic-recorded-judge.test.ts` |
| [Retrieval and search](retrieval-and-search.md#retrieval-and-search) | Policy-scoped hybrid search that returns evidence packets | `./dev test retrieval src/search/retrieve.test.ts` |
| [Verification executor and the `knowledge` CLI](executor-and-knowledge-cli.md#verification-executor-and-the-knowledge-cli) | The schema workspace, bounded reads, ingestion and the chain over CLI, MCP and HTTP | `./dev test verification-executor src/knowledge/cli.test.ts src/tool-list.test.ts` |
| [Platform API, MCP and `ks`](platform-api-mcp-and-ks.md#platform-api-mcp-and-ks) | The platform's catalogued operations over HTTP, MCP and the `ks` CLI, run by the durable worker | `./dev test mcp src/tests/catalog.test.ts` |
| [Evaluation](evaluation.md#evaluation) | Retrieval evaluation datasets, verification benchmarks, the consumer-surface scorecard | `./dev test evaluation src/index.test.ts` |
| [Jev decisions](jev.md#jev-decisions) | Closed-choice decision jobs on a local queue with bounded workers | `./dev test apps/jev src/http.test.ts` |
| [Database release check](database-release-check.md#database-release-check) | Every process checks the AI Engineer database release at startup, refuses another release and reports the one it runs on | `./dev test persistence src/database-release.test.ts` |

How the features fit together is explained in the concept docs ([knowledge index](../knowledge/index.md#find-the-relevant-concept)). Database
variables and the local-by-default rule are in [ENVIRONMENT](../docs/ENVIRONMENT.md#plane-selection).
