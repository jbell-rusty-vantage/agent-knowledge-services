# BellLabs Knowledge Platform

Final specification and delivery packet, 2026-10-10. Authorized target architecture; implementation remains tracked work.

- [Specification](SPECIFICATION.md): product, domain, platform and orchestration contract.
- [Domain surfaces](DOMAIN-SURFACES.md): user/product/retrieval, domain skills, MCP, CLI and Jev.
- [Verification](VERIFICATION.md): research-backed verification upgrades and PostgreSQL/Neo4j semantics.
- [Delivery and capabilities](DELIVERY-CAPABILITIES.md): installations, catalog registration, maintenance and deployment.
- [Architecture decisions](ADRS.md): decisions and explicit changes to existing ownership.
- [Implementation plan](PLAN.md): vertical slices, dependencies and final fixture gate.
- [Linear publication](LINEAR.md): official project, specification and child issues.
- [Current state](CURRENT-STATE.md): **dated 2026-10-10 planning snapshot**, superseded by Sprint V and Sprint OC (component 2.5.0, AIDB contract 0.6.0, K01 `knowledge.read_intent`); source revisions, dirty-work and worktree limits as of that date only. For the present state read [current architecture](../../architecture/current-state.md) and live source.
- [Validation](VALIDATION.md): checks actually performed; runtime and final fixtures unrun.

Architecture is maintained here. Linear owns delivery status after promotion. Update both when a decision changes; local issue copies are a publication snapshot, not a second status tracker. A final specification is not a completed implementation.

## GraphQL and native retrieval amendment

- [Clarification/interview register](CLARIFICATIONS.md): confirmed choices, open decisions and blocked implementation.
- [Biotech GraphQL and typed client](GRAPHQL-CLIENT.md): deployed evidence, library optimization, web/Expo package and Fly qualification.
- [Native agent retrieval and ingestion](NATIVE-RETRIEVAL-INGESTION.md): Cypher/typed artifact options, write semantics and backend-specific GraphRAG.

The latest owner request qualifies the earlier final specification: boundaries remain authorized, while unfinished schema/corpus/agent decisions are explicitly gated.
