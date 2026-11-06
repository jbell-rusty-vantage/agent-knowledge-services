# Module review: acquisition

Module and reviewed revision: `@aiengineer/knowledge-acquisition` plus worker `knowledge.capture/v1` upload wiring (2026-09-16).

Purpose, owner, callers, and supported interfaces: Knowledge Services owns sealed-byte custody. Callers are the platform worker (`source fetch` → `capture`), the verification grant acquirer (pinned HTTP only), executor capture/read tools, and package examples. Public interface: `AcquisitionAdapter`, `RoutedAcquisitionAdapter`, HTTP helpers used by verification, upload filesystem source, inspect read/search/observe, `planPaperAsHttpRequest`.

Affected agent skills: `knowledge-acquisition-and-vetting` v1.2.0. Preparation and ingest skills unchanged.

## Must-haves

| ID | Must-have | Given / when / then | Assessment |
|---|---|---|---|
| ACQ-HTTP | Public static HTTPS URL seals one digest with redacted headers | Given a mocked public fetch, when plan/execute/verify run, then one artifact is stored and `set-cookie` is absent | present |
| ACQ-UPLOAD | Local attested file under the upload root seals one digest | Given `ACQUISITION_UPLOAD_ROOT` and a sidecar attestation, when target.kind is upload, then one artifact is stored | present |
| ACQ-INSPECT | Inspection returns handles/excerpts, not locators or admission | Given sealed bytes, when read/search/observe run, then excerpt has no locator and findings never say accepted | present |
| ACQ-CARD | Platform capture stays one primary body | Given acquire, when verify fails or artifacts.length !== 1, then the worker rejects | present |
| ACQ-VENDOR | Vendor MCP is not a KS MCP dependency | Firecrawl/Tavily stay agent-attached | present |

Normal path: HTTP or upload → seal → inspect excerpts. Failure path: `ADDRESS_DENIED`, `UPLOAD_PATH_TRAVERSAL`, `CAPTURE_DIGEST_MISMATCH`. Recovery: retry only on recorded retryAdvice; do not fall back to Firecrawl inside KS.

Provider restrictions: do not grow Firecrawl scrape; do not wire repository or paper `execute`; do not admit platform inspect.

Evidence: `packages/sources/src/*.test.ts`, `packages/sources/examples/`, `apps/worker/src/activity-registry.test.ts`.

Explicitly skipped checks: live Firecrawl, live paper resolvers, platform inspect admission, lifting `artifacts.length === 1`.

## Addendum 2026-09-19: folder normalization (Phase 1, S1-C3)

Structural change only; no behavior change; nothing newly wired. Decision P1-1 from the Phase 1 recommendation memo: the three library-only adapters are kept, made physically explicit, and stay unwired.

| Item | Before | After |
|---|---|---|
| Root shims | `src/http.ts`, `src/manual-upload.ts` | `src/http/index.ts`, `src/upload/index.ts` |
| Paper | `src/paper.ts` | `src/paper/identity.ts` (`normalizePaperIdentifier`), `src/paper/adapter.ts` (`IdentityBoundPaperAcquisitionAdapter`, `PaperProvider`, `ResolvedPaper`); `src/paper/plan-http.ts` unchanged |
| Repository | `src/repository.ts` | `src/repository/adapter.ts` |
| Firecrawl | `src/firecrawl.ts` | `src/firecrawl/adapter.ts` |
| Root tests | `acquisition.test.ts`, `deadline.test.ts`, `mapped-address.test.ts`, `residuals.test.ts` | `http/adapter.test.ts`, `http/deadline.test.ts`, `http/mapped-address.test.ts`; `residuals.test.ts` split by adapter into `firecrawl/adapter.test.ts`, `upload/adapter.test.ts`, `repository/adapter.test.ts`, `paper/adapter.test.ts`. `route.test.ts` stays at the root. Assertions unchanged. |
| Root barrel | flat re-exports | banners: Contract, Route, HTTP (wired), Upload (wired), Inspect (library), Paper (identity wired; execute unwired), Repository (unwired), Firecrawl (unwired), Fakes |
| Wiring status | prose only | table in `packages/sources/examples/README.md` |

Names unchanged: 58 exports on `src/index.ts` before and after, checked by emitting declarations (`tsc --declaration --emitDeclarationOnly`) for both trees and diffing the flattened export list (name, kind, hash of the resolved declaration text); only source paths differ.

Checks run: `corepack pnpm --filter @aiengineer/knowledge-acquisition typecheck`, `test`, `examples`; typecheck of `@aiengineer/knowledge-application`, `@aiengineer/knowledge-worker`, `@aiengineer/knowledge-verification-executor`; `scripts/live-gate1.ts` still imports names the barrel exports. Must-have table, provider restrictions, and skipped checks above are unchanged.
