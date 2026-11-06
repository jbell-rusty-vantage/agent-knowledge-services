# Knowledge Services code quality and delivery process

Status: **Proposed workflow; some implementation foundations are already delivered.**

Owner: the main developer. This document records the broader delivery process, not a claim that every control is installed. Q0 delivered formatting, lint and boundary gates; 5P delivered transport structure and parity/error checks. See [current architecture](../architecture/current-state.md) and [quality tooling](../../tools/quality/README.md). Creating or updating this prose does not schedule automatic work.

## Purpose and sequence

Knowledge Services supplies the underlying research and ingestion capabilities used by agents and other clients. Its code must be easy for humans and agents to read, its interfaces must be demonstrable, and its behavior must remain dependable when external providers change or fail.

The earlier [internal fallbacks, inspection, conversion, and application order](internal-fallbacks-and-application-order.md) proposal is historical planning context; consult the [cleanup continuation](package-cleanup/NEXT-PACKAGE-CLEANUP.md), current source and accepted decisions before treating any item as pending. [Conversion route and admitted chunk profiles](conversion-and-chunking.md) retains its own proposal status.

After the current sprint is complete:

1. Establish the completed sprint baseline and inventory every package and app.
2. Review one module at a time with the developer: capture declarative must-haves, verify the implementation, fill agreed gaps, clean the code, and enhance executable exemplars, documentation, and the agent skills that teach callers to use it.
3. Pilot and test the delivery workflow below on a small Knowledge Services change, then make it the default for subsequent changes.
4. Extend the proven process to other codebases, respecting each repository's ownership and conventions.

The main developer can explicitly forego the normal workflow for an individual change. The process must support that choice without requiring a second approver or silently representing skipped work as completed.

## Start after the sprint

Record the sprint completion evidence and the source revision being reviewed. Recheck the working tree and coordinate around remaining active changes; do not reset, sweep unrelated changes into a commit, or refactor unfinished sprint work. A green test run or an old handoff alone does not establish sprint completion.

Read the repository and directory AGENTS.md files, the relevant accepted architecture, the module's code and tests, and the corresponding knowledge explanation together. Record disagreements as decisions to resolve. Use [.agent-docs/modules.json](../../.agent-docs/modules.json) and [CODE-MAP.md](../agents/CODE-MAP.md) for navigation, then verify against actual manifests and immediate source directories.

Initial inventory observed on 2026-09-16; **all items are pending review**:

| Group | Modules |
|---|---|
| Apps | api, cli, mcp, verification-executor, worker |
| Packages | acquisition, application, chunking, client-typescript, config, contracts, conversion, db-read, documents, domain, embeddings, evaluation, ingestion, observability, persistence, policy, projections, retrieval, runtime, schema-workspace, testkit, vector-backends, verification |

Refresh this inventory when work begins. No package is exempt because it is small, internal, or primarily configuration. Include relevant separately deployed services and scripts when a reviewed flow depends on them; keep their ownership explicit. Choose review order by dependency and risk, without losing full inventory coverage.

## Repeatable module review

Maintain one review record per package/app. It can live beside the owning documentation and link to code, examples, and test results rather than duplicate them.

### 1. Capture declarative must-haves

Let the developer describe what must be true in plain language before selecting implementation details. Turn each requirement into a stable ID and observable acceptance criteria. Distinguish developer requirements from agent suggestions; do not invent product requirements to fill an empty template.

```text
Module and reviewed revision:
Purpose, owner, callers, and supported interfaces:
Affected agent skills, consumer wrappers, references, examples, and templates:
Requirement ID and developer's must-have:
Given / when / then acceptance criteria:
Inputs, outputs, side effects, and invariants:
Normal path, failure path, and recovery expectations:
Provider requirements and fallback restrictions, if applicable:
Evidence: implementation, behavioral tests, and example paths:
Assessment: present / partial / missing / unclear / not applicable:
Agreed change and unresolved decisions:
Validation results and explicitly skipped checks:
Completion status and remaining work:
```

### 2. Check before changing

Trace each must-have through the actual interface, implementation, and meaningful tests. A type declaration or README claim alone is insufficient evidence of implemented behavior. Separate missing behavior from unreadable but functioning code. Implement agreed gaps; clarify only ambiguities that materially affect behavior or ownership.

### 3. Clean and organize

Follow the workspace's [clean-code rules](../../../.cursor/rules/clean-code.mdc), [TypeScript guidance](../../../.agents/skills/typescript-clean-code/SKILL.md), and [codebase design guidance](../../../ai-engineer-meta/.agents/skills/codebase-design/SKILL.md).

