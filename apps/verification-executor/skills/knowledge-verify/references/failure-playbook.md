# Failure playbook

Failures include capture, locate, capability and infrastructure outcomes. Read the code and
preserve the failed evidence; the repairs below describe possible actions, not authorization to
bypass custody. Never work around a failure by paraphrasing, by citing uncaptured text, or by
editing files the executor produced.

## Capture

| symptom | cause | fix |
|---|---|---|
| `FIRECRAWL_SCRAPE_FAILED:4xx/5xx` | the page blocked the scraper or timed out | retry once; then try `--method https_get`; then another URL for the same fact |
| `FIRECRAWL_MARKDOWN_EMPTY` | JS-only page or empty PDF text layer | find the HTML equivalent of the page, or a different primary source |
| `CAPTURE_ID_CONFLICT:<captureId>:existing=…:new=…` | the same `--capture-id` was reused for different bytes (page changed, or a different URL) | pick a new `--capture-id`; never reuse an id for different content. Re-capturing identical bytes under the same id is fine (`reused: true`) |
| URL capture and `capture-file` of the same PDF have different text digests | the URL was scraped in place instead of downloaded and parsed | `.pdf` URLs are downloaded + parsed by default; for a PDF served without a `.pdf` extension use `--method https_get` so both paths share the parser |
| `HTTPS_GET_FAILED:404/403` | wrong or gated URL | re-check the URL with your discovery skill (`map`/`search`); never capture a search-result page as a source |
| `HTTPS_GET_TEXT_EMPTY` | page has no text body | use `--method firecrawl` (JS rendering) |
| `HTTPS_GET_DOCUMENT_REQUIRES_FIRECRAWL` / `CAPTURE_FILE_DOCUMENT_REQUIRES_FIRECRAWL` | binary document but the executor has no `FIRECRAWL_API_KEY` | report the configuration gap; do not convert the document yourself |
| `CAPTURE_FILE_UNSUPPORTED_TYPE` | extension/media type not capturable (see `media-types`) | obtain the document in a supported format (pdf, docx, xlsx, pptx, csv, html, md, txt, json, …) |
| `characters` very small (< 500) or preview shows cookie banner / login | not the real page | discard the capture, choose another URL |
| `reused: true` | same captureId and same bytes as before | fine; nothing changed |

## Locate

| status | meaning | fix |
|---|---|---|
| `ambiguous` (`occurrenceCount > 1`) | the quote appears several times | extend the quote with the row label / preceding heading / next cell; use `suggestions` |
| `not_found` (`occurrenceCount 0`) | paraphrased or formatting differs (pipes, spaces, unicode dashes, footnote markers) | `search <captureId> "<a few words>"` and copy the `exact` substring it returns |

## Retired commands

| symptom | meaning | fix |
|---|---|---|
| `<command> is retired (SV-17)` (exit 2) for `verify-claims`, `verify-extraction`, `judge`, `policy`, `seal`, `check-report` and `status` | the executor's verification chain was removed | claims, runs and seals go through ks.knowledge_operation.v2 (K01) on the knowledge_verification component |
