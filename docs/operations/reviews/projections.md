# Module review: projections

Module and reviewed revision: `@aiengineer/knowledge-projections` at `ff7fe97` plus the uncommitted 2026-09-19 P2-5 split (`packages/projections/src/{index.ts,types.ts}`, `src/validation/`, `src/projection/`, `src/classification/`, `examples/`; the previous single 165-line `src/index.ts` and its flat `index.test.ts` are removed). No public export changed; see the declaration diff below.

Purpose, owner, callers, and supported interfaces: Knowledge Services owns building contract-valid domain projections from validated evidence, and classifying a domain disposition set into the vector spaces it targets. Caller: `packages/application/src/preparation/preparation.ts` only (`createProjection`, `EvidenceSupport`), confirmed by `rg "@aiengineer/knowledge-projections"` across `apps/`, `packages/`, `scripts/`. Affected agent skills: none. No skill file names a projections symbol (`rg "knowledge-projections|createProjection" skills/`), so no skill changes accompany this split. Public interface: `validateEvidenceSupport`, `createProjection`, `classifyProjectionSpaces`, `publicProjectionSpaces`, and the types `EvidenceSupport`, `SupportedAssertion`, `ProjectionInput`, `EvidenceValidationResult`, `DomainDisposition`, `ClassificationProposal`.

## Structure

```
src/
  index.ts                          // barrel: Validation / Projection / Classification / Types banners
  types.ts                          // EvidenceSupport, SupportedAssertion, ProjectionInput, EvidenceValidationResult,
                                     // DomainDisposition, ClassificationProposal
  validation/{index.ts, evidence-support.ts, evidence-support.test.ts}      // validateEvidenceSupport
  projection/{index.ts, create-projection.ts, create-projection.test.ts}    // createProjection, projectionText, lines
  classification/{index.ts, disposition-spaces.ts, disposition-spaces.test.ts}
                                     // classifyProjectionSpaces, dispositionSpace, publicProjectionSpaces
examples/
  README.md, fixtures.ts
  01-validate-and-build.ts, 02-source-native-fidelity.ts, 03-classify-dispositions.ts (+ .test.ts each)
```

`classification/`, not `spaces/` (P2-5): Phase 2 already ships `retrieval/spaces/` (admission) and `vector-backends/spaces/` (storage); a third `spaces/` meaning classification here would be the ambiguity the cleanup plan forbids. Long lines from the single-file original are reformatted to one statement per line and one `case` per line in both switches (`createProjection`, `projectionText`); behaviour, error strings and every produced `projectionId`/digest are unchanged (proved by the moved determinism assertions, still passing).

## Must-haves

Derived from `SPECIFICATION.md` §5.1 (the representation-eligibility table: faithful source sections carry no derived assertions and need reconstructable locators; atomic/derived projections need admitted evidence) and §5.2 (canonical projection metadata requires resolved identity before an official candidate is publishable). Assessment reflects what `src/validation/evidence-support.test.ts`, `src/projection/create-projection.test.ts`, `src/classification/disposition-spaces.test.ts`, and `examples/*.test.ts` actually assert.

