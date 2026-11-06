---
status: conversion-cleanup-landed
owner: knowledge-services
created: 2026-09-16
---

# Conversion route and admitted chunk profiles

Status: **Conversion fallback cleanup landed 2026-09-16. Chunk multi-profile selection is the next slice.**

Parent slice (work order, acquisition, application folders): [internal fallbacks, inspection, and application order](internal-fallbacks-and-application-order.md). This page is the conversion and chunking sibling. It does not claim the router order, multi-profile selection, or skill rewrite exist yet.

Accepted architecture for this pair: [ADR 0002 deterministic preparation](../architecture/0002-deterministic-preparation.md). Packages: `packages/preparation`, `packages/preparation`, `packages/preparation`. Deployed binary fallback: `services/docling`.

## What we are deciding

Conversion and chunking are **custody procedures**, not vendor products and not session-local scripts.

External partitioners (Unstructured Transform, and later any LlamaIndex-style splitter an agent has attached) stay first-class in the **agent framework**. Mission config materializes their MCP servers and skills. Knowledge Services does not re-host them, wrap them as our MCP tools, or grow a second Firecrawl/Unstructured product.

What we own and must make excellent:

- a **route** over already-stored artifacts (who ran, fallback used, fidelity)
- a **registry of admitted chunk profiles** that emit reconstructable spans
- an **import seam** so vendor MCP output becomes our artifacts, then our nodes, then our chunks

Paying Unstructured is a budget and safety-net decision. It is not how we get the capability.

## The loop (two inspections)

Chunking does not run on a raw download. Conversion makes the tree. Chunking only slices a sealed tree. The agent **selects** an admitted profile. The package **runs** it.

```text
acquire    →  sealed bytes + digest
inspect 1  →  media type, structure, rights, injection, “is this a document?”
convert    →  structural nodes (text fallback / Docling / gated Unstructured)
inspect 2  →  node kinds, fidelity, headings / tables / code / turns present?
select     →  admitted profile(s) from (kind + observed nodes + target spaces)
preview    →  chunkDocument(nodes, profile); qa.valid or next admitted profile
propose    →  stop. conversion or chunk success is not admission
```

**Inspect 1** is acquisition. **Inspect 2** is preparation. Skip the second and the model invents a splitter because the tree looked odd.

`prepare-captured` (and its MCP equivalent) already means “pinned convert + chunk on retained bytes.” That stays the path for MCP-only agents. A filesystem agent may download and look, then must call the **same** convert/chunk operations on the sealed digest. Local peeking is not a second pipeline.

MCP is the skill + CLI path with the same objects. A sandboxed filesystem agent and an MCP-only agent run these stages; only the transport changes.

## Conversion

Already the right package. Do not move Docling or Unstructured into acquisition.

