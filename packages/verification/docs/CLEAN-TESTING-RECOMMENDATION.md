> **Status (2026-09-19):** superseded. The refactor this document recommended was implemented on 2026-09-19 (see the package [README](../README.md) for the current layout, sequence and invariants). Retained for history; file paths and symbol names below refer to the pre-refactor tree and are not updated.

# Clean testing recommendation for verification

Status: recommendation only, based on the working tree inspected on 2026-09-11. No tests or production algorithms have been changed by this documentation work. The [final clean-code implementation plan](CLEAN-CODE-RECOMMENDATION.md) incorporates these findings and governs scope, implementation order and conflicting suggestions. This file supplies the detailed testing rationale and examples. Read it alongside [module comprehension](COMPREHENSION.md) and [testing comprehension](TESTING-COMPREHENSION.md).

The objective is a suite whose failures tell us **which verification promise broke and under what condition**. Increasing the test count or freezing the current implementation structure is not the objective. Prototype and experiment caller migration remain deferred; existing production assertions that happen to use prototype-named fixtures still matter.

## 1. Evidence and scope

The review used the [clean-tests skill](../../../.agents/skills/clean-tests/SKILL.md) and [clean-names skill](../../../.agents/skills/clean-names/SKILL.md). The detailed “one concept per test” guidance is the useful rule: a result and proof that no forbidden side effect occurred can require multiple assertions about the same concept.

| Verification performed | Result |
| --- | --- |
| Verification package test script | 13 files, 110 tests passed; reported duration 4.83 seconds. Includes compatibility and publication tests. |
| Contracts package test script | 25 files, 85 tests passed; reported duration 3.49 seconds. Includes non-verification contract tests. |
| Core/verification-contract source scan for `skip`, `only`, `todo` test modifiers | No matches found in the inspected scope. |
| Verification coverage command | Blocked by missing `@vitest/coverage-v8`; no coverage percentage was measured. |

These are a baseline for this snapshot, not permanent counts or evidence of full branch coverage. No live provider, database proof, executor end-to-end run, typecheck or mutation test was performed for this documentation review. Application/worker tests were located as boundary references, not exhaustively audited or run.

## 2. Preserve the tests that protect real contracts

The suite already contains valuable checks. Keep their intent while improving their names and organization:

- Hard-coded deterministic result digests and explicit canonical JSON expectations in [deterministic.test.ts](src/deterministic/deterministic.test.ts).
- Evidence degradation that never improves eligibility, and rejection of wrong-source numeric values.
- Frozen accepted extraction leaves and the single-resolution evidence regression in [extraction.test.ts](src/extraction/extraction.test.ts).
- No judge call when the mechanical gate is closed in [semantic/verification.test.ts](src/semantic/verification.test.ts).
- Retained HTTP status/raw responses before local rejection in [providers.test.ts](src/providers/providers.test.ts) and [Gateway observations](src/providers/gateway-semantic-observation.test.ts).
- Authorization/hydration adjacency, actual Ed25519 verification, semantic replay before policy, and detection of changed retained inputs in [provenance.test.ts](src/provenance/provenance.test.ts).
- Distinguishing unsigned integrity from a trusted signature in [benchmark-publication.test.ts](src/provenance/benchmark-publication.test.ts).

A call-count assertion is useful when it protects an externally meaningful guarantee, such as avoiding a second source resolution or provider dispatch. Asserting that a newly extracted private helper ran once would merely mirror implementation.

## 3. First priority: make each test prove its stated claim

These are specific assertion-quality findings, not claims that the production behavior is broken.

