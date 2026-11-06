# Source attempt accounting

Knowledge Services preserves discovery requests and responses separately from source captures and verified evidence. A search snippet is a lead, even when KS called the provider itself. Provider-returned instructions have no policy or publication authority.

The executor composes the source-discovery application service with the existing artifact custody path and canonical evidence tables. `evidence.source_provider_attempt` records the invocation; existing `source_query`, `provider_result`, `source_encounter`, and source-state projections retain its results and observed failures. This does not create Mission Control missions or accept research stages.

## Managed discovery

`source_discover` is exposed by the shared operation registry as the `knowledge source discover` CLI command, MCP tool, and `POST /knowledge/source_discover` route. The host requires configured remote custody (`KNOWLEDGE_ARTIFACT_STORAGE=supabase`), the configured tenant, and a database compatible with the pinned contract. Provider credentials remain host configuration (`TAVILY_API_KEY` or `FIRECRAWL_API_KEY`); callers cannot supply credentials, endpoints, headers, or arbitrary provider options.

Example request file:

```json
{
  "schemaVersion": "source-discovery-managed-request.v1",
  "providerCode": "tavily",
  "queryText": "official model documentation",
  "purpose": "find primary sources for a research question",
  "parameters": { "max_results": 5, "search_depth": "basic" },
  "requestedUrls": [],
  "idempotencyKey": "research-run-17-discovery-1"
}
```

Run `knowledge source discover request.json`; HTTP and MCP wrap this object in a `request` field. The host currently supports Tavily search and Firecrawl web search with bounded options and at most 20 results. Provider mapping is based on the [Tavily search reference](https://docs.tavily.com/documentation/api-reference/endpoint/search) and [Firecrawl search reference](https://docs.firecrawl.dev/api-reference/endpoint/search). Mocked provider tests establish adapter behavior, not live provider availability or research quality.

The service registers the canonical request before starting an attempt. A fenced dispatch claim precedes the provider call. It preserves the bounded response before committing result leads. HTTP failures and malformed responses become explicit outcomes; known credential bytes are redacted. Invalid UTF-8 is retained in a labelled base64 envelope of the sanitized bytes. Oversized and interrupted responses preserve a bounded prefix with `responseComplete: false`; they expose no leads. Limit failures and uncertain transport outcomes remain distinguishable.

Reuse the original idempotency key after response loss. A terminal attempt returns its original receipt. `knowledge source attempt <attemptId> --offset 0 --limit 100` reads a bounded page, with no leads exposed for a pending attempt. `knowledge source reconcile <attemptId>` reconciles an interrupted attempt; it does not silently call the provider again. A new key represents a new invocation; it is not a way to acknowledge the old invocation. To retry a terminal attempt deliberately, include its `retryOfAttemptId`; the new attempt retains the original query, root attempt and increasing ordinal. A live lease excludes competing dispatch or reconciliation. After expiry, reconciliation reads the original completion artifact or records explicit uncertainty, preserving its original dispatch identity.

Managed endpoint versions come from the host. Callers cannot upgrade that provenance by supplying a version string. Imported provider versions remain self-reported, and unavailable version/raw-output accounting is explicitly partial.

## Result selection

Managed search returns unreviewed leads. `source_select` / `knowledge source select selection.json` records an explicit inclusion decision without invoking the provider again:

```json
{
  "schemaVersion": "source-discovery-selection.v1",
  "attemptId": "00000000-0000-4000-8000-000000000017",
  "idempotencyKey": "research-run-17-selection-1",
  "decisions": [{ "rank": 1, "disposition": "selected", "reason": "Capture this official-source candidate next" }]
}
```

Dispositions are `selected`, `omitted` and `duplicate`. Each change creates an immutable revision and parent-bound artifact receipt. Bounded reads apply the latest decision for each rank; earlier decisions and original provider output remain preserved. Selecting a result does not admit it as evidence.

## External receipts

`source_import` / `knowledge source import receipt.json` accounts for external tool execution. Preserve the external receipt through artifact upload first, then supply its exact handle in `externalReceiptArtifact`. The import schema requires `selfReported: true`. Separate raw output is optional when the external receipt itself contains the output or failure record.

Imports preserve requested/final URLs, redirect chains, dispositions, and optional capture references. A capture reference must belong to the same tenant and source. Imported metadata remains self-reported, including provider identity, timestamps, redirect observations and claimed outcomes. Importing it neither upgrades provenance trust nor admits its content as evidence.

## Custody and lifecycle

Request/response handles retain their logical lineage while the existing storage layer deduplicates compatible bytes. A terminal receipt is not evidence that a research question was answered. Remote availability and digest verification are required before outputs can be used; a final agent message cannot substitute for this receipt.

Workspace checkpointing additionally preserves notes, partial reports, child work, pending operations and executor run state. That harness responsibility is distinct from provider accounting and uses the same artifact service. Mission Control later decides continuation and stage acceptance through public references to the original work.