Review for descriptive names, coherent files, focused functions, small explicit interfaces, visible dependencies and side effects, clear error handling, and useful comments that explain rationale. Remove proven dead code and unnecessary duplication. Avoid arbitrary splitting and layers that make a reader jump between files to understand one operation. Keep provider details behind appropriate adapters and business decisions in their owning modules.

Preserve behavior during structural cleanup; make intentional behavior changes explicit and validate them separately. A reader should be able to find the entrypoint, follow the normal path, understand failure behavior, and locate the tests without reconstructing the entire repository.

### 4. Create an exemplar file or set of files

Each module needs a readable, runnable demonstration of its intended use. Prefer a small `examples/` directory beside the owning app/package, or an existing equivalent location. State the exact run command, prerequisites, expected output, and what is mocked.

For agent-facing capabilities, mock an agent's intent and decisions while exercising the real supported interface. Demonstrate request construction, response interpretation, failure handling, and any bounded follow-up or recovery. Mock external providers at their adapter boundary with deterministic fixtures so the default example needs no credentials or paid calls. Do not mock away the behavior being demonstrated.

Cross-repository callers use published HTTP/client, CLI, or MCP contracts, not internal algorithm imports. Internal packages can have focused examples using their intended internal API; link them to a caller scenario where useful. Configuration, contracts, and test utilities may use a small consuming example rather than an artificial standalone agent.

Cover at least the normal path and one meaningful failure or fallback. Keep examples typechecked or exercised by an appropriate check so interface drift fails visibly. Live provider smoke tests are a separate, explicitly configured check; successful mocked examples do not prove live integration.

### 5. Update documentation with the change

Every change includes a review of code quality, exemplars, documentation, and affected agent skills. Update affected examples, contracts, README instructions, architecture, knowledge explanations, operational guidance, and skill materials in the same change. If an example, documentation, or skill update is unnecessary, record why; do not generate meaningless edits to satisfy a checkbox.

Edit authored sources, not generated blocks. Register documentation status and routes in [.agent-docs/config.json](../../.agent-docs/config.json); update module ownership and entrypoints in the module manifest when they change. Follow the [documentation maintenance process](../../../ai-engineer-meta/docs/agents/workspace/README.md) to regenerate and check the affected maps. A successful freshness check does not replace a semantic review.

### 6. Enhance and contextualize agent skills

Agent skills that reference Knowledge Services are part of this flow, including the repository's canonical [skills](../../skills/README.md) and consuming repositories' runtime-specific wrappers or instructions. Start with [skills/manifest.json](../../skills/manifest.json), then inventory known consumers using explicit source paths. Map each skill to the capabilities, interfaces, and modules it depends on so a service change triggers review of the relevant instructions. Record consumer ownership and version pins; canonical Knowledge Services semantics remain here rather than being forked into consumer skills.

Enhance each affected skill beyond a command catalog:

- Explain the task context: when to use the capability, prerequisites, required inputs and evidence, expected outcomes, and how it fits into the wider research or ingestion workflow.
- Explain the agent's decisions: which interface or operation to choose, how to interpret results, when to continue, when to stop or escalate, and which bounded recovery or provider fallback is appropriate.
- Supply focused references to authoritative contracts, domain explanations, operational guidance, and relevant provider constraints. Keep the main SKILL.md navigable and place detailed material in linked references; links must remain usable in the distributed skill, not only in a sibling checkout.
- Provide worked examples of realistic agent tasks with requests, representative responses, interpretation, and next steps. Include a normal path and a meaningful failure or recovery path. Reuse maintained module exemplars where distribution permits, and clearly distinguish mocked responses from observed results.
- Where a repeated workflow benefits from runnable scaffolding, provide a custom executable template with explicit inputs, configuration, dependencies, run commands, expected outputs, and extension points. Make templates optional and task-driven; do not manufacture one for every skill. Use supported public interfaces and preserve authorization, evidence, tenant, retry, and cost boundaries.

Keep executable templates deterministic with fixtures by default, label live modes and side effects, and exercise them against the interfaces they teach. Templates should compose service calls rather than duplicate service business logic. Include shipped references, examples, and templates in the release/pin integrity mechanism; inspect and extend existing packaging and checks where needed rather than assuming new files are already covered.

Validate command and tool conformance using the existing `node skills/check.mjs` check, inspect its actual coverage, and add appropriate checks for new references, examples, and executable templates. Conformance alone does not establish that instructions are useful: walk through a representative agent scenario and verify that the skill supplies enough context to choose operations, interpret results, and handle failures. Record the scenario and its outcome.

For changes affecting consumers, identify compatible skill/service versions and coordinate wrapper or pin updates in their owning repositories. Record pending consumer updates explicitly rather than declaring the skill rollout complete. This document proposes that work after the sprint; it does not modify or release skills now.

