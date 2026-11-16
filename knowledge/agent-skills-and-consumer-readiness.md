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
| Research method: leads, capture, claims, verification, handback | knowledge-research | Names tools of both servers and says what does not exist; external search tools are attached by the consumer. |
| Schema meaning, snapshot, deterministic write | schema-explore, knowledge-db, knowledge-ingest | Executor registry until database-group folding. |
| Source capture and preparation | knowledge-acquisition-and-vetting, knowledge-preparation-and-promotion | Check each procedure's executor or platform binding. |
| Search and evaluation | knowledge-retrieval-and-evidence, knowledge-evaluation | Platform `ks` and grouped MCP tools. |
| Verification | knowledge-verification, executor knowledge-verify | Preserve the difference between platform operation and executor run. There is no separate recovery skill: it was folded into knowledge-verification, and SV-17 retired the executor's recovery operations. |
| Vector-store operations | vector-store-management | Publication is separately authorized; no MCP publication grant. |
| Closed-choice judgment | jev-system-one | Dedicated Jev service and `jev` binary; `ks` has no `jev` group. |

The [application catalog](../packages/application/src/operations/catalog.ts) records current bindings and exclusions. Pin the distribution and materialized skill bytes in each run. A skill referring to another distribution is not proof the installed binary contains that command.

## What the current checker proves

[`skills/check.mjs`](../skills/check.mjs) compares declared operations and command/tool references against implemented catalogs and emits aggregate skill-content digests. It also fails when a `SKILL.md` has no frontmatter, no `name`, no `description`, or a `name` that differs from its directory; the five skills that lacked `name:` gained it on 2026-11-15 (for example, [retrieval frontmatter](../skills/knowledge-retrieval-and-evidence/SKILL.md)). It does not run the DeepAgents metadata parser, so a checker pass is necessary for loader conformance and does not prove it.

An agent without a filesystem reads the same files through the guide: the MCP tool `knowledge_guide` on the platform and executor servers, `GET /v1/guide[/topic]` and `ks guide [topic]`, all answered by [one module](../packages/contracts/src/operations/guide.ts) from pages [bundled into the contract package](../packages/contracts/scripts/generate-guide-pages.mjs). The start page lists the jobs with the skills of `manifest.json` `guide.jobs` and the tools the servers register; the checker fails when a job names a skill or tool that does not exist, when an executor or Jev tool belongs to no job, and when the bundle differs from the skills directory. [`knowledge-research`](../skills/knowledge-research/SKILL.md) is the research method and verification procedure, with one playbook per external tool. The [consumer evaluation](../scripts/consumer-surface-eval.ts) (`corepack pnpm eval:consumer-surface`) asks the consumer questions through the MCP and HTTP paths in process and prints a scorecard.

[Unit 6 direction](../docs/operations/package-cleanup/UNIT-6-SKILLS-DIRECTION.md) proposes eight canonical skills, strict metadata, per-file byte digests, package-contained links, source/installed-bundle checks and zero parser skips. `knowledge-research` is shipped; the other seven target names are not, and the skills they would replace keep today's names. The publication/read-side merge, the place of the executor's `knowledge-verify` and some skill decomposition details still need their bounded implementation specification.

## DeepAgents integration belongs to its consumer

[Readiness DR1-DR5](../docs/operations/package-cleanup/DEEPAGENTS-READINESS.md) historically placed the runner in `research_ingestion_systems_agent/agents/deepagents-stage`. That repository is retired and absent from BellLabs; the path is historical evidence, not an executable consumer. No replacement runner is established by this concept. A future consumer owns model routes, skill IDs/digests, MCP grants, custody and sync/async child configuration. KS owns public service contracts and conformance of its distributed skills. See the [current neighbor map](../README.md#neighbor-systems).

The seven-stage fixture and full async integration are not proven by an installed CLI smoke test. Local LangGraph state uses a separate database; it does not appropriate the populated shared Supabase schema. Follow the readiness gates before claiming real fixture acceptance, and preserve historical Eve work without treating it as the current fixture harness.
