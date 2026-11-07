---
type: Operator Runbook
title: Repository history starts at the 2026-11-06 clean-slate baseline
description: "Knowledge Services moved to the jbell-rusty-vantage GitHub account as a clean slate on 2026-11-06: one root commit whose tree equals the last pre-move main. Commit IDs cited in older docs are not in this repository; how to read them, what the baseline is, and the one-branch rule going forward."
tags: [knowledge-services, git, github, history, operations]
---
# Repository history

**Knowledge Services's Git history starts at the clean-slate baseline of 2026-11-06.** The owner moved the repository from the
`Overton77` GitHub account to `jbell-rusty-vantage` and chose a fresh start over carrying the old history: start-up mode, forward
only, no rollbacks to earlier commits.

## The baseline

- The root commit, *Knowledge Services: fresh start on jbell-rusty-vantage*, has no parent. Its file tree is byte-identical to the
  last pre-move `main`, `b00039b6` (2026-11-06). Nothing in the source changed at the move; only history was dropped.
- The repository is [`jbell-rusty-vantage/agent-knowledge-services`](https://github.com/jbell-rusty-vantage/agent-knowledge-services), which is public. Only `main` is published. There are no other
  branches, tags, recovery refs or stashes on the new remote.
- The old `Overton77/ai-engineer-knowledge-services` repository is legacy and no longer the source of truth. Do not push to it or open PRs there.

## Sibling repositories (as of 2026-11-07)

The other BellLabs repositories moved the same way (clean slate, `main` only). Links to `Overton77/...` in older documents
point at the legacy account; use these homes instead.

| Checkout (BellLabs workspace) | GitHub home |
| --- | --- |
| `platform/mission-control` | [`jbell-rusty-vantage/agentic-mission-control`](https://github.com/jbell-rusty-vantage/agentic-mission-control) |
| `platform/agentic-sdlc` | [`jbell-rusty-vantage/agentic-sdlc`](https://github.com/jbell-rusty-vantage/agentic-sdlc) |
| `aiengineer/ai-engineer-db-contract` (schema authority this repository pins) | [`jbell-rusty-vantage/agent-engineer-db-contract`](https://github.com/jbell-rusty-vantage/agent-engineer-db-contract) |
| `aiengineer/ai-engineer-service` | [`jbell-rusty-vantage/ai-engineer-services`](https://github.com/jbell-rusty-vantage/ai-engineer-services) |
| `aiengineer/ai-engineer-industry-cloud-automated-research` (being renamed) | [`jbell-rusty-vantage/ai-engineer-cloud-agent-knowledge-repo`](https://github.com/jbell-rusty-vantage/ai-engineer-cloud-agent-knowledge-repo) |
| `biotech/biotech-knowledge-services` | [`jbell-rusty-vantage/biotech-knowledge-services`](https://github.com/jbell-rusty-vantage/biotech-knowledge-services) |
| `biotech/biotech-postgres-db-contract` | [`jbell-rusty-vantage/biotech-postgres-db-contract`](https://github.com/jbell-rusty-vantage/biotech-postgres-db-contract) |

Workspace status and the move recipe: [worktree routing](../../../docs/navigation/WORKTREES.md#github-move-and-clean-slate-2026-11-06).

## Commit IDs in older documents

Specs, ledgers, handoffs, ADRs, receipts and evidence files written before the move cite commit IDs and links to the old
repository (its Actions runs, blobs and pull requests). **Those commits do not exist in this repository**, and the old links
are not public. `git show`, `git log` and `git blame` cannot resolve them, and `git blame` attributes every line to the baseline.

- Read an old ID as a *dated label*: "the state of Knowledge Services at that point", not something to check out or diff against.
- The claim it supports stands or falls on the current code and tests, not on the old commit. Re-verify against live source
  before you rely on it.
- Do not rewrite old documents just to remove the IDs. They remain provenance.
- Pinned identifiers that are data, not links, keep their old values: package names (`@aiengineer/*`), fixture
  manifests (`repository: ai-engineer-knowledge-services`), recorded commit fields in receipts and benchmark lineage.
- Cite the baseline or later commits in new documents.

The owner keeps a private, local-only archive of the full pre-move history (a Git bundle outside tracked source). Cloud
sessions and other clones do not have it. Do not plan work that depends on it. Ask the owner only if a pre-move commit is
genuinely needed.

## Going forward

- One branch: work lands on `main`. Short-lived branches are fine locally; publish only `main` unless the owner asks otherwise.
- Commit author is `John Overton Bell <286395280+jbell-rusty-vantage@users.noreply.github.com>`, set in the repository's local
  Git config on the owner's machine. Cloud sessions use their own configured identity.
- The secret-scan baseline at the move was clean: gitleaks 8.30.1 over the full old history and over the baseline tree found only
  false positives (idempotency keys and object keys in tests, content digests, environment-variable names). Keep it that way:
  fixtures use obviously fake values, and real credentials never enter tracked files
  ([data planes and credentials](../../../docs/navigation/DATA-PLANES-AND-CREDENTIALS.md)).
- Windows clones may need `git config core.longpaths true`.
