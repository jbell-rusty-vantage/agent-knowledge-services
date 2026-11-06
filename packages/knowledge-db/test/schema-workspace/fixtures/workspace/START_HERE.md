---
id: start
kind: entry
workspace_fingerprint: sha256:fixturews00000000000000000000000000000000000000000000000000000000
migration_head: "20260912020000"
---

# Start here (fixture workspace)

Search before reading: `search/index.json`. Read the domain page before any relation page.
Named queries live in `queries/catalog.json`; canonical facts are written only by the knowledge
executor as `executor_service` through `temporal.begin_batch` → `temporal.assert_*` → `temporal.commit_batch`.
