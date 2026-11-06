<!-- BEGIN GENERATED: semantic-map -->
## Code navigation: apps

Executable transports and durable workers.

Full interfaces, dependencies, tests, and architecture: [semantic map](../docs/agents/CODE-MAP.md). Paths in the rows below are repository-relative.

| Module | Responsibility | Enter |
|---|---|---|
| [api](../docs/agents/CODE-MAP.md#api) | Fastify HTTP transport. createApiRuntime composes through createHost (role api) and maps host services onto buildServer. | apps/api/src/index.ts |
| [cli](../docs/agents/CODE-MAP.md#cli) | The ks binary: remote knowledge/verify/db commands call KnowledgeClient over HTTP; the verification intent pipeline runs on host's local file-store profile, loaded lazily; offline demo, attestation and benchmark utilities use application or verification on frozen files. pack:sandbox builds the installable ks tarball. | apps/cli/src/index.ts |
| [mcp](../docs/agents/CODE-MAP.md#mcp) | In-process Streamable HTTP MCP tools. createMcpRuntime composes through createHost (role mcp), which supplies the same knowledge, verify and operations groups as the API role; MCP never calls the API. | apps/mcp/src/index.ts |
| [verification-executor](../docs/agents/CODE-MAP.md#verification-executor) | Sandbox verification executor that also hosts schema, bounded-read, and ingestion operations on CLI, MCP, and HTTP, and serves ks.knowledge_operation.v2 (K01 over the Sprint V application services: register, assess, read, derive, apply, verify, status, cancel, receipt) with K07 issuer-credential validation and durable single-use credentials. | apps/verification-executor/src/index.ts |
| [worker](../docs/agents/CODE-MAP.md#worker) | Durable knowledge-operation execution and activity dispatch over host-composed adapters; verification runtime wiring stays in the worker execution factory. | apps/worker/src/index.ts |
| [skill-verification-executor](../docs/agents/CODE-MAP.md#skill-verification-executor) | Executor capture, quote, claim, extraction, policy and report procedure with a shipped offline CLI scaffold. | apps/verification-executor/skills/knowledge-verify/SKILL.md |
| [jev-service](../docs/agents/CODE-MAP.md#jev-service) | Dedicated Jev HTTP/Streamable HTTP MCP and stdio host, plus HTTP CLI through the public client. | apps/jev/src/index.ts |

Descriptions are maintained in `.agent-docs/modules.json` at the repository root. Do not edit this generated block.
<!-- END GENERATED: semantic-map -->
