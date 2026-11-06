<!-- BEGIN GENERATED: semantic-map -->
## Code navigation: skills

Agent skills for schema navigation, bounded reads, and ingestion.

Full interfaces, dependencies, tests, and architecture: [semantic map](../docs/agents/CODE-MAP.md). Paths in the rows below are repository-relative.

| Module | Responsibility | Enter |
|---|---|---|
| [skill-schema-explore](../docs/agents/CODE-MAP.md#skill-schema-explore) | Progressive-disclosure procedure for navigating the pinned schema workspace without querying the database. | skills/schema-explore/SKILL.md |
| [skill-knowledge-db](../docs/agents/CODE-MAP.md#skill-knowledge-db) | Procedure for catalog reads and reproducible knowledge-read snapshots that an ingestion intent can cite. | skills/knowledge-db/SKILL.md |
| [skill-knowledge-ingest](../docs/agents/CODE-MAP.md#skill-knowledge-ingest) | Procedure for composing, planning, applying, and verifying knowledge-ingestion intents through the executor. | skills/knowledge-ingest/SKILL.md |
| [skill-knowledge-verification](../docs/agents/CODE-MAP.md#skill-knowledge-verification) | Platform verification procedure with assertion/media routing, admitted operations, held outcomes and audit limits. | skills/knowledge-verification/SKILL.md |
| [skill-knowledge-acquisition-and-vetting](../docs/agents/CODE-MAP.md#skill-knowledge-acquisition-and-vetting) | Source discovery, acquisition, sealed-byte inspection and vetting-proposal procedure across executor and platform surfaces; a fetch, seal or inspection is never admission. | skills/knowledge-acquisition-and-vetting/SKILL.md |
| [skill-knowledge-preparation-and-promotion](../docs/agents/CODE-MAP.md#skill-knowledge-preparation-and-promotion) | Conversion route, node inspection, admitted chunk-profile preview, content linking, embedding and promotion-proposal procedure over already stored bytes; a routing receipt or chunk preview is not admission. | skills/knowledge-preparation-and-promotion/SKILL.md |
| [skill-knowledge-retrieval-and-evidence](../docs/agents/CODE-MAP.md#skill-knowledge-retrieval-and-evidence) | Scoped retrieval planning, search, per-stage explanation, immutable evidence-packet reads and citation replay through the platform CLI and MCP. | skills/knowledge-retrieval-and-evidence/SKILL.md |
| [skill-knowledge-evaluation](../docs/agents/CODE-MAP.md#skill-knowledge-evaluation) | Frozen-version evaluation procedure: reviewed retrieval cases, experiment runs, comparisons and failure diagnosis that recommend, never execute, a knowledge release. | skills/knowledge-evaluation/SKILL.md |
| [skill-vector-store-management](../docs/agents/CODE-MAP.md#skill-vector-store-management) | Store-class-explicit vector-store creation, document addition, evaluation, status, and guarded space publish/rollback submissions through the platform CLI. | skills/vector-store-management/SKILL.md |
| [skill-jev-system-one](../docs/agents/CODE-MAP.md#skill-jev-system-one) | Agent procedure for closed-choice tasks, captured input references, process workers, uncertainty handling and LLM composition. | skills/jev-system-one/SKILL.md |

Descriptions are maintained in `.agent-docs/modules.json` at the repository root. Do not edit this generated block.
<!-- END GENERATED: semantic-map -->
