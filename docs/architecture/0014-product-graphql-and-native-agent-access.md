# ADR 0014: Product GraphQL and native agent access are separate contracts

Status: accepted boundary under the owner's 2026-10-10 correction. v2 adoption, auth topology and agent artifact details have explicit interview gates.

## Context

The Biotech GraphQL service exists on Fly while the proposed domain schema is not implemented in the underlying graph. Earlier platform prose described common use cases but did not make consumer routing explicit enough. A generated API, a pinned SDL, an owner-reviewed candidate and migrated graph data are four different states.

## Decision

Biotech web and React Native/Expo entity clients use the Neo4j GraphQL library through a versioned typed client package. AI Engineer entity clients use its custom PostgreSQL-backed API. Product services own user state, entitlements and composition; a Biotech BFF may proxy GraphQL if the access decision selects it.

Biotech agents use admitted native Neo4j skills or schema-workspace/read/ingest operations; the planned client-facing Deep Agent must use the same path. AI Engineer agents retain their native PostgreSQL domain tools. No GraphQL adapter is inserted into their path. Equivalent domain outcomes and authority do not require identical transports. Directly configured skills use separately provisioned principals; secrets never travel in skill bundles or output artifacts.

GraphQL is a bounded product read surface. Canonical graph mutations retain domain validation, verification admission and native plan/apply authority. A future agent-GraphQL experiment requires a separate decision and is outside this release.

## Consequences

Generate client types from the exact executable product API, not the input domain SDL. Keep source-schema, executable-schema, operation-registry and migrated-data versions separate. Review v2, map legacy data and qualify a staged migration before adoption. Persisted client operations do not replace database authorization or become an agent language.

## Gates and references

- [Clarifications Q01, Q02 and Q04](../specs/belllabs-knowledge-platform/CLARIFICATIONS.md)
- [GraphQL optimization and client contract](../specs/belllabs-knowledge-platform/GRAPHQL-CLIENT.md)
- [Native agent contract](../specs/belllabs-knowledge-platform/NATIVE-RETRIEVAL-INGESTION.md)

This qualifies ADRs 0005, 0006 and 0010 wherever “one contract” or “typed read” could imply one universal wire API. It does not select a replacement ontology or migrate data.
