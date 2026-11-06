---
type: Architecture Concept
title: Retrieval and evidence
description: How policy-scoped retrieval produces bounded, replayable evidence packets instead of unsupported answers.
tags: [knowledge, retrieval, evidence, provenance]
owner: ai-engineer-knowledge-services
sources:
  - id: retrieval-contract
    resource: ../packages/contracts/src/retrieval.ts
    title: Retrieval plan and evidence packet contract
  - id: canonical-retrieval-executor
    resource: ../packages/application/src/knowledge/retrieval/canonical-retrieval-executor.ts
    title: Canonical retrieval executor (application; API and MCP)
  - id: bounded-read-executor
    resource: ../packages/knowledge-db/src/db-read/read-executor.ts
    title: Bounded knowledge read executor
---

# Retrieval and evidence

Retrieval answers a bounded question against an authorized knowledge publication and returns the evidence required to inspect that answer. It is a read-and-explain capability: it does not certify a claim, change canonical knowledge, or promote a vector version.

This page describes the current local implementation and tests. It does not claim that the retrieval endpoint or its dependencies are deployed.

## Purpose

Good retrieval is more than finding similar text. A caller needs to know what question was asked, which scope and clocks applied, which channels contributed, what support survives inspection, and when the service should decline to answer. The durable output is an immutable evidence packet, with a route to replay cited bytes instead of trusting cached prose.

The accepted design background is [`docs/architecture/0003-embedding-retrieval-evaluation.md`](../docs/architecture/0003-embedding-retrieval-evaluation.md). The detailed contract lives in [`packages/contracts/src/retrieval.ts`](../packages/contracts/src/retrieval.ts).

## A plan declares the allowed question

A retrieval plan requires a policy version, query, one or more named subqueries, intent, vector spaces, hard filters, candidate and final bounds, graph settings, and an abstention threshold. It can also carry entity/concept/use-case anchors, optional capabilities, and temporal scopes. A plan is validated before provider work begins.

Three clocks are deliberately separate:

| Clock | What it means | It must not be used as |
| --- | --- | --- |
| World time | When a fact is asserted to hold, as a point or half-open interval. | Evidence that the corpus captured it then. |
| Knowledge sequence | The tenant’s sealed knowledge state to read. | Evidence of world time. |
| Observed/capture time | When material was acquired or indexed. | Evidence that a fact held in the world. |

For example, a caller can ask what a tenant knew at sequence 42 about a feature that was true in March. A document captured in April may support that answer only if its own canonical temporal and evidence bindings do so; freshness alone cannot prove March availability.

The contract enforces distinct bounded entity anchors, unique vector spaces and subquery identifiers, `finalK <= candidateK`, nonempty world intervals, and microsecond-valid timestamps. These are covered by [`packages/contracts/src/retrieval.test.ts`](../packages/contracts/src/retrieval.test.ts).

## Required capability must be real

Some plan features may be expressed as optional, but that declaration is explicit. When a requested feature is absent, the service returns a typed `RETRIEVAL_CAPABILITY_UNSUPPORTED` response before calling a provider. If the caller marks that same capability optional, the omission is recorded in the packet instead of silently changing the query.

The canonical executor, shared by `POST /v1/retrieval-runs` and the MCP `knowledge_retrieve_search` tool, supports the tested world/K/entity scope and rejects required graph expansion, freshness upper bounds, observed-time upper bounds, soft boosts, context, concept anchors, and use-case anchors when they are not implemented. See capability preflight in [`canonical-retrieval-executor.ts`](../packages/application/src/knowledge/retrieval/canonical-retrieval-executor.ts) and tests in [`canonical-retrieval-executor.test.ts`](../packages/application/src/knowledge/retrieval/canonical-retrieval-executor.test.ts). This is a local-working-copy observation; configured providers and live endpoint behavior need separate operational proof.

## From candidate to packet member

The executor searches admitted publication versions through exact, full-text, trigram, and ANN channels, fuses bounded candidates, optionally validates a reranker’s finite subset, and resolves support before putting a member in the packet. A packet member records its canonical record or faithful representation, locator, per-channel scores and explanation, support paths, authority/assurance, freshness, contradictions, supersession, covered subqueries, artifacts, and the abstention decision.

Canonical support requires a typed target plus admitted claims, assessments, locators, source families, and capture artifacts. A path carries the claim status, verification run, admission digest, assessment verdict, selector digest, selected-content digest, and exact capture identity. Candidates without admitted support are omitted; large closures are marked truncated rather than presented as complete. The resolver and its bounded behavior are in [`packages/persistence/src/retrieval-evidence.ts`](../packages/persistence/src/retrieval-evidence.ts), with tests in [`packages/persistence/src/retrieval-evidence.test.ts`](../packages/persistence/src/retrieval-evidence.test.ts).

