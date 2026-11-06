---
status: proposed
owner: knowledge-services
created: 2026-09-16
---

# Internal fallbacks, inspection, and application order

Status: **Proposed. Do not start implementation while another agent is changing Knowledge Services.**

This is the first concrete slice of the [post-sprint module review](code-quality-and-delivery-process.md). It records the high-level goal and the work order. It does not claim the fallbacks, the application folders, or the skill rewrite exist yet.

Conversion and chunking policy (accepted conceptually 2026-09-16) lives in the sibling [conversion route and admitted chunk profiles](conversion-and-chunking.md). This page keeps the work order and points there instead of restating the profile table.

## High-level goal

Give research agents a **reliable local path** to acquire source bytes, inspect them, convert them, and chunk them — without paying Firecrawl, Tavily, or Unstructured, and without treating those vendors as our product.

External providers stay first-class in the **agent framework** (their MCP servers and skills, attached by mission config when Mission Control exists). Knowledge Services owns **custody**: replayable bytes, observations, conversion of *already stored* artifacts, and a stop at the authority boundary.

When this slice is done:

1. HTTP download, local/operator upload, repo-at-SHA, and paper-identity fetch are clean, tested internal acquisition adapters.
2. Inspection is a real step: read, search, and record findings on sealed bytes. It does not convert, ingest, or publish.
3. Conversion fallbacks are clean: deterministic text first, **Docling Serve** as the deployed default, **Unstructured Transform** only when managed processing is allowed and paid. This item landed with the conversion package cleanup.
4. Chunking is an admitted-profile preview on the sealed tree, not a session-local script. See the [sibling](conversion-and-chunking.md).
5. `packages/application` is ordered so a reader can find the use-case modules instead of a 160-file flat dump.
6. Skills are rewritten **last**, against the catalogs that actually exist, with provider-skill citations and worked examples.

Skills wait until the interfaces stop moving. Updating them now would teach the current mess.

## What each word means

| Word | Meaning | Not this |
|---|---|---|
| **Acquisition** | Get exact source bytes into tenant custody and seal a digest | Search snippets, Firecrawl markdown-as-evidence, conversion |
| **Inspection** | Look at those bytes and observations without promoting them | Vetting-as-acceptance, license/malware theater without recorded checks |
| **Conversion** | Turn a stored artifact digest into structural nodes | Fetching a URL, Unstructured/Docling as “acquisition tools” |
| **Chunking** | Slice sealed nodes with a named admitted profile | Session-local splitter, vendor elements written straight to `chunk_set` |
| **Application** | Admit the operation, account for it, persist receipts | Reimplementing HTTP or Docling inside use-case files |
| **External MCP** | Firecrawl, Tavily, Unstructured Transform in the agent toolbox | Nested inside Knowledge Services MCP |

Acquisition fetches. Inspection looks (twice: bytes, then nodes). Conversion structures. Chunking slices. Application admits and remembers.

## Provider composition (settled for this plan)

Do **not** compose vendor MCP servers into `@aiengineer/knowledge-mcp`.

```text
Mission config (later Mission Control)
  ├─ Firecrawl MCP / skill     research search and scrape
  ├─ Tavily MCP / skill        research search
  ├─ Unstructured Transform MCP / skill   paid partition
  ├─ Docling Serve             our conversion deploy
  └─ Knowledge Services MCP/CLI
        discover-account · import · acquire · inspect · convert · chunk · vet-propose
```

The handshake is **receipts**, not tool wrapping. An agent may use Firecrawl or Tavily, then `source import` a self-reported receipt. Host-held `source discover` remains the bounded exception (our schema, our budget, our redaction).

