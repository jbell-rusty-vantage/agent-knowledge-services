# ADR 0011: Share content lifecycle while retaining domain validation

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

AI Engineer and Biotech both author versioned content, but a lesson and protocol have different correctness and usability conditions.

## Decision

Share content identity/version envelopes, assets, source/evidence lineage, review and publication mechanisms. Keep domain payload schemas and validators: courses/challenges/projects and learning/runnable properties for AI Engineer; protocols/reports/articles/timelines and scientific qualifiers for Biotech. Separate authored draft, verification, domain validation, admission and publication.

## Consequences and implementation gate

Private/user-authored drafts and official publications carry different scope and policy. Publication binds exact content/evidence versions and can be withdrawn or superseded without rewriting history. Initial ordinary MCP tools expose drafts and submit-review, with an explicit publication exclusion; official publish/withdraw use reviewer-authorized HTTP/CLI. Existing vector-publication exclusions remain. Product progress and personalization reference content versions but do not become canonical knowledge. Learning projects include an admitted runnable workspace/test path and external editor handoff; a full embedded IDE is outside this release.

## Alternatives

Rejected: a universal step/content schema, publishing on agent completion, and treating citation verification as proof of pedagogical or scientific adequacy.

## Compatibility

Extends preparation/publication architecture without changing existing official admission semantics.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
