# GPT 6 Astra coordinator: Knowledge Services final layout

> Current continuation: [NEXT-PACKAGE-CLEANUP.md](./NEXT-PACKAGE-CLEANUP.md) records the merged Jev starting point and the exact Unit 1 missing-fixture exception; it supersedes the earlier green-only prerequisite for that failure only.

This is the developer's execution brief for a new session. Use **GPT 6 Astra as coordinator/planner/reviewer** and **GPT 6 Sol as implementation workers**. The developer explicitly authorizes this delegation. Attaching this file does not itself change the session model: select GPT 6 Astra for the coordinator session.

## Objective and scope

Implement the accepted `FINAL-LAYOUT.md` in its prescribed order, prepare the DeepAgents stage runner for the new services and updated skills, and then run the pre–Mission Control testing. Begin with bounded planning and immediately move into execution. Do not stop after producing another plan, or ask for permission at each mechanical step.

There are **no live consumers** of these services. The DeepAgents stage runner (`research_ingestion_systems_agent/agents/deepagents-stage`) is the test consumer and real fixture harness. Follow [DR1–DR5](./DEEPAGENTS-READINESS.md) and the [real fixture stage graph](./REAL-FIXTURE-STAGE-GRAPH.md), including config-composed compiled sync and native async children. Historical Eve adaptation is superseded: Eve remains untouched and unmaintained for this fixture; an adapter may come later. Do not build legacy adapters, maintain old binaries for compatibility, or stage a production migration. The populated shared database and stored evidence still must be preserved.

Repository roots relative to the workspace:

- `ai-engineer-knowledge-services/`: primary implementation and this cleanup ledger.
- `research_ingestion_systems_agent/`: DeepAgents readiness and fixture execution; preserve existing Eve/proof work.
- `ai-engineer-meta/`: accepted cross-system intent and the pre–Mission Control test plan; use its navigation to locate the current plan.
- `ai-engineer-db-contract/`: shared database authority; consume the pinned contract. A package cleanup does not authorize unrelated schema changes.

## Read and establish the starting state

Developer-accepted branch rule: one cleanup unit per branch, created from integrated local `main`; multiple cohesive commits per branch are expected. Complete and validate the unit, update its evidence and next-unit handoff, then merge it into local `main` before branching for the next unit. Routine local unit merges are authorized. Do not stack unfinished units or implement them directly on main. Follow [the current handoff](./NEXT-PACKAGE-CLEANUP.md) for the exact next branch and baseline exception. Preserve functionality; specify and test deliberate enhancements in the appropriate later units. Remote publication and deployment are separate from this local workflow.

1. Read workspace `AGENTS.md`, primary repository `AGENTS.md`, and this folder's `FINAL-LAYOUT.md`.
2. Read `workspace/README.md`, `workspace/PROGRESS.md`, `FINAL-REVIEW.md`, and the current unit's specification. Follow links to source-specific guides and accepted architecture as needed. Read the research repository's own instructions before changing that repository.
3. Inspect actual Git status, branch, HEAD, worktrees, and relevant source. The preparation session was based on `9084428` and left documentation uncommitted; this is historical context, not a command to reset to that commit. Preserve those authored and generated documentation changes and any unrelated user work.
4. Establish one implementation branch/worktree and record its absolute path and baseline SHA. If creating a worktree, explicitly carry the reviewed preparation documents into it: a new worktree does not include uncommitted changes. Do not silently execute from the pre-review version of the plan. Inspect and checkpoint only intended files; do not indiscriminately stage the workspace.
5. Locate the applicable pre–Mission Control test plan through meta's instructions/navigation. Record its exact path and relevant commands in the ledger early, including any prerequisites that can be prepared during cleanup. Historical S0–S7 sequencing does not override this cleanup's unit order. Do not invent a substitute evaluation and call it the requested test plan.
6. Write a concise execution plan in the ledger and start the current unit. If earlier units are already validated, inspect their evidence and continue from the first incomplete unit. Do not repeat the full architecture review or rerun unchanged checks without a reason.

`FINAL-LAYOUT.md` and the developer's no-live-consumers clarification control the target. Unit specifications control implementation details. The ledger records progress, not a second architecture. The older phase approval-memo process and old orchestration plan do not require another permission round or override this brief's worker model and sequence.

## Astra's responsibilities

You own sequencing, interface decisions, specifications, integration, review, and final acceptance. Sol owns bounded implementation tasks you assign.

