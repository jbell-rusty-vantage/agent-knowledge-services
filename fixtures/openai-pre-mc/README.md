# OpenAI pre-Mission Control fixture preparation

This directory contains custody-bound captures and provisional engineering labels for the OpenAI 2024–2026 fixture. It is not an accepted fixture or a passing lane. The canonical requirements are OPENAI_FIXTURE.md §3 in the pre-Mission-Control specification.

## Current evidence

The source inventory currently records52 capture attempts,48 distinct origin/digest documents, and37 admitted projections. Duplicate attempts and raw-only parser failures are retained separately. This reaches the numerical document minimum; it does not establish complete major-event coverage or source inclusion review. Primary announcement pages and more than six system-card PDFs have admitted projections. Captures were acquired in September2026 and are never represented as historical snapshots.

The candidate-claims files contain agent-authored engineering candidates with exact captured-source/projection bindings. Candidate questions, relevance labels and synthetic negatives are separate from accepted gold. `goldReview.status` remains `review_required`; no human adjudication, frozen release corpus or complete-year inventory is claimed.

## Boundaries

- Raw HTML/PDF bytes remain in the service artifact store; sources.jsonl and named capture receipts retain handles, tenant identity and digests.
- Read only explicitly named artifacts. Never search experiment outputs, caches or private stores for substitute evidence.
- Candidate/gold labels, qrels, expected deltas and adversarial mutations are evaluator-only. Producers, planners, verifiers and retrieval requests must not receive them.
- Related source families and their mutations share a split. Engineering split assignments do not imply human approval.
- Current pages can contain later addenda and navigation. Date qualifiers and retrospective provenance are part of each candidate; scheduled events are not completed releases.
- The fixture consumes contract0.4.14/head20260916010000. Acquisition and inspection require the guarded disposable project and existing service custody/parser boundaries.

## Tools and remaining work

`capture-primary-sources.ts` acquires one to four explicit allowlisted leads using the admitted HTTPS route. `update-capture-inventory.mjs` merges named receipts and preserves failed attempts. `inspect-capture.ts` reads admitted projections with bounded PDF page selection. Candidate preparation never invokes paid semantic providers.

The gold files, major-event inventory, source revision coverage, seeded database/delta, discovery recordings and deterministic fault manifest remain incomplete. Review GAP-INVENTORY.md and the manifest before attempting any run. Do not implement or launch `fixture:openai` until P6.1, P4.4 and P5.3 prerequisites are met. No scored lane has run.