Unstructured’s current agent guidance prefers the [Transform MCP](https://docs.unstructured.io/agent-guide), then their Python SDK, then REST. We cite that skill. We do not re-host their server. We do not promote their retired open-source partition stack.

## Internal fallbacks we will make excellent

These are the adapters we own. They must be clean TypeScript (small interfaces, deep modules, no `any` at the seam) and demonstrable with fixtures. Default examples never need a paid key.

### Acquisition and inspection (including local download)

| Fallback | Job | Today | Desired |
|---|---|---|---|
| Exact HTTPS GET | Static URL → one sealed body | Strong library; only production-wired adapter | Keep as the default acquire path; document `knowledge.capture/v1` |
| Local / operator upload | File already on disk → attested bytes | Adapter exists, unwired | Wire as the local-download path: path safety, digest, rights attestation |
| Repository @ 40-char SHA | Immutable archive + manifest | Adapter exists, unwired | Wire only after capture can store archive + manifest (or a declared primary + observations) |
| Paper identity | DOI / arXiv / OpenReview → resolved PDF via HTTP | Normalizer exists; fetch unwired | Resolve identity, then HTTP-acquire the representation URL |
| Firecrawl scrape adapter | Host-held rendered fetch | Written, unwired, too product-shaped | Do **not** grow it. Thin scheduled/operator scrape only if KS must fetch with no agent. Agents use Firecrawl MCP + import |
| Inspection | Read/search/observe sealed bytes | Executor `verify_read_capture` / `verify_search_capture`; platform `source inspect` unsupported | Make inspection first-class: excerpt ≠ locator, findings recorded, no admission |

Inspection dimensions that may be recorded (not invented as “accepted”): identity conflict, declared vs observed media type, redirects, byte/replay integrity, license/rights *observations*, secret-*class* findings without secret values, extraction-loss notes. Platform `source vet` stays a **proposal**. It does not become acceptance.

Capture cardinality is an explicit decision before repo/Firecrawl-scrape wiring: either one primary body, or lift the worker’s `artifacts.length === 1` rule.

### Conversion

Conversion lives in `packages/preparation/src/conversion`. Do not move Docling or Unstructured into acquisition.

| Fallback | Job | Policy |
|---|---|---|
| Deterministic text | Plain text and Markdown | Always first when the media type is native text |
| Docling Serve | PDF/HTML/Office on our deploy | Default conversion fallback; free to run, costs the box |
| Isolated verification parser | Quote-bearing PDF geometry / HTML DOM | Verification path; not a general converter |
| Unstructured Transform | Nasty documents | Only if `managedProcessingAllowed`; paid; credentials never in URLs or errors |

`ConversionRouter` now uses the table above (Docling default, Unstructured gated). The receipt (who ran, fallback used, fidelity) is the thing skills teach. Detail: [conversion-and-chunking.md](conversion-and-chunking.md#conversion).

### Chunking

Chunking lives in `packages/preparation/src/chunking`. Do not add a second splitter in application, skills, or the sandbox.

| Fallback | Job | Policy |
|---|---|---|
| Admitted profile registry | Slice sealed `DocumentNode`s | Only writer of custody-grade chunks. Agent **selects** `name@version`; package **runs** it. |
| Multi-profile per document | One tree, several spaces | `forSpace(space)` ∩ observed node kinds. Skip `table-row-groups-v1` when there are no tables. |
| QA + reconstructable spans | Replay and bounds | `qa.valid` required. Fail → next admitted profile or alternate converter. |
| Custom script | Skill example only | Inspect helper, QA diagnosis, or a JSON proposal for a **new named profile**. Never the chunk writer. |

Vendor MCP output is imported as stored artifacts, converted to our nodes, then chunked here. LlamaIndex / Unstructured elements do not write `retrieval.chunk_set`. Profile table, script rules, and the skill sequence: [conversion-and-chunking.md](conversion-and-chunking.md#chunking).

## Application order

`packages/application/src` is about **166 files** and a shallow `index.ts` barrel (~80 `export *` lines). The product modules are deep. The tree is not.

A read-only organization pass on 2026-09-16 (see the conversation map of `packages/application/src`) found:

**Keep and folder (deep use-cases):**

- `operations/` — capability catalogs, `KnowledgeOperationPort`, A2A
- `preparation/` — vet/preview, exploratory knowledge
- `source-discovery/` — managed/import/select accounting
- `checkpoints/`
- `promotion-selection/`
- `verification/admission/`
- `verification/operations/` — catalogs, parse, metrics, seal, claims, audit, adjudication, reads
- `verification/source-acquisition/` — grant-keyed HTTPS over acquisition ports (stays here; do not copy HTTP policy)
- `verification/recovery/`
- `verification/benchmark/` — registered run/compare/import only

**Quarantine, do not delete:**

- `diagnostics/` — the `verification-diagnostics-*` dump and the diagnostics host hiding inside `verification-benchmark.ts` (~34 + 34 files). CLI/scripts still need today’s export names.

**Do not move into acquisition, conversion, or `packages/verification`:** recovery, admission, claims, and source-acquisition use-cases. Those are orchestration modules. Algorithms stay in their packages.

**Worst leak to fix later:** persistence imports application *implementations* (hydrate/composer/result factories), not only ports. Invert that after the folder move.

### Application cleanup phases (safe order)

0. **Freeze the barrel.** No new `export *` while the other agent is working. New files join an existing module or stay unexported.
1. **Folder move only.** Same export names from `index.ts`. Zero consumer edits. Only phase that is merge-safe with transport work.
2. **Delete leftover `.d.ts`** beside live `.ts` (`verification-recovery.d.ts`, `verification-component-drift.d.ts`).
3. **Split `verification-benchmark.ts`.** Product benchmark stops importing diagnostics.
4. **Quarantine diagnostics** on the barrel; optional `./diagnostics` subpath later.
5. **Persistence type-only** application imports. Touches persistence + worker together — after folders.
6. **Optional subpaths** (`./operations`, `./verification`, `./source-discovery`). Keep `"."` until transports switch, mcp first.

Do not, in the same change: move files into other packages, rewrite worker preparation, or drop diagnostics export names.

**Delivered (Unit 4, 2026-09-28).** Phases 1–4 are done: `src/` groups `operations/`, `knowledge/` (preparation, source discovery, checkpoints, promotion selection, retrieval, knowledge reads) and `verification/` (with `reads/`), with `access/`, `errors/` and `reads/resource-read-result.ts` shared; there is no `db/` folder until application owns a db use case (Unit 5, after the R1 inversion). No stale `.d.ts` remained beside live sources. `verification-benchmark.ts` no longer imports diagnostics (the offline demo and the pilot-v3 provider grant moved into `diagnostics/`), and a test keeps product source free of diagnostics imports; export names are unchanged. Phases 5–6 remain open. See [Unit 4](package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md#delivered-structure-and-decisions).

**Hot files if another agent is active:** `index.ts`, `promotion-selection.ts`, `source-discovery.ts`, `checkpoints.ts`, `verification-recovery*.ts`, `verification-benchmark.ts`. Folder-move those last or coordinate.

## Work order (when the tree is free)

```text
1. Application folders (phase 0–1)     order, no behavior change
2. Acquisition + inspection fallbacks  HTTP, upload/local, inspect
3. Conversion fallback cleanup         Docling default, Unstructured gated
4. Chunk profile selection             multi-space select; QA fail-closed
5. Wire only what inspection can see   repo/paper after cardinality decision
6. Skills                              last
```

Steps 3–4 are specified in [conversion-and-chunking.md](conversion-and-chunking.md). Do not implement them while the other agent is in the tree.

Skills to update after the interfaces exist:

| Skill | What changes |
|---|---|
| `knowledge-acquisition-and-vetting` | Become acquisition **and inspection**. Split executor vs platform `source discover`. Cite Firecrawl/Tavily skills. Add cli/mcp/examples like verification. Document HTTP capture body. Say inspect ≠ admit. |
| `knowledge-preparation-and-promotion` | Conversion router: deterministic → Docling → Unstructured. Profile table, two inspections, `qa.valid`, no session-local splitter. Cite Unstructured Transform skill and our Docling deploy. CLI/MCP/examples like verification. |
| `knowledge-ingest` | Keep discovery receipts as inputs, not evidence. Cross-link; do not fork semantics. |
| `knowledge-verification` | Point at inspect/read-capture; do not re-teach acquire. |

`node skills/check.mjs` must pass. Examples use placeholder UUIDs and fixtures. Do not name unsupported platform commands (`source inspect` stays unsupported until it is admitted).

## Must-haves (developer-facing)

Recorded here so implementation does not invent product:

- Internal acquire works for a public static HTTPS URL and for a local file upload, with sealed digest and redacted observations.
- Inspection can read and search a sealed capture and return handles, not payloads.
- Conversion of plain text does not call Docling or Unstructured.
- Conversion of a PDF can succeed on Docling without an Unstructured key.
- Unstructured is never invoked unless managed processing is explicitly allowed.
- Chunk preview uses only an admitted profile, requires `qa.valid`, and can attach more than one profile when spaces and node kinds justify it.
- Failed chunk QA does not accept a session-local splitter.
- Vendor MCP is not a dependency of our MCP process.
- Application has named module folders; public export names still resolve from `@aiengineer/knowledge-application`.
- Skills describe the sequence and the two `knowledge` binaries after the above is true.

## Out of scope for this slice

- Mission Control mission-config wiring (record the contract; do not build MC here).
- Growing a second Firecrawl product inside acquisition.
- Session-local or vendor splitters as the chunk writer (see sibling).
- Making platform `source inspect` / `source compare` production-admitted before a persisted contract exists.
- Publication, retrieval, or ingestion behavior changes.
- Rewriting `packages/verification` algorithms.

## Coordination

Implementation waits until the in-flight Knowledge Services agent is done or this work is explicitly reassigned. Safe parallel work: documents and skills drafts that only cite current catalogs. Unsafe parallel work: `packages/application/src/index.ts`, persistence verification adapters, executor recovery/checkpoint hosts.

When work starts, recheck `git status` and this document against the tree. CODE-MAP’s application section is stale; trust the source barrel and the organization pass above.
