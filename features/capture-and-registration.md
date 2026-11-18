# Capture and registration

**What it does.** The verification executor fetches a URL (Firecrawl when `FIRECRAWL_API_KEY` is set, otherwise an
HTTPS GET) or takes bytes you already hold, and stores the text as an immutable, content-addressed capture.
`source_prepare_captured` then registers the capture as an evidence capture with quotable units, so a governed
`record_claim` can anchor to it. On database contract 0.10.0 each registration also writes an operation intent, a
receipt and receipt targets (intent type `capture_registration`). Concept: [capture, conversion and
custody](../knowledge/capture-conversion-and-custody.md#from-source-bytes-to-inspectable-evidence).

**Code.** `apps/verification-executor/src/capture.ts`, `store.ts`, `executor.ts`;
`apps/verification-executor/src/knowledge/capture-registration.ts`; the `sourcePrepareCaptured` operation in
`apps/verification-executor/src/knowledge/operations.ts`; `packages/knowledge-db/src/capture/register.ts`
(`CaptureRegistrar`) and `units.ts`. The platform's durable capture is the catalog row `knowledge.capture` in
`packages/application/src/operations/catalog.ts`.

**Tests.** `packages/knowledge-db/src/capture/register.test.ts`, `units.test.ts`;
`apps/verification-executor/src/knowledge/capture-registration.test.ts`, `src/capture.test.ts`, `src/locate.test.ts`.
`apps/verification-executor/src/knowledge/capture-chain.integration.test.ts` needs a disposable database and skips
without one.

**Reach it.**
- `knowledge-verify capture <url> --run --capture-id <id> [--method auto|firecrawl|https_get]`, `capture-file <path>`,
  `media-types`, `captures`, `read`, `search`, `locate`, `fragment`, `register`, `artifact`
  (`apps/verification-executor/src/index.ts`).
- `knowledge source prepare-captured <captureId>`.
- Executor MCP (`apps/verification-executor/src/mcp.ts`): `verify_capture_source`, `verify_capture_file`,
  `verify_supported_media_types`, `verify_list_captures`, `verify_read_capture`, `verify_search_capture`,
  `verify_locate_quote`, `verify_capture_fragment`, `verify_register_artifact`, `verify_get_artifact`,
  `source_prepare_captured`.
- Executor HTTP (`apps/verification-executor/src/http.ts`): `POST /captures`, `GET /captures`, `POST /artifacts`,
  `GET /artifacts/:id`, `GET /media-types`, `POST /knowledge/source_prepare_captured`.
- `ks verify capture source|file|list|read|search|locate|media-types` and `ks verify artifact register|get` (local
  profile, `apps/cli/src/ks-commands.ts`); platform MCP `knowledge_source_fetch`, HTTP `POST /v1/captures`.

**Prove it.** `./dev test knowledge-db src/capture/register.test.ts` (a fake SQL client: one `executor_service`
transaction, the receipt once the intent type is declared, refusals before any transaction). Second proof:
`./dev test verification-executor src/knowledge/capture-registration.test.ts` (a temporary file store).

**Gotchas.**
- Only text, Markdown, HTML and JSON register; anything else is `CAPTURE_MEDIA_TYPE_UNSUPPORTED`.
- A database without the `capture_registration` intent type answers `INTENT_TYPE_UNDECLARED` and writes no receipt.
- `CAPTURE_NOT_FOUND` carries a "Next: verify_list_captures" hint; `VERSION_LABEL_TAKEN` is the other refusal.
- Durable custody needs `KNOWLEDGE_ARTIFACT_STORAGE=supabase` plus the plane's runtime DSN, URL and secret key;
  otherwise custody is local and `verify_capture_fragment` is unavailable. Since 2026-11-18 a remote plane also needs
  `KS_APPLICATION` ([ENVIRONMENT](../docs/ENVIRONMENT.md#plane-selection)).
- `knowledge-verify locate` exits 0 only for `status=resolved`; an ambiguous quote exits 1.
- The local store is `VERIFY_STORE_DIR` (default `.verification-store`, git-ignored).
