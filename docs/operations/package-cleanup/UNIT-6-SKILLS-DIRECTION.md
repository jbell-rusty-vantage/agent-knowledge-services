# Unit 6 — canonical skills direction

Status: **proposed**, 2026-09-29. Direction stub; 5H writes the bounded implementation specification against its validated state. No skill implementation changes are made by this document.

## Target and ownership

Consolidate to the eight skills in [FINAL-LAYOUT §3](./FINAL-LAYOUT.md#3-target-layout): `knowledge-research`, `knowledge-sources`, `knowledge-preparation`, `knowledge-retrieval`, `knowledge-evaluation`, `knowledge-verification`, `knowledge-db`, `jev-system-one`. Preserve all operation coverage, recovery references, Jev capabilities and installed CLI packaging while applying that section's merge map.

Each `SKILL.md` uses the [Agent Skills standard](https://agentskills.io/specification) consumed by [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/skills):

- Required `name`: equals its directory name, lowercase letters/digits with single separating hyphens, no leading/trailing hyphen, at most 64 characters.
- Required `description`: what it does and when to use it, at most 1,024 characters.
- Optional top-level fields only: `license`, `compatibility` (at most 500 characters), `metadata` (string values only), `allowed-tools`. No KS-specific or other top-level keys.
- Concise body, under about 500 lines. Put detail in `references/`, `scripts/` and `assets/`, one level deep, and resolve every link in the installed package.

KS-specific version, operations, surfaces and per-file SHA-256 belong in `skills/manifest.json`. Stage files select skills by manifest id plus digest; the role-to-skill binding belongs to stage files, never KS or hardcoded agent roles. Pin the manifest and materialized bytes in every run manifest.

## Observed defect and exit gate

The [proof result](../../../../research_ingestion_systems_agent/agents/deepagents-stage/RESULT.md) found five skills without `name:`: `knowledge-acquisition-and-vetting`, `knowledge-evaluation`, `knowledge-preparation-and-promotion`, `knowledge-retrieval-and-evidence`, `vector-store-management`. DeepAgents warns and silently drops these; the proof loader fails closed. The current `skills/check.mjs` checks catalogs, coverage, links and digests but does not invoke DeepAgents' parser. Its existing pass is not parser conformance.

Extend that checker with the pinned DeepAgents 1.14.x `parseSkillMetadata` / `listSkills` parser path. Verify the actual exports/signatures at implementation entry. Compare the exact expected manifest ids to loaded ids and fail on every skip, invalid metadata, duplicate, missing file or digest mismatch. Enforce the stricter top-level/length rules above even if the parser only warns. Retain existing operation, surface, link and seal-versus-admission checks. Validate source and installed skill bundles; do not replace parser validation with a home-grown frontmatter approximation.

Exit: eight canonical skills with preserved coverage, conformant metadata, per-file digest manifest, zero parser skips, passing installed-bundle check and documented stage references. No Eve skill-pack-sync gate remains.

## Sequence

Unit 6 follows KS Unit 5; DR1–DR3 preparatory work may be scheduled in parallel only by explicit coordination. All Unit 6 conformance and [DR1–DR5](./DEEPAGENTS-READINESS.md) exits are required before fixtures. This stub does not reopen the accepted order: KS cleanup/readiness → DeepAgents readiness → real fixtures → Mission Control. Unit 7's previously accepted scheduling exception remains.

## Additions from the 2026-09-29 quality review

Proposed; evidence in [APP-AND-SKILL-QUALITY.md](./APP-AND-SKILL-QUALITY.md). 5H's bounded specification must absorb these.

**Entry gate — command coverage.** At review time `ks` has no db schema/read/ingest, knowledge source/content/report, recovery or checkpoint commands, so `knowledge-db`, `schema-explore`, `knowledge-ingest` and `knowledge-verification-recovery` can only name the executor `knowledge` binary. Unit 6 starts only when every command, MCP tool and operation a skill names resolves in `apps/cli/src/ks-commands.ts` and the operation catalog; the checker enforces it. Stale names to remove: `knowledge-verify`, the executor `knowledge` binary, `VERIFY_EXECUTOR_URL`, `VERIFY_STORE_DIR`, `VERIFY_GIT_SHA`, `KNOWLEDGE_EXECUTOR_URL`, `node apps/jev/dist/index.js`.

**Additional metadata defects.** `allowed-tools` is a YAML list in `knowledge-db`, `schema-explore`, `knowledge-ingest` and the executor's `knowledge-verify`; the Agent Skills specification defines a space-delimited string — confirm against the pinned DeepAgents parser. `knowledge-verification-recovery` keeps KS surface data in `metadata`; move it to the manifest. The acquisition, retrieval and evaluation descriptions say when but not what.

**Checker rebuild (`skills/check.mjs`).** Today it passes all twelve skills, including the five without `name:`, because it never parses frontmatter. Required:
- a pinned `deepagents` devDependency and its parser (no home-grown frontmatter approximation);
- per-file SHA-256 over bytes (not UTF-8 text), stored in `manifest.json` and compared on every run, plus `metadata.version` = manifest version, description ≤ 1,024 and body line limits;
- links must stay inside the installed skill package;
- one rule set for every skill (the executor skill currently gets a weaker set), one manifest schema (the executor's second catalog schema is merged);
- the built-executor comparison must not depend on whether `dist` happens to exist;
- the check runs against the installed `ks` tarball as well as source;
- replace the prose regex that forces every sealing skill to repeat "seal is not admission" with one statement in `knowledge-research`.

**`knowledge-research` must be specified.** It exists only as a line in FINAL-LAYOUT. Contents: a question → skill routing table; stage order (db snapshot and gaps → sources → capture/verify → report register/assess → ingest → read back); shared rules stated once (untrusted content, seal ≠ admission, pass handles not payloads, unknown usage ≠ zero, receipts are authoritative, claim batch limits); the numbered workspace file convention; stop conditions; report authoring moved out of `knowledge-ingest`. Its archived F6 dependencies (`completion_submit`, `usage_read`, `space_manifest`) are in no catalog: it must not describe them as available (FINAL-REVIEW).

**Merge-map corrections (developer to confirm).**
- `knowledge-verification` merged from three sources is ~640 body lines: split into `references/chain.md`, `references/recovery.md`, `references/recovery-operations.md`, and carry recovery's trigger phrases into the description.
- Resolve the verification MCP names (`verify_*` vs `knowledge_verify_*`) in 5P before writing the skill.
- `vector-store-management`'s space publish/rollback submissions are write authority; keep them out of the read-side `knowledge-retrieval` body (an authority-stated reference file, or `knowledge-evaluation`).
- Embedding (`knowledge embed run/verify/status`) is declared in the manifest but documented nowhere; document it in `knowledge-preparation`.
- `knowledge-db` combines reads and writes; split references so a stage file can grant read-only use.

**Deduplicate.** Content-link guidance (ingest and preparation), source-receipt text (acquisition and ingest), budget/handles boilerplate (five skills), and competing "overrides every other skill" statements; `jev-system-one`'s PowerShell-only examples and dated provider facts move to a reference. Update `skills/README.md` ("eleven" skills, two distributions) and the generated navigation through `.agent-docs/modules.json`.
