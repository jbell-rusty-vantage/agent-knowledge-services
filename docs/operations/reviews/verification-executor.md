# Verification executor review

Status: **Reference — reviewed 2026-09-16.** Baseline, authorization and preserved concurrent
work are recorded in the [package review](verification.md).

## Purpose and acceptance

The executor translates agent-written capture/claim/extraction/report intents into real
verification and custody operations. Its local CLI, remote CLI/MCP/HTTP, and host adapters
share the implementation. The broader knowledge surfaces include ingestion, schema reads,
report assessment and durable recovery; their existence does not turn an executor quote
intent into a native-media locator interface.

| ID | Given / when / then | Assessment / evidence |
|---|---|---|
| EXEC-REVIEW-01 | Given captured text, when an agent searches and locates, returned quotes and offsets refer to the original representation | Present; Unicode-expanding lowercase search regression fixed; overlapping quote counts now agree with deterministic resolution |
| EXEC-REVIEW-02 | Given an exact claim quote, when mechanically verified without a judge, mechanics pass but policy remains held | Exercised by the [CLI scaffold](../../../apps/verification-executor/skills/knowledge-verify/examples/offline.mjs) |
| EXEC-REVIEW-03 | Given a configured comparison, its required options reach the real field verifier; changed values/missing options fail | Fixed missing plumbing for all optional comparison rules; CLI scaffold exercises seven configured comparisons and failures |
| EXEC-REVIEW-04 | Given unsupported raw image input, capture explicitly refuses it rather than fabricating a representation | Exercised by CLI scaffold; full media matrix is in [acquisition capabilities](../../../apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md) |
| EXEC-REVIEW-05 | Agent guidance explains media choices, requirements, result interpretation and bounded recovery; files ship and are integrity checked | Canonical skill/reference/template updated; conformance now includes executor-owned skill files and nested links |

## Changes and compatibility

- G26/N1: literal case-insensitive search uses original-string match positions; lowercasing
  the entire source previously shifted offsets after expanding Unicode characters.
- G3: occurrence counting and ambiguous suggestions include overlapping matches.
- TS3/G2: bounded optional normalization, allowed-values, decimal bounds, identifier and
  checksum options are validated by the intent schema and forwarded to existing algorithms.
  No business comparison is reimplemented in the executor. Inapplicable/missing options fail.
- Optional properties are omitted when absent, including two existing recovery call sites,
  so API consumers using exact optional-property types can typecheck the executor code.
- The operation registry expectation was stale (25 operations versus 42 implemented);
  the test now names the complete current catalog without removing its equality check.

Intent schema versions and package version remain unchanged; fields are optional additions.
The updated skill requires this executor build. An old build can strip unfamiliar fields,
so source/schema version alone is not a compatibility pin. Rebuild and pin the tarball digest
alongside complete skill-content hashes. Existing sealed runs/pins are not mutated.

## Skills and consumer ownership

| Owner / distribution | Changes / pin policy |
|---|---|
| KS `skills/knowledge-verification` | Catalog and frontmatter aligned to 1.2.0; standalone media/assertion reference ships alongside existing CLI/MCP examples |
| KS executor `skills/knowledge-verify` | Catalog 1.1.0; portable capability/reference docs and executable offline template; main instructions distinguish evidence text, proposition and admission |
| KS `skills/check.mjs` | Checks executor command names, reference existence, nested links, executable syntax and full content digest in addition to platform catalog checks |
| KS sandbox packer | Copies entire executor skill tree; tarball SHA-256 covers references and executable template; packaging inspection verifies their presence |
| `research_ingestion_systems_agent/tools/skill-pack-sync` | Reads executor skill version from its manifest instead of hard-coding 1.0.0; generated embedded pack and per-role full-content pins regenerated |
| Mission Control / cloud research / pre-research | No matching local verification SKILL.md wrapper found in the explicit skill directories inspected; their service dispatch contracts are unchanged |

Research consumer regeneration preserves its active source work and does not claim a new
deployment or replace existing run pins. Newly created compatible installations must use the
new full-content pin and matching executor artifact. No frozen experiment output was edited.

## Validation and scenario walk-through

The offline scaffold invokes the built CLI through capture-file → locate (ambiguous) →
locate (unique) → verify-claims → policy. Actual result: mechanical `passed`, zero semantic
judgments, policy `review`. Seven configured field comparisons pass; changed currency and
missing allowed-value options and out-of-range decimal bounds fail; raw image capture exits 2. Receipts are inspected.
Only the source data and agent choices are synthetic. No provider/database/live server is used.

Final validation:

| Check | Result |
|---|---|
| Verification package Vitest | 182 passed across 15 files, including 12 selector examples and offset regressions |
| Executor Vitest, `exec vitest run --maxWorkers=2` | 235 passed, 39 skipped across 50 files; skipped suites require external configuration |
| Package + examples, executor and API typechecks | Passed; API additionally checks executor imports under exact optional-property rules |
| Verification package and executor builds | Passed |
| Both example commands | Passed; no provider calls; decimal lower/upper bounds also reject out-of-range values |
| Skill conformance | Passed: 11 skill directories; executor references/template included in full-content hashes |
| Checker failure detection | Invalid fenced CLI command rejected with both LF and CRLF newlines; original file restored |
| Sandbox packaging | Passed; all five shipped executor skill files byte-compared with source inside tarball |
| Research consumer sync/check | Passed; both affected installed-content hashes match the canonical checker |
| Knowledge Services documentation build/check | Passed after correcting documentation links to the existing ingestion test relocation |
| Scoped Git whitespace check | Passed |
| Root `corepack pnpm verify` | Blocked by pre-existing ingestion relocation imports: files now in src/tests still import ./intent.js, ./plan.js, ./rules.js and ./vocabulary.js. Broad tests/build do not run after that typecheck failure |
| Research-consumer documentation check | Reports existing unmapped tools/run-pin and tools/team modules; skill sync itself is current |

The unrestricted executor test invocation initially exposed a stale operation catalog
expectation (fixed), then four 5-second timeouts during concurrent builds/tests. The bounded
worker run above passed all enabled tests without increasing timeouts or skipping failures.
No live parser/provider/database smoke test, research-agent runtime deployment or full
consumer build was performed. No populated shared database was touched.

Packaged local artifact: apps/verification-executor/dist/sandbox/knowledge-verify-0.1.0.tgz.
SHA-256: `49ace80077614cd25d6b04abc49d776815f4e1ea93ef8cc901119e078427fd73`.
This is a local build receipt, not a deployment claim. Repacking may change the digest.

## Remaining limitations

The source [acquisition capabilities](../../../apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md) and [library capability matrix](../../../packages/verification/CAPABILITIES.md) record
the narrower text-only intents, permissive text decoding, broad PDF scrape fallback,
download buffering, native-media gaps, producer-declared report coverage and first-edge
report citation aggregation. They remain visible product/operational gaps; semantic tuning
and deployment were outside this task. Long executor orchestration methods remain a future
structural refactor rather than being arbitrarily split during this review.
