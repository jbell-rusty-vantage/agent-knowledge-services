# ADR 0005: Platform, domain and product ownership

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

Knowledge Services contains reusable algorithms and AI Engineer-specific bindings; Biotech already has a separate native executor. Product retrieval and agent-facing workflows need stable ownership.

## Decision

Keep four bounded owners: product services, domain knowledge services, reusable Knowledge Services, and Mission Control. General modules receive explicit ports and versioned configuration. The authenticated application binding selects the native domain endpoint/schema/policy; the model cannot select credentials. Keep TypeScript shared services and native SQL/Cypher semantics. API/MCP/worker handlers call shared application use cases in process; cross-repository consumers use published interfaces.

## Consequences and implementation gate

Isolate the AI Engineer binding in the current repository before relocation; preserve its contract pin. Maintain Biotech as a separate consumer. Generalize only operations demonstrated against both domains. Product account/progress/conversation storage is distinct from evidence and canonical knowledge.

## Alternatives

Rejected: a universal ORM, copying the complete service per product, a Python rewrite, and product-name branches inside algorithm code.

## Compatibility

Extends current-state architecture and preserves ADR 0004 transport call graph. Does not transfer existing migration authority.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
