# Shared Knowledge Services

Follow the [BellLabs owner goal and reporting directive](../../AGENTS.md#owner-goal-and-reporting-directive-2026-10-29). Explain changes through the workflow/agent-configuration gap they close for the Deep Agents-focused Mission Control path, while preserving provider-neutral shared contracts and exact implementation/test/qualification distinctions.

Canonical: `BellLabs/platform/knowledge-services`; `@aiengineer/*` names and the pinned schema binding remain. Use [boundaries](knowledge/service-boundaries.md) and [neighbors](README.md#neighbor-systems) for platform/domain ownership and planned services. Retired `ai-engineer-mission-control` and `research_ingestion_systems_agent` are not entrypoints; do not recreate or repoint them.

Sprint V agents: [start here for repositories, database roles and claim order](../mission-control/docs/specs/provider-consolidation-2026-10/sprint-v/START-HERE.md). The accepted full refactor changes shared operational schema ownership through one explicit cutover; the current binding and target component are distinguished there.

Before editing, run `git status --short`, `git branch --show-current`, and `git worktree list` here. Preserve dirty work; `.git/maintenance/jobs/` worktrees are not the primary source. Edit registered sources and build this repository only. Deeper guides: [README map](README.md#documentation-map), [code map](docs/agents/CODE-MAP.md).

GitHub: public [`jbell-rusty-vantage/agent-knowledge-services`](https://github.com/jbell-rusty-vantage/agent-knowledge-services), `main` only. History starts at the 2026-11-06 clean-slate baseline, so commit IDs and `Overton77/ai-engineer-knowledge-services` links in older documents do not resolve here ([repository history](docs/REPOSITORY-HISTORY.md)).

---

## Engineering planning and delivery

Use the installed Matt Pocock planning skills in `.agents/skills/` and the configured [Linear tracker](docs/agents/issue-tracker.md), [triage labels](docs/agents/triage-labels.md), and [domain documentation](docs/agents/domain.md). The [BellLabs Knowledge Platform specification](docs/specs/belllabs-knowledge-platform/SPECIFICATION.md) and ADRs 0005–0015 are the authorized implementation direction; their existence does not certify delivered behavior. The [Knowledge Machine and Content Machine direction](docs/specs/knowledge-machine-2026-11/DIRECTION.md) (2026-11-02, proposed, owner decisions KM-D1..D11 open) refines that specification with a feature-by-feature current-state cross-reference; read it before the Knowledge Services truth pass. The packet's `CURRENT-STATE.md` is a 2026-10-10 snapshot that predates Sprint V and Sprint OC; use [current architecture](docs/architecture/current-state.md) and live source for present state. Read the [glossary](GLOSSARY.md) and work the native Linear dependency frontier. Preserve existing migration authority until its explicit transition gate. Do not run the complete AI Engineer or Biotech application fixture before every prerequisite of the final acceptance issue passes; component checks remain required during implementation.

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
- `scripts/AGENTS.md`: Explicit proof, evaluation, reconciliation, and experiment commands.
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
