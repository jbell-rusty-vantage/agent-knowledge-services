# GitHub playbook

**Use GitHub for facts about a repository at an exact commit or release.** The repository is a thing with releases. Its file tree is not the knowledge.

## Best for

| Question shape | Read |
| --- | --- |
| What a file says at a given version | the file at a resolved full commit |
| When a version was released and what its notes say | the releases, or the changelog file at the release tag |
| Licence, primary language, package name, declared dependencies | repository fields and the manifest file at a tag |
| What changed between two releases | the changelog between the two tags; the public interface at each tag |
| A failure mode, a workaround, whether a bug was fixed | the issue thread and the merged pull request that closed it |
| How popular or active a project is | repository counts, recorded as dated observations |

## Bad at

- **Whole-tree reading.** A repository can hold thousands of files. Read the knowledge-bearing surfaces and count the rest as skipped.
- **Authority by popularity.** Stars and forks are attention, not correctness.
- **Search as evidence.** Repository and code search results are discovery only.
- **Issues as facts.** A thread is a claim candidate from one reporter. See [sources](../sources.md#community).
- **"Latest".** The default branch is not a release. In a repository that holds several packages, a tag may belong to a different package than the one you are studying. Check the tag's prefix.

## Query patterns that work

- **Resolve first.** Turn a branch or tag into its full 40-character commit, then read at that commit. State the commit in the claim.
- **Read the knowledge-bearing surfaces, per release tag:** the README, the documentation folder, the changelog or release notes, the package manifest, the public interface, schema files, the examples, the security policy and the licence.
- **Public interface, not internals.** For "what changed", compare exported names and signatures between two tags. Added, removed and changed signatures are the evidence of a breaking change.
- **Threads:** read the opening report and the resolution. A merged pull request supersedes the report. Record the platform's own role label for each author (member, contributor, none).
- **Releases from the registry too.** For a published package, the package registry's record is the authority on version numbers and dates. Use it to check release pages.
- **Cap the work per repository and per release** before you start. Over the cap, fall back to README, changelog and manifest, and record what was skipped with counts.

## Cost and rate notes

- GitHub's own interface cost nothing in every recorded lab run. Calls without a token are rate-limited; a read-only token is supplied by name when the lane has one. You never see or request it.
- A failed or refused call is recorded and not retried automatically.
- The cost that matters is volume: files read, text captured, items extracted. Set the cap first.

## From lead to capture

1. **Record the lead:** the search query or the page that pointed here, the repository, the ref and the date.
2. **Capture exact bytes:** the file at the full commit, the release list, the repository fields, or the thread. The capture's title should name the commit or the release.
3. **Locate the quote:** exact, contiguous, occurring once.
4. **When the claim names a commit, a version or a release,** add the line that shows it as a second quote from the same capture. If no such line exists, drop that detail from the claim.

## Common mistakes

- Reading from the default branch and stating a release fact.
- Citing a short commit id or a branch name.
- Taking a number from the README badge instead of the repository field with its date.
- Treating an open issue as a confirmed defect, or a closed issue as a fixed one. "Closed as not planned" is not a fix.
- Ingesting the tree.
- Attributing a monorepo tag to the wrong package.

<a id="availability"></a>
## Availability, checked 2026-11-15

**In Knowledge Services:**

- There is no GitHub tool or command. A repository-archive adapter exists in the acquisition code and is not wired to any worker or tool.
- Capture a file at its full commit with `verify_capture_source` on the executor server, from the address that names the commit. Capture a file you already hold with `verify_capture_file`, and give the address it came from.
- `verify_supported_media_types` lists what the capture path converts. Check it before capturing a release archive or a binary.
- Record a repository search you ran with your own tool with `source_import`.

**Outside this service, recorded 2026-11-15 and not checked here:**

- Not seeded for mission agents. In Mission Control, GitHub exists only as four test-fixture tools written on 2026-10-31: a repository search (discovery only), repository fields, the latest releases, and one file at a resolved commit. The last three produce citable captures in the fixture.
- Seeded alternative: the Firecrawl developer index reaches issues, merged pull requests, READMEs and documentation. See [firecrawl](firecrawl.md).
- Cloud agents: the AI Engineer cloud repository says a GitHub server is configured in the provider, and to use the `gh` command line for read-only inspection when none is loaded.
- Lab work read GitHub's interface and release archives over plain HTTPS from scripts.
- How deep to ingest a repository is domain policy. Load your domain charter.
