# Unit 1 specification: mechanical package merges

> Current continuation: [NEXT-PACKAGE-CLEANUP.md](./NEXT-PACKAGE-CLEANUP.md) records the merged Jev starting point and the exact Unit 1 missing-fixture exception; it supersedes the earlier green-only prerequisite for that failure only.

Status: landed locally on main; acceptance evidence is recorded in the ledger (2026-09-27), under the exact Unit 1 missing-fixture exception. Parent: [`FINAL-LAYOUT.md`](./FINAL-LAYOUT.md) §5, unit 1. Progress: [workspace ledger](./workspace/PROGRESS.md).

## 1. Goal

Reduce 13 packages to 4 by moving code, not changing it:

| New package (folder → npm name) | Absorbs | Source lines |
|---|---|---|
| `packages/core` → `@aiengineer/knowledge-core` | `domain`, `runtime`, `observability` | ~700 |
| `packages/preparation` → `@aiengineer/knowledge-preparation` | `conversion`, `documents`, `chunking` | ~2,600 |
| `packages/retrieval` → `@aiengineer/knowledge-retrieval` (name kept) | `retrieval`, `projections`, `embeddings`, `vector-backends` | ~3,050 |
| `packages/knowledge-db` → `@aiengineer/knowledge-db` | `schema-workspace`, `db-read`, `ingestion` | ~5,900 |

**No behavior change.** Every exported name that existed before exists after, from the new package's root. No function, schema, route, MCP tool, SQL, persisted string, or test assertion changes.

## 2. Non-goals

Out of scope for this unit; each belongs to a later unit in `FINAL-LAYOUT.md`:

- `packages/config` (absorbed by `packages/host` in unit 2).
- Renaming `acquisition`, `client-typescript`, `services/verification-parser` (unit 4).
- Subpath exports (`@aiengineer/knowledge-core/domain`, …). Add one only if a later unit shows a bundle-size or name-collision reason.
- Renaming files or folders inside a moved package, or reorganizing its internals.
- Collapsing the two `deterministicUuid` functions (`runtime`: `(namespace, value)`; `documents`: `(value)`). They land in different packages and do not collide.
- Rewriting dated review records and phase memos (see §8).
- Re-running or re-sealing historical proofs.

## 3. Pre-checks already done

- **No export-name collisions inside any group.** Every `export const|function|class|type|interface|enum` name across each group's `src/` was compared (2026-09-27); none repeats inside a group. A single root barrel per new package is therefore safe.
- **No dependency cycle.** The resulting graph is:
  - `core` → `contracts`
  - `preparation` → `contracts`, `core`
  - `retrieval` → `contracts`, `core`, `preparation` (projections uses documents)
  - `knowledge-db` → `contracts`, `core`, `persistence`, `@aiengineer/database-contract`, `zod`; devDependency `preparation`
  - `persistence` → `application` → `core`, `preparation`, `retrieval`, …; nothing upstream depends on `knowledge-db`.
- **No external consumer.** All thirteen packages are `private: true` and workspace-only. Mission Control uses `KnowledgeClient` over HTTP. No compatibility shim packages are published.

These are the original pre-check claims, not substitutes for before/after evidence. Recheck compiler-resolved public barrels and actual consumer references at the implementation SHA; private package metadata alone does not prove absence of sibling consumers. The graph is acyclic for **this unit**. Before unit 5 adds `application → knowledge-db`, invert the remaining `knowledge-db → persistence` dependency (final review R1). Do not mix that architectural change into these moves.

## 4. Target folder layout

Each absorbed package's `src/` moves to a subfolder named after the old package; the one exception is the retrieval pipeline itself, which becomes `search/`. `examples/` and `test/` follow the same pattern.

```
packages/core/
  package.json  tsconfig.json
  src/index.ts                     export * from "./domain/index.js"; "./runtime/index.js"; "./observability/index.js"
  src/domain/…                     ← packages/domain/src/…
  src/runtime/…                    ← packages/runtime/src/…
  src/observability/…              ← packages/observability/src/…

packages/preparation/
  package.json  tsconfig.json  tsconfig.examples.json
  src/index.ts                     re-exports ./documents, ./chunking, ./conversion
  src/conversion/…                 ← packages/conversion/src/…
  src/documents/…                  ← packages/documents/src/…
  src/chunking/…                   ← packages/chunking/src/…
  examples/{conversion,documents,chunking}/…   ← each package's examples/

packages/retrieval/
  package.json  tsconfig.json  tsconfig.examples.json
  src/index.ts                     re-exports ./vector-backends, ./search, ./embeddings, ./projections
  src/search/…                     ← packages/retrieval/src/… (retrieve.ts, plan/, lexical/, semantic/, graph/, rerank/, spaces/, types.ts)
  src/projections/…                ← packages/projections/src/…
  src/embeddings/…                 ← packages/embeddings/src/…
  src/vector-backends/…            ← packages/vector-backends/src/…
  examples/{search,projections,embeddings,vector-backends}/…

packages/knowledge-db/
  package.json  tsconfig.json
  src/index.ts                     re-exports ./schema-workspace, ./db-read, ./ingestion
  src/schema-workspace/…           ← packages/schema-workspace/src/…
  src/db-read/…                    ← packages/db-read/src/…
  src/ingestion/…                  ← packages/ingestion/src/… (including src/tests/)
  test/schema-workspace/fixtures/… ← packages/schema-workspace/test/fixtures/…
  test/ingestion/…                 ← packages/ingestion/test/…
```

