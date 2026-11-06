# `@aiengineer/knowledge-verification`

Private workspace package that owns the verification **algorithms** for Knowledge Services (`verification.v1`): content-addressed capture integrity, evidence-selector resolution, mechanical assertion/metric/extraction checks, evidence-closed semantic judging, and audit-bundle sealing, inspection and replay. Transport schemas live in `@aiengineer/knowledge-contracts`; `packages/application` composes use cases with persistence; `apps/api`, `apps/cli`, `apps/mcp` and `apps/worker` are thin transports. Policy admission is decided in `packages/policy`, never here. Cross-repository consumers use HTTP, CLI or MCP and must not import this package.

## Sequence

The package answers five ordered questions. Later stages may add restrictions; they never reverse an earlier deterministic failure.

| Stage | Question | Entry | Reads |
|---|---|---|---|
| 0 | Primitives | `canonicalizeJson`, `digestCanonicalJson`, `sha256Digest`, `parseDecimal` | `src/canonical/`, `src/decimal/`, `src/versions.ts` |
| 1 | Capture integrity | `verifyDeterministicBundle` | `src/deterministic/bundle-verification.ts` → `capture-integrity.ts`, `runtime-separation.ts` |
| 2 | Selector integrity | `resolveEvidenceSelector` | `src/evidence-selection/resolve-evidence-selector.ts` → `core-resolver.ts`, `projection-resolver.ts`, `projections/*` |
| 3 | Mechanical correctness | bundle assertions and metrics (`evidence-edge.ts`, `assertion-verification.ts`, `metric-verification.ts`); `verifyExtractionFields` / `verifyExtractionFieldsWithEvidence`; `verifyReportWide`, `applyReportWideMechanicalGates`; `assessSourceAuthority` | `src/deterministic/`, `src/extraction/field-verification.ts`, `src/report/`, `src/authority/` |
| 4 | Semantic support | `verifyAssertionSemantics` = `mechanicalSemanticClosure` → `authorizeSemanticCase` → `verifySemanticCase` | `src/semantic/closure.ts`, `authorize.ts`, `verify-case.ts`, `judge-output.ts`; adapters in `src/providers/` |
| 5 | Provenance | `sealAuditBundle` → `inspectAuditBundle` → `replayAuditBundle`; DSSE/SLSA attestation | `src/provenance/seal.ts`, `replay.ts`, `attestation.ts` |

`src/provenance/replay.ts` is the top of the dependency graph: it re-hydrates artifacts through a trusted resolver, re-runs the deterministic engine, re-checks report-wide gates and recorded policy inputs, and optionally re-runs semantic replay. It is the best single file to read the whole pipeline end to end.

## Invariants enforced here

| Invariant | Enforcement |
| --- | --- |
| Deterministic-before-semantic; monotonic failure | `verifyDeterministicBundle` sets `semanticEligibility` only when mechanical status is `passed` (`src/deterministic/bundle-verification.ts`). `authorizeSemanticCase` throws `SEMANTIC_MECHANICAL_GATE_CLOSED` otherwise (`src/semantic/authorize.ts`). `applyReportWideMechanicalGates` can only add hard failures and clear eligibility (`src/report/report-wide.ts`). |
| Evidence-closed judges cannot override mechanical failure | `verifyAssertionSemantics` returns `mechanicalSemanticClosure` (`locator_error` / `unverifiable`, reason `MECHANICAL_GATE_CLOSED`) without calling a judge (`src/semantic/closure.ts`). Judges see only authorized fragment IDs/bytes; a case not minted by `authorizeSemanticCase` is rejected by runtime identity (`src/semantic/authorize.ts`, `verify-case.ts`). |
| Content-addressed immutable captures | `CAPTURE_DIGEST_MATCH` / `CAPTURE_BYTE_LENGTH_MATCH` hash hydrated bytes against the registered handle (`src/deterministic/capture-integrity.ts`). Projection bytes are re-hashed the same way. |
| Selectors ≠ display excerpts | Resolution binds `selectorDigest = digestCanonicalJson(selector)` (`SELECTOR_DEFINITION_BOUND`, `src/deterministic/evidence-edge.ts`); selected bytes are re-hashed and compared with the resolver's claim (`src/evidence-selection/resolve-evidence-selector.ts`). HTML `canonicalTextFallback` is a check, not a locator (`src/evidence-selection/projections/html.ts`). |
| Producer/verifier independence | `PRODUCER_VERIFIER_INDEPENDENT` requires distinct runtime principal deployments and principal digests (`src/deterministic/runtime-separation.ts`). |
| RFC 8785 canonicalization before hashing/sealing | `canonicalizeJson` / `digestCanonicalJson` (`src/canonical/`). Manifest and audit seals hash that projection (`src/provenance/seal.ts`: `verificationManifestDigest`, `sealAuditBundle`). |
| Append-only judgments (seal-time) | No in-package judgment store or overwrite API. A run manifest's `judgments` array is part of the RFC 8785 signable payload; changing it changes `manifestDigest` (`src/provenance/seal.ts`). |
| Bounded provider effects | Every provider call runs admission → persist request → fetch → persist response → interpret through one procedure (`src/providers/dispatch.ts`); no retry path exists in this package. |

## Module map