| Path | Owner | When |
|---|---|---|
| Deterministic text | `packages/preparation` | Always first for markdown, HTML, VTT, plain text. Never call Docling or Unstructured. |
| Docling Serve | Our deploy + HTTP adapter | Default binary fallback (PDF / Office / hard HTML). Costs the box, not a vendor invoice. |
| Isolated verification parser | Verification only | Quote geometry / DOM. Not a general converter. |
| Unstructured Transform MCP / skill | Their team, attached by mission config | Nasty documents when budget **and** `managedProcessingAllowed` say yes. Cite [their agent guide](https://docs.unstructured.io/agent-guide). |
| Unstructured HTTP adapter | Our thin custody client | Only when **this host** must convert stored bytes and managed processing is allowed. Not a product wrapper. |

Desired router order: **text → Docling → Unstructured (gated)**. Unstructured is the expensive safety net, not the default.

`ConversionRouter` now walks **text → Docling → Unstructured (gated)**. Exclusive text never calls Docling or Unstructured. A PDF can succeed on Docling with no Unstructured key. The routing receipt (candidate route, attempts, `fallbackUsed`, fidelity) is the thing skills teach. Credentials never appear in URLs or errors. The worker intersects a caller `providerRoute` with that policy order; it does not let Unstructured jump the queue.

Fidelity is conversion QA: character coverage, locator resolvability, encoding, repeated blocks. `alternate_conversion` means try the next **admitted** converter. It does not mean the agent writes a parser.

### Import seam (vendor MCP → our custody)

The handshake is receipts, not tool wrapping.

1. Mission attached Unstructured / Firecrawl / Tavily. The agent used **their** skill.
2. Agent `source import`s the self-reported receipt (or we already hold a managed discover attempt).
3. We convert **stored** provider-native + markdown/text artifacts into `ConversionNode`s (or seal their elements as the native artifact and derive nodes).
4. We chunk those nodes with an admitted profile.

We do not re-host Transform. We do not promote Unstructured’s retired open-source partition stack. Host-held `source discover` remains the bounded exception (our schema, our budget, our redaction).

## Chunking

Already the right package. The registry is the only writer of custody-grade chunks. LlamaIndex, Unstructured elements, or a model-authored splitter may **inform** a future named profile. They must not write `retrieval.chunk_set`.

What the internal fallback must keep doing:

- deterministic ids and digests (`inputDigest` / `outputDigest`)
- spans that reconstruct to `sourceText`
- token bounds and duplicate / boilerplate QA
- contextual heading prefix on embedding text
- omitted-node list (boilerplate, exact dupes)

That is the thing a vendor splitter will not give us with replay.

### Select, do not invent

Today preparation picks one profile from `document_kind` (`profileFor`). Desired state: select the **set** of admitted profiles from `forSpace(space)` intersected with observed node kinds. One document may take several profiles. If the tree has no tables, do not run `table-row-groups-v1`.

| After inspect 2 you see | Target space | Profile |
|---|---|---|
| Headings / sections | `source_native_sections`, `paper_case_study_knowledge` | `heading-sections-v1` |
| Timed turns | `source_native_sections`, `engineering_claims` | `transcript-topics-v1` |
| Claim-sized sentences | `engineering_claims` | `atomic-claims-v1` |
| Code / symbols | `implementation_examples` | `code-symbols-v1` |
| Tables | `benchmark_intelligence`, `paper_case_study_knowledge` | `table-row-groups-v1` |
| Tool / model cards | `tool_capabilities`, `model_capabilities` | `tool-capabilities-v1` |
| Entity pages | `entity_profiles` | `entity-facets-v1` |

The profile table now lives at `packages/preparation/src/chunking/profiles/definitions.ts` as `chunk-profile-table.v1`, with an explicit `nodeKinds` binding per profile; this prose table is a reading of that data, not a second source.

A host may auto-select from this table. An agent may override only with another **admitted** `name@version`. Dynamic skills may change which admitted profiles a mission can see. They must not mint an anonymous strategy during a run.

Claims / entities / tools profiles may stay “pack by tokens / split sentences” as the fallback. Desired deepening (still our package, still named): headings already break on heading boundaries; code and tables should refuse to split mid-fence or mid-row; claims stay atomic. No model-authored splitter is required for that.

If `qa.valid` is false: next admitted profile, or repair conversion (Docling ↔ Unstructured), or quarantine. Do not “just split every 500 tokens in a custom script.” That drops locators and replay.

### Custom scripts: teach them, do not run them as the chunker

Skills may show a custom script. That is not permission to become the writer.

| Allowed in a skill example | Forbidden as the procedure |
|---|---|
| Inspect helper: list node kinds, heading tree, table count (read-only; prefer inspect / read-capture) | Session-local splitter that emits the chunk set |
| QA diagnosis: dump the failing node and span on reconstruction mismatch | One-off Python/JS in the sandbox used as `chunking_procedure_version` |
| Propose a new profile: JSON `ChunkProfile` (`name`, `version`, token bounds, strategy, spaces) for host admission | Anonymous strategy invented mid-run |

A new profile is admitted by the host, then cited as `name@version` on the next run.

## Skills (last, against the catalogs)

Home: `knowledge-preparation-and-promotion`. Do not rewrite it until convert/chunk interfaces stop moving. When they have, match verification: `SKILL.md` + `cli-reference.md` + `mcp-reference.md` + `examples.md`.

Teach this sequence, not a philosophy paragraph:

1. You already have a sealed capture, or you imported a Firecrawl / Tavily / Unstructured receipt.
2. Inspect bytes. Do not convert if identity or rights fail.
3. Convert: text stays local; PDF goes Docling unless policy and budget allow Unstructured.
4. Inspect nodes. If fidelity is `low`, `alternate_conversion`.
5. Select profile(s) from the table. Preview. Require `qa.valid`.
6. `promotion propose`. You do not publish.

Cite Unstructured’s Transform skill and our Docling deploy by name. Default examples use fixtures and no paid keys. The Unstructured example is the gated branch: mission attached their skill, budget allowed, here is the import receipt, here is convert-from-stored-bytes.

`node skills/check.mjs` must pass. Do not name unsupported platform commands.

## Must-haves (developer-facing)

Recorded so implementation does not invent product. Parent slice owns acquire/inspect/application must-haves.

- Conversion of plain text does not call Docling or Unstructured.
- Conversion of a PDF can succeed on Docling without an Unstructured key.
- Unstructured is never invoked unless managed processing is explicitly allowed.
- Routing receipt records candidate route, typed attempts, selected provider, and `fallbackUsed`. Secrets stay out of the receipt.
- Vendor MCP is not a dependency of our MCP process. Import is receipts.
- `chunkDocument` is the only writer of preview/persisted chunk spans for this pipeline.
- Profile selection can emit more than one admitted profile for one representation when target spaces and node kinds justify it.
- Preview requires `qa.valid` (reconstructable spans, token bounds, duplicate ratio).
- Failed QA tries the next admitted profile or an alternate admitted converter. It does not accept a session-local splitter.
- A new strategy enters as a named, versioned profile, then a host admission, not as run-local code.
- Skills describe the sequence and the two `knowledge` binaries after the above is true.

## Out of scope here

- Mission Control mission-config wiring (record the attach contract; do not build MC here).
- Growing a second Unstructured or Firecrawl product inside conversion or acquisition.
- LlamaIndex / Unstructured / agent scripts as the chunk writer.
- Dynamic mid-run anonymous profiles.
- Publication, retrieval, or ingestion behavior changes.
- Rewriting `packages/verification` algorithms.
- Application folder moves (parent slice).

## Observed after the conversion cleanup

- `ConversionRouter` order is text → Docling → gated Unstructured. Exclusive text never calls the binaries. Office Open XML is not treated as text. Low-fidelity `alternate_conversion` advances to the next admitted converter. Routing receipts omit secrets.
- Worker durable convert uses `conversionRouterFromProviders` and keeps `providerRoute` as the admitted set, not as an Unstructured-first queue.
- In-process preparation (`packages/application/src/knowledge/preparation/preparation.ts`) still converts with the text provider only (`managedProcessingAllowed: false`) and picks one profile from `document_kind`. Multi-profile selection is the next slice.
- `knowledge-preparation-and-promotion` 1.3.0 teaches the router, the two inspections, and points at `packages/preparation/examples`. Chunk profile table teaching stays thin until that slice lands.

Recheck `git status` and both operations pages against the tree before the chunking slice.
