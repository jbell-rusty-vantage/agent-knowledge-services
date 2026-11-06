---
type: Architecture Concept
title: Jev decisions and worker lifecycle
description: Use closed-choice semantic judgments through a captured-input, single-host queue while keeping calibration, authority, and side effects outside the model.
tags: [jev, decisions, classification, workers, sqlite, uncertainty]
aliases: [System One, typed judgments, taxonomy routing, reranking]
questions:
  - When should an agent use Jev instead of an LLM?
  - Does Jev confidence authorize a tool or knowledge write?
  - Can a retried Jev job cause another provider charge?
owner: ai-engineer-knowledge-services
implementation_status: implemented-dedicated-service
decision_status: reference
validation_status: source-and-test-inspected
sources:
  - resource: ../packages/jev/src/service.ts
    title: Queue supervisor and child workers
  - resource: ../apps/jev/src/index.ts
    title: Dedicated Jev CLI and host
  - resource: ../packages/contracts/src/jev.ts
    title: Public Jev contracts
---

# Closed answers with explicit uncertainty

Jev returns Choice, Score or Noul judgments against supplied state. Use it when labels or rubric levels are known. An LLM can construct candidates, explain ambiguity or compose several decisions; code remains responsible for permissions, exact validation and side effects. Confidence is provider metadata, not proof or admission.

Start with the [Jev skill](../skills/jev-system-one/SKILL.md), [architecture](../docs/architecture/modules/jev.md) and [public contract](../packages/contracts/src/jev.ts). Hierarchical taxonomy search and uncertain-case escalation are caller recipes; they are not automatic service modes. Raw PDF, image or office bytes first need [preparation](capture-conversion-and-custody.md).

## Submit, retain, inspect

1. Define one narrow judgment per question with explicit labels, criteria and insufficient-evidence outcomes.
2. Supply inline text/JSON, an allowed-root file, or an allowlisted HTTPS artifact. Inputs are captured once; ordinary filenames inside inline state are not fetched.
3. Submit through the dedicated `jev` CLI, HTTP or MCP, retain job IDs and inspect terminal failures as well as successes.
4. Evaluate judgments on independently labelled cases before using thresholds. Escalate uncertain cases with their evidence.

[The service](../packages/jev/src/service.ts) uses a persistent SQLite queue and real child processes with bounded concurrency, timeouts and retries. Request identity is idempotent for identical normalized input; conflicting reuse fails. Restart recovers pending work from captured inputs instead of refetching a changed source. A crash after provider acceptance can still cause a second paid request: local job idempotency is not exactly-once provider billing. See [service tests](../packages/jev/src/service.test.ts).

## Transport and trust

[The dedicated host](../apps/jev/src/index.ts) exposes `serve` and `mcp-stdio`; client commands use `KnowledgeJevClient`. Its [MCP surface](../apps/jev/src/mcp.ts) provides submit, batch, get, list, cancel and workers. [HTTP tests](../apps/jev/src/http.test.ts) anchor the transport behavior.

This is a single-host operator trust domain with one supervisor per local database, not distributed tenant admission. Keep the database off network filesystems. Allowed input roots are capabilities to read those files; choose narrow prepared-data directories. Stored snapshots need suitable filesystem protection and retention. Keys remain host configuration, never task contents or returned receipts.

## Current and planned

The dedicated `jev` binary is implemented. [CLI bindings](../apps/cli/src/ks-commands.ts) reserve `ks jev` until cleanup slice 5F; importing the normal host does not start Jev. Do not remove the working service or `.jev` operator data because the [target layout](../docs/operations/package-cleanup/FINAL-LAYOUT.md) describes later consolidation. Source tests do not establish deployed availability or question-specific quality calibration.
