---
status: proposed
owner: knowledge-services
created: 2026-09-19
---

# Orchestrating subagents through S0–S7

Status: **Proposed. Not started.** This is how a coordinator session would run the merged sequence in `FEATURE-SET-SPECIFICATION.md` §4 with subagents, if the developer permits it. It respects the existing protocol (`implementation/PROTOCOL.md`: one ledger writer, independent review, file reservations) and the existing lesson (`PHASE-EXPLORATION-INSTRUCTIONS.md` ground rule 1: a prior pass lost two of five delegated forks silently). It amends one thing: fan-out happens at the **coordinator** level, with each subagent itself running with zero subagents.

## 1. Where the time actually goes

Efficiency here is not "more agents". The critical path is:

1. developer decisions (D1–D10, the spend ceiling, human gold review) — cannot be delegated;
2. the **disposable-services lock** — only one proof at a time may run against `disposable-ks-p0-p1` (54422/54421) or `disposable-ks-p5-retrieval` (54432/54431), and nothing may reset them;
3. **hot files** — `apps/verification-executor/src/knowledge/operations.ts` (every new operation lands there), `packages/application/src/index.ts`, `skills/manifest.json`, `implementation/ledger.json`;
4. independent review before any ledger acceptance.

So the plan front-loads decisions at gate boundaries, gives each hot file exactly one owner per wave, serializes proofs behind a lock, and fans out only across disjoint file sets.

## 2. Roles

| Role | Who | Rules |
|---|---|---|
| Coordinator | this session | Sole ledger writer. Writes every assignment and reads every result file. Runs the verifying command itself before believing any result (`node skills/check.mjs`, `./node_modules/.bin/vitest run <file>`, `node .agent-docs/cli.mjs check`). Batches developer questions at gates. Never delegates the ledger, reservations, or the decision list. |
| Memo author | one fork per phase memo | Inherits this session's grounding (spec, challenges, evidence). Zero subagents. Deliverable is `PHASE-<n>-RECOMMENDATION.md`. Never edits code. |
| Implementer | fresh general-purpose agent per unit | Receives: the feature or phase section verbatim, an explicit file allowlist (its reservation), the exact verify commands, and the result-file path. Zero subagents. Must write `sessions/<step>/<unit>-result.json` (files touched, commands, exit codes, skips, open questions) before finishing. Absence of that file means the unit did not complete, regardless of the notification. |
| Reviewer | fresh agent, never the unit's implementer | Reads the result file and the diff, reruns the verify commands, writes `<unit>-review.md` with approve / approve-with-nits / reject. Required before any ledger acceptance or gate. |
| Proof runner | one agent at a time, holding the disposable lock | Runs integration proofs, lane A, stage conformance. Checks Docker labels and ports before every run. Never resets a disposable. Never runs while another proof runner is live. |
| Doc updater | coordinator, after each wave | `node ai-engineer-meta/tools/agent-docs/cli.mjs build --workspace .` then `check`; registers new docs and modules. |

Concurrency cap: **four live agents** (three implementers plus one proof runner, or two implementers plus one memo author plus one reviewer). More than that contends on the shared disposable services and on review throughput, which is the real limit.

## 3. Wave plan

Each wave lists what runs in parallel, what is serialized, and what the coordinator verifies before the next wave.

