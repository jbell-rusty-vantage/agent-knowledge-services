# ADR 0010: Domain skills and installed capabilities are product deliverables

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

Generic operation documentation does not teach an agent how to perform application-specific research, retrieval or content creation. Existing skill/parser/catalog readiness is partial.

## Decision

Release application-specific skills, MCP server/tool manifests and CLI bindings with each domain capability. Skills own exact process guidance, Jev recipe, evidence obligations, failure handling and escalation. Register every domain skill, server and tool in the respective app-local Mission Control capability catalog using current supported kinds. Store immutable bundle bytes in custody and manifests/digests/versions/dependencies/grants in PostgreSQL. Publication, installation, admission and runtime qualification are distinct.

## Consequences and implementation gate

Jev classifies captured input using domain-pinned choices/rubrics and explicit uncertainty. It never grants authority or writes canonical facts. Upstream providers remain separately owned capabilities. Public guidance has its own disclosure profile; private rubrics and secrets are not leaked into downloadable bundles. CLI bindings use supported catalog semantics rather than an invented kind.

## Alternatives

Rejected: generic platform skills as a substitute for domain guidance, prompt-only enforcement, one shared cross-app catalog authority, and recording fake tool schemas as production qualifications.

## Compatibility

Preserves Mission Control catalog ownership and existing capability ADRs. Existing ks jev/executor retirement plans are dependencies, not delivered capabilities.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
