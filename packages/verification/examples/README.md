# Verification examples

Run from the repository root with Node >=24 and installed workspace dependencies:

```sh
corepack pnpm --filter @aiengineer/knowledge-verification examples
corepack pnpm --filter @aiengineer/knowledge-verification typecheck
corepack pnpm --filter @aiengineer/knowledge-verification test
```

One example per pipeline stage. Each `NN-*.ts` module exports a small runnable
function over readable fixtures; `NN-*.test.ts` runs the same fixtures in the
ordinary package test suite with one behavior per `it`; [run.ts](run.ts) runs
01–06 in order and prints one JSON line per result, asserting with
`node:assert/strict`. No credentials, network, files, or parser process are needed.

| Stage | Example | Shows |
|---|---|---|
| 0 primitives | [01-canonical-digest.ts](01-canonical-digest.ts) | `canonicalizeJson` key ordering, `digestCanonicalJson` stability across key order, `isSha256Digest` |
| 2 selector integrity | [02-resolve-selectors.ts](02-resolve-selectors.ts) | one fixture for each of the **12 selector kinds**, then ambiguous-quote recovery with source context |
| 1 capture integrity | [03-deterministic-bundle.ts](03-deterministic-bundle.ts) | a minimal passing `VerificationBundle`; the same bundle with an equal-length byte corruption fails `CAPTURE_DIGEST_MATCH` and loses `semanticEligibility` |
| 3 mechanical correctness | [04-extraction-fields.ts](04-extraction-fields.ts) | `admitExtractionSchema` → candidate → `verifyExtractionFieldsWithEvidence` with one `exact` and one `decimal` field; accepted leaves carry raw and compared values |
| 4 semantic support | [05-semantic-recorded-judge.ts](05-semantic-recorded-judge.ts) | `verifyAssertionSemantics` closes the corrupted bundle with `MECHANICAL_GATE_CLOSED` **without calling the judge**; the passing bundle gets a recorded `directly_supported` verdict keyed by the blinded-input digest |
| 5 provenance | [06-seal-inspect-replay.ts](06-seal-inspect-replay.ts) | in-process Ed25519 keypair, `sealAuditBundle` → `inspectAuditBundle` (`signatureStatus: "verified"`) → `replayAuditBundle` with an in-memory trusted resolver and a stub policy replay |

[bundle-fixture.ts](bundle-fixture.ts) is the shared minimal bundle used by 03, 05 and 06.
Example 06 reuses the run-manifest fixture from `src/provenance/audit-bundle.fixture.ts`
so the examples and the provenance tests agree on one manifest shape.

Expected output for 02: twelve `resolved` results with coordinate ranges; repeated `42` is
`ambiguous`, then resolves after adding source context. The resolvers are real;
HTML/PDF/image/table/transcript/repository/dataset/API projections are synthetic parser
outputs, not a raw-media ingestion demonstration. Structured results intentionally retain
locator metadata: they are not interchangeable with scalar extraction values.

These are internal algorithm examples. External agents use the
[executor CLI example](../../../apps/verification-executor/examples/README.md) or the admitted
platform HTTP/client/CLI/MCP contracts, never imports from this package.

[../CAPABILITIES.md](../CAPABILITIES.md) reviews the selector matrix, deterministic
diversity and semantic scope, and links each row to the example that exercises it.
