# Executor acquisition and intent capabilities

What an agent can actually get **into** verification through the executor: which media the
capture catalog accepts, how each becomes a representation, and which library selectors and
rule options the intent schemas expose. The algorithms themselves — selector kinds,
deterministic check families, field comparisons, semantic scope — are documented in the
library's [CAPABILITIES.md](../../../packages/verification/CAPABILITIES.md). A selector type in
the contract is not proof that a public acquisition route for that type is admitted or deployed.

## Claim intents

The executor accepts **14 claim types**: attribute, relationship, measurement, capability,
compatibility, temporal, causal, comparative, methodological, definition, event, provenance,
recommendation and other. Each claim can carry 1–8 evidence entries with supports, contradicts,
qualifies or context roles, up to 16 qualifiers, 8 entity bindings and 8 downstream uses. There
can be up to 256 claims per intent; this maximum is not a recommended semantic batch size.
Propositions are limited to 600 characters and quotes to 4,000.

These categories describe claims; they are not fourteen specialized truth-checking engines.
`compileClaims` marks claims atomic. It does not independently discover that a compound sentence
is atomic.

Evidence: [intent schemas](../src/intents.ts), [compilation](../src/executor.ts).

## Which library selectors an agent can express

| Library selector | Executor availability |
|---|---|
| `text_quote` | Exact quote with normalization `none`; no prefix/suffix intent fields, so extend the quote until it is unique |
| `character_position` | Internal/bundle capability only; intents do not accept offsets |
| `json_pointer` | Internal/bundle capability only; the executor captures JSON as text and quotes it |
| `multi_fragment_text` | Internal/bundle capability only; use separate evidence entries instead |
| `html` | Executor HTML capture produces text, not the DOM projection |
| `pdf_text`, `bounding_box` | Only via the platform capture use case with admitted PDF lineage; executor document capture binds quotes to derived text |
| `table` | Spreadsheet/CSV input is provider-produced Markdown, not cell-addressable evidence |
| `media_timecode`, `repository`, `dataset`, `api_record` | Not reachable through executor intents |

## What can enter through each surface

The executor's [capture catalog](../src/capture.ts) declares **17 media types**. Markdown,
plain text and JSON decode locally; HTML uses a simple tag-removal conversion. CSV, PDF, Word,
OpenDocument, RTF, Excel, PowerPoint and EPUB route through the configured Firecrawl document
parser. Document capture stores original bytes and the selected text representation. Quotes are
bound to the derived text, not native page/cell coordinates. Local text decoding is permissive
UTF-8; it is not an encoding-forensics tool.

Raw PNG/JPEG/audio/video are not supported by `capture-file`. Do not mislabel their bytes as
text or silently substitute agent-authored OCR/transcripts. A transcript captured as text
supports statements about that transcript; it does not independently verify the original media.

The platform capture use case is narrower still: the
[application admission rule](../../../packages/application/src/verification/operations/verification-service.ts)
admits HTML DOM for web pages and acquired PDFs with ordered PDF-text + geometry projections,
subject to host catalogs and grants. The
[native parser](../../../services/parser/README.md) is distinct from the executor's
Firecrawl conversion and from Docling.

## Acquisition behavior and observed limits

Executor acquisition calls Firecrawl `/v1/scrape` and `/v2/parse` directly, with request
timeouts. Automatic PDF capture catches any direct-download/parser error and tries scraping; this
broad fallback can omit original document bytes and does not establish equivalent native PDF
geometry. Other scrape failures do not have an automatic retry chain. HTTPS fetching does not
impose a streaming byte cap before buffering the body; parse upload checks 50 MB after download.
These are observed limitations, not an approved provider policy.

## Extraction rule options in intents

Extraction intents expose the library's field-rule options: `allowedValues`,
`normalizationId`, `minimum`, `maximum`, `identifierKind`, `checksum` and top-level
`normalizations`. Missing or inapplicable options fail closed. Cross-field totals, duplicate
rules and structured source components (table cell, geometry token, transcript text) are
library/bundle capabilities that intents do not expose; executor intents remain text-only.
Older executors may silently strip unknown options; deploy a matching build before teaching
agents these fields.

## Recovery

For production, unresolved evidence should remain held and flow through the host's durable
recovery/adjudication mechanism. A standalone executor can run without that host; a synthetic
example's local quote correction is not authorization to bypass production recovery custody.

## Assessment

**Partial end-to-end coverage:** many media can become text, but agents cannot express every
library selector in executor intents. **Missing in these surfaces:** admitted arbitrary raw
image/audio/video acquisition, OCR/transcription/frame interpretation with retained locator
lineage, and comprehensive independent discovery of report assertions. Supporting the remaining
media requires explicit parser/representation admission and an agent-facing locator contract
with retained source lineage. Merely accepting a new MIME type would not meet it.
