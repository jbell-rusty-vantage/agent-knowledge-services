# Tool routing: from question shape to primary source

**Route by the shape of the question, and know the primary source you intend to end at before the first call.** The first tool finds it. The second tool is the one fallback. The last column is where the claim's locator must point.

Before any tool in this table: read the knowledge base ([method](../method.md#orient)).

| Question shape | First tool | Second tool | Primary source to end at |
| --- | --- | --- | --- |
| **A library interface fact** (what it returns, a default, a signature, a parameter name) | Firecrawl developer index, READMEs and documentation; or Context7 for a first look | GitHub: the file at the release's commit | The official reference page or the source file, at a named release. Strongest: a deterministic check that runs it |
| **A release or version fact** (which version, when, what the notes say) | The package registry's record, or GitHub releases | The changelog file at the release tag | The registry record for numbers and dates; the first party's release notes for content |
| **A paper's claim** (what it reports, uses or compares against) | Firecrawl paper index: search, then read passages in the one paper | arXiv's record for the exact version; the full text | The paper at an exact version: the passage or table, with its conditions |
| **A benchmark number** | Web search for the benchmark's own results page or leaderboard | The paper or the first party's results table | The results table published by whoever ran it, with dataset, metric, setting, date and denominator. Say whether it is self-reported |
| **A company or product fact** (price, limit, availability, ownership) | Web search restricted to the company's own domain | Map the site, then read the one page | The first party's own page, with the date observed. For a regulated filing, the filing itself |
| **A community claim** (a reported failure, a workaround, "X is broken") | Firecrawl developer index, issues and pull requests; or web search on the forum | GitHub: the thread, read to its resolution | The captured thread as the record of what was said, **plus** a first-party locator or a deterministic check for whether it is true |
| **"What changed since"** | The knowledge base's change records; then the first party's changelog between two versions | Two dated captures of the same page, compared | The first party's change record, or the two captures with both dates |
| **A known error message** | Firecrawl developer index with the literal string and the library name | Web search with the string in quotes | The issue and the merged pull request that fixed it |
| **A page that needs a click, a form or pagination** | Scrape with a longer wait | Browser | A stable address reached by navigation, else the rendered capture marked as not replayable |
| **A local document** | Parse, to read it | The capture path, for the original file | The original file's bytes |

## Rules for routing

- **One first tool, one fallback, then stop.** If both miss, record the miss and move on. See [dead ends](../method.md#dead-ends).
- **Either search provider is discovery.** Tavily search and Firecrawl search answer the same shape. Use the one your stage was given. Do not run both for the same query to "confirm": two search engines agreeing is not corroboration.
- **The tool that found a page is not the tool that makes it evidence.** Every row ends at a capture through the capture path, however the page was found.
- **Prefer the tool built on primary material** for the shape: the developer index for interface and bug questions, the paper index for papers, the registry for releases. General web search is for what no primary source states: comparisons, opinion, news, unindexed projects.
- **A synthesis tool is for orientation.** A research report or an agent extraction can help you frame questions. Its statements are leads.
- **Follow your grant.** Use only the tools your stage selected and only the hosts it allows. A missing tool is reported, not improvised around.

## Each playbook

[tavily](tavily.md) · [firecrawl](firecrawl.md) · [context7](context7.md) · [github](github.md) · [arxiv](arxiv.md) · [browser](browser.md)

<a id="availability"></a>
## Availability, checked 2026-11-16

**Knowledge Services has none of the discovery tools in this table.** It has no Tavily, Firecrawl, Context7, GitHub, arXiv or browser tool, and it wraps none of them. Your environment attaches them, and your live tool list is the authority on which you have.

What Knowledge Services does hold, on the **executor server**:

| Need | Tool | Command line |
| --- | --- | --- |
| The capture path every row ends at | `verify_capture_source`, `verify_capture_file` | `knowledge-verify capture`, `knowledge-verify capture-file`; `ks verify capture source`, `ks verify capture file` |
| Locate the quote | `verify_search_capture`, `verify_locate_quote` | `knowledge-verify search`, `knowledge-verify locate`; `ks verify capture search`, `ks verify capture locate` |
| Make your capture quotable by a claim, and get the anchor of each quote | `source_prepare_captured` | `knowledge source prepare-captured` |
| One managed web search that the host runs and records | `source_discover` | `knowledge source discover` |
| Record a search you ran with your own tool, and your choice of leads | `source_import`, `source_select` | `knowledge source import`, `knowledge source select` |
| Read the knowledge base before any tool in the table | `schema_search`, `db_read_intent` | `knowledge schema search`, `knowledge db read-intent` |
| Find the content unit and capture a quote anchors to, in content the knowledge base holds | `evidence_units` | `knowledge evidence units` |
| Write one step of the chain: claim, restatement, triage, probe, probe run, verdict, source assessment, attention sweep | `chain_write` | `knowledge chain write` |

- `source_discover` offers two providers, Tavily search and Firecrawl search, and only when the host holds the key. It returns leads. It does not read pages.
- `chain_write` takes the step in `operation`. Which operation performs which chain step, what it never writes and what a refusal means: [verification, Availability](../verification.md#chain-tools). `knowledge_describe` with `operation:<name>` returns one operation's full input.
- A capture you make with `verify_capture_source` lives in the executor's store. `source_prepare_captured` registers it in the knowledge base as content units and returns the anchor of each quote you name, ready for `chain_write`: [verification, Availability](../verification.md#chain-tools). Text, Markdown, HTML and JSON captures only.
- `verify_capture_source` fetches a page itself. Firecrawl may do that fetch when the executor is configured with it; otherwise the fetch is a plain HTTPS request. Either way the stored bytes are the capture.
- Not wired: repository archives, paper records and page scraping as acquisition routes. The adapters exist in the code and no worker or tool runs them.
- On the platform server, `knowledge_source_discover` ranks candidates you supply and `knowledge_source_fetch` stores an exact HTTPS capture for document preparation. Neither searches.

**Outside this service, recorded 2026-11-15 from Mission Control's catalog seeds and not checked here.** Seeds are catalog entries, and a mission attaches one only if its manifest selects it.

| Tool | Mission agents | Elsewhere |
| --- | --- | --- |
| Tavily | Seeded: `mcp.tavily` (`tavily-mcp` 0.2.22) | Cloud agents: `tvly` 0.1.6 |
| Firecrawl, including the developer and paper indexes, parse, interact, monitor | Seeded: `mcp.firecrawl` (`firecrawl-mcp` 3.28.2) | Cloud agents: `firecrawl` 1.23.3 |
| Browser | Seeded: `mcp.agent-browser` (0.38.2) and `skill.agent-browser` | Cloud agents: `agent-browser` 0.35.1 |
| SEC filings | Seeded for the AI Engineer application only: `mcp.edgartools` (5.61.1). It needs a declared identity that was not set when the seed was written | — |
| GitHub | Not seeded. Test fixtures only | Cloud agents: provider-configured server or the `gh` command line |
| arXiv's own interface | Not seeded. Test fixtures only | — |
| Context7 | Not seeded. Test fixtures only | Cloud agents: provider-configured server |

- `plugin.web-research` bundles Tavily, Firecrawl and the browser skill, with the browser tool server optional.
- The seeded tool lists were transcribed from documentation and not captured from running servers.
