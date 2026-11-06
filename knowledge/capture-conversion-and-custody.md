---
type: Architecture Concept
title: Capture, conversion, and artifact custody
description: Preserve exact source bytes and conversion lineage while keeping acquisition, document conversion, native parsing, and admission separate.
tags: [capture, conversion, artifacts, custody, parser, docling]
aliases: [source bytes, PDF parsing, HTML parsing, document conversion]
questions:
  - What is the difference between Docling and the verification parser?
  - Does converting a document admit its claims?
  - How are parsed projections bound to captured bytes?
owner: ai-engineer-knowledge-services
implementation_status: implemented-with-provider-gates
decision_status: reference
validation_status: source-and-test-inspected
sources:
  - resource: ../packages/preparation/src/conversion/index.ts
    title: Conversion and parser entrypoints
  - resource: ../packages/preparation/src/conversion/verification-parser.ts
    title: Isolated parser admission and resource bounds
  - resource: ../packages/persistence/src/preparation.ts
    title: Immutable preparation persistence
---

# From source bytes to inspectable evidence

Acquisition obtains bytes; conversion produces a useful representation; parsing produces structured projections for selectors. Custody binds each result to its source and procedure. None of these operations alone admits a claim or publishes knowledge.

The [preparation repository](../packages/persistence/src/preparation.ts) retains capture, representation and chunk identities with lineage, rejecting conflicting replay metadata. Its [tests](../packages/persistence/src/preparation.test.ts) cover immutable persistence. Continue to [preparation and publication](preparation-and-publication.md) for nodes, chunks and canonical effects.

## Select the right boundary

| Need | Owner | Evidence to inspect |
| --- | --- | --- |
| Acquire an HTTP response or local upload | `packages/sources` | Captured bytes, acquisition receipt and source identity; acquisition is not admission. |
| Convert stored text or documents | `packages/preparation/src/conversion` | Provider route, transformation signature, output and residuals. |
| Run Docling conversion | Separate `services/docling` deployment | Pinned service image and explicit availability. |
| Resolve native HTML DOM or PDF text/geometry | Isolated parser invoked by preparation | Parent digest, parser version, bounded projections and residuals. |
| Admit claims or canonical changes | Verification and policy, then ingestion | Sealed evidence and independently admitted use, not a conversion success. |

The [conversion barrel](../packages/preparation/src/conversion/index.ts) exposes media classification, deterministic conversion, providers, HTTP clients and the verification parser. Routing uses deterministic text handling, Docling and gated Unstructured; the [conversion tests](../packages/preparation/src/conversion/conversion.test.ts) exercise text-only handling, HTML routing and PDF conversion without an Unstructured key. Do not silently replace a failed route with an unrecorded local splitter or provider.

## Docling is not the native parser

[Docling compose](../services/docling/compose.yaml) configures a pinned image, loopback HTTP service, read-only filesystem, temporary storage, resource bounds and a health check. This is a deployment recipe, not evidence that a service is running.

The [native parser](../services/parser/parser.py) is a separate stdin/stdout Python process: html5lib produces DOM projections; pdfplumber produces PDF text and geometry. The [container](../services/parser/Dockerfile) runs as an unprivileged user. The [TypeScript adapter](../packages/preparation/src/conversion/verification-parser.ts) checks the parent-byte digest, allowed kinds and parser output, and imposes byte, page, process and execution bounds. Current limits include 8 MB input, 4 MB output, 40 pages and 45 seconds. Inspect constants before changing callers rather than copying those values into new policy.

[Parser tests](../packages/preparation/src/conversion/verification-parser.test.ts) anchor rejection and isolation behavior. A projection is evidence about the captured document, not a fresh URL fetch. Preserve residuals and unsupported-format failures so callers can distinguish absent evidence from successful empty extraction.

## Handoff and failure

Pass retained artifact handles and exact locators across stages. A later stage must authenticate custody and scope before trusting a handle; a path string or successful upload is insufficient. If bytes change, create a new capture and repeat affected stages rather than rewriting an old receipt. Recovery must preserve the original bindings described in [durable execution and recovery](durable-execution-and-recovery.md).