| Current test / source | What is currently established | Recommendation |
| --- | --- | --- |
| “keeps the public read projection strict and free of Storage coordinates” in [audit-inspection.test.ts](../contracts/src/verification/audit-inspection.test.ts) | Both supplied candidates are invalid for reasons beyond storage coordinates; one has an empty output, another is constructed from an empty partial object. | Start with a fully valid public resource; establish it parses, add only `objectKey`, and check the rejection identifies that extra key. Otherwise the test could pass if storage-key rejection disappeared. |
| “passes only mechanically selected fragment bytes and keeps provider confidence uncalibrated” in [semantic/verification.test.ts](src/semantic/verification.test.ts) | Result dimensions, raw confidence and one judge call. It does not inspect the judge input. | Split confidence semantics from evidence isolation. Inspect the exact input envelope and verify it contains only authorized fragment IDs/text, without suggested evidence roles or extra bytes. |
| “sends Interfaze ZDR at the HTTP boundary and persists its successful HTTP status before parsing” in [providers.test.ts](src/providers/providers.test.ts) | Header and request/response sink records; fetch is not included in the recorded order. | Separate header policy from ordering. Record admission, request persistence, fetch and response persistence. Reject request persistence and prove fetch never occurs; reject raw persistence and prove no interpreted result escapes. |
| “is admitted by the core port only when its canonical selected bytes replay” in [resolvers.test.ts](src/selectors/resolvers.test.ts) | A valid resolver result's digest matches its bytes. No dishonest resolver is supplied. | Add a resolver returning bytes inconsistent with its digest and assert rejection by the admission wrapper. Keep the valid case as its own test. |
| “captures structured scalar selection once … rather than resolving a mutable source twice” in [extraction.test.ts](src/extraction/extraction.test.ts) | The resolver is called once and accepted leaves are returned. The resolver itself does not change its response. | Keep the useful call-count check. For stronger regression proof, return different content on a second call and assert the leaf remains bound to the first selection, or narrow the test name to the current proof. |
| “accepts URL-safe base64 but rejects PAE, payload-type, subject, dependency, and private-field tampering” in [attestation.test.ts](src/provenance/attestation.test.ts) | Several independent cases; subject/dependency changes also invalidate the existing signature. | Separate byte/signature tampering from signed-but-wrong statement bindings. Re-sign with the fixture's trusted test key when testing semantic subject/dependency binding, keeping the signature valid. |

**Failure isolation rule:** begin from a valid fixture, change one relevant fact, assert the intended failure code/status/path, and verify an earlier unrelated gate did not explain the rejection. A malformed payload that returns `false` is weak evidence for any particular validation rule.

For hash-specific corruption, change bytes without changing their length so a length check cannot mask missing hash validation. For lineage or policy coverage checks, recompute fixture hashes when appropriate so the inner binding rule is actually exercised. Never update a production golden digest automatically to make a changed algorithm pass.

## 4. Naming: the test runner should read like a specification

Use `describe` for the operation or domain rule and `it` for **outcome + condition**. Prefer domain terms from the module interfaces. Avoid vague labels such as “works,” “validates everything,” or “fails closed” without identifying what is withheld or rejected.

Examples below are proposed names, not newly implemented tests:

| Current name | Proposed focused names |
| --- | --- |
| `rejects fabricated, missing, failed, and cyclic operands` | `rejects a calculation when an operand value differs from its observation`; `rejects a calculation when an operand observation is missing`; `rejects a calculation that depends on a failed observation`; `rejects a cycle in observation dependencies` |
| `rejects invented fragments, contradictory fields, extra private reasoning and capacity overflow` | `rejects a judge output that cites an undeclared fragment`; `rejects direct support paired with a contradicted NLI label`; `rejects private reasoning in judge output`; `does not call a judge whose input capacity is exceeded` |
| `reports citation completeness separately from correctness, placement, conflicts, duplicates and qualifiers` | `weights citation completeness by required claim weight`; `counts a contradicted citation as incorrect`; `reports misplaced citation IDs`; `groups conflicting values within the same context`; `reports duplicate assertion text` |
| `emits frozen all-or-none accepted leaves with raw scalar custody and declared total metadata` | `retains the original source value for a normalized field`; `preserves null as an accepted scalar`; `records total operands on a computed leaf`; `returns no accepted leaves when any field fails`; `keeps accepted leaves unchanged after input mutation` |
| `accepts bounded canonical payloads for all twelve mutations and six readers` | Parameterized `accepts the minimal $operation request`; separately `rejects caller-supplied verifier identity in $operation`; separately test mutation discriminator membership. |

The `frozen prototype parity` group currently includes production projection-lineage checks. Move those to a production behavior group. Replace prototype-named setup with a small production fixture as needed; do not keep misleading suite names merely to preserve caller compatibility.

### Fixture names should reveal their defaults and effects

| Current helper | Suggested direction |
| --- | --- |
| `source()` in diagnostics, defaulting to a promotional self-reported source | `makePromotionalSourceAssessment()`; a separate independent source builder where needed. |
| `fixture()` returning mechanically valid claims and selected fragments | `makeMechanicallyVerifiedClaim()`; document that it executes the real engine. |
| `adapter()` / `directOutput()` | `makeSyntheticJudge()` / `makeDirectSupportOutput()`; use a distinct contradiction factory rather than a flag-like verdict changing several hidden fields. |
| `schema()` in extraction | `admitTestExtractionSchema()`; fail with useful admission checks if fixture construction fails. |
| Async `verify()` helper around synchronous field verification | `verifyExtractionAgainstSource({candidate, source, fields, evidence})`; return synchronously when no async work occurs. |
| `source = candidate` default | Require an explicit source in tests claiming source support; an explicit `makeMatchingExtraction()` fixture can serve comparison-format tests. |
| `sink` with empty methods | `allowingArtifactSink` for irrelevant plumbing; use `recordingArtifactSink` for retention/order tests. |

