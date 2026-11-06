---
type: Service Boundary
title: Execution profiles and transport availability
description: Choose the server, local verification, remote CLI, or transitional executor surface without mistaking a declared operation for an executable capability.
tags: [host, profiles, transports, cli, mcp, capabilities]
aliases: [local mode, remote mode, ks commands, tool availability]
questions:
  - Which commands work offline without a database?
  - Why does an MCP tool return CAPABILITY_NOT_ADMITTED?
  - Does the remote CLI fall back to local execution?
owner: ai-engineer-knowledge-services
implementation_status: partial
decision_status: reference
validation_status: source-and-test-inspected
sources:
  - resource: ../packages/host/src/create-host.ts
    title: Host composition by profile and role
  - resource: ../packages/host/src/local/capabilities.ts
    title: Local operation capability matrix
  - resource: ../packages/application/src/operations/catalog.ts
    title: Operation availability and transport bindings
---

# Choose an execution profile

The operation catalog answers two different questions: whether a capability is implemented and whether this host is authorized and configured to expose it. A tool name or contract type alone answers neither.

| Context | Behavior | Boundary |
| --- | --- | --- |
| Server API, MCP, worker | `createHost({ profile: "server", role })` composes application services and owned resources. | Optional admission, storage, reviewer and provider ports still gate individual operations. |
| Local verification | File-backed intent pipeline, loaded lazily by `ks`. | Offline operations need no database; URL capture, document conversion and semantic judging require explicit provider configuration. |
| Remote CLI | `ks` calls `KnowledgeClient` over HTTP. | Does not load host or fall back locally after an authorization/network failure. |
| Transitional executor | Separate CLI/HTTP/MCP host for schema/read/ingest, custody and recovery. | These groups have not all moved to the platform hosts. |
| Jev | Dedicated `jev` service and client. | `ks jev` is reserved; see [Jev](jev-decisions-and-workers.md). |

Read the [capability matrix](../packages/host/src/local/capabilities.ts), [host entry](../packages/host/src/create-host.ts), and [CLI bindings](../apps/cli/src/ks-commands.ts). The [profile tests](../packages/host/src/tests/local-profile.test.ts) and [matrix tests](../packages/host/src/tests/capability-matrix.test.ts) exercise composition and rejection boundaries.

## Trace a tool before using it

1. Find its row in the [application operation catalog](../packages/application/src/operations/catalog.ts).
2. Check `admission`: admitted, gated, declared, or executor-only. Read any `requires` and transport exclusion reason.
3. Follow the actual API, MCP or CLI binding. Check the execution profile, not just the operation ID.
4. Retain returned operation/run/receipt IDs and use their owning read surface; a submission is not proof of completion.

The 5P MCP names use `knowledge_*` and `verify_*`; old dotted names and `knowledge_verify_*` aliases are absent. The [MCP catalog](../apps/mcp/src/catalog.ts) forbids raw SQL, secret reads, storage listing, publication approval/publication and capability admission. HTTP operator capabilities therefore do not imply equivalent agent tools.

API and MCP call application in process. Protocol error mappings differ intentionally, but authority and business behavior must agree: [catalog parity](../apps/mcp/src/tests/operation-catalog.test.ts), [API/MCP parity](../apps/mcp/src/tests/api-mcp-parity.test.ts), [no HTTP shims](../apps/mcp/src/tests/no-http-shims.test.ts), and [MCP error cases](../apps/mcp/src/tests/golden-errors.test.ts).

## Current and target

5P delivered the application-owned catalog, transport structure and grouped MCP names. Executor folds 5D1–5D3, Jev consolidation 5F, and executor retirement 5H remain separate work under the [accepted layout](../docs/operations/package-cleanup/FINAL-LAYOUT.md). Existing local verification composition still uses the executor's transitional seam. None of these source observations attest deployment or provider reachability.
