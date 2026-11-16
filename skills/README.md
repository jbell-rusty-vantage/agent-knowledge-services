# Skills

This directory is the source of truth for the eleven versioned Knowledge Services skills listed in
`manifest.json`. Consumers pin a released version and may add runtime-specific wrapper instructions,
but must not fork authority, evidence, tenant, or publication semantics.

Every skill uses a public v1 surface: the platform HTTP/client and MCP tools, or the verification
executor's `knowledge` CLI, HTTP routes and `/mcp`, or the Jev worker service's CLI, HTTP and MCP. None authorizes raw SQL beyond the guarded
read-only capability, secrets, private bucket listing, direct vector writes, self-approval, or
publication.

| Skill | Surfaces | Covers |
|---|---|---|
| `knowledge-research` | executor, platform | The research method: orient, frame, find leads, capture, state claims, verify, write, hand back; one playbook per external tool (Tavily, Firecrawl, Context7, GitHub, arXiv, browser) |
| `schema-explore` | executor | Progressive navigation of the pinned schema workspace without querying the database |
| `knowledge-db` | executor | Named catalog reads and reproducible snapshots an ingestion intent can cite |
| `knowledge-ingest` | executor | Ingestion intents and preserved source receipts |
| `knowledge-acquisition-and-vetting` | executor, platform | Discovery, preserved untrusted attempts, capture and vetting |
| `knowledge-preparation-and-promotion` | executor, platform | Conversion, chunking, embedding, promotion proposals and reviews |
| `knowledge-verification` | platform (+ executor reads) | Admitted extraction verification, structured extraction, artifact parse, benchmark, replay, provider reconciliation |
| `knowledge-retrieval-and-evidence` | platform | Scoped retrieval plans, explanations and immutable evidence packets |
| `knowledge-evaluation` | platform | Reviewed retrieval cases, ablations, release recommendations |
| `vector-store-management` | platform | Store classes, ingestion, publication and rollback |
| `jev-system-one` | jev-cli, jev-mcp, jev-http | Jev typed decisions over inline, local and remote inputs; persistent single-host jobs, process workers, bounded batches and LLM composition |

## The guide: the same files for an agent without a filesystem

`knowledge_guide` (platform and executor MCP servers), `GET /v1/guide[/topic]` and `ks guide [topic]` (also
`knowledge guide [topic]` on the executor) serve this directory as Markdown pages. Without a topic the answer is the
start page: what the service is for, the jobs in the order a research task meets them with the skill to read and
the tools of each job by server, and three rules. A skill name returns its `SKILL.md`; `<skill>/<path>` returns one
of its files (`knowledge-research/references/tools/tavily`); `tools` lists every tool by job and `topics` every page.

- **One module.** `packages/contracts/src/operations/guide.ts` answers for every transport.
- **Bundled, not read at run time.** `packages/contracts/scripts/generate-guide-pages.mjs` copies every skill file
  (and the executor's `knowledge-verify`) into `src/operations/guide-pages.generated.ts`, which the contract
  package's build runs first. The servers and the `ks` binary carry the pages inside that package and need no
  checkout. `node skills/check.mjs` and the contract tests fail when the bundle differs from this directory.
- **Lists are generated.** The start page takes each job's skills and its executor and Jev tools from
  `manifest.json` `guide.jobs`, and its platform tools from the operation contracts, when the page is asked for.
  Only the sentences are written by hand. An executor tool that belongs to no job goes under `guide.unassigned` with
  the reason.
- **To add a skill:** add its directory and its manifest entry, name it in a job of `guide.jobs`, then run
  `corepack pnpm --filter @aiengineer/knowledge-contracts generate`.

## Two distributions: the executor's `knowledge` and the platform `ks`

`@aiengineer/knowledge-verification-executor` ships the sandbox `knowledge` (and `knowledge-verify`)
binary with the `schema_*`, `db_*`, `ingest_*`, `artifact_get`, `source_*` and `checkpoint_*`
operations until Unit 5H removes it; SV-17 retired its report, content-link and recovery operations.
`@aiengineer/knowledge-cli` ships `ks` (Unit 5C): `ks knowledge|verify …` call the admitted API, and
the `ks verify capture|artifact` commands run on the local file-store profile. `ks` has no `db` or `jev` group: every `ks` command runs. `ks guide` and `ks describe` answer offline. Its `pack:sandbox` tarball ships the `platform-cli`
skills. A bare binary name is not a dependency identity: a run pin must name the distribution, and
`manifest.json` records which surfaces each skill uses.

`@aiengineer/knowledge-jev-service` ships the separate `jev` binary. Its client commands use the
Jev HTTP interface; its `/mcp` tools share that host's queue. Dedicated `mcp-stdio` starts its own
host and must use a separate database if an HTTP host is already running.

## Conformance

```bash
node skills/check.mjs          # exit 1 on drift, 2 when a catalog source cannot be read
node skills/check.mjs --json   # digests per skill, for freezing onto an explicit run pin
```

The check reads the implemented catalogs — the executor operation registry and MCP server, the
`ks` command table (`apps/cli/src/ks-commands.ts`, bound to `CLI_COMMANDS`), the platform MCP tool list, and the Jev MCP/CLI sources — and fails when a skill names a
command or tool that is not implemented (or one `CLI_COMMANDS` marks unsupported, should such a
command return; none exists today), uses a
surface it did not declare, omits a catalog operation it owns, links to a file that does not exist, or describes a
structural seal as admission. It fails as well when `guide.jobs` names a skill or tool that does not exist, when an
executor or Jev tool belongs to no job, and when the bundled guide pages are out of date. `absentOperations` and `artifactTypes` document names that deliberately are not
operations; the check fails if one of them becomes an admitted operation.

It also fails when a `SKILL.md` has no YAML frontmatter, no `name`, no `description`, or a `name`
that differs from its directory: a skill loader (Deep Agents, the Agent Skills format) cannot load
such a skill.

Skill digests use the same content hash as the research run-pin installation (sorted relative paths
over the complete UTF-8 bytes of `SKILL.md` and every reference file), so an installed child slot and
the pinned digest can be compared directly.