Keep fixtures local until another suite needs the same domain setup. If shared, use a named file such as `testing/verified-claim.fixture.ts` or `testing/audit-bundle.fixture.ts`. Do not create a universal `test-utils.ts` full of unrelated builders. Return fresh mutable inputs per test; share immutable constants only.

## 5. Organize tests around ownership and reading order

Proposed destinations are not files that already exist.

| Current file | Proposed ownership |
| --- | --- |
| `deterministic/deterministic.test.ts` | `canonical.test.ts`, `decimal.test.ts`, `engine.test.ts`, `selectors.test.ts`, plus any deliberately retained golden regression cases. |
| `extraction/extraction.test.ts` | `schema.test.ts`, `verification.test.ts`, `evidence.test.ts`; source-component cases can remain with field verification or move beside that operation if independently useful. |
| `semantic/diagnostics.test.ts` | Move decomposition cases to `claims/decomposition.test.ts`, report cases to `claims/report.test.ts`, source-fitness cases to `authority/assessment.test.ts`, rescue and attribution cases beside their operations. |
| `semantic/verification.test.ts` | Start by grouping authorization, judge-output rules, cross-family decisions and gate closure. Split files only if that improves navigation. |
| `providers/providers.test.ts` | Provider-specific suites and bounds tests: `interfaze.test.ts`, `gateway.test.ts`, `bounds.test.ts`. Keep observation/recorded-judge suites recognizable. |
| `provenance/provenance.test.ts` | `seal.test.ts`, `replay.test.ts`, `policy-inputs.test.ts`; keep the real-signature and replay cross-module tests. |
| Contracts tests | Keep beside their schema owners; split multi-request loops into named rows before considering more files. |

A focused test suite can call several real core functions when the property is their interaction. For example, replay must agree with sealing; an isolated mock of both would remove the very guarantee being tested. Keep one compact successful sequence per major composition, then isolate its failure cases.

## 6. Targeted coverage work

“Add or strengthen” below means compare against existing tests before adding. Absence from the core suite is not absence from the repository: [application claims tests](../application/src/verification-claims.test.ts), [admission tests](../application/src/verification-admission.test.ts), [provider tests](../application/src/verification-provider.test.ts) and [policy tests](../policy/src/verification-policy.test.ts) own adjacent guarantees.

| Priority / operation | Existing evidence | Add or strengthen in the owning layer |
| --- | --- | --- |
| P1 report gates | Diagnostics checks report metrics; no direct calls to `applyReportWideMechanicalGates` or `verifyReportWideFromLedger` found in core tests. | Direct cases for new hard failure closing eligibility, previous failures remaining failed, review-only reasons preserving current status, and mechanical ledger summary leaving semantics unassessed. |
| P1 semantic authorization | Fabricated case rejection and closed gates exist. | Isolate fragment hash mismatch, empty/duplicate/unknown fragments, size limits and both bundle/assertion gates. Prove judge non-invocation for each precondition failure. |
| P1 cross-family policy within semantics | Same-family rejection and disagreement exist together. | Different family with the same deployment; critical risk without a valid second judge; low-risk certain support not calling the optional second judge. Use expected verdict/disposition/reason tuples. |
| P1 provider dispatch | Retention and some post-response failures exist. | Admission rejection and request-persistence failure prevent fetch; uncertain response failures do not trigger an automatic duplicate dispatch. Reuse application coverage where reservation/ownership is the actual subject. |
| P1 audit contract projection | Invalid-payload checks exist. | Valid public resource + one forbidden field, with precise rejection evidence. |
| P2 decomposition and authority | Synthetic diagnostics include reconstruction, qualifier loss and scope restrictions. | Separate no-assessment, duplicate fragment, wrong assertion, unknown critical authority facts and mixed-scope cases. Add human-adjudicated precision/recall cases without presenting synthetic labels as empirical quality. |
| P2 numeric/selector boundaries | Decimal operations, Unicode, ambiguous selectors and multiple projection kinds exist. | Use limit/one-past-limit pairs and independent numeric expectations; name cases by rounding mode, zero divisor, coordinate basis and boundary being checked. |
| P2 schema runtime binding | Mutation snapshot checks exist. | Original admitted schema works; structurally identical reconstructed object does not carry runtime admission. Pair with explicit descriptions, null/absent and resource-limit cases. |
| P2 replay drift | Retained-input tampering and semantic reconstruction failures exist. | Separate same-length digest mismatch, denied authorization before hydration, deterministic drift, policy decision drift and semantic artifact binding. Confirm relevant downstream port was not called. |

