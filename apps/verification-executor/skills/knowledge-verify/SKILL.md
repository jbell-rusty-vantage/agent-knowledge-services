---
name: knowledge-verify
description: >-
  Use when a task needs source-attributed evidence: capture sources as immutable evidence
  (including PDF, DOCX, XLSX, CSV and other documents), read and search captures, locate exact
  quotes, and register or read artifacts through the knowledge-verify CLI. The executor's
  verification chain (verify-claims, judge, policy, seal, check-report, status) is retired.
allowed-tools:
  - Bash(knowledge-verify *)
---

# knowledge-verify — capture, locate and artifact procedure (CLI surface)

`knowledge-verify` is the command-line face of the knowledge-verification executor. The
executor runs **outside** your sandbox (`VERIFY_EXECUTOR_URL` is set); the CLI forwards each
command and prints one JSON document. You cannot edit its store or its receipts.

The CLI and MCP (`verify_*` tools) provide only capture, locate, register and artifact tools.
`verify-claims`, `verify-extraction`, `judge`, `policy`, `seal`, `check-report` and `status` exit `2` with `retired (SV-17)`; claims, runs and seals go through ks.knowledge_operation.v2 (K01) on the knowledge_verification component (`/knowledge-operation/v2/*`).
A seal is not admission; mechanics, semantic support and policy remain separate.

Read [media and evidence decisions](references/capabilities.md) before choosing a capture.
The runnable [offline example](examples/offline.mjs) exercises capture → locate → register →
artifact and the retired commands.

## Preflight (do this first)

```bash
knowledge-verify health                       # must print {"status":"ok",...}
RUN=<host-issued-run-id>                    # pinned hosts require a canonical UUID
mkdir -p /workspace/run && cd /workspace/run
```

Use the same `--run "$RUN"` on every call so all captures and artifacts land in one run. If the
task gives you a runId, use that one verbatim.

## The evidence rule (overrides every other skill)

1. **Captured bytes are the evidence.** Every evidence quote must be an exact, contiguous
   substring of an executor capture. A successful match alone does not establish semantic
   support or truth.
2. Search engines, scrapers, extractors and other CLIs (Firecrawl, Tavily, curl) are **for finding
   URLs and previewing pages only**. Their output is a lead. Never quote it, never register it as
   an artifact, never cite it. When a preview looks useful, capture the URL with this CLI and quote
   from the capture.
3. **Quotes are copied, never paraphrased**, and must occur exactly once in the capture
   (`locate` → `status: resolved`, exit 0).
4. You never construct bundles, digests, manifests or verdicts.

## Sequence

Work top to bottom. Do not start the next stage until the current one's quality gate passes
(exit code 0). Write the listed file at the end of each stage so progress is observable.

| # | stage | command(s) | quality gate (exit 0) | file |
|---|---|---|---|---|
| 1 | plan | — | — | `00-plan.md` |
| 2 | discover | other skills (search / map) → candidate URLs | — | append to `00-plan.md` |
| 3 | capture | `capture <url> --run $RUN --capture-id <id>` / `capture-file <path> …` | command succeeds; inspect `characters` and `preview` | `10-captures.md` |
| 4 | inspect + locate | `read`, `search`, `locate` | `locate` → `resolved` for every quote | `20-quote-ledger.md` |
| 5 | register | `register <file> --label <label> --run $RUN`; read back with `artifact <artifactId>` | command succeeds; record `artifactId` and `digest` | `30-artifacts.md` |
| 6 | hand off | pass captures, the quote ledger and artifact handles to the ks.knowledge_operation.v2 (K01) caller | — | `70-run-summary.md` |

### 3. Capture

```bash
knowledge-verify capture "https://vendor.example/docs/models" --run "$RUN" --capture-id cap-models --out 10-cap-models.json
knowledge-verify capture-file ./paper.pdf --run "$RUN" --capture-id cap-paper --source-uri "https://where/it/came/from.pdf"
knowledge-verify media-types                 # what can be captured and how it is converted
```

- Quote URLs (shells treat `?` and `&` specially). Prefer primary sources on the vendor's domain.
  Prefer HTML docs pages over PDFs when both exist (tables in markdown are easier to quote); still
  capture the PDF when it is the canonical artifact.
- `--out <file>` writes the full JSON to a file and prints a compact summary; use it for
  captures, whose output is large.
- Read `characters` and `preview`. A tiny capture, a login wall, a 404 body or a cookie banner is
  not a source: discard it and try another URL. Record every kept capture (captureId, URL, title,
  characters, digest) in `10-captures.md`.
- Documents: `capture` handles html, markdown, json and, behind a URL, pdf / docx / doc / odt /
  rtf / xlsx / xls / pptx / ppt / epub / csv. `capture-file` handles the same types from a local
  path. The executor converts the document to markdown itself and stores the original bytes as a
  second artifact (`originalArtifact`), so the capture is trustworthy. Never convert a document
  yourself and then capture the converted text.

### 4. Inspect and locate

```bash
knowledge-verify read cap-models --offset 0 --length 6000
knowledge-verify search cap-models "context window" --limit 5
knowledge-verify locate cap-models "| Context window | 1M tokens | 200K tokens |"   # exit 0 ⇔ resolved
```

For every quote you intend to use, run `locate` and record `status`, `occurrenceCount` and
`selectedContentDigest` in `20-quote-ledger.md`.

- `ambiguous` (exit 1, `occurrenceCount > 1`): extend the quote until it is unique (include the
  row label, the preceding heading, or the next cell). The output's `suggestions` show longer
  unique candidates.
- `not_found` (exit 1): you paraphrased or the text is formatted differently. Use `search` to
  find the real wording and copy it exactly, including punctuation and table pipes.
- Aim for the **shortest unique** quote that still contains the value **and** an identifier of
  what it measures.

### 5. Register and read artifacts

```bash
knowledge-verify register 50-report.md --label report --run "$RUN"      # → artifactId, digest
knowledge-verify artifact <artifactId> --as text
```

Re-register after any edit: the artifactId changes with the bytes.

## Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | command succeeded and its quality gate passed | continue to the next stage |
| 1 | command succeeded, quality gate failed (`{"qualityGate":"failed","reason":…}` on stderr, full JSON on stdout / `--out`) | read the JSON; fix the quote or capture |
| 2 | usage, network, auth or executor error (`{"error":…}` on stderr), including a retired command | fix the command; if `health` fails, stop and report the outage |

## References

- [references/capabilities.md](references/capabilities.md) — media paths and the worked locate scenario
- [references/failure-playbook.md](references/failure-playbook.md) — capture and locate failure codes
- [references/intents.md](references/intents.md) — retirement note for the former intent files