- Turn each unit into a small number of concrete tasks with explicit paths, invariants, expected output, and checks. Write specifications for units 2–7 immediately before they begin, against the preceding validated state. Do not spec every implementation detail up front.
- Make the architectural decisions yourself: dependency direction, host interfaces and profiles, authorization placement, catalog semantics, and DeepAgents' published consumer contract. Give workers decisions to implement rather than asking each to redesign the repository.
- Be the sole writer of `workspace/PROGRESS.md` and coordinator-owned unit specs. Keep path reservations and validation ownership explicit.
- While a worker implements, do useful independent work: inspect adjacent consumers, prepare acceptance cases, inspect baseline evidence, or review untouched interfaces. Do not concurrently edit the worker's reserved paths.
- Inspect each returned diff and evidence before accepting it. Check behavior and dependency direction, not only test exit codes. Reuse the worker for bounded fixes when useful; use a fresh worker when its task/context is exhausted.
- Run or designate the integration checks once per meaningful checkpoint. Do not have every worker repeat the full monorepo verification. A worker report alone is not sufficient evidence to mark a unit done.
- Give concise progress updates and continue through the sequence. Ask only for genuinely missing decisions, credentials, or scope authorization that existing instructions cannot resolve. Work on independent tasks while awaiting necessary input.

## Sol delegation and concurrency

Default to **one active Sol implementation worker**. Keep structural units sequential. Unit 1's merge groups also run sequentially. The coordinator may use a second worker for an independent, bounded read-only investigation or a truly disjoint implementation, but only when there is useful work for both and no shared file/test resource conflict. Respect the runtime's actual concurrency limit; this brief does not require filling all slots.

Use subagents attached to this coordinator session, not separate user-owned tasks. Workers must not recursively delegate. They report to Astra and do not independently merge, push, deploy, or change architecture.

When the environment exposes `collaboration.spawn_agent`, request the exact worker model:

```json
{
  "task_name": "unit0_fixture_baseline",
  "model": "gpt-6-sol",
  "fork_turns": "none",
  "message": "<self-contained assignment using the template below>"
}
```

Use a self-contained brief because `fork_turns: "none"` carries no conversation history. In environments where full-history forks inherit the coordinator model, do not use `fork_turns: "all"` and assume the worker is Sol. Confirm the requested model is supported; report an unavailable model honestly rather than silently substituting Astra for implementation work. No specific worker reasoning-effort override is required.

Subagents normally share the checkout. Their file changes are already visible; do not cherry-pick them as though they were isolated branches. If you deliberately use a separate worktree, record its path/base and integrate it explicitly. Reserve shared manifests, lockfile, barrels, generated navigation, and disposable test services to one writer/runner at a time. Never run competing full test suites; the preparation run showed process failures under concurrency.

### Assignment template

```text
You are the GPT 6 Sol implementation worker for <unit/task>.
Coordinator: GPT 6 Astra. Do not delegate or redesign the agreed layout.

Working directory: <absolute repository/worktree path>
Baseline: <SHA and relevant coordinator changes already present>
Read: <AGENTS.md paths, current unit spec, precise source/test references>
Objective: <one bounded, observable result>
Decisions already made: <interfaces/names/dependency direction/profile behavior>
Reserved writable paths: <explicit paths; shared manifests only if assigned>
Do not change: <ledger/specs/unrelated files, persisted identities, etc.>
Checks you own: <targeted commands and expected outcomes>
Checks the coordinator owns: <integration/full verify/packaging as applicable>

Implement and run your checks. Preserve other agents' edits. If a required
change is outside your reserved paths, report the specific dependency to Astra
before expanding scope. Fix failures caused by your change; do not weaken tests.
Do not push, merge, deploy, or create commits unless explicitly assigned.

Return: changed files; behavior/interface effects; exact check outcomes and
skips; remaining risks; any deviations; next action needed. Distinguish observed
results from assumptions. Do not mark the overall unit complete yourself.
```

## Execution sequence

