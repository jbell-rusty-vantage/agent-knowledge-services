---
name: knowledge-preparation-and-promotion
description: Use when converting sealed captures, inspecting nodes, previewing admitted chunks, and submitting a promotion proposal.
license: Proprietary
metadata:
  version: "1.7.0"
  contract: "knowledge-service/v1"
---

# Knowledge preparation and promotion

Follow this loop without skipping a gate:

```text
you already have a sealed capture, or you imported a Firecrawl / Tavily / Unstructured receipt
→ inspect bytes (identity, media type, rights). Do not convert if identity or rights fail
→ convert stored bytes: text stays local; PDF goes Docling unless policy and budget allow Unstructured
→ inspect nodes and fidelity. If fidelity is low, alternate_conversion
→ select an admitted chunk profile. Preview. Require qa.valid
→ promotion propose. You do not publish
```

Inspect bytes is acquisition. Inspect nodes is preparation. Conversion success, a routing receipt, and a chunk preview are not admission. A seal is not admission.

## Conversion route we own

Knowledge Services converts **already stored** artifacts. It does not fetch a URL and it does not re-host Unstructured or Firecrawl MCP.

| Path | When |
|---|---|
| Deterministic text (`deterministic-structural-text@1.0.0`) | Markdown, VTT, plain text, JSON. Never call Docling or Unstructured. |
| Docling Serve (`docling-serve`) | Default binary fallback for PDF / Office / hard HTML. Costs the box, not a vendor invoice. |
| Unstructured Transform | Only when `managedProcessingAllowed` is true and budget says yes. Cite their [agent guide](https://docs.unstructured.io/agent-guide). |

The routing receipt records `candidateRoute`, typed `attempts`, `selectedProviderKey`, and `fallbackUsed`. Secrets never appear in the receipt. Runnable mocked copies: `packages/preparation/examples`.

Vendor MCP stays in the **agent** toolbox. After their skill runs, `source import` the self-reported receipt, then convert the stored markdown or native bytes. Do not wrap Transform inside `@aiengineer/knowledge-mcp`.

## Two binaries

| Surface | Binary | Convert / chunk |
|---|---|---|
| Executor | `knowledge` / `knowledge-verify` | None; `source prepare-captured` makes an executor capture quotable by the verification chain and does not chunk |
| Platform | `ks` (API client) | `ks knowledge document convert` (`transformation`), `ks knowledge chunk preview`, `ks knowledge chunk build` |

Do not substitute a local converter. The platform has no node or chunk-set inspection command or tool; inspect nodes from the conversion output or an executor read of sealed bytes.

Worked command bodies: [cli-reference.md](cli-reference.md), [mcp-reference.md](mcp-reference.md), [examples.md](examples.md).

## An executor capture is not a chunk set

The executor's `source_prepare_captured` (`knowledge source prepare-captured <captureId>`) registers a
text, Markdown, HTML or JSON capture as an evidence capture with one content unit per block, so a claim
or a probe run can quote it. It runs no chunk profile, writes no chunk set, embeds nothing and promotes
nothing; chunking and promotion stay on the platform commands below. Its procedure is in the
`knowledge-research` verification reference.

## Chunk with an admitted profile

`chunkDocument` is the only writer of preview or persisted chunk spans for this pipeline. Select a named admitted profile (`heading-sections-v1`, `transcript-topics-v1`, `atomic-claims-v1`, `code-symbols-v1`, `table-row-groups-v1`, `tool-capabilities-v1`, `entity-facets-v1`). Preview requires `qa.valid`. Failed QA tries the next admitted profile or an alternate admitted converter. Do not invent a session-local splitter.

## Content links were retired

Content-link and summary close-out (`content-link-intent.v1`) was retired in SV-17; claims, runs and seals go through ks.knowledge_operation.v2 (K01) on the knowledge_verification component.

## Budgets, exclusions and compact responses

State the budget before generating anything and keep membership inside it: exact selected content,
exact exclusions with reasons, and the estimate you reserved. Write previews and manifests to files
and carry handles (`receiptId`, `artifactId`, digests, counts) rather than pasting content. Charge
conversion, preview and review work to the caller's budget and report usage; unknown usage
is unknown, never zero.

## Submit only the proposal and review operations

The platform CLI has `ks knowledge promotion propose`, `ks knowledge promotion review`, and
`ks knowledge promotion status`. The equivalent MCP catalog exposes `knowledge_promotion_propose` and
`knowledge_promotion_status`. A successful submission is an operation receipt, not selection, evaluation,
activation, or publication. There is no public `promotion select` command and no
`promotion_selection_select` MCP tool; do not substitute a capability catalog or an internal host
helper for either one.

```text
ks knowledge promotion propose --context '<OperationContext>' --input '<promotion proposal input>'
ks knowledge promotion review --context '<OperationContext>' --input '<promotion decision input>'
ks knowledge promotion status --context '<OperationContext>' --input '{"operationId":"<uuid>"}'
```

Keep proposer and reviewer identities distinct. Selection, evaluated publication, pointer activation,
revocation, and rollback are host-owned transitions; use the publication and retrieval procedures
only after an independently authorized host exposes their admitted operation.

Authored text and derived text must remain distinguishable. Preserve exact locators, attribution, representation lineage, procedure versions, warnings, and uncertainty. A revised proposal is append-only and uses a new guarded digest. Never approve your own proposal, publish a vector-space version, infer acceptance from processing success, or use arbitrary converter code.
