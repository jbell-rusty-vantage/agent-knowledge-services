# Acquisition examples

Runnable, mocked demonstrations of the internal acquisition and inspection fallbacks. Default examples need no vendor key.

From `packages/sources`:

```bash
pnpm exec tsx examples/01-http-acquire.ts
pnpm exec tsx examples/02-upload-acquire.ts
pnpm exec tsx examples/03-inspect-bytes.ts
pnpm exec tsx examples/04-http-then-inspect.ts
pnpm exec tsx examples/05-paper-resolve-then-http.ts
pnpm exec tsx examples/06-http-policy-failure.ts
pnpm exec tsc --noEmit -p tsconfig.examples.json
```

| File | Sequence | What is mocked |
|---|---|---|
| `01-http-acquire.ts` | plan → execute → verify | injected `fetch` |
| `02-upload-acquire.ts` | local fixture file + attestation | none (real file under `examples/fixtures`) |
| `03-inspect-bytes.ts` | read + search + observe | none |
| `04-http-then-inspect.ts` | acquire then inspect | injected `fetch` |
| `05-paper-resolve-then-http.ts` | resolve identity → one HTTP target | fixture paper resolution + injected `fetch` |
| `06-http-policy-failure.ts` | private DNS answer | mocked resolver |

Expected shape: JSON on stdout with a sealed digest or a policy error, `artifactCount: 1` on success, and no secret values in inspection output.

Platform `source inspect` is not admitted. Agents inspect sealed bytes with executor `verify_read_capture` / `verify_search_capture` or this package API.

## Wiring status

The root barrel (`src/index.ts`) groups adapters under the same banners. "Library only" means the code is exported, tested, and used by examples or scripts, but no host constructs it. Decisions that block wiring are recorded in [`docs/operations/reviews/acquisition.md`](../../../docs/operations/reviews/acquisition.md) (provider restrictions) and [`docs/operations/internal-fallbacks-and-application-order.md`](../../../docs/operations/internal-fallbacks-and-application-order.md) (capture cardinality, provider composition).

| Adapter | Folder | Wired in | Decision that blocks wiring |
|---|---|---|---|
| `RoutedAcquisitionAdapter` | `src/route.ts` | `apps/worker/src/index.ts` (`knowledge.capture/v1`) | n/a |
| `ExactHttpAcquisitionAdapter` | `src/http/` | `apps/worker/src/index.ts`; `apps/verification-executor/src/root-host-preparation.ts`; HTTP policy and pinned transport in `packages/application/src/verification/source-acquisition/` | n/a |
| `BoundedManualUploadAdapter` + `FilesystemManualUploadSource` | `src/upload/` | `apps/worker/src/index.ts` when `ACQUISITION_UPLOAD_ROOT` is set | n/a |
| `readSealedCapture` / `searchSealedCapture` / `observeSealedCapture` | `src/inspect/` | library only (examples 03, 04); executor `verify_read_capture` / `verify_search_capture` read captures on their own path | platform `source inspect` is not admitted until a persisted contract exists (internal-fallbacks §"Out of scope") |
| `normalizePaperIdentifier` | `src/paper/identity.ts` | `apps/worker/src/activity-registry.ts` | n/a |
| `planPaperAsHttpRequest` | `src/paper/plan-http.ts` | library only (example 05) | paper fetch stays "resolve identity, then HTTP-acquire" (internal-fallbacks §"Acquisition and inspection") |
| `IdentityBoundPaperAcquisitionAdapter` (`execute`) | `src/paper/adapter.ts` | library only | review record: do not wire paper `execute`; capture cardinality decision pending (internal-fallbacks §"Acquisition and inspection") |
| `ImmutableRepositoryAcquisitionAdapter` | `src/repository/` | library only | seals archive + manifest (two artifacts) while the worker admits `artifacts.length === 1`; wait for the capture-cardinality decision (review record; internal-fallbacks) |
| `FirecrawlAcquisitionAdapter` | `src/firecrawl/` | library only (`scripts/live-gate1.ts` deep-imports it) | review record: do not grow Firecrawl scrape; agents use the Firecrawl skill and `source_import` (internal-fallbacks §"Provider composition") |
| `FixtureAcquisitionAdapter` | `src/fakes.ts` | worker and application tests | n/a (test double) |