Missing report evidence needs an explicit behavioral decision. A test should not quietly convert today's precondition failure into a desired “missing evidence” result. Record current behavior separately from the proposed change, then implement its regression test with that change.

## 7. Useful assertions and examples

For structured result contracts, assert a compact observable projection: status, relevant reason/check code, affected path and eligibility or accepted output. For Zod failures, check the relevant issue path/code or unrecognized key rather than an incidental long prose message. For `ProviderFailure`, check its code and retryability when retry semantics are the subject.

Prefer named `it.each` rows when inputs exercise the same rule. Do not create a table with a large switch inside the test body. Split cases with different arrangements or stages.

Illustrative test style using existing production functions:

```ts
import { describe, expect, it } from "vitest";
import { formatRoundedDecimal, parseDecimal } from "./decimal.js";

describe("formatRoundedDecimal", () => {
  it.each([
    { value: "1.25", mode: "half_even" as const, expected: "1.2" },
    { value: "1.25", mode: "half_up" as const, expected: "1.3" },
    { value: "1.35", mode: "half_even" as const, expected: "1.4" },
  ])("rounds $value to $expected with $mode at one decimal place", ({ value, mode, expected }) => {
    expect(formatRoundedDecimal(parseDecimal(value), 1, mode)).toBe(expected);
  });
});
```

The expected strings are independently specified, not computed by the same rounding function being tested. This example is a proposed style, not a committed test or a claim that rounding coverage is absent.

Example validation: all three rows passed when run temporarily against the current decimal source; the temporary test file was removed afterward.

Interaction examples should assert a semantic event trace such as `admission → request persisted → fetch → response persisted`, including failure traces that stop at the correct boundary. Avoid asserting private helper order that has no externally meaningful effect.

## 8. Repeatability, coverage and execution

Use injected fetch and recorded/synthetic judges for core tests. Keep real in-process crypto for cryptographic contracts; ephemeral generated test keys are fine for round-trip verification, while fixed known vectors are better for independently pinning byte formats. A signer/verifier round trip sharing a wrong encoding can agree with itself; supplement it with independently specified PAE/canonicalization expectations.

Use fixed time or fake clocks for deadline boundaries; restore clocks/mocks after each affected test. Use a controlled deferred promise to test mutation during signing or dispatch rather than sleeping. The skill's fast-test guidance is a design target, not a fragile per-test wall-clock assertion on shared CI machines.

The current coverage attempt failed because the optional provider is absent. A future implementation can add the provider matching the installed Vitest version (4.1.11 in this snapshot), configure coverage to include production source files even if no test imports them, and review uncovered branches. Do not publish coverage numbers until the command succeeds. Do not automatically install dependencies or rewrite the lockfile as part of this documentation change.

Use focused mutation checks for critical promises: bypass a digest comparison, reopen a mechanical gate, permit same-deployment judgment, remove persistence-before-dispatch, or admit a forged runtime case. The intended named test should fail. Perform these changes in an isolated checkout or reversible patch and restore them; this recommendation does not claim mutation testing has already run.

The contracts script currently uses `--passWithNoTests`. Consider removing it for CI now that the package has substantive tests, so accidentally losing test discovery is a failure. Keep ordinary tests independent of live credentials, database availability and model quality evaluations.

## 9. Implementation sequence and completion criteria

1. Save a test baseline and list behavior promises before moving cases.
2. Fix assertion-quality problems in section 3, beginning with valid control fixtures and precise failure isolation.
3. Split overloaded tests into independent named cases; give builders honest names and fresh state.
4. Move claims/authority/report tests to their owning domains; extract shared fixtures only where needed.
5. Add high-value missing boundary tests after checking adjacent layer coverage.
6. Enable coverage tooling deliberately, inspect uncovered branches, and use targeted mutation checks for the most important guarantees.
7. Run affected suites, verification/contracts tests and relevant typechecks; expand to application/policy/worker checks when their public dependencies change.

Completion means each test title matches its assertions, each negative test reaches its intended gate, retained behavior remains covered, source/expected values are independent where correctness matters, and a failure points to one rule. More test cases after splitting are expected; the count itself is not the acceptance criterion.