## External providers and fallback behavior

For each provider-backed capability, record the usual path, provider/API or SDK version assumptions, normalized output contract, supported features, and observed limitations. Firecrawl and Tavily are examples named for this review; this document does not assert which integrations or fallback chains currently exist.

Define and verify:

- Which failures are transient, which are terminal, and which qualify for fallback: timeouts, rate limits, outages, malformed responses, and unsupported capabilities.
- Bounded retries, deadlines, cancellation, concurrency and cost limits, and idempotency where actions have side effects. Respect provider retry guidance when applicable.
- The ordered fallback choices and capability equivalence required for each operation. If no fallback can meet the contract, return a clear failure or explicitly degraded result.
- Preservation of provenance, source identity, evidence quality, tenant boundaries, and admission policy. A fallback must not turn a deterministic verification failure into success or hide reduced guarantees.
- Observable attempts and provider selection, with useful errors and redacted logs. Test primary success, eligible fallback, ineligible fallback, and exhausted recovery using fixtures.

During provider changes, check official provider documentation and release notes against adapters and contract tests. Keep credentialed smoke tests separate and record their environment and result. Assign an owner and review cadence when implementing provider upkeep; no monitoring is configured by this proposal.

## Default delivery workflow

Implement this workflow incrementally and test the controls before treating it as enforced:

| Stage | Expected evidence |
|---|---|
| Sync and branch | Inspect local changes, fetch and update safely from the intended base, and create a focused branch or isolated worktree. Record the baseline. |
| Scope | State requirements, affected modules, callers and agent skills, acceptance criteria, and relevant compatibility or migration concerns. |
| Work | Implement the focused change with readable code, executable examples, documentation, and contextualized skill references and templates reviewed together. |
| Local validation | Run appropriate formatting/lint checks where configured, type checks, behavioral tests, example and template checks, skill conformance, and build checks. Record actual commands and results. |
| Integration validation | Exercise affected real service boundaries in an isolated test environment, including important failure/recovery paths. Distinguish fixture tests from live provider checks. |
| Review | Review the diff against requirements, readability, contracts, examples, docs, affected skill scenarios and consumer pins, test evidence, and operational impact. Use a PR by default; the main developer can self-review. |
| Merge and delivery | Confirm relevant checks against the final revision, merge deliberately, and follow existing deployment/rollback procedures when deployment is in scope. |

The repository-wide command is `corepack pnpm verify`; its current script runs formatting, the lint ratchet, typecheck, tests, build, dependency boundaries and verification examples. Inspect [package.json](../../package.json) when adopting the process. It does not imply every database integration, live provider, skill or documentation check ran. Build an explicit check matrix from existing scripts before adding automation. Shared database schema changes remain owned by `ai-engineer-db-contract`; preserve the populated shared database and use disposable environments for destructive proofs.

Proposed enforcement consists of a concise change/PR template, reliable local commands, CI checks for objective requirements, and documented review criteria. CI can verify runnable examples and documentation freshness; a human or reviewing agent must judge readability and whether the example is useful. Configure branch protections only as part of the later workflow setup, preserving the main developer's override route.

### Main-developer override

The main developer may choose a direct change, omit a branch or PR, or skip particular process checks. An explicit instruction is sufficient; agents should not repeatedly ask for the same authorization. Briefly record the scope, reason, skipped checks, known uncertainty, and any agreed follow-up in the change record or handoff. Report actual validation honestly. Do not disable repository-wide controls permanently to bypass one change.

This is an override of delivery procedure; it does not silently redefine service contracts, tenant isolation, evidence requirements, or ownership of shared data.

## Completion and rollout

A module is complete when its agreed must-haves have evidence, gaps are implemented or explicitly deferred by the developer, code has been reviewed for readability, exemplars and applicable skill templates run, relevant tests pass, and affected documentation and agent skills are current. Skill completion includes reviewed context, usable references, worked examples, scenario validation, and resolved or explicitly deferred consumer updates. Track incomplete modules and waived work visibly.

For the workflow pilot, demonstrate one normal change through branch, implementation, local checks, integration checks, review, and merge. Verify that a failing behavioral check and a stale example/documentation check are detected, and exercise the documented developer override without concealing those failures. Record limitations before expanding enforcement.

Finish the Knowledge Services inventory before declaring its cleanup complete. Carry the process to other repositories afterward, adapting commands and examples to each codebase. The continuing default is: **each change includes clean code, a maintained exemplar, appropriate validation, documentation review, and review of affected agent skills and their supporting materials**, with an explicit developer override when needed.
