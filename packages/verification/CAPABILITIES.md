# Verification capabilities

What this package's algorithms establish, per selector kind, deterministic check family and
semantic stage, with the limit that goes with each. Every row links to the runnable example
that exercises it. This describes implementation and fixture evidence, not production
deployment or measured semantic accuracy. What can actually be **acquired** and which of these
selectors an agent can express through the executor is a separate question, answered in the
executor's [acquisition capabilities](../../apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md).

## Assertion versus verification

An assertion declares a proposition, subject bindings, qualifiers, risk and intended use, plus
evidence links. A locator identifies the exact source material. A successful locator does not
establish that the proposition follows from that material. Mechanical verification checks
identity, immutable bytes, locator uniqueness, binding and deterministic rules. Semantic support
and policy admission are separate decisions after mechanics.

The decomposition interface ([`src/report/decomposition.ts`](src/report/decomposition.ts))
validates supplied segmentation, exact report reconstruction, offsets and qualifier
preservation; it does not independently discover every factual assertion. Human-gold
decomposition accuracy remains separate.

Example: "Panel A has 42 samples" can cite a unique row plus a contextual header. A count of 42
found in Panel B, an omitted date, or a different population is not support for that claim
merely because the digits occur. Preserve those qualifiers in the assertion and report.

## Media and locator matrix

There are **4 built-in selectors and 8 projection selectors**. Every row is exercised by
[`examples/02-resolve-selectors.ts`](examples/02-resolve-selectors.ts). A canonical projection
resolver consumes an already prepared representation; it does not download, OCR, transcribe or
visually interpret media.

| Source representation | Selector and deterministically checked location | Limit | Example |
|---|---|---|---|
| Text / Markdown | `text_quote`: unique quote, optional adjacent prefix/suffix, explicit normalization | Repeated quotes are `ambiguous` until prefix/suffix disambiguates | [02 "exact quote"](examples/02-resolve-selectors.ts), [03](examples/03-deterministic-bundle.ts) |
| Text positions | `character_position`: UTF-8 bytes, UTF-16 units or Unicode code points | Reported coordinates retain their declared basis; split code points are rejected | [02 "Unicode character position"](examples/02-resolve-selectors.ts) |
| JSON | `json_pointer`: escaped RFC 6901 field/index path | Structured results retain locator metadata; they are not scalar extraction values | [02 "JSON pointer"](examples/02-resolve-selectors.ts), [04](examples/04-extraction-fields.ts) |
| Discontinuous text | `multi_fragment_text`: ordered non-overlapping fragments with explicit joiner | Fragments must not overlap | [02 "multiple text fragments"](examples/02-resolve-selectors.ts) |
| HTML DOM | `html`: bounded CSS/XPath subset or DOM child path, optional text range | Hidden/script/style content excluded; locator descriptions must agree; not arbitrary browser CSS/XPath | [02 "HTML DOM"](examples/02-resolve-selectors.ts) |
| Native PDF text | `pdf_text`: physical page, text-layer digest and offset basis | Requires matching sealed projection and source lineage; page labels and chart contents cannot be inferred from text | [02 "PDF physical page"](examples/02-resolve-selectors.ts) |
| PDF/image text geometry | `bounding_box`: normalized/pixel box containing ordered tokens | Selects pre-existing tokens, not raw pixels; no OCR, chart interpretation or visual grounding | [02 "image or PDF geometry"](examples/02-resolve-selectors.ts) |
| Tables | `table`: table ID, row, column, header path, optional expected value | Validates geometry/merged-cell constraints in the projection | [02 "table cell with header"](examples/02-resolve-selectors.ts) |
| Audio/video transcript | `media_timecode`: half-open milliseconds, speaker/channel, fully contained segments | Mixed unscoped speakers/channels are ambiguous; no transcription or frame verification | [02 "audio/video transcript interval"](examples/02-resolve-selectors.ts) |
| Repository source | `repository`: full commit, safe path, zero-based half-open lines or UTF-8 bytes | Frozen file contents only; no checkout, test-running or correctness proof | [02 "repository at a commit"](examples/02-resolve-selectors.ts) |
| Dataset | `dataset`: version, unique row key, optional column | Requires supplied frozen rows; no live query or population-statistical validation | [02 "versioned dataset cell"](examples/02-resolve-selectors.ts) |
| Paginated API | `api_record`: page, unique record key, optional field pointer | Requires supplied API version/query digest/pages; does not prove all remote pages were collected | [02 "paginated API field"](examples/02-resolve-selectors.ts) |

