# ADR 0013: Contract-first slices and final two-application acceptance

Status: accepted implementation direction under the owner's 2026-10-10 planning authorization. Not an implementation or deployment attestation.

## Context

Parallel module changes need integration evidence, but the owner requires complete application fixtures only once the implementation is ready.

## Decision

Deliver context-sized vertical slices with native Linear blocking edges and self-contained acceptance criteria. Run unit/contract/disposable adapter integration, frozen replay and labeled quality evaluations during implementation. Run the full AI Engineer and Biotech application fixtures only after every implementation, skill/catalog, product and deployment-readiness prerequisite is complete. Their final ticket depends on the complete prerequisite set.

## Consequences and implementation gate

Use a common compatibility contract and build evidence with independent application release manifests, locks and readiness states. Preserve unrelated dirty changes and retained worktrees. Separate interactive workloads from heavy workers and maintain app-specific authority. Scope checks to the change; report failed, skipped, blocked and unrun honestly. A final fixture failure reopens the owning slice; targeted repairs precede rerun.

## Alternatives

Rejected: early full research fixtures, a mock-only production-readiness claim, per-module microservices by default, or discarding maintenance worktrees because they appear clean.

## Compatibility

Supersedes older requests to run the retired research-agent readiness fixture during intermediate cleanup for this program. Preserves useful lower-level replay and adapter tests; all final app fixtures remain unrun in the planning delivery.

## References

- [Final specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md)
- [Verification contract](../specs/belllabs-knowledge-platform/VERIFICATION.md)
- [Domain surfaces](../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md)
- [Delivery contract](../specs/belllabs-knowledge-platform/DELIVERY-CAPABILITIES.md)
