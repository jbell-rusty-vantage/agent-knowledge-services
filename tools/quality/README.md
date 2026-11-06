# Quality gates

Mechanical gates that keep the code base from getting worse. They run in `pnpm verify` and CI, in this order:
`format:check`, `lint`, `typecheck`, `test`, `build`, `boundaries`, `examples:verification`.

| Command | What it does |
|---|---|
| `pnpm format` | Rewrites JavaScript/TypeScript source with Biome (`biome.json`). |
| `pnpm format:check` | Fails when any in-scope file is not formatted. |
| `pnpm lint` | Runs Biome lint through `lint-ratchet.mjs` and compares per-rule counts with `lint-baseline.json`. |
| `pnpm boundaries` | Runs dependency-cruiser (`.dependency-cruiser.cjs`) and ignores the violations in `boundaries-baseline.json`. Run it after `pnpm build`: workspace packages export `dist/`, so their edges resolve to `packages/<name>/dist/...` only once built. |

## Store-backed tests

The turbo `test` task forwards (and hashes) `KNOWLEDGE_DB_CONTRACT_ADMIN_DSN`, `KS_TEST_DATABASE_URL`,
`KS_TEST_PROJECT_DIR`, `KS_REQUIRE_CONFORMANCE_STORE` and `CI`, so `pnpm verify` runs the disposable-database suites when
they are set. Without the DSN the knowledge backend conformance checks that need a store are visible skips; with `CI` or
`KS_REQUIRE_CONFORMANCE_STORE=1` they fail.

## Scope

Formatting and lint cover `.ts .tsx .mts .cts .js .mjs .cjs` under `apps/`, `packages/`, `services/`, `scripts/` and
`tools/`. Nothing else is formatted: JSON, YAML, Markdown, `catalog/`, `fixtures/`, `vendor/`, `docs/`, `skills/`,
`knowledge/`, `infra/` and every `skills/` folder (skill packs are hashed and packaged as written) hold sealed, hashed or hand-written bytes, and `packages/persistence/src/promotion-selection.ts`
is excluded because `content-links.integration.test.ts` digests its source text. Add a file to `files.includes` exclusions in
`biome.json` when a test or example reads its bytes.

Line endings are `auto` (CRLF on Windows, LF elsewhere): with `core.autocrlf=true` the Windows working copy is CRLF while
CI checks out LF, and one fixed value would fail on one of them. Git stores LF either way.

## Lint ratchet

`lint-baseline.json` records the diagnostics per Biome rule. A rule with diagnostics is `warn` in `biome.json`; rules
with none keep Biome's recommended severity. `pnpm lint` fails when

- any rule's count is higher than its baseline,
- a rule that is not in the baseline reports anything, or
- Biome reports an error (including a parse error).

Counts may only fall. When they do, `pnpm lint` prints the lowered rules; commit the lower numbers with
`pnpm lint --update`, which rewrites the baseline only if nothing rose. Turn a rule with a zero count into an
`"error"` in `biome.json` and delete its baseline entry. A Biome upgrade can change rule sets: refresh the baseline in
the same commit as the upgrade and say so.

## Boundary baseline

`.dependency-cruiser.cjs` encodes the current FINAL-LAYOUT section 4 rules:

- `no-app-to-other-app` (tests included),
- `apps-import-host-contracts-client` (production app code; tests exempt; the executor's backend composition
  `apps/verification-executor/src/serve.ts` is the one exception),
- `executable-composes-backend-registrations` (that composition module may also import `packages/bindings/*`, for their
  `BACKEND` registrations; Sprint OC R5),
- `host-imports-no-app`,
- `host-imports-no-binding` (the host owns the knowledge backend port and registry; tests included),
- `packages-import-no-apps`,
- `knowledge-db-no-persistence-in-production`.

`boundaries-baseline.json` lists the violations that exist today. `pnpm boundaries` fails only on a violation that is
not in it. Remove entries when a refactor removes the import (regenerate with `pnpm build && pnpm boundaries:baseline`
and check the diff only deletes entries); never add one to make a check pass.

dependency-cruiser reads TypeScript through the `typescript` compiler API, which TypeScript 7 does not provide, so
`pnpm-workspace.yaml` (`packageExtensions`) gives dependency-cruiser its own TypeScript 6 copy. No workspace package
resolves it.