Each root `src/index.ts` keeps the explanatory banner comments the old barrels carry (for example the retrieval barrel's "Pipeline"/"Internal" notes), under one `// <former package>` heading per section. Old barrels become `src/<former>/index.ts` unchanged.

Use `git mv` for every move so history follows the files.

## 5. Package manifests

Template for all four (mirrors the existing packages):

```json
{
  "name": "@aiengineer/knowledge-<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "<one line, from FINAL-LAYOUT §3>",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm && tsc --emitDeclarationOnly --rootDir src --outDir dist",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "examples": "tsc --noEmit -p tsconfig.examples.json"
  },
  "dependencies": { },
  "devDependencies": { "tsup": "catalog:", "typescript": "catalog:", "vitest": "catalog:" }
}
```

- `core` and `knowledge-db` have no `examples` script or `tsconfig.examples.json`.
- `dependencies` per §3. `knowledge-db` keeps `"@aiengineer/database-contract": "file:../../vendor/aiengineer-database-contract-0.4.16.tgz"` (same relative depth; the folder stays directly under `packages/`), `zod: catalog:`, and `@types/node: catalog:` as a devDependency.
- `tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"] }`. `tsconfig.examples.json`: extends it and adds `"examples/**/*.ts"`.
- Remove obsolete absorbed package folders once their tracked contents are accounted for. Keep `packages/retrieval/`, which is both a source and destination. Do not recursively delete ignored/untracked local material while moving tracked code.

## 6. Import rewrites

### 6.1 Package-name codemod (consumers outside the group)

Apply to explicitly enumerated tracked source/config files in `apps/`, `packages/`, and `scripts/` for `*.ts`, `*.mts`, `*.mjs`, and package manifests. Inspect named live `internal/` consumers from §6.3 individually. Exclude generated output, artifacts, runs, receipts, caches, dependencies, and historical material; do not recursively enumerate `internal/`:

| Old specifier | New specifier |
|---|---|
| `@aiengineer/knowledge-domain`, `-runtime`, `-observability` | `@aiengineer/knowledge-core` |
| `@aiengineer/knowledge-conversion`, `-documents`, `-chunking` | `@aiengineer/knowledge-preparation` |
| `@aiengineer/knowledge-retrieval`, `-projections`, `-embeddings`, `-vector-backends` | `@aiengineer/knowledge-retrieval` |
| `@aiengineer/knowledge-schema-workspace`, `-db-read`, `-ingestion` | `@aiengineer/knowledge-db` |

Measured blast radius (files naming each old specifier, 2026-09-27): domain 180, runtime 220, conversion 61, db-read 48, schema-workspace 45, documents 20, ingestion 19, embeddings 14, chunking 11, retrieval 6, vector-backends 4, projections 3, observability 1.

- A file importing two old packages that now share one name ends up with two `import` lines from the same specifier. That is valid TypeScript; merge them only when it is trivial.
- In each `package.json`, replace old dependency keys with the new one, deduplicate, and keep the original section (`dependencies` vs `devDependencies`). Root `package.json` `dependencies` gets the same treatment.
- Regenerate `pnpm-lock.yaml` with `corepack pnpm install`. Never hand-edit it.

### 6.2 Inside a merged package

A package cannot import itself by name before it is built. Replace intra-group specifiers with relative imports to the sibling folder's barrel:

| In | Old | New |
|---|---|---|
| `core/src/runtime/**`, `core/src/observability/**` | `@aiengineer/knowledge-domain` | `../domain/index.js` (adjust depth) |
| `preparation/src/chunking/**` | `@aiengineer/knowledge-documents` | `../documents/index.js` |
| `retrieval/src/search/**` | `@aiengineer/knowledge-vector-backends` | `../vector-backends/index.js` |
| `knowledge-db/src/db-read/**` | `@aiengineer/knowledge-schema-workspace` | `../schema-workspace/index.js` |
| `knowledge-db/src/ingestion/**` | `@aiengineer/knowledge-db-read`, `-schema-workspace` | `../db-read/index.js`, `../schema-workspace/index.js` |

Cross-group imports (for example `projections` → `documents`, now `retrieval` → `preparation`) use the new package name from §6.1.

### 6.3 Path-sensitive files (fix by hand)

These use relative filesystem paths whose depth changes by one level:

| File (old path) | What to fix |
|---|---|
| `schema-workspace/src/schema-workspace.test.ts:12` | `"../test/fixtures/workspace"` → `"../../test/schema-workspace/fixtures/workspace"` |
| `ingestion/src/tests/plan.test.ts:157` | `"../../../schema-workspace/test/fixtures/workspace"` → `"../../../test/schema-workspace/fixtures/workspace"` |
| `ingestion/src/tests/executor.integration.test.ts` | `../../test/*.mjs` → `../../../test/ingestion/*.mjs`; `../../../persistence/test/disposable.mjs` and the `ai-engineer-db-contract/workspace` path each gain one `../` |
| `db-read/src/snapshot.integration.test.ts:16`, `db-read/src/read-executor.integration.test.ts:15` | `ai-engineer-db-contract/workspace` path gains one `../` |
| `ingestion/test/temporal.integration.test.ts`, `ingestion/test/current-schema.integration.test.ts` | `ai-engineer-db-contract/workspace` path gains one `../`; `../src/<file>.js` → `../../src/ingestion/<file>.js` |
| `ingestion/test/*.mjs` and `*.d.mts` | `../src/<file>.js` → `../../src/ingestion/<file>.js` |
| every `examples/**/*.ts` in preparation and retrieval | `"../src/index.js"` → `"../../src/index.js"` (sibling `./0N-*.js` imports unchanged) |

Deep imports into package internals from outside:

| File | Fix |
|---|---|
| `apps/verification-executor/src/knowledge/{admission,content-links,provenance,record-materialization,report-assessment}.integration.test.ts`, `selected-candidate-fixture.ts` | `packages/ingestion/test/*.mjs` → `packages/knowledge-db/test/ingestion/*.mjs`; `packages/ingestion/src/content-links/operations.js` → `packages/knowledge-db/src/ingestion/content-links/operations.js`; `packages/embeddings/src/index.js` → `packages/retrieval/src/index.js` |
| `scripts/live-gate1.ts`, `evaluate-real-bundles.ts`, `live-gateway-embeddings.ts`, `validate-gate5-human-review.ts`, `prove-verification-parser-v2-visible.ts`, `prove-verification-provider-{accounting,operation-scope,response-capture}.ts`, `.verification-remote-accounting-*.ts` | `../packages/<old>/src/<file>` → `../packages/<new>/src/<old-folder>/<file>` |
| `scripts/prove-verification-parser-review.mjs`, `-v2.mjs`, `prove-report-packages.mjs`, `prove-verification-benchmark-freeze-v4.ts` | `../packages/<old>/dist/index.js` → `../packages/<new>/dist/index.js`; source-path lists in `-v2.mjs` updated to new paths |
| `scripts/run-verification-security-regressions.mjs:12` | `cwd:'packages/conversion', files:['src/verification-parser.test.ts']` → `cwd:'packages/preparation', files:['src/conversion/verification-parser.test.ts']` |
| `internal/audit-verification-canonical-write-paths.mjs:37-38` | `packages/conversion/src/{deterministic,providers}.ts` → `packages/preparation/src/conversion/…` |

Historical proof receipts that recorded digests over old source paths will not match if those proofs are re-run. That is expected; do not re-seal them in this unit.

### 6.4 Do not change

`packages/persistence/src/preparation.ts` lines ~176, ~295, ~300 write `'packages/conversion'` and `digestHex("packages/chunking")` into database rows as procedure identities, and `CHUNK_PROCEDURE_CONFLICT` compares against them. They are persisted identifiers, not paths. Leave the strings exactly as they are and add one comment above each: `// Persisted procedure identity; not a filesystem path. Do not rename.`

## 7. Suggested commit sequence

One PR, four package commits plus documentation, smallest blast radius first so a failure isolates to one group. Each package commit must pass install, typecheck and tests on its own. Run commands separately in PowerShell and stop on a failed exit code; `&&` examples assume a shell that supports it.

1. `knowledge-db` (schema-workspace, db-read, ingestion)
2. `retrieval` (retrieval, projections, embeddings, vector-backends)
3. `preparation` (conversion, documents, chunking)
4. `core` (domain, runtime, observability) — widest codemod, last
5. Docs commit (§8)

Per commit: `git mv` sources → write manifest, tsconfig, root barrel → intra-group rewrites (§6.2) → path fixes (§6.3) → consumer codemod (§6.1) → `corepack pnpm install` → checks.

## 8. Documentation updates

Update live navigation in the docs commit:

- `.agent-docs/modules.json`: replace the 13 module entries with 4 (descriptions: union of the old ones, one line); update module ids referenced from `.agent-docs/config.json` (`docs[].modules`, `routes`, and the knowledge schema/read/ingest rule, which becomes `packages/knowledge-db`); update the source path list at `config.json` ~line 393. Then `node .agent-docs/cli.mjs build --repo .` to regenerate `AGENTS.md`, `packages/AGENTS.md`, and `docs/agents/CODE-MAP.md`, and `node .agent-docs/cli.mjs check --repo .`.
- `knowledge/*.md` (six concept files): update package paths.
- `apps/verification-executor/README.md` lines 104–106, `services/verification-parser/README.md`, `skills/knowledge-preparation-and-promotion/{SKILL.md,examples.md}`, `docs/operations/conversion-and-chunking.md`: update paths.
- Do **not** rewrite `docs/operations/reviews/*.md`, the phase memos in this folder, `docs/specifications/*`, or `docs/REPORTS.md`; they are dated. `FINAL-LAYOUT.md` §6 carries the mapping.

## 9. Acceptance criteria

1. `corepack pnpm install` succeeds; `pnpm-lock.yaml` regenerated.
2. `corepack pnpm verify` is green (typecheck, test, build, `examples:verification`).
3. **Test identities and outcomes preserved.** Record file/test identities and passed/failed/skipped totals for the 13 old packages and four new packages; match through the move map, with no lost tests or new skips. Original test-file counts (core 5, preparation 14, retrieval 31, knowledge-db 28) are historical hints; use unit 0's actual baseline.
4. **Public exports preserved.** Compare built runtime export names against unit 0's snapshot. Use the TypeScript symbol/declaration graph to resolve public type exports, `export *`, and aliases; textual presence in a root `index.d.ts` is insufficient. Compile before/after consumer probes for existing type contracts. Retain compact evidence or an immutable artifact URL/digest in the ledger; raw build output can stay outside the repository.
5. Search old package specifiers in explicitly selected tracked live sources, package manifests, root scripts/config, and live docs. No old imports or dependency keys remain. Audit the regenerated lockfile separately. Exclude historical docs/receipts and dependency/output directories; report the searched scope and deliberate exclusions.
6. Search old filesystem paths over the same bounded inventory, including named live scripts and fixture resolution. No unresolved live paths remain. Preserve the exact procedure identity strings in `packages/persistence/src/preparation.ts` (§6.4); do not mistake these identities for paths. Keep historical evidence and review records unchanged.
7. `node .agent-docs/cli.mjs check --repo .` passes.
8. Integration tests that need Postgres or the sibling `ai-engineer-db-contract` checkout (`*.integration.test.ts` in knowledge-db and the executor) pass locally where those are available; if not run, the PR says so.
9. `git log --follow` on a sample moved file (for example `packages/knowledge-db/src/db-read/read-executor.ts`) shows its pre-move history.
10. Run the preparation and retrieval `examples` scripts explicitly (root `verify` covers verification examples only), then build and run the executor's `pack:sandbox` check and installed CLI smoke test from the baseline. Verify source-relative assets/fixtures, not only TypeScript imports.

## 10. Risks

| Risk | Mitigation |
|---|---|
| A relative path missed in §6.3 only fails in an integration test not run by default | Run the integration suites locally (criterion 8); `rg -n "import.meta.dirname" packages/{core,preparation,retrieval,knowledge-db}` after the move and re-check each hit |
| Barrel ordering changes module initialization order | Barrels only re-export. Order root sections in old dependency order (domain → runtime → observability; documents → chunking → conversion; vector-backends → search → embeddings → projections; schema-workspace → db-read → ingestion) and keep each old barrel's order unchanged inside its section |
| tsup bundles a larger root for consumers that used one small package | Acceptable for server apps; revisit with subpath exports only if a measured Vercel bundle limit is hit |
| `verification-executor` sandbox packaging (`scripts/pack-sandbox.mjs`) bundles by package | It bundles `@aiengineer/*` via `noExternal` and names skills, not packages; no change expected. Run `pnpm --filter @aiengineer/knowledge-verification-executor pack:sandbox` once to confirm |
| Merge conflicts with in-flight branches | Land this unit before starting unit 2; it is mechanical and quick to rebase by re-running the codemod |
