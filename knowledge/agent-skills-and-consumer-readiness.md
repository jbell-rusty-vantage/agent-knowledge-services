---
type: Service Boundary
title: Agent skills and consumer readiness
description: Pin executable skill procedures to current transports and distinguish the shipped skill catalog from the planned DeepAgents-ready consolidation.
tags: [skills, manifest, deepagents, packaging, consumers, readiness]
aliases: [skill loading, parser conformance, skill bundle, stage configuration]
questions:
  - Which skills are shipped today and which are only planned?
  - Why can a skill checker pass while DeepAgents skips a skill?
  - Who owns an agent stage's skill and MCP permissions?
owner: ai-engineer-knowledge-services
implementation_status: partial
decision_status: reference
validation_status: source-and-test-inspected
sources:
  - resource: ../skills/manifest.json
    title: Current skill IDs and distributions
  - resource: ../skills/check.mjs
    title: Current catalog and digest checker
  - resource: ../docs/operations/package-cleanup/UNIT-6-SKILLS-DIRECTION.md
    title: Proposed canonical skill consolidation
---

# Skills teach procedures; hosts enforce authority

KS owns skill meaning, operation coverage and packaged reference material. A consumer owns which skills and MCP tools a stage receives. A skill's instructions cannot expand tenant scope, publication permission, recovery authority or provider budget.

The current [manifest](../skills/manifest.json) lists eleven root skills across executor, platform and Jev distributions. The executor's [knowledge-verify skill](../apps/verification-executor/skills/knowledge-verify/SKILL.md) is separate. Use the [skill README](../skills/README.md) for the current inventory, not the future eight-skill names in the accepted layout.

## Select by job and surface

| Task | Current skill route | Interface boundary |
| --- | --- | --- |
| Schema meaning, snapshot, deterministic write | schema-explore, knowledge-db, knowledge-ingest | Executor registry until database-group folding. |
| Source capture and preparation | knowledge-acquisition-and-vetting, knowledge-preparation-and-promotion | Check each procedure's executor or platform binding. |
| Search and evaluation | knowledge-retrieval-and-evidence, knowledge-evaluation | Platform `ks` and grouped MCP tools. |
| Verification and repair | knowledge-verification, executor knowledge-verify, knowledge-verification-recovery | Preserve the difference between platform operation and executor run. |
| Vector-store operations | vector-store-management | Publication is separately authorized; no MCP publication grant. |
| Closed-choice judgment | jev-system-one | Dedicated Jev service, not yet `ks jev`. |

The [application catalog](../packages/application/src/operations/catalog.ts) records current bindings and exclusions. Pin the distribution and materialized skill bytes in each run. A skill referring to another distribution is not proof the installed binary contains that command.

## What the current checker proves

[`skills/check.mjs`](../skills/check.mjs) compares declared operations and command/tool references against implemented catalogs and emits aggregate skill-content digests. It does not run the DeepAgents metadata parser. Five current skill files lack `name:`; a checker pass therefore does not prove loader conformance. For example, inspect [retrieval frontmatter](../skills/knowledge-retrieval-and-evidence/SKILL.md).

[Unit 6 direction](../docs/operations/package-cleanup/UNIT-6-SKILLS-DIRECTION.md) proposes eight canonical skills, strict metadata, per-file byte digests, package-contained links, source/installed-bundle checks and zero parser skips. `knowledge-research` is planned, not shipped. The publication/read-side merge and some skill decomposition details still need their bounded implementation specification.

## DeepAgents integration belongs to its consumer

[Readiness DR1-DR5](../docs/operations/package-cleanup/DEEPAGENTS-READINESS.md) historically placed the runner in `research_ingestion_systems_agent/agents/deepagents-stage`. That repository is retired and absent from BellLabs; the path is historical evidence, not an executable consumer. No replacement runner is established by this concept. A future consumer owns model routes, skill IDs/digests, MCP grants, custody and sync/async child configuration. KS owns public service contracts and conformance of its distributed skills. See the [current neighbor map](../README.md#neighbor-systems).

The seven-stage fixture and full async integration are not proven by an installed CLI smoke test. Local LangGraph state uses a separate database; it does not appropriate the populated shared Supabase schema. Follow the readiness gates before claiming real fixture acceptance, and preserve historical Eve work without treating it as the current fixture harness.
