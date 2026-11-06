# Catalog

Versioned acquisition, conversion, chunking, embedding, retrieval and evaluation profiles belong here as implementation gates introduce them.

## Admitted local prototype profiles

| Capability | Version | Status | Egress |
| --- | --- | --- | --- |
| deterministic structural text conversion | `1.0.0` | local fixture admission | none |
| exact HTTP capture | `1.0.0` | contract-tested candidate | bounded public HTTP(S) |
| Unstructured Transform adapter | provider-pinned | contract only | policy-controlled managed processing |
| Docling Serve adapter | container-pinned | contract/fallback | local service |
| transcript topics | `transcript-topics-v1@1.0.0` | local fixture admission | none |
| heading sections | `heading-sections-v1@1.0.0` | local fixture admission | none |
| atomic claims | `atomic-claims-v1@1.0.0` | local fixture admission | none |
| entity facets | `entity-facets-v1@1.0.0` | local fixture admission | none |
| tool capabilities | `tool-capabilities-v1@1.0.0` | local fixture admission | none |
| code symbols | `code-symbols-v1@1.0.0` | local fixture admission | none |
| table row groups | `table-row-groups-v1@1.0.0` | local fixture admission | none |

## Gate 3–5 capabilities

| Capability | Package | Deterministic proof |
| --- | --- | --- |
| Gateway embeddings and fake | `@aiengineer/knowledge-embeddings` | ordered batches, dimensions/finiteness, cache, retry/idempotency, safe receipts |
| Exact and Postgres vectors | `@aiengineer/knowledge-vector-backends` | exact cosine, canonical RPC, atomic publication, rollback/reconciliation |
| Advanced retrieval | `@aiengineer/knowledge-retrieval` | lexical/semantic/RRF/graph/rerank/diversity/context/abstention packets |
| Evaluation and gates | `@aiengineer/knowledge-evaluation` | frozen qrels, ablations, quality/hard/regression gates, rollback proof |
| Service telemetry | `@aiengineer/knowledge-observability` | SLO/cost snapshots and manifest drift findings |

The preparation profiles produce review candidates. The Gate 3–5 services can embed, evaluate, and atomically publish approved versions. The three real bundles remain `internal_exploratory`; no live verification promotes them to canonical state.

Broad Gate 5 evidence is frozen in `broad-corpus-review-v4.json` (independent acceptance), `broad-corpus-review-history.json` (preserved rejection trail), `broad-heldout-evaluation.json` (96-case experiment/gate/rollback receipt), and `live-judge-calibration-receipt.json` (bounded 12-case Gateway calibration). Run `pnpm evaluate:broad` for deterministic replay and `pnpm test:live:judge` only for an explicit live run with configured credentials. `gate5-human-review-sample.packet.json` and its blank response template are a pending actual-human sample audit; see `docs/GATE5_HUMAN_REVIEW.md`.

`capability-profiles.v1.json` is the machine-readable Gate 6 catalog. Profile versions are immutable: changing an image/model, schema, dimension, resource envelope, egress rule, or idempotency behavior requires a new version and admission evidence.

## Gate 1 live evidence

`gate1-live-evidence.json` is the bounded, noncanonical acquisition/conversion receipt. It contains only source identity, digests, sizes, typed provider outcomes and verification checks. Provider bodies and credentials are not retained. See `docs/GATE1_IMMUTABLE_ACQUISITION_AND_CONVERSION.md` for status and replay instructions.
