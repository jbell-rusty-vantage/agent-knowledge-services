<!-- BEGIN GENERATED: semantic-map -->
## Code navigation: packages/verification/src

Internal verification algorithm seams.

Full interfaces, dependencies, tests, and architecture: [semantic map](../../../docs/agents/CODE-MAP.md). Paths in the rows below are repository-relative.

| Module | Responsibility | Enter |
|---|---|---|
| [verification-canonical](../../../docs/agents/CODE-MAP.md#verification-canonical) | RFC 8785 canonical JSON and prefixed SHA-256 digests shared by every stage. | packages/verification/src/canonical/index.ts |
| [verification-decimal](../../../docs/agents/CODE-MAP.md#verification-decimal) | Exact rational-decimal parsing, replay, tolerance, and rounding. | packages/verification/src/decimal/index.ts |
| [verification-deterministic](../../../docs/agents/CODE-MAP.md#verification-deterministic) | Staged mechanical bundle engine: index → capture integrity → runtime separation → evidence edges → assertions → metric graph → result. | packages/verification/src/deterministic/bundle-verification.ts |
| [verification-evidence-selection](../../../docs/agents/CODE-MAP.md#verification-evidence-selection) | Locates the evidence a VerificationSelector points at inside captured bytes: core text/JSON locators, projection-backed locators, and verification of resolver claims. | packages/verification/src/evidence-selection/resolve-evidence-selector.ts |
| [verification-extraction](../../../docs/agents/CODE-MAP.md#verification-extraction) | Bounded schema admission and staged field, cross-field, and duplicate verification against immutable representation bytes. | packages/verification/src/extraction/field-verification.ts |
| [verification-provenance](../../../docs/agents/CODE-MAP.md#verification-provenance) | Audit-bundle seal/inspect/replay, recorded policy inputs, detached-seal benchmark publications, and DSSE/SLSA attestations. | packages/verification/src/provenance/seal.ts |
| [verification-report](../../../docs/agents/CODE-MAP.md#verification-report) | Claim decomposition acceptance and report-wide mechanical gates. | packages/verification/src/report/report-wide.ts |
| [verification-authority](../../../docs/agents/CODE-MAP.md#verification-authority) | Source authority and corroboration assessments. | packages/verification/src/authority/assessment.ts |
| [verification-semantic](../../../docs/agents/CODE-MAP.md#verification-semantic) | Evidence-closed semantic verification: closure, authorization, judge ports, output lattice validation, cross-family reconciliation, drift, rescue, attribution. | packages/verification/src/semantic/closure.ts |
| [verification-providers](../../../docs/agents/CODE-MAP.md#verification-providers) | Provider port, HTTP bounds, one bounded dispatch procedure, Gateway/Interfaze adapters, recorded/NLI judges, and conformance registry. | packages/verification/src/providers/dispatch.ts |
| [verification-internal](../../../docs/agents/CODE-MAP.md#verification-internal) | Package-private helpers: deep freeze, plain-record guards, and the allocation-bounded JSON walker shared by extraction, semantic, and provider preflights. | packages/verification/src/internal/bounded-json.ts |
| [verification-prototype-compat](../../../docs/agents/CODE-MAP.md#verification-prototype-compat) | Frozen legacy prototype locator, hash, JSON-pointer, arithmetic, and bundle translation shapes. | packages/verification/src/prototype-compat/index.ts |

Descriptions are maintained in `.agent-docs/modules.json` at the repository root. Do not edit this generated block.
<!-- END GENERATED: semantic-map -->
