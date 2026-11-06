# ADR 0008: One owner for common Knowledge Services operational SQL

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

Knowledge Services currently consumes the AI Engineer database-contract release for operational and domain persistence. A second installation needs reusable operational DDL without competing migration authorities.

## Decision

Extract a versioned Knowledge Services operational database component under platform ownership through an explicit expand/migrate/contract delivery. Per-app database contract/deployment consumers pin that component. AI Engineer continues owning domain SQL and generated application types; Biotech owns graph migrations and its PostgreSQL deployment wrapper. Mission Control retains its existing common database package unchanged.

## Consequences and implementation gate

Before extraction, inventory exact tables/functions/grants and consumers; distinguish operational execution from domain evidence/admission. Never issue the same DDL from two authorities. Prove existing-data preservation, scoped permissions, deterministic upgrade, receipt identity and rollback/forward repair on disposable databases. Until the migration gate passes, existing pins and authority remain in force.

## Alternatives

Rejected: a second hand-maintained copy of AI Engineer migrations, moving knowledge tables into Mission Control for convenience, and a third shared multi-app authority database.

## Compatibility

Explicitly schedules the future change to the current AGENTS migration rule; that rule remains authoritative for current schemas until the ownership transition is delivered.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