Projection parsers reject malformed, noncanonical, unbounded or inconsistent representations
(`PROJECTION_INVALID:*`). Deterministic bundle execution also requires admitted projection
lineage: manufacturing a JSON projection that resolves successfully is not sufficient to admit
evidence. See [`src/evidence-selection/projection-resolver.ts`](src/evidence-selection/projection-resolver.ts),
[`src/evidence-selection/projections/`](src/evidence-selection/projections/),
[`src/evidence-selection/core-resolver.ts`](src/evidence-selection/core-resolver.ts) and
[`projection-resolver.test.ts`](src/evidence-selection/projection-resolver.test.ts).

## Deterministic verification diversity

| Capability | What is established | Limits | Example |
|---|---|---|---|
| Capture and provenance | Registered artifact digest/length, capture identities, representation binding, expected selection digest | Immutable storage is not proof of source truth or acquisition completeness | [03](examples/03-deterministic-bundle.ts) |
| Assertion mechanics | Unique IDs, exact evidence resolution, declared atomicity, runtime producer/verifier separation | Caller-supplied atomicity and authority vectors are not independently established facts | [03](examples/03-deterministic-bundle.ts) |
| Bounded schema | Admitted schema subset; candidate types, required fields, null/absent distinction, collection/string bounds | Not unrestricted JSON Schema and not semantic accuracy | [04](examples/04-extraction-fields.ts) |
| Field comparisons | 11 kinds below; evidence re-resolved from immutable bytes for every leaf | No judge confidence substitutes for a failed match | [04](examples/04-extraction-fields.ts) |
| Cross-field arithmetic | Exact rational-decimal identity, sum, difference, product, ratio and percent change; explicit tolerances and rounding | Keys and rules must be supplied | [`extraction.test.ts`](src/extraction/extraction.test.ts) |
| Duplicate records | Declared array key paths checked for repeated records | Keys must be supplied; not fuzzy entity resolution | [`extraction.test.ts`](src/extraction/extraction.test.ts) |
| Structured selected values | Explicit table-cell, geometry-token or transcript-text scalar extraction | Must choose a supported source component and joining rule | [`extraction.test.ts`](src/extraction/extraction.test.ts) |
| Reports | Declared citation completeness/weights, pointer failures, misplaced citations, omitted qualifiers, duplicates/conflicts, consistency groups, high-severity support | Measures producer-declared assertions, not discovery of uncited facts | [`report-wide.test.ts`](src/report/report-wide.test.ts) |
| Authority | Directness, applicability, freshness, independence and source-family assessment | One qualifying independent family can satisfy corroboration; not a quorum or proof of world correctness | [`assessment.test.ts`](src/authority/assessment.test.ts) |
| Audit/replay | Manifest/payload lineage, digest binding, replay drift, optional Ed25519 signatures and DSSE/SLSA attestations | Unsigned integrity differs from signature authority; a valid seal is not admission | [06](examples/06-seal-inspect-replay.ts) |

The **11 field comparisons** are exact, normalized text, decimal, percentage, currency, unit,
date, datetime, enum, identifier and checksum. Currency uses explicit `CODE decimal` strings and
allowed codes, not locale or currency-symbol inference. Unit checks compare allowed tokens; they
do not convert kilograms to pounds. Dates are strict calendar dates; datetimes require a
timezone. Identifier checks support UUID, SHA-256, CVE and three-letter currency-code syntax;
checksum checks support Luhn and ISBN-13. They do not verify that an identifier was actually
issued. Comparators live in [`src/extraction/field-comparators.ts`](src/extraction/field-comparators.ts).

## Semantic scope

Semantic authorization, evidence-only judging, output-lattice validation, cross-family second
judging, drift observation, bounded rescue proposals and attribution audit metrics exist
([`src/semantic/`](src/semantic/)). Mechanical failure cannot be reversed by a semantic result:
[`examples/05-semantic-recorded-judge.ts`](examples/05-semantic-recorded-judge.ts) shows the
gate closing with `MECHANICAL_GATE_CLOSED` before any judge is consulted, then a recorded
`directly_supported` verdict on a passing bundle. No prompt, model selection, calibration,
semantic algorithm or quality threshold is optimized here, and the examples never call a live
provider.

Provider adapters ([`src/providers/`](src/providers/)) carry their own byte bounds, deadlines,
cancellation, admission and request/response persistence through one dispatch procedure; fixture
tests trace that effect order but do not prove current live provider behavior.

## Strongest and weakest coverage

**Strongest:** immutable text evidence, native structured locators, schema/field mechanics,
exact arithmetic and retained audit artifacts. **Not established by this package:** OCR,
transcription or frame interpretation, live data acquisition, independent discovery of report
assertions, or semantic accuracy. Supporting further media requires explicit parser and
representation admission with retained source lineage upstream of these algorithms, not a new
selector kind here.
