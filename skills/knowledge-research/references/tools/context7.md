# Context7 playbook

**Use Context7 to get oriented in a library's documentation and to find which upstream file states something.** It is a secondary mirror. The upstream file is the source.

## Best for

| Question shape | Use |
| --- | --- |
| "What does this library's documentation say about topic T?" as a first look | read documentation for one library and one topic |
| "Which upstream page or file documents this?" | read the snippets, then take the upstream source address each one names |
| "Which library is this, exactly?" when names collide | search by library name to get its identifier |

## Bad at

- **Being primary.** Snippets are copied from upstream documentation and code. They can lag the upstream, and they are cut out of their context.
- **Version precision.** A snippet does not reliably tell you which release it describes. A version claim needs the upstream file at a pinned commit or tag.
- **Authority.** The trust score and the last-update date in a search result describe the mirror's entry. They are not a judgment of the library or of a claim.
- **Behaviour.** It shows what documentation says. Whether the code does that is a different claim.

## Query patterns that work

- Two steps. First resolve the library: search by name and choose the identifier. Then read documentation for that identifier and one specific topic.
- Name the topic narrowly: a function, a class, a configuration key. Broad topics return broad snippets.
- Ask for a small amount of text first. Raise it only when the snippet is clearly the right place and is cut short.
- Read the upstream source line on each snippet. That address is what you came for.

## Cost and rate notes

- The tool needs a key held by the worker. Without it, the tool refuses.
- The amount of text returned is bounded by a size you set. Smaller is cheaper to read and usually enough.
- No price or rate limit was confirmed from repository sources. Record the calls you make.

## From lead to capture

1. **Record the lead:** the library identifier, the topic, the date and the upstream address the snippet names.
2. **Capture the upstream source,** not the snippet. For a file in a repository, read it at a pinned commit: see [github](github.md). For a documentation page, capture the page from the first party's site.
3. **Locate the quote** in that capture: exact, contiguous, occurring once.
4. If the upstream cannot be reached and you capture the mirror's page instead, cite it only for what it literally shows, name it as a secondary mirror in the claim's source, and say that the upstream was not captured.

## Common mistakes

- Quoting a snippet as "the documentation".
- Stating a version from a snippet.
- Treating the trust score as source authority.
- Stopping at the mirror when the upstream address was on the page.
- Searching Context7 for something that is not a library question (a price, a release date, a paper).

<a id="availability"></a>
## Availability, checked 2026-11-15

**In Knowledge Services:**

- There is no Context7 tool, command or adapter. Nothing in this service reads a documentation mirror.
- Capture the upstream page with `verify_capture_source` on the executor server. For a file you fetched at a pinned commit, use `verify_capture_file` and give the address it came from.
- Record the Context7 call you made with `source_import`, as a search you ran elsewhere.

**Outside this service, recorded 2026-11-15 and not checked here:**

- Not seeded for mission agents. In Mission Control, Context7 exists only as two test-fixture tools written on 2026-10-31: a search that returns library identifiers (discovery only) and a documentation read by identifier and topic. The fixture treats search results as never citable and marks documentation reads as a secondary mirror that names its upstream sources.
- Cloud agents: the AI Engineer cloud repository says a Context7 server is configured in the provider, not in the repository. Its tool names could not be confirmed from repository sources: read your tool list.
- If your tool list has no Context7 tool, use the Firecrawl developer index for the same question shape: see [routing](routing.md).
