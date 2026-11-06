# Preparation examples

Placeholder UUIDs are RFC-layout (`…-4111-8111-…`). Replace them with admitted IDs. Package exemplars under `packages/preparation/examples` are mocked and need no paid key.

## 1. Exclusive text stays local

Markdown, VTT, and plain text use `deterministic-structural-text` even when `managedProcessingAllowed` is true. Docling and Unstructured must not run. Runnable copy: `packages/preparation/examples/conversion/01-text-convert.ts`.

## 2. PDF on Docling without an Unstructured key

A PDF convert with `managedProcessingAllowed: false` and `providerRoute` that includes `docling-serve` succeeds on Docling. Unstructured is not a candidate. Runnable copy: `packages/preparation/examples/conversion/02-pdf-docling.ts`.

Executor text-only shortcut:

```text
knowledge source prepare-captured 11111111-1111-4111-8111-111111111111 --title 'Durable agents' --version '2026-09-16'
```

## 3. Gated Unstructured after Docling outage

When budget and `managedProcessingAllowed` allow it, the route is Docling then Unstructured. A Docling outage records `failureClass: provider_unavailable` and `fallbackUsed: true`. The secret from the provider error does not appear in the receipt. Runnable copy: `packages/preparation/examples/conversion/04-docling-then-unstructured.ts`.

## 4. Import seam

A Firecrawl or Unstructured skill may already have produced markdown. `source import` the receipt, then convert the **stored** artifact. Do not wrap their MCP. Runnable copy: `packages/preparation/examples/conversion/05-import-stored-markdown.ts`.

## 5. Failure: managed processing denied

Unstructured `convert` throws `MANAGED_PROCESSING_DENIED` when the flag is false, and the router does not add it to `candidateRoute`. Runnable copy: `packages/preparation/examples/conversion/06-managed-denied.ts`.
