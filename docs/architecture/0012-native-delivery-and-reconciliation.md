# ADR 0012: Idempotent native application across operational and domain stores

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

Verification may finish in PostgreSQL while Biotech application occurs in Neo4j; crashes can occur before or after either durable write.

## Decision

Use a durable outbox/result-delivery record scoped by application/tenant and stable semantic effect identity. Validate sealed result authority and exact intended effect before native apply. Record the canonical graph effect and its unique intent marker in one native transaction. A lost response is reconciled by receipt/marker lookup; retrying the same bytes is idempotent and changed bytes conflict. Mark delivery complete only after verified receipt.

## Consequences and implementation gate

Preserve the pure Biotech planner and one-transaction executor. Record pending/applied/rejected/unresolved delivery separately from verification execution and domain admission. Reconciliation reauthorizes current scope without rewriting historical evidence or inventing exactly-once provider billing. Cancellation cannot erase an already committed effect.

## Alternatives

Rejected: distributed transaction assumptions, inline caller verdict flags, creating a new intent identity after a timeout, and using missing operation rows as proof no write occurred.

## Compatibility

Aligns with both native receipt contracts and Mission Control external-effect reconciliation; does not merge their state machines.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
