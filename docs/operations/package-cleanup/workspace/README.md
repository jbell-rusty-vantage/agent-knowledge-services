# Cleanup execution workspace

Status: reference; operational coordination for the accepted [final layout](../FINAL-LAYOUT.md).

Start with [PROGRESS.md](./PROGRESS.md), then [FINAL-REVIEW.md](../FINAL-REVIEW.md), then the current unit specification. This workspace is the execution ledger for the seven-unit cleanup and its baseline prerequisite. Historical S0–S7 ledgers in meta remain history/feature records; they do not determine this cleanup's next task. This ledger does not redefine product scope, grant provider/database access, or prove deployment.

Delegated execution: [COORDINATOR-INSTRUCTIONS.md](../COORDINATOR-INSTRUCTIONS.md) is the developer-requested brief for GPT 6 Astra to coordinate GPT 6 Sol workers. It defines mostly sequential assignments, review ownership, and restart discipline.

## Working rules

- One active structural unit at a time. Finish and validate its dependency/import changes before starting the next. The coordinating agent owns `PROGRESS.md`; any explicitly delegated worker reports results to that owner rather than editing shared status concurrently.
- Before edits, record owner/session, baseline SHA, branch/worktree, and reserved paths. Shared manifests, lockfile, barrels, and generated navigation have a single writer. No standing instruction here requires spawning agents.
- Status vocabulary: `queued`, `active`, `blocked`, `validated`, `landed`. `validated` requires recorded checks; `landed` requires a merge/commit reference and synchronized base. Do not claim completion from intent, file existence, or test counts alone.
- Keep the target in `FINAL-LAYOUT.md`, concrete implementation detail in unit specs, findings in `FINAL-REVIEW.md`, and progress here. Write specs for units 2–7 just before execution, using the entry/exit gates on the board; do not treat provisional design sketches as implemented contracts.
- Preserve behavior during mechanical units. For surface consolidation, validate the DeepAgents stage runner against the new services and skills (Eve adaptation is superseded); the developer confirmed there are no live consumers and no legacy compatibility adapters are needed. Record intentional contract changes in the unit spec. Run pre–Mission Control testing after cleanup and integration adaptation.
- Store small, reproducible evidence summaries here or in linked CI artifacts. Never commit tokens, database URLs, private research, raw environment files, large logs, or mutable copies of historical receipts. Do not crawl output directories.
- Use repository doc generation after updating its authored inputs; never edit generated blocks. Historical review records retain their original paths.

## Session handoff format

Add a dated entry to `PROGRESS.md` containing:

1. Owner/session and branch/worktree; starting and ending SHA; dirty paths left behind.
2. What changed and which finding/unit it satisfies.
3. Exact checks, results, test identity/count deltas, skipped integrations, and evidence link/digest.
4. Remaining risks/blockers and DeepAgents readiness or updated-skill testing still required.
5. The next bounded task, prerequisite, and command; release or transfer path reservations.

Use a linked `sessions/<UTC-date>-<unit>.md` only when the handoff exceeds a short ledger entry. Keep `PROGRESS.md` as the single status board.