| ID | Must-have | Given / when / then | Assessment |
|---|---|---|---|
| PROJ-EVIDENCE | At least one evidence locator is required; duplicate locator ids are reported | Given evidence with a repeated `locatorId`, when validated, then `duplicate evidence locator <id>` is an issue | present: `evidence-support.test.ts` "reports duplicate evidence locator ids" |
| PROJ-QUOTE | Quoted text is never empty; a quote digest mismatch is reported | Given quoted text that is blank, or whose digest disagrees with the locator's `quoteDigest`, when validated, then the matching issue is present | present: "reports an empty quoted text", "rejects unsupported assertions and altered quoted evidence" (digest mismatch case) |
| PROJ-ASSERTION | A derived (non-`source_native_sections`) space requires at least one supported assertion; every assertion's support locators must exist in the evidence set | Given zero assertions on `engineering_claims`, when validated, then `derived projections require supported assertions`; given an assertion citing an unknown locator, then `unknown support locator <id>` | present: "requires supported assertions for a derived space with zero assertions", "rejects unsupported assertions and altered quoted evidence" |
| PROJ-FAITHFUL | `source_native_sections` text must equal the ordered evidence exactly and carries no assertions | Given `sourceText` that does not match the joined evidence, or any assertion present, when validated, then the matching faithfulness issue is present | present: `evidence-support.test.ts` (both cases); example 02 (`02-source-native-fidelity.ts`) exercises the same rule end to end through `createProjection` |
| PROJ-DETERMINISTIC | `projectionId` is a pure function of `sourceRecordId`, `procedureVersionId`, `space`, `text`, and the evidence support-set digest | Given the same input twice, when built, then `projectionId` is identical; given only `procedureVersionId` changed (text unchanged), then `projectionId` changes | present: `create-projection.test.ts` "builds deterministic contract-valid projections for every space" and the added "produces a different projectionId when procedureVersionId changes but the text does not" |
| PROJ-CONTRACT | Every space builds a `DomainProjectionSchema`-valid projection | Given one input per space, when built, then `createProjection(input).space` matches the expected space and the schema parse succeeds | present: `create-projection.test.ts`, all eight spaces covered |
| PROJ-CLASSIFY | Classification requires a non-empty `targetContractVersion`, at least one admitted disposition, evidence locators, and deduplication keys; `not_ingestible` cannot combine with another disposition | Given each omission or combination, when classified, then the matching error is thrown | present: `disposition-spaces.test.ts` (empty version, unknown disposition, `not_ingestible` combined, missing evidence, missing deduplication keys) |
| PROJ-IDENTITY | A canonical (non-`faithful_source_section`) disposition is refused while any entity identity question is unresolved | Given `unresolvedIdentityQuestions` non-empty alongside a canonical disposition, when classified, then `Canonical projections require resolved entity identities` | present: `disposition-spaces.test.ts` "validates classification evidence and resolved canonical identities"; example 03 |
| PROJ-PUBLIC | `publicProjectionSpaces` names exactly the seven public domains, excluding `source_native_sections` | Given the constant, when inspected, then it has length 7 and does not contain `source_native_sections` | present: `disposition-spaces.test.ts` "has exactly the seven public domains and excludes source_native_sections" |

Normal path: evidence → `validateEvidenceSupport` → `createProjection` (deterministic `projectionId`, contract-valid shape) → `classifyProjectionSpaces` maps the disposition set to target vector spaces for publication. Failure path: `Projection evidence validation failed: <issues>` from `createProjection`; typed `Error` messages from `classifyProjectionSpaces` for each rule above.

Evidence: `packages/projections/src/validation/evidence-support.test.ts` (4 cases), `packages/projections/src/projection/create-projection.test.ts` (2 cases), `packages/projections/src/classification/disposition-spaces.test.ts` (7 cases), `packages/projections/examples/*.test.ts` (7 cases across 3 examples). Checks run 2026-09-19: `corepack pnpm --filter @aiengineer/knowledge-projections typecheck` (exit 0), `test` (6 files, 21 tests, exit 0), `examples` (exit 0), `build` (exit 0); consumer `corepack pnpm --filter @aiengineer/knowledge-application typecheck` (exit 0).

Explicitly skipped checks: none specific to this package; it has no I/O and no live dependency.

Remaining debt: the open `sectionPath` bug in `packages/conversion/src/deterministic/nodes.ts:65-66` (a skipped heading level leaves `undefined` in `sectionPath`, which `SourceNativeSectionProjectionSchema`'s array-of-non-empty-string check would reject) is untouched by this unit. Examples build fixtures from `@aiengineer/knowledge-documents`'s `createSourceLocator` directly and never import `@aiengineer/knowledge-conversion` (P2-11), so the bug cannot reach this package's proof; fixing the bug itself remains conversion's debt, carried from the Phase 1 handoff.
