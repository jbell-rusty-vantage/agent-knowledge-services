# ADR 0007: Knowledge Services owns verification records; Mission Control links execution

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

Both application PostgreSQL databases install Mission Control. That availability does not make its lifecycle tables the authority for scientific judgments. Biotech needs graph-visible results without waiting for a final ontology.

## Decision

Own common verification operational records in app-local Knowledge Services PostgreSQL. Mission Control owns operation intent, budget/attempt/lifecycle and references to domain receipts. Link through scoped installation/application/tenant and optional mission/run/attempt identifiers plus verification run and effect identities. Standalone verification has no fabricated mission. Domain stores own authoritative admission and queryable result bindings. Audit bytes reside in app-scoped immutable custody.

## Consequences and implementation gate

AI Engineer maps the result into its relational knowledge schema. Biotech adopts an independently versioned minimal binding for assertions, immutable adjudications, evidence snapshots/locators and activity lineage. A thin graph receipt may reference the full sealed bundle. Completion, application and admission remain independently observable.

## Alternatives

Rejected: embedding all evidence in Mission Control tables, treating a mission success as admission, foreign keys across PostgreSQL and Neo4j, and requiring the whole Biotech ontology to be finalized.

## Compatibility

Preserves Mission Control knowledge integration ownership. The candidate graph mapping is a design input, not acceptance or deployment of the complete candidate schema.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