| Directory | Responsibility | Entry |
| --- | --- | --- |
| `src/canonical/` | RFC 8785 JSON and prefixed SHA-256 digests | `index.ts` |
| `src/decimal/` | Exact rational-decimal parsing, replay and tolerance | `index.ts` |
| `src/versions.ts` | Every protocol version literal that participates in digests | — |
| `src/deterministic/` | Staged bundle engine: index → captures → runtime separation → evidence edges → assertions → metric graph → result | `bundle-verification.ts` |
| `src/evidence-selection/` | Core text/JSON locators (`verification-core.v1`), projection-backed locators per media kind (`verification-projections.v1`), resolver-claim verification | `resolve-evidence-selector.ts` |
| `src/extraction/` | Bounded schema admission; field, cross-field and duplicate verification against immutable representation bytes | `field-verification.ts` |
| `src/report/` | Claim decomposition acceptance; report-wide mechanical gates | `report-wide.ts` |
| `src/authority/` | Source-fitness / independent-corroboration decision | `assessment.ts` |
| `src/semantic/` | Closure, evidence-closed authorization, judge ports, output lattice validation, cross-family reconciliation, drift, rescue, attribution | `closure.ts` |
| `src/providers/` | Provider port, HTTP bounds, shared bounded dispatch, Gateway/Interfaze adapters, recorded/NLI judges, conformance registry | `dispatch.ts` |
| `src/provenance/` | Audit-bundle seal/inspect/replay, recorded policy inputs, detached-seal publications, DSSE/SLSA attestation | `seal.ts`, `replay.ts` |
| `src/prototype-compat/` | Frozen legacy prototype locators, hashes and bundle translation; subpath export `@aiengineer/knowledge-verification/prototype-compat` | `index.ts` |
| `src/internal/` | Deep freeze, record guards, bounded JSON walker (not exported) | — |

## Error style by layer

| Layer | Style |
| --- | --- |
| Deterministic engine, extraction, report-wide | Never throws for verification outcomes: returns checks (`code`, `status`/`passed`, `detail`) and aggregate status; malformed input is itself a failed check. |
| Selector resolution | Returns an `EvidenceSelection` whose `resolution.status` is `resolved`, `not_found`, `ambiguous`, `invalid` or `parse_error`; `undefined` means no resolver owns the kind. Projection parsers throw `PROJECTION_INVALID:*` internally and the resolver converts that to `invalid`. |
| Semantic authorization and sealing | Throws `Error("CODE")` with a stable code (`SEMANTIC_MECHANICAL_GATE_CLOSED`, `POLICY_VERSION_BINDING_MISMATCH`, `LINEAGE_CYCLE`, …); nothing is repaired. |
| Provider adapters | Throws `ProviderFailure` with a `code` and `retryable` flag; callers decide, this package never retries. |
| Verification-style results | `{ verified: false, reason }` or `{ valid, errors[] }` records (`inspectAuditBundle`, attestation inspection, decomposition evaluation) so a caller can persist the outcome. |

## Usage

Start with the runnable, tested examples — one per stage:

- [`examples/01-canonical-digest.ts`](examples/01-canonical-digest.ts)
- [`examples/02-resolve-selectors.ts`](examples/02-resolve-selectors.ts)
- [`examples/03-deterministic-bundle.ts`](examples/03-deterministic-bundle.ts)
- [`examples/04-extraction-fields.ts`](examples/04-extraction-fields.ts)
- [`examples/05-semantic-recorded-judge.ts`](examples/05-semantic-recorded-judge.ts)
- [`examples/06-seal-inspect-replay.ts`](examples/06-seal-inspect-replay.ts)

See [examples/README.md](examples/README.md). [CAPABILITIES.md](CAPABILITIES.md) is the selector, deterministic-diversity and semantic-scope matrix, with each row linked to its example.

## Development

```bash
corepack pnpm --filter @aiengineer/knowledge-verification typecheck
corepack pnpm --filter @aiengineer/knowledge-verification test
corepack pnpm --filter @aiengineer/knowledge-verification examples
corepack pnpm --filter @aiengineer/knowledge-verification build
```

On Windows Git Bash use `corepack.cmd`. Tests are colocated `*.test.ts` files run by `vitest run`; the examples' `*.test.ts` files are part of the same suite and the typecheck covers `examples/`. The frozen engine golden lives at `src/deterministic/engine-golden.fixture.ts`: a change to its digests means bytes, order or meaning changed — find out why, do not refresh it.

Historical design and review notes are under [`docs/`](docs/).

## Boundaries

This package must not:

- Own persistence, tenant authorization or artifact registration (application + `packages/persistence`).
- Be the policy admission authority (`packages/policy`).
- Put provider SDK client objects on the public facade. Adapters take `fetch`, an API key and a `ProviderArtifactSink`.
- Perform filesystem I/O. An injected `fetch` inside the provider adapters is the only network path.
- Retry provider calls, add selector kinds, or extend `prototype-compat/`.
- Be imported by other repositories. Cross-repo callers use HTTP, CLI or MCP.

## Responsibilities outside this package

| Concern | Location |
| --- | --- |
| Metrics | `packages/application/src/verification-metrics.ts` |
| Experiments / benchmarks | `packages/evaluation/src/verification-benchmark*.ts`, `verification-statistics.ts`, `verification-human-review.ts`; `packages/application/src/verification-benchmark*.ts` |
| Demos | `apps/cli/src/diagnostics-demo.ts`; `packages/application/src/verification-diagnostics-*.ts` |
| Persistence | `packages/persistence/src/verification*.ts` |
| Policy admission | `packages/policy/src/verification-policy.ts` |
| Acquisition and executor intents | `apps/verification-executor` ([acquisition capabilities](../../apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md)) |
