# Knowledge Services technology stack

Status: reference. Versions and boundaries are observed in checked-in manifests after slice 5P; consult those manifests before installing or upgrading. This page describes this repository, not a workspace-wide stack policy.

## Runtime and builds

| Technology | Purpose | Authoritative file |
| --- | --- | --- |
| Node.js 24 or later, ESM | Service, worker and CLI runtime; Jev child processes and local SQLite. | [Root package](../../package.json), [Jev service](../../packages/jev/src/service.ts) |
| pnpm 10.34.5 workspaces | Package resolution and shared version catalog. | [package.json](../../package.json), [workspace catalog](../../pnpm-workspace.yaml) |
| TypeScript 7.0.2, tsup 8.5.1, tsx 4.23.13 | Types, package bundles and source commands. | [Workspace catalog](../../pnpm-workspace.yaml) |
| Turborepo 2.10.12 | Workspace build, test and typecheck graph. | [Workspace catalog](../../pnpm-workspace.yaml) |
| Fastify 5.12.1, MCP SDK 1.30.0, Zod 4.5.4 | HTTP transport, MCP transport and runtime contract validation. | [Workspace catalog](../../pnpm-workspace.yaml) |

Package names and public export subpaths come from each package manifest. Internal algorithm packages are not cross-repository SDKs; use [client](../../packages/client/package.json) and [contracts](../../packages/contracts/package.json). API and MCP share in-process application services, while the remote CLI uses HTTP.

## Persistence and external boundaries

- Postgres/Supabase adapters live in [persistence](../../packages/persistence/package.json), using `pg` 8.16.3. The vendored database contract is 0.4.16 in persistence, knowledge-db and the executor manifests. Migrations remain owned by the sibling contract repository. A package pin is not proof the target database has that migration head.
- Postgres/pgvector is the canonical retrieval backend in [ADR 0003](0003-embedding-retrieval-evaluation.md). Exact local cosine is an evaluation oracle, not an alternative canonical store.
- Object/artifact custody and operation records belong to the service's configured persistence adapters. Local verification and Jev have explicit local storage profiles; they do not duplicate shared schema authority.
- [Docling](../../services/docling/compose.yaml) is an independently configured, image-digest-pinned conversion service. The [native parser](../../services/parser/Dockerfile) uses pinned Python 3.12.12 with [requirements](../../services/parser/requirements.txt) and a bounded stdin/stdout protocol. These are distinct from TypeScript deterministic text conversion.
- Provider adapters and configured capabilities determine whether embedding, semantic judgment or document conversion can run. A configured environment variable or present adapter is not a successful live conformance proof.

## Tests and quality tools

[Root scripts](../../package.json) compose Vitest tests, typechecking, builds, Biome 2.5.14 formatting, the lint ratchet, dependency-cruiser 18.4.0 boundaries and verification examples in `pnpm verify`. Dependency-cruiser receives its own TypeScript 6.0.3 compiler API compatibility dependency; workspace code still uses its catalog compiler. See [quality tooling](../../tools/quality/README.md).

Database integration tests and live-provider proofs have explicit prerequisites and are not implied by the existence of unit tests. Documentation build/check and skill conformance are separate commands. See [evaluation gates](../../knowledge/evaluation-and-publication-gates.md) for what each form of evidence supports.

## Consumer tooling is separate

TypeScript DeepAgents/LangGraph is the planned research-consumer harness under the sibling research-agent repository, not the KS service runtime. Its model routes, checkpoints and stage permissions are governed by [readiness DR1–DR5](../operations/package-cleanup/DEEPAGENTS-READINESS.md). Do not add its proposed runtime or shared database requirements to every KS service merely because it consumes KS.
