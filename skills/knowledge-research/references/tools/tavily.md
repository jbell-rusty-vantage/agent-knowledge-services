# Tavily playbook

**Use Tavily to find where the answer lives when you have no address yet.** Its output is a lead. Read each tool's own description for its arguments.

## Best for

| Question shape | Tool |
| --- | --- |
| "Where is this stated?" with no address known | search |
| Recent news or a change inside a date window | search, bounded by date and topic |
| A fact you expect on a known first-party site | search restricted to that domain |
| "Give me this page's text" for a known address, including pages that render with scripts | extract |
| "Which page on this site covers X?" | map, then extract the one page |
| Many pages of one site section | crawl, with a page cap |
| Orientation on a broad topic before framing questions | research (a cited synthesis) |

## Bad at

- **Being evidence.** A snippet, a relevance score, an AI answer and extracted markdown are all the provider's rendering. None is quoted.
- **Strict matching.** The score measures relevance to the query. It does not tell you the result is the right person, product or version. Check that yourself.
- **Synthesis you can rely on.** A research report is a secondary source written by a model. Every statement in it is a lead to the page it cites.
- **Speed for deep work.** A research run takes tens of seconds to minutes.

## Query patterns that work

- Write a search query, not a prompt. Keep it short.
- Split a compound question into separate searches and run them side by side.
- Use the default depth for discovery. Use the advanced depth when you need one specific fact and precision matters.
- Restrict to the first party's domain when you know it. Exclude domains that only repeat others.
- Bound by date for anything recent. Use the news topic for news.
- When a result names a likely answer, read its page with extract before searching again. Put the candidate's name in the next query when you test it.
- For one page on a large site: map first, then extract that page. Try basic extraction first; use the advanced depth for script-heavy pages and tables.
- Ask extract for the chunks relevant to a question when you only need to decide whether a page is worth capturing.

## Cost and rate notes

- **Depth costs.** The advanced search depth costs more than the default. Choose the depth yourself; automatic parameter selection may pick the expensive one.
- **Volume costs.** Crawl is billed by the page, more at the advanced extraction depth and more again when you give it natural-language instructions. Set a page limit before every crawl.
- **Batches are bounded.** Extract takes a limited number of addresses per call. Split a longer list.
- **Context costs.** Search that returns full page content can bring back hundreds of thousands of characters. Write results to a file, or filter them in code, and bring only what you need into context.
- **Record usage.** Read the usage the tool reports and put it in the handback. The listed prices on the checked date are in Availability.

## From lead to capture

1. **Record the lead:** the query, the date, the result address, its rank and why you chose it. Record the results you rejected and why.
2. **Capture the page itself** through the capture path, from its own address. Do not capture Tavily's extracted text in place of the page.
3. **Inspect the capture.** A login wall, a cookie banner, a 404 body or a few hundred characters is not a source. Discard it and try another address.
4. **Locate the quote** in the capture: exact, contiguous, occurring once, holding both the value and what it measures.

If the result is a secondary source, follow it to the primary page and capture that instead.

## Common mistakes

- Quoting the snippet or the AI answer because the capture step felt redundant.
- Trusting a high relevance score as proof of identity.
- Running a third search when the first result already named a page worth reading.
- Citing a research report's sentence instead of the page behind it.
- Crawling without a page limit.
- Treating "no results" as "does not exist". Widen once, try the second tool, then record the miss.

<a id="availability"></a>
## Availability, checked 2026-11-15

**In Knowledge Services:**

- There is no Tavily tool on either server, and no `ks` command for it. Tavily's own tools come from a Tavily server your environment attaches. Read their descriptions in your tool list.
- One managed Tavily search exists: `source_discover` on the executor server (`knowledge source discover`), with Tavily as the provider. The host runs the search with its own key and budget and keeps the receipt. It returns leads only. Extract, map, crawl and research are not offered through it.
- Record a search you ran with your own Tavily tool with `source_import`, and your choice of leads with `source_select`.
- Capture the page with `verify_capture_source` and locate the quote with `verify_locate_quote`, both on the executor server.

**Outside this service, recorded 2026-11-15 and not checked here:**

- Mission Control's common catalog seeds `mcp.tavily`, pinned to the `tavily-mcp` package at 0.2.22, with five tools: search, extract, crawl, map, research. It is a member of the `plugin.web-research` bundle. The list was transcribed from documentation, not captured from a running server: trust your live tool list over this line.
- Cloud agents in the AI Engineer cloud repository use the `tvly` command line, pinned at 0.1.6, with the vendored `tavily-*` skills.
- Listed in the vendored suite on that date: advanced search 2 credits; crawl extraction 1 credit per 5 pages, 2 at the advanced depth; crawl instructions 2 credits per 10 pages; extract at most 20 addresses per call; queries under 400 characters; a research run takes 30 to 120 seconds.
- Without a key, only search and extract work. The key is a named secret reference held by the lane. You never see or request it.
