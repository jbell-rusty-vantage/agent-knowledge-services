# Knowledge Services repository guide

The detail that [AGENTS.md](../../AGENTS.md#knowledge-services) points to (SPEC-03 K4 keeps that file at 60 lines or fewer). The
authored sections come first; the generated guide below them is rebuilt from `.agent-docs/config.json` and
`.agent-docs/modules.json` by `node .agent-docs/cli.mjs build --repo .`. Paths in this guide are repository-relative
unless they are links.

<a id="orientation"></a>
## Orientation and history

- Owner reporting: follow the [BellLabs owner goal and reporting directive](../../../../AGENTS.md#owner-goal-and-reporting-directive-2026-10-29).
  Explain changes through the workflow and agent-configuration gap they close for the Deep Agents-focused Mission
  Control path, keep shared contracts provider-neutral, and keep implementation, test and qualification distinct.
- Canonical checkout: `BellLabs/platform/knowledge-services`; the `@aiengineer/*` package names and the pinned schema
  binding remain. Ownership against platform and domain neighbours: [service boundaries](../../knowledge/service-boundaries.md#purpose)
  and [neighbor systems](../../README.md#neighbor-systems). The retired `ai-engineer-mission-control` and
  `research_ingestion_systems_agent` are not entrypoints; do not recreate or repoint them.
- Sprint V finished and is archived in Mission Control: [repositories, database roles and claim
  order](../../../mission-control/docs/specs/archive/provider-consolidation-2026-10/sprint-v/START-HERE.md#start-here).
  Current Mission Control work starts at the [Sprint OC board](../../../mission-control/docs/specs/provider-consolidation-2026-10/sprint-oc/NEXT-SESSION.md#sprint-oc-control-board).
  The accepted full refactor changes shared operational schema ownership through one explicit cutover; the current
  binding and the target component are distinguished there.
- Current state (2026-11-15): read the [Knowledge Services state card](../../../../docs/state/2026-11-15/KNOWLEDGE-SERVICES.md#identity)
  first. Live work is driven from AI Engineer Build 08 ([current
  handoff](../../../ai-engineer-research-2026-11-02/schema-units/archive/handoffs/NEXT-SESSION-BUILD-08-AFTER-LOOP-8.md)) and the
  accepted, not started [binding relocation plan](../specs/binding-relocation-2026-11/PLAN.md). The generated task route
  below that calls `NEXT-PACKAGE-CLEANUP.md` the current handoff is historical (last integrated 2026-10-24).
- GitHub: public [`jbell-rusty-vantage/agent-knowledge-services`](https://github.com/jbell-rusty-vantage/agent-knowledge-services),
  `main` only. History starts at the 2026-11-06 clean-slate baseline, so commit ids and
  `Overton77/ai-engineer-knowledge-services` links in older documents do not resolve here ([repository
  history](../REPOSITORY-HISTORY.md)).
- Before editing, run `git status --short`, `git branch --show-current` and `git worktree list` (or `./dev status`).
  Preserve dirty work; `.git/maintenance/jobs/` worktrees are not the primary source. Edit registered sources and build
  this repository only. Deeper guides: [README map](../../README.md#documentation-map), [code map](CODE-MAP.md).

<a id="environment"></a>
## Environment

Database variables are `KS_{AIENG,BIOTECH}_DB_{PROJECT_REF,URL,SECRET_KEY,ADMIN_DSN,RUNTIME_DSN,COMPONENT_DSN}`. The
plane is the application of the binding or operation, or `KS_APPLICATION` for the process (`ai-engineer` -> AIENG,
`biotech` -> BIOTECH). With no application named a process is AIENG and loopback only: a remote value is refused. Only
`packages/host/src/config/database.ts` reads these names; there are no aliases or fallbacks to old names. The registry
`config/env.registry.yaml` and [ENVIRONMENT](../ENVIRONMENT.md#plane-selection) list every name and reader. `.env` is
owner-managed: never edit or print it. Values live in `BellLabs/.secrets/aieng-db.env` and `biotech-db.env`, with the
`KS_` prefix.

<a id="planning"></a>
## Engineering planning and delivery

Use the installed Matt Pocock planning skills in `.agents/skills/` and the configured [Linear tracker](issue-tracker.md),
[triage labels](triage-labels.md) and [domain documentation](domain.md). The [BellLabs Knowledge Platform
specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md) and ADRs 0005-0015 are the authorized
implementation direction; their existence does not certify delivered behavior. The [Knowledge Machine and Content
Machine direction](../specs/knowledge-machine-2026-11/DIRECTION.md) (2026-11-02, proposed, owner decisions KM-D1..D11
open) refines that specification with a feature-by-feature current-state cross-reference; read it before the Knowledge
Services truth pass. The packet's `CURRENT-STATE.md` is a 2026-10-10 snapshot that predates Sprint V and Sprint OC; use
[current architecture](../architecture/current-state.md) and live source for present state. Read the
[glossary](../../GLOSSARY.md) and work the native Linear dependency frontier. Preserve existing migration authority until
its explicit transition gate. Do not run the complete AI Engineer or Biotech application fixture before every
prerequisite of the final acceptance issue passes; component checks remain required during implementation.

<a id="provenance"></a>
## Provenance

Work starts in a committed answers file (`<FAM>-S<n>`; Mission Control's `AS` sittings, the AI Engineer review
workspace's `B08-S<n>`), then a spec, then a Linear `OVE` issue with `Goal:` and a `## Provenance` block
([SPEC-02](../../../mission-control/docs/specs/agentic-sdlc-2026-11/SPEC-02-PROVENANCE-CHAIN.md#chain)). Every commit
ends with `Refs:` (`OVE-n`, `<FAM>-S<n>`, `<FAM>-D<n>`, `ADR-NNNN`, or `none <reason>`) and, when they apply,
`Decisions:` and `Docs:`. `docs/tools/trace.py` (`./dev trace ...`) resolves ids here, in Mission Control's answers and
in the review workspace when those checkouts exist, and reports absent ones as notes. The commit-msg hook
(`node tools/maintenance/cli.mjs install-hooks`) and the `Provenance` workflow warn only until the owner sets
`SDLC_TRACE=block`. The Linear snapshot (`./dev trace linear pull`, `LINEAR_API_KEY` from the environment) lands in the
git-ignored `.sdlc/trace/`.

<!-- BEGIN GENERATED: agent-docs -->
## Repository guide

Knowledge preparation, retrieval, evidence, evaluation, publication, and verification; API, MCP, CLI, durable workers, and parser boundaries.

Lifecycle: Active service repository; see deployment docs for rollout state.

Read the relevant documents below before changing behavior. Inspect more-specific AGENTS.md files in the destination directory. Accepted docs record settled decisions; proposed, reference, and deprecated docs are labelled context. The map is navigation, not proof of implementation or deployment.

- Transport handlers share packages/application. Cross-repository consumers use published HTTP/client, CLI, or MCP contracts; do not import internal algorithm packages.
- API, MCP, and workers call packages/application in process; MCP has no API client. Out-of-process callers use KnowledgeClient HTTP. Local CLI demo/attestation stays application-direct.
- Verification execution and policy admission are separate. Semantic judgment cannot override a deterministic failure. Preserve immutable captures, selectors, provenance, and tenant isolation.
- Mission Control dispatches verification and classifies retry/cancellation; Knowledge Services owns algorithms, policy admission, and durable knowledge execution.
- Shared Supabase migrations and generated database types are owned by ai-engineer-db-contract; consume its pinned contract. Do not create another migration/type authority.
- Search explicit source paths first. Do not recursively enumerate artifacts, outputs, runs, receipts, caches, dependencies, or private notes. Read an individual artifact only when the task calls for it.
- Knowledge schema/read/ingest live in packages/knowledge-db and the verification-executor knowledge surfaces. Retrieval read ops are skipped; ingestion does not write knowledge_service.operation. The K01 knowledge.read_intent (native contract knowledge-read-intent/v1) is a different contract from the bounded knowledge-read-intent.v1 and records every served read in knowledge_verification.operation; see knowledge/schema-read-and-ingestion.md.

### Business logic and workflows (OKF)

Start with `knowledge/index.md`; read one matching concept, then its implementation/tests. Do not load the whole bundle.

- Ownership, profiles and caller contracts: `knowledge/service-boundaries.md` → `knowledge/execution-profiles-and-transports.md`
- Capture, convert and prepare faithful content: `knowledge/capture-conversion-and-custody.md` → `knowledge/preparation-and-publication.md`
- Schema, bounded reads and canonical ingestion: `knowledge/schema-read-and-ingestion.md`
- Retrieve evidence, evaluate and publish: `knowledge/retrieval-and-evidence.md` → `knowledge/evaluation-and-publication-gates.md`
- Verify claims and policy admission: `knowledge/verification-and-admission.md`
- Leases, retries, cancellation and recovery: `knowledge/durable-execution-and-recovery.md`
- Jev decisions and workers: `knowledge/jev-decisions-and-workers.md`
- Agent skills and consumer readiness: `knowledge/agent-skills-and-consumer-readiness.md`

Search: `node .agent-docs/cli.mjs search --repo . --query "your terms"` (add `--format json`).
Exact text: `rg -n -i "your terms" knowledge -g "*.md"`.
Run this repository-relative command from the canonical repository root; package identity does not determine its workspace directory.
Concepts describe observed behavior; accepted source decisions remain authoritative. Check cited code/tests before changing behavior.

### Code navigation

Read `docs/agents/CODE-MAP.md` for source entrypoints, interfaces, dependencies, tests, and architecture by module.

- `apps/AGENTS.md`: Executable transports and durable workers.
- `packages/AGENTS.md`: Business algorithms, contracts, adapters, and use-case composition.
- `packages/verification/src/AGENTS.md`: Internal verification algorithm seams.
- `services/AGENTS.md`: Separately deployed conversion and native parser boundaries.
- `docs/tools/AGENTS.md`: Provenance trace tool (SPEC-02) and its tests; standard-library Python.
- `scripts/AGENTS.md`: Experiment commands and the consumer-surface evaluation (`corepack pnpm eval:consumer-surface`); the proof and reconciliation scripts are not in the tree and have no root command.
- `skills/AGENTS.md`: Agent skills for schema navigation, bounded reads, and ingestion.
- `tools/AGENTS.md`: Repository quality and Git-driven maintenance tooling.
- Change an HTTP/MCP/CLI verification surface: contracts → application → api → mcp → cli
- Change locator or evidence verification: verification → verification-evidence-selection → verification-deterministic → verification-semantic
- Debug worker retry or persistence: worker → core → persistence
- Change parsing and conversion: preparation → parser → docling
- Change retrieval or embedding: retrieval → policy
- Find experiment commands: script-experiments
- Change schema workspace, knowledge read, or ingestion: knowledge-db → verification-executor
- Change the Sprint V verification core, component or binding: knowledge-operation-protocol → research-core → knowledge-db-contract → binding-aiengineer-postgres → binding-biotech-graph

### Task routes

- [reference] Current handoff and experiment milestone: `docs/operations/package-cleanup/NEXT-PACKAGE-CLEANUP.md`
- [accepted] Accepted cleanup layout and sequence: `docs/operations/package-cleanup/FINAL-LAYOUT.md`
- [accepted] Runtime, transport, and deployment changes: `docs/architecture/0001-runtime-and-deployment.md`
- [accepted] Preparation pipeline: `docs/architecture/0002-deterministic-preparation.md`
- [accepted] Embedding, retrieval, evaluation: `docs/architecture/0003-embedding-retrieval-evaluation.md`
- [accepted] In-process servers call application; out-of-process callers use KnowledgeClient HTTP: `docs/architecture/0004-transport-call-graph.md`
- Verification behavior and invariants: `docs/verification/README.md`
- Cross-service verification integration: `docs/verification/INTEGRATION-GUIDE.md`
- Authentication, capability admission, parser isolation: `docs/security.md`
- [reference] Current implementation, ownership and remaining cleanup: `docs/architecture/current-state.md`

### Validation

Run from this repository root; choose checks relevant to the change. Commands are documented here, never executed by the documentation updater.

- `./dev check (fast gate) and ./dev check --full (what CI runs)`
- `corepack pnpm verify`
- `Gates: tools/quality/README.md`
- `corepack pnpm test:maintenance && corepack pnpm test:context`

Documentation: `node .agent-docs/cli.mjs check --repo .`; refresh with `node .agent-docs/cli.mjs build --repo .`. Edit `.agent-docs/config.json` to change this guide.

[Docs index]|root:.
|docs/architecture:{0001-runtime-and-deployment.md,0002-deterministic-preparation.md,0003-embedding-retrieval-evaluation.md,0004-transport-call-graph.md,current-state.md}
|docs/operations/package-cleanup:{FINAL-LAYOUT.md,NEXT-PACKAGE-CLEANUP.md}
|docs:{security.md}
|docs/verification:{INTEGRATION-GUIDE.md,README.md}
<!-- END GENERATED: agent-docs -->
