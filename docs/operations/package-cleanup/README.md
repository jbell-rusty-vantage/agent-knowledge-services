# Knowledge Services package cleanup

Status: reference. Current execution index.

Current continuation: [NEXT-PACKAGE-CLEANUP.md](./NEXT-PACKAGE-CLEANUP.md). Units 1–4 are merged into local main, each under an explicitly reassessed missing-input exception; acceptance evidence is recorded in the ledger. The continuation also carries the bounded pre–Mission Control stage-graph experiment milestone.

## Start here

1. [COORDINATOR-INSTRUCTIONS.md](./COORDINATOR-INSTRUCTIONS.md): attach to a GPT 6 Astra session; delegate bounded implementation to GPT 6 Sol.
2. [FINAL-LAYOUT.md](./FINAL-LAYOUT.md): accepted layout, transport rules, and seven-unit sequence.
3. [workspace/PROGRESS.md](./workspace/PROGRESS.md): current state, validation evidence, and next task.
4. [workspace/README.md](./workspace/README.md): ledger ownership and handoff rules.

## Implementation references

- [FINAL-REVIEW.md](./FINAL-REVIEW.md): source-backed findings and implementation considerations, including the developer's subsequent clarification.
- [UNIT-0-BASELINE.md](./UNIT-0-BASELINE.md): establish reproducible verification before package moves.
- [UNIT-1-PACKAGE-MERGES.md](./UNIT-1-PACKAGE-MERGES.md): mechanical package merges and their preservation gates.
- [UNIT-2-HOST-COMPOSITION.md](./UNIT-2-HOST-COMPOSITION.md): delivered host composition, lifecycle and the remaining Unit 3/5 seams.
- [UNIT-3-APPLICATION-AND-MCP.md](./UNIT-3-APPLICATION-AND-MCP.md): delivered application use cases, in-process MCP (no HTTP shims) and API/MCP parity.
- [UNIT-4-APPLICATION-ORDER-AND-CATALOG.md](./UNIT-4-APPLICATION-ORDER-AND-CATALOG.md): delivered application folders by tool group, A2A binding in the API, testkit off the API runtime, the folder naming pass and the operation catalog parity test.
- [UNIT-5-EXECUTOR-FOLD-CLI-AND-EVE.md](./UNIT-5-EXECUTOR-FOLD-CLI-AND-EVE.md): next bounded specification. [UNIT-5-SLICES.md](./UNIT-5-SLICES.md) divides it into sessions (5A–5H), one branch each. 5A–5B are delivered; 5C's implementation is committed on its branch and awaits validation evidence, ledger entry and local merge; then Q0, 5P and **5D1**. 5E1/5E2 are superseded. Write full specifications for units 6–7 as their turn arrives.
- [APP-AND-SKILL-QUALITY.md](./APP-AND-SKILL-QUALITY.md): proposed app and skill quality plan (2026-09-29) — close 5C, then Q0 quality gates and 5P transport structure before 5D1; per-slice quality additions; proposed Unit 8 worker extraction and service hardening.
- [UNIT-6-SKILLS-DIRECTION.md](./UNIT-6-SKILLS-DIRECTION.md): proposed canonical eight skills and DeepAgents parser conformance.
- [DEEPAGENTS-READINESS.md](./DEEPAGENTS-READINESS.md): proposed DR1–DR5, config-composed sync/async agents, model routes, artifacts and budget.
- [REAL-FIXTURE-STAGE-GRAPH.md](./REAL-FIXTURE-STAGE-GRAPH.md): proposed seven-stage mission, validators, operator continuation and $25 allocation.

No live consumers require compatibility support. Order: KS cleanup/readiness → DeepAgents readiness → real fixtures → Mission Control. Eve adaptation is superseded; its repository code stays untouched. Preserve stored evidence and the populated shared database.

## Historical material

The superseded plans, phase approval instructions, and recommendation memos are in [archive/](./archive/README.md). They do not control execution order, delegation, approvals, or new feature scope. Consult a historical memo only for a specific decision explicitly retained by FINAL-LAYOUT.md; verify its implementation claims against current code.
