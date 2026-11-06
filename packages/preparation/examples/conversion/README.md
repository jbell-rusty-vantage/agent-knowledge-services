# Conversion examples

Runnable, mocked demonstrations of the internal conversion fallbacks. Default examples need no vendor key.

From `packages/preparation`:

```bash
pnpm exec tsx examples/conversion/01-text-convert.ts
pnpm exec tsx examples/conversion/02-pdf-docling.ts
pnpm exec tsx examples/conversion/03-inspect-fidelity.ts
pnpm exec tsx examples/conversion/04-docling-then-unstructured.ts
pnpm exec tsx examples/conversion/05-import-stored-markdown.ts
pnpm exec tsx examples/conversion/06-managed-denied.ts
pnpm exec tsc --noEmit -p tsconfig.examples.json
```

| File | Sequence | What is mocked |
|---|---|---|
| `01-text-convert.ts` | markdown → deterministic only | Docling and Unstructured stubs that must not run |
| `02-pdf-docling.ts` | PDF → Docling | Docling client; Unstructured never configured |
| `03-inspect-fidelity.ts` | inspect nodes and fidelity | none |
| `04-docling-then-unstructured.ts` | Docling outage → gated Unstructured | both HTTP clients |
| `05-import-stored-markdown.ts` | stored vendor markdown → our nodes | none; import is receipts, not tool wrapping |
| `06-managed-denied.ts` | Unstructured refused without the flag | Unstructured client that must not create a job |

Expected shape: JSON on stdout with `selectedProviderKey`, `candidateRoute`, and `fallbackUsed`. Secrets never appear in the routing receipt.

Paying Unstructured is a budget decision. The happy path with money still prefers Docling first, then Unstructured only when `managedProcessingAllowed` is true.
