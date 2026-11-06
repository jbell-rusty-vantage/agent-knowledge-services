# ADR 0006: Direct reads and bounded query modes

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

Schema sandboxes are useful for novel work but excessive for navigation and familiar knowledge questions. Current native bounded reads exist; graph-capable canonical retrieval is incomplete.

## Decision

Product APIs compose authorized user state and domain results. Domain services expose typed entity/content reads and Direct/Fast/Explore/Research execution paths. Direct needs no model; Fast uses approved query/retrieval profiles; Explore permits bounded schema planning; Research invokes Mission Control. Escalation respects declared scope and budget. Required unsupported operations reject explicitly.

## Consequences and implementation gate

Compile schema slices and query catalogs at schema release, reusing Biotech question patterns and AI Engineer named queries. Cache schema and result data separately; result reuse keys include authority and knowledge/publication versions, and revocation remains live. Benchmark correctness, coverage, p50/p95 and full cost on fixed requests before setting production SLOs.

## Alternatives

Rejected: a mission/sandbox per read, exposing the full generated ontology as the product contract, and silently treating failed/skipped reads as empty answers.

## Compatibility

Adds a product query contract; does not claim existing retrieval executor graph features are delivered.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
