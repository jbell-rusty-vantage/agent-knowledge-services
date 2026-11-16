# arXiv and the paper index playbook

**Use these to identify a paper at an exact version and to read what it claims.** A paper's claim is the authors' claim. Whether it is true is a separate question.

Two routes exist: arXiv's own record of a paper, and Firecrawl's paper index (abstracts with full text reachable, across arXiv and the biomedical servers).

## Best for

| Question shape | Use |
| --- | --- |
| One named paper | one paper-index search, or arXiv search by title |
| "Which paper introduced X?", "papers that do X" | paper-index search, then expand from the best hits to similar papers |
| "Who builds on this?", "what does it build on or compare against?" | related papers: those citing it, or its references |
| Title, authors, dates, identifiers for one paper | the paper's metadata record |
| "Does the paper actually report this number, use this method, compare to that system?" | read passages inside that one paper for a specific question |
| The exact version read | arXiv's abstract record for a versioned identifier |

## Bad at

- **Peer-review status.** A preprint is not a reviewed publication. Say which it is.
- **Rankings and superlatives.** "Best on benchmark B" lives on a leaderboard or a results page, not in one abstract. Find the ranking on the web, then map the entries back to papers.
- **Results from an abstract.** An abstract rarely carries the conditions of a number. A numeric claim needs the table or passage in the full text.
- **Coverage.** The paper index is strongest on arXiv, PubMed, bioRxiv and medRxiv. A paper that exists only behind a publisher's paywall or in a small venue may be absent. Absence from the index is not absence from the literature.
- **Papers through web search.** The "research" category of Firecrawl web search filters websites. It does not search paper records.

## Query patterns that work

- **Named paper:** one search and stop.
- **By description or method:** find the best match, then assume a family. Expand to similar papers and keep the close neighbours.
- **A set ("alternatives to", "benchmarks for"):** expand from several strong hits, then re-seed from the new strong hits. One search is not enough.
- **Uses or exhibits a property:** start from the paper that defined the property and walk to the papers that cite it. Confirm inside each candidate.
- **From an organisation or by an author:** topical match is not enough. Confirm the affiliation or authorship in the metadata before keeping a paper.
- **Thin or uniform results:** re-run with a different framing: the sibling field, the rival method, the dataset or benchmark name.
- **Verify to exclude.** Read inside a paper to rule it out when a hard requirement clearly fails. Do not read every candidate.

## Cost and rate notes

- No price or rate limit for arXiv's interface or for the paper index was confirmed from repository sources. Record each call and any usage the tool reports.
- Resolving an unversioned identifier costs one extra call to learn which version is current.
- Full text is large. Read passages by question before deciding to capture the whole paper.

## From lead to capture

1. **Record the lead:** the query, the tool, the date and the paper identifier. A search listing is never cited.
2. **Fix the version.** An identifier without a version resolves to the latest. Record the exact version you read and state it in the claim.
3. **Capture** the abstract record for identity, authorship, dates and the abstract's own statements. For a result, a method detail or a comparison, capture the full text at that version (the HTML rendering when one exists, otherwise the PDF as a file) and quote from it.
4. **Locate the quote:** exact, contiguous, occurring once. For a number, the quote must include what it measures. State the conditions in the claim: dataset, metric, setting, date.
5. **When the claim names the version,** add the line that shows it as a second quote from the same capture.

## Common mistakes

- Citing an abstract for a result the abstract does not state.
- Dropping the version, then quoting text that changed between versions.
- Reporting a paper's self-reported result as an independent evaluation.
- Keeping only the single best match when the question asked for a method or a comparison.
- Reading a missing index entry as "no such paper".
- Stating a benchmark number without its denominator, dataset and date.

<a id="availability"></a>
## Availability, checked 2026-11-15

**In Knowledge Services:**

- There is no arXiv tool and no paper-index tool. A paper adapter exists in the acquisition code: it can resolve a paper's identity, and its fetch step is not wired to any worker or tool.
- Capture the abstract record or the HTML rendering with `verify_capture_source` on the executor server. Capture a PDF you hold with `verify_capture_file`: the executor converts it and keeps the original bytes beside the text.
- Record a paper search you ran with your own tool with `source_import`.

**Outside this service, recorded 2026-11-15 and not checked here:**

- Seeded for mission agents: the Firecrawl paper-index tools (search papers, related papers, inspect paper, read paper), under `mcp.firecrawl`.
- Not seeded: arXiv's own interface. In Mission Control it exists only as two test-fixture tools written on 2026-10-31: a search (discovery only) and a read of one exact abstract version, which produces a citable capture in the fixture and resolves an unversioned identifier to its current version first.
- How deep to ingest a paper (reference only, digest, or in full) is domain policy. Load your domain charter.
