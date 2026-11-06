# ADR 0009: Evidence assurance is independent of effort and backend

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

Verification has implemented mechanical and evidence-closed semantic stages, while prior research describes stronger assurance and efficiency. A tier or database must not change the meaning of a judgment.

## Decision

Keep capture/selector/mechanical integrity universal. Represent evidence support, world correctness, attribution faithfulness, source authority and provenance independently, including not_assessed. Pin domain intended-use policies and risk profiles. Adopt research-derived selective escalation only behind risk-stratified calibration, pass audits and full coverage accounting. Reuse deterministic results by exact evidence/algorithm identity; semantic reuse additionally binds claim/qualifiers, policy, model/rubric and calibration provenance.

## Consequences and implementation gate

Education, engineering and science share the engine but have separate rubric examples, applicability constraints and evaluation datasets. Scientific world-knowledge claims require external evidence and applicability, not model memory or source-count quorum. Optimize batching/concurrency/routing only with total-cost and supported-claim quality measurements. Revision changes propagate through explicit claim/support dependencies.

## Alternatives

Rejected: a single confidence scalar as admission, semantic override of deterministic failure, silent omission of unverifiable claims, and importing literature savings as local benchmark results.

## Compatibility

Adopts explicitly listed portions of the September evidence-research proposal through the verification annex; remaining hypotheses stay gated. Existing frozen seals and replay bytes are preserved.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
