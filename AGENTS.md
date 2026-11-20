# Knowledge Services

Shared knowledge machinery for BellLabs: capture and custody, preparation, retrieval, evaluation, verification and policy admission, and durable knowledge execution, served over the API, MCP, CLIs and workers. Mission Control dispatches verification and classifies retry and cancellation; Knowledge Services owns the algorithms, admission and durable knowledge execution. Report against the [owner goal](../../AGENTS.md#owner-goal-and-reporting-directive-2026-10-29) (Deep Agents workflow and agent configuration on the Mission Control path) and keep implemented, tested, integrated and qualified apart.

## Start, act, finish
- `./dev status` orients (branch, dirty files, contract pin, hooks, which local services answer); `./dev doctor` names each fix. `./dev db status|schema|query --plane P` reads a database read-only (`config/planes.toml`, copied from Mission Control; `--plane` is always required, DDL is refused).
- `./dev check` is the fast gate (about 30 s: format, lint ratchet, boundaries, docs, retrieval checks, trace); `./dev check --full` is what CI runs; `./dev test <package> <file>` runs one suite.
- `./dev trace check` before finishing. Every commit ends with `Refs: OVE-n | <FAM>-S<n>` and, when they apply, `Decisions:` and `Docs:`; `./dev trace show <id>` prints the chain ([provenance](docs/agents/REPOSITORY-GUIDE.md#provenance)). The hook and CI warn only.
- Work lands on `main`; commit explicit paths; preserve dirty work (`.git/maintenance/jobs/` worktrees are not the source). Build and edit this repository only.
- What each feature does and the command that proves it: [features](features/README.md#knowledge-services-feature-map). Orientation, history, environment and planning detail: [repository guide](docs/agents/REPOSITORY-GUIDE.md#orientation).

## Boundaries and what enforces them
- **Local by default.** A process with no application named reaches loopback only; `KS_APPLICATION=ai-engineer|biotech` names a remote plane. Enforced by `loadKsDatabaseConfig` (`packages/host/src/config/database.test.ts`) and, for tests and proof scripts, `disposableAdminDsn()` ([ENVIRONMENT](docs/ENVIRONMENT.md#plane-selection)). No remote database in tests; never write the Aura graph `4773dc72`.
- **One reader of database variables.** Only `packages/host/src/config/database.ts` reads `KS_{AIENG,BIOTECH}_DB_*`; no aliases. The same test keeps `config/env.registry.yaml` and `.env.example` in step. `.env` is owner-managed: never edit or print it.
- **Transport and package boundaries.** Handlers share `packages/application`; the API, MCP and workers call it in process (MCP has no API client); out-of-process and cross-repository callers use the published HTTP/client, CLI or MCP contracts, never internal algorithm packages. Enforced by `corepack pnpm boundaries` (dependency-cruiser, in `./dev check`).
- **Schema authority is `aiengineer/ai-engineer-db-contract`.** Consume its vendored pin (`./dev status` shows it); create no other migration or generated-type authority. Enforced by review; the pin is checked in `./dev status`.
- **Verification versus admission.** Execution and policy admission stay separate; semantic judgment never overrides a deterministic failure; captures, selectors, provenance and tenant isolation are immutable. Enforced by `packages/policy/src/verification-policy.test.ts` and `corepack pnpm examples:verification`.
- **Formatting and lint.** Biome (`corepack pnpm format`, never a default prettier) and the lint ratchet; enforced by the pre-commit hook (`node tools/maintenance/cli.mjs install-hooks`) and `./dev check`.
- **Docs stay true.** Generated blocks change only through `.agent-docs/config.json` and `modules.json`, then `node .agent-docs/cli.mjs build --repo .`; `check` runs in `./dev check` and CI. Markdown links are relative with explicit anchors (the workspace `check_links.py`).
- **Bounded search.** Search explicit source paths first; never enumerate artifacts, outputs, runs, receipts, caches, dependencies or private notes. Retired `ai-engineer-mission-control` and `research_ingestion_systems_agent` are not entrypoints.

## Pointers
- Current state: the [state card](../../docs/state/2026-11-15/KNOWLEDGE-SERVICES.md#identity); live work comes from AI Engineer Build 08 ([handoff](../ai-engineer-research-2026-11-02/schema-units/archive/handoffs/NEXT-SESSION-BUILD-08-AFTER-LOOP-8.md)).
- Concepts: [knowledge index](knowledge/index.md#find-the-relevant-concept); code map: [CODE-MAP](docs/agents/CODE-MAP.md); glossary: [GLOSSARY](GLOSSARY.md); the kit: [SPEC-03](../mission-control/docs/specs/agentic-sdlc-2026-11/SPEC-03-REPO-KIT.md#parts).

<!-- BEGIN GENERATED: agent-docs -->
## Repository guide (generated)

Knowledge preparation, retrieval, evidence, evaluation, publication, and verification; API, MCP, CLI, durable workers, and parser boundaries.

Rules, OKF concept routes, code map, task routes and validation: [docs/agents/REPOSITORY-GUIDE.md](docs/agents/REPOSITORY-GUIDE.md#repository-guide). Concepts: `node .agent-docs/cli.mjs search --repo . --query "your terms"`; code map: `docs/agents/CODE-MAP.md`.

Edit `.agent-docs/config.json` to change the guide; `node .agent-docs/cli.mjs build --repo .` regenerates it and `check` reports drift.
<!-- END GENERATED: agent-docs -->