| Step | Parallel (disjoint reservations) | Serialized | Coordinator verifies |
|---|---|---|---|
| **S0** | none — coordinator does it directly: review-record close-out, `modules.json` registration, pin reconciliation, reservations file | — | `pnpm verify` baseline recorded; doc check green |
| **S1** | (a) F1 skills correctness pass — owns `skills/*` and `skills/manifest.json`; (b) F2+F3+F4 contract authoring — owns `packages/contracts/src/research-execution.ts`, `evidence-assurance.ts`, `usage-ledger.ts` plus tests, additive only; (c) `chunking` + `documents` splits with examples — owns those two packages; (d) `acquisition` unwiring — owns `packages/acquisition`; (e) F10a stage frontmatter schema in `skills/check.mjs` — sequenced **after** (a) because they share `check.mjs` | P6.1 corpus and candidate labels — proof runner, needs HTTPS capture through custody and the disposable lock | check.mjs and harness skills:check; contract tests; four review files; G1 |
| **S2** | (a) F9 selection eligibility — owns `packages/policy`; (b) T11 role catalogs — owns the research harness role files; (c) T12 CLI/MCP adapters — owns the harness adapter files; (d) D1 design memo (fork, no code) | **Executor registry owner** — one implementer does F5 `source_inspect`, F8 `space_manifest`, F4 `usage_read`, F6's `completion_submit` in sequence, because all four land in `operations.ts` and the executor skill packs. Then T13 Eve dispatch (Docker), then T14 nano/mini (needs D7 spend ceiling). Independent review of T4–T7, T10 → P5.1/P5.2/P5.3/P4.2 acceptance | executor unit tests; T6 re-proof on p0-p1 after the identity write-path; reviewer files for every acceptance; G2 |
| **S3** | (a) runner skeleton — phases `prepare/contracts/agent/live/deployment/report`, manifest validation, run-pin validation, `readiness.json`; (b) case adapters by family — one agent for F/T/D, one for S/P/R/A/RC — each owns its own directory under the runner | lane A execution on the disposable pair by the proof runner; F3 assurance assertions in R01–R03 | 65 cases executed, zero silent skips, nonzero exit on any failed mandatory gate; G3 receipt filed as the regression baseline |
| **S4** | Phase 1 remainder: application folder move is **one** agent (hot barrel). Phase 2: `retrieval`, `embeddings`, `vector-backends` (+`spaces/`), `projections` — four agents, disjoint packages. Phase 3: `persistence` split (one agent), `application` remaining (one agent, after persistence's type-only import migration is designed), `contracts` light pass (one agent, last) | Each phase: memo → developer approval → implementation wave → review → **lane A rerun** by the proof runner. Phases do not overlap. | lane A green after each phase; review record per package in `docs/operations/reviews/`; G4 |
| **S5** | F10b/c harness first (one agent, owns `skills/stages/`). Then twelve skill enhancements in parallel, one agent per skill directory; F6 and F7 authored by forks because they need the spec grounding. Coordinator merges `skills/manifest.json` edits. | recorded-mode conformance for all twelve by the proof runner; live mode only under D7 | twelve conformance receipts; pin digests recorded; bundle frozen; G5 |
| **S6** | Lanes are real agent runs on the frozen bundle, not subagents of this session. Subagents only prepare materialization, launch, and collect receipts. B's six runs are serialized on the disposable pair; C after B; E after B. | human gold review binding — developer | lane receipts and `readiness.json` per lane; G6 |
| **S7** | (a) KS client extension or knowledge-host route per D1 — owns `packages/client-typescript` and the executor HTTP auth; (b) F11 outbox — owns persistence/api outbox files, proposes any table to db-contract first; (c) MC-side template and Event Wait fixture — one agent in `ai-engineer-mission-control` | lane D on the identified target; P7.2 handoff assembly by the coordinator | standalone public-contract consumer proof; MC fixture run; five-lane readiness receipt; G7 |

## 4. Rules that make this efficient rather than merely parallel

1. **Contract first, then fan out.** Nothing that consumes a schema starts before the schema's tests pass. S1(b) precedes every S2 consumer; the F10a stage schema precedes S5's twelve skills; D1's design precedes S7.
2. **One owner per hot file per wave.** Reservations are written into `sessions/<step>/RESERVATIONS.md` before the wave launches. An implementer that needs a file outside its allowlist stops and reports; it does not edit.
3. **Proof lock.** The proof runner is the only agent that may talk to the disposable services. Implementers use unit tests and fakes. This is what prevents two agents from racing on 54422 and reporting each other's failures.
4. **Results are files, not messages.** A unit is complete when its result file exists and the coordinator has rerun its verify commands. This is the direct mitigation for silently lost forks.
5. **Reviewer is never the implementer.** Acceptance in the ledger requires the review file; the coordinator does not self-accept.
6. **Forks only where grounding matters.** Memo authors, F6/F7 skill authors and the D1 design use forks (they inherit the spec, the challenges and the evidence). Mechanical units (package splits, adapters, contract files, case adapters) use fresh agents with a verbatim spec section and an explicit file list, which is cheaper and avoids context bloat.
7. **Decisions are batched at gates.** The coordinator asks the developer once per gate: D1–D5 and D7 before S2; Phase memos before each S4 phase; gold review before S6. No mid-wave questions.
8. **No rediscovery.** Every assignment carries the feature or phase text and the file list. Agents are told not to reconstruct the project from old session notes, the same rule `BOUNDED-SESSIONS.md` already gives.
9. **Windows shell rules travel with every assignment.** `./node_modules/.bin/vitest`, `npx pnpm@10.34.5`, repo-pinned Supabase CLI, no `supabase status` secrets, Docker label check before proofs.
10. **Stop conditions.** An agent stops on: a file outside its reservation, a failing verify it cannot fix inside scope, a needed operation that is not on the pin, or any instruction to reset a disposable. It writes the result file with `status: blocked` and the reason.

## 5. What cannot be delegated

- Decisions D1–D10, the spend ceiling, and human gold review.
- Ledger writes and reservations.
- Commits and pushes (only when the developer asks; each repo is its own Git tree).
- Any change to the populated shared database. Disposables only, never reset.
- Declaring a ledger unit accepted without a reviewer file.

## 6. Expected shape of a run

The sequence has seven gates. Waves S1, S2, S4-Phase-2, S5 and S7 are where parallelism pays; S0, S3's execution, S4's lane A reruns and S6 are inherently serial. Under the four-agent cap the coordinator spends most of its own time verifying results and batching gate questions, which is where a coordinator should spend it.

Before the first wave, the developer approves this plan and answers D1–D5 and D7 (D6 is this ordering; D8–D10 can wait for S4). The first wave is S0 by the coordinator alone, then S1 with five implementers and the proof runner on P6.1.
