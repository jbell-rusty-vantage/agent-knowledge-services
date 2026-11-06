# ADR 0002: deterministic knowledge preparation

Status: accepted for the local prototype

The preparation service treats every stage as an activity with serializable input and output. Exact input bytes are sealed in a tenant-scoped content-addressed artifact store. Canonical JSON, SHA-256 digests, capability/profile versions and ordered spans define deterministic identities. An operation ledger records step leases, retries, events and receipts so an expired worker can be reclaimed without inventing a second output identity.

The application exposes two bounded use cases:

1. `vetOnly` validates source identity inputs, source roles, content presence, entity anchors, target spaces and the exploratory-store guard.
2. `preparePreview` seals selected content, converts it, normalizes stable document nodes, creates reconstructable chunks, validates faithful source sections and claim evidence, then submits an append-only curation proposal.

The preview boundary does not embed, publish, mutate canonical data or accept its own proposal. A reviewer/control-plane decision bound to the guarded proposal digest is a later authority step.

Managed converters remain adapters. Deterministic native conversion handles text, transcripts, Markdown and HTML fixtures. Docling Serve is the default binary converter. Unstructured Transform is the gated paid safety net and uses a bounded job contract. Acquisition and conversion tests inject transports and providers, so default CI never reaches arbitrary live web content.

The versioned `embedding-bundle-seed-2026-09-01` corpus is loaded from the research-starter sibling repository with provenance and schema validation. The fixture importer can copy the three exact bundle files plus a canonical manifest into a standalone test location when repository co-location is unavailable.