Temporal state metadata also comes from canonical writes. An accepted segment that explicitly replaces an overlapping segment in the same stream can identify the earlier claim in `supersedesIds`. An admitted `segment_support` relation with role `challenges` identifies the opposing claim in `contradictionIds`. Both sides retain their admitted evidence; the temporal relation and its target must be valid at the requested knowledge sequence. Different text alone does not establish a contradiction. These fields qualify the returned evidence rather than automatically changing the packet's coverage-based abstention policy. A challenge's captured quote supports the challenge assertion itself; its separate canonical support relation challenges the target fact.

Legacy `claim_conflict` and `superseded_by_id` metadata have no relation knowledge clock. They contribute only when the requested sequence equals the tenant's current watermark; historical requests use the versioned temporal relations. Both legacy endpoints must still be admitted and known at that sequence. Only explicit `contradiction` conflicts populate contradiction IDs; supersession remains a separate qualification.

### Example: answering a constrained implementation question

For “Which supported approach works for a versioned deployment?” the caller supplies a policy, vector space, required subqueries, entity anchor, `candidateK`, `finalK`, and a minimum coverage threshold. The packet can show a direct support path for each retained result and flag a superseded claim. If a required subquery is not covered, the packet recommends abstention. The caller should report that limitation instead of filling the gap with nearby context.

## Citation replay protects the explanation

An evidence packet is not a license to quote its stored text forever. Citation replay reads the retained capture object, resolves the original selector again, and verifies tenant, availability, size, media type, representation digest, capture digest, selector digest, selected-content digest, occurrence count, normalization, and resolver version. It returns selected text only after those checks pass.

Replay is bounded: citation operations, capture bytes, and support paths have limits. It rejects unavailable artifacts, object drift, ambiguous/changed selectors, altered locator bindings, and missing remote objects. It does not substitute database metadata for missing bytes. The replay tests exercise Unicode selectors, byte/media drift, cache behavior, and limits in [`packages/persistence/src/retrieval-evidence.test.ts`](../packages/persistence/src/retrieval-evidence.test.ts).

## Boundaries

- **Retrieval owns** plan validation, policy-scoped search, candidate fusion, explanation, packet assembly, and citation replay.
- **Evidence verification owns** whether a claim and assessment are admissible; retrieval consumes that closure and does not re-adjudicate it.
- **Publication owns** which evaluated version is active. Retrieval reads authorized publication bindings and cannot publish or roll back.
- **Callers own** presenting abstention, unsupported-capability responses, qualifiers, contradictions, and freshness accurately.
- **Transports own** HTTP/MCP/CLI adaptation. Cross-repository consumers use published contracts, not internal retrieval packages.

## What an answer consumer should preserve

Store the evidence packet identifier and digest, retrieval run identifier, plan, query clock, authorization decision, selected publication bindings, member locators, and any unsupported-capability or abstention fields. This makes a later explanation trace back to the exact scoped read rather than to an unqualified search string.

Treat score components as diagnostics. A high fusion or semantic score ranks candidates; it does not replace a locator, an admitted support path, or the packet’s assurance and contradiction fields.

## Relationship to preparation

Retrieval consumes the published, versioned output of preparation. It does not repair a weak capture, generate a missing selector, or decide that a failed publication should be visible. Those responsibilities remain upstream in the [knowledge preparation and publication concept](./preparation-and-publication.md).

## Failure modes and expected behavior

| Condition | Result | Caller or operator response |
| --- | --- | --- |
| Required unimplemented feature | Typed `RETRIEVAL_CAPABILITY_UNSUPPORTED` before provider work. | Remove it only if business intent permits, or mark it optional explicitly. |
| Candidate lacks admitted support | Candidate is omitted from the packet. | Do not cite it as canonical evidence. |
| Coverage below threshold | Packet recommends abstention. | State that support is insufficient and refine the plan. |
| Citation bytes or selector drift | Replay fails; cached prose is not accepted as a substitute. | Repair custody or use another reproducible support path. |
| Contradiction, supersession, or truncation | Packet exposes the condition. | Preserve the qualification; request narrower or additional evidence if needed. |

## Current limitations

The bounded read-intent executor accepts a retrieval operation but returns it as skipped with `RETRIEVAL_UNAVAILABLE`; see [`packages/knowledge-db/src/db-read/read-executor.ts`](../packages/knowledge-db/src/db-read/read-executor.ts). That code path is distinct from the API retrieval executor described here, so a caller must select the intended transport rather than assuming every read surface executes retrieval.

This page also does not guarantee the quality of a result merely because it passed contract checks. Retrieval evaluates bounded, authorized support for the requested purpose. It cannot make inaccessible material visible, turn contextual similarity into proof, or replace a policy/admission decision with ranking score. The upstream custody and publication path is described by the neighboring [knowledge preparation and publication concept](./preparation-and-publication.md).

A replayable packet can still be stale for the caller’s question, so consumers must apply its declared clocks and freshness fields.
