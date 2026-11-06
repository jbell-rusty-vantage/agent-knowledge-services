# Embedding bundle test fixture

This repository-owned fixture contains the three `internal_exploratory` embedding bundles produced by `research_starter_pre_research_agent/experiments/embedding-bundle-seed-2026-09-01` on 2026-09-01. It supports the testkit's embedding-bundle and broad retrieval evaluation tests. It is not the full research corpus, a publication, or a gold evaluation approval.

Each bundle is an exact byte copy of its source file, preserving all 37 selected documents and 41 engineering claims across the three public talks and official-source selections. Optimized transcripts and summaries as separate files, dossiers, ingestion intents, and database receipts are excluded. No sibling checkout or populated database is needed by the tests.

`outputs/catalog.json` lists the three required bundle paths, the raw SHA-256 of each source and local bundle file, and the source catalog's raw SHA-256. Git stores these JSON files without line-ending conversion, preserving their original bytes across platforms. The testkit checks the catalog and every requested file, including each file's digest, before returning any bundle. Changes to the fixture require deliberate catalog updates and the existing evaluation assertions must still pass.