| Work | Coordinator focus | Suggested Sol assignment |
|---|---|---|
| 0 — baseline | Follow `UNIT-0-BASELINE.md`; establish reproducible checks and export/test inventories before moves | Diagnose and repair fixture isolation first; then investigate test-resource failures and capture baseline evidence in separate bounded tasks |
| 1 — mechanical merges | Follow `UNIT-1-PACKAGE-MERGES.md`; preserve public exports, test identities and stored procedure identities | One merge group at a time: `knowledge-db`, retrieval, preparation, core; then live documentation updates |
| 2 — host | Specify profile capabilities/lifecycle and reuse the existing shared verification host | Extract config and composition into host without duplicating admission implementations |
| 3 — application/MCP | Specify remaining ownership/admission/retrieval moves and new transport contracts | Move one remaining concern or shim at a time, with shared authorization/admission tests |
| 4 — organization/catalog | Specify folder/service renames, internal import rules, and complete operation descriptors | Implement bounded renames, then catalog parity covering reads, mutations, profile availability and exclusions |
| 5 — executor/CLI | Define unified services and the DeepAgents smoke against ks | Follow unchanged KS slices 5C–5D3 and 5F; 5E1/5E2 are superseded; validate 5H with DR2 smoke |
| 6 — skills | Specify eight canonical skills and accurate operation/procedure coverage | Consolidate skills, references and manifest; validate with DeepAgents parser and installed packaging; stage configs own role bindings |
| 7 — proofs | Classify runnable proof commands versus build tooling and historical records | Move active proofs and repair entrypoints/fixtures/assets; archive historical material without changing receipts |
| Final testing | Execute the identified pre–Mission Control plan using the DeepAgents stage graph after DR1–DR5 and Unit 6 conformance | Delegate bounded test execution/triage; coordinate results and fix implementation regressions |

Sequence: KS cleanup/readiness → DeepAgents readiness → real fixtures → Mission Control. Runner implementation belongs to the research repository, not a cleanup slice. Unit 7 retains its accepted scheduling exception.

Do not insert new feature-development tracks merely because historical documents list them. Keep Jev and planned research capabilities accurately represented; do not claim them implemented through renaming or skill prose. Do not unify the deferred capture/parser paths during package cleanup.

## Review and completion gates

For each task: inspect diff → run targeted checks → fix failures → integrate. For each unit: verify the applicable unit acceptance criteria, run repository verification and doc checks, update the ledger, then continue. Missing integration prerequisites remain explicit limitations; they never become passing evidence.

Pay particular attention to:

- The future `application → knowledge-db → persistence → application` cycle. Unit 1 preserves the current graph; unit 5 must remove the persistence coupling before introducing the new edge.
- Existing ownership/admission factories and `createVerificationHostRuntime`: reuse them. Preserve tenant isolation, bounded roles, evidence custody, deterministic failure precedence, idempotency and receipt semantics.
- Local filesystem storage versus offline capability. Offline commands must not silently reach providers/databases; remote CLI must remain client-only. The host owns construction and cleanup.
- Declared versus admitted versus executable operation kinds. Catalog parity must not activate unavailable operations or give ingestion a second durable ledger.
- Test and export identity, not just counts; root `verify` does not cover every preparation/retrieval example. Installed sandbox packages must work without monorepo module resolution.
- DeepAgents must use the new services and canonical skills, and demonstrate both real sync and async children for final testing. Passing the old executor integration does not validate the new one.

Use isolated disposable databases for destructive/fresh-chain proofs. Preserve the populated shared database, immutable receipts and persisted identities. Keep secrets and raw private research out of logs and committed evidence. Follow the actual test plan and existing service authorization; do not invent deployment or paid-provider permissions just to complete a checklist.

Keep validated changes in small, scoped commits when appropriate, with baseline fixes separated from mechanical moves and surface changes. Local implementation can proceed across validated commits without waiting for a PR merge after every unit. Do not infer authorization to merge future PRs or deploy from the earlier request to merge Claude Code's PR. Record commit/PR status accurately; use `landed` only when the ledger's definition is met.

At the end, report the achieved layout, DeepAgents/skill integration status, pre–Mission Control test results, actual commands/evidence, and any remaining limitations. If a real blocker prevents completion, record precisely what is missing and the next executable action; do not substitute an optimistic completion claim.

## Ledger and restart discipline

Update `workspace/PROGRESS.md` after each meaningful checkpoint with owner, model, branch/worktree, SHA, reserved paths, changes, checks, skips, evidence location, and next action. Keep raw logs outside docs; preserve compact inventories and stable evidence references needed by later agents.

Before context exhaustion or session end, leave a bounded handoff. On resume, verify the current source and recorded evidence, then continue. Do not respawn workers that are already active or repeat completed units. Release path reservations when workers finish.

**First action now:** read the current ledger and Git state, preserve the prepared documents, take ownership of the first incomplete unit, make its bounded plan, and dispatch the first GPT 6 Sol implementation task while you prepare its review and acceptance checks.
