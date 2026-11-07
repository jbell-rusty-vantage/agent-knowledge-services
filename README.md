# Shared Knowledge Services

Canonical checkout: `BellLabs/platform/knowledge-services`. This is the shared modular service foundation; existing `@aiengineer/*` package identities and the pinned AI Engineer database binding remain in place. Biotech's native domain service is a separate repository at [`../../biotech/biotech-knowledge-services`](../../biotech/biotech-knowledge-services). See [service boundaries](knowledge/service-boundaries.md) for the implemented surfaces and the accepted direction for separating platform, domain and product responsibilities.

TypeScript monorepo for **knowledge preparation, retrieval, evidence, evaluation, publication, and verification**. Transports are HTTP, MCP, CLI, and A2A. Durable workers and isolated parsers sit beside them. Cross-repository callers use published contracts — they do not import algorithm packages.

This repository is the knowledge-services half of the AI Engineer flywheel: research becomes captured bytes, captured bytes become verified claims, verified claims become admitted knowledge, and admitted knowledge becomes retrievable evidence. The same surfaces are meant to travel. A mission-completing agent — here or in another environment — should be able to acquire sources, verify them, ingest what they support, and retrieve what they published, without owning a second knowledge stack.

AI Engineer product context: [vision](../../aiengineer/ai-engineer-meta/docs/product/00-vision.md) and [north-star path](../../aiengineer/ai-engineer-meta/docs/product/11-north-star-path.md). Official knowledge comes from the research / ingestion flywheel into a proprietary KB. Surfaces are designed **MCP, Agent Skill, CLI, and A2A first**. This product context does not transfer product/user API ownership to the platform repository.

Repository: public [`jbell-rusty-vantage/agent-knowledge-services`](https://github.com/jbell-rusty-vantage/agent-knowledge-services), `main` only; history starts at the 2026-11-06 clean-slate baseline ([repository history](docs/REPOSITORY-HISTORY.md)).

Working-copy explanations of observed behavior live in [`knowledge/`](knowledge/index.md). Start there when you need a concept, not a file dump.

For the implemented architecture after 5P, read [current state](docs/architecture/current-state.md) and [technology stack](docs/architecture/technology-stack.md). The [accepted cleanup layout](docs/operations/package-cleanup/FINAL-LAYOUT.md) describes the target; executor folds, `ks jev`, and canonical skill consolidation remain separate work.

## Contents

- [What this is](#what-this-is)
- [What this is not](#what-this-is-not)
- [Two distributions](#two-distributions)
- [Architecture](#architecture)
- [Capabilities and maturity](#capabilities-and-maturity)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Use these services in your own environment](#use-these-services-in-your-own-environment)
- [Research and ingestion loop](#research-and-ingestion-loop)
- [Skills](#skills)
- [Transports](#transports)
- [Deterministic preparation pipeline](#deterministic-preparation-pipeline)
- [Verification and admission](#verification-and-admission)
- [Neighbor systems](#neighbor-systems)
- [Documentation map](#documentation-map)
- [Invariants](#invariants)
- [Validate](#validate)

## What this is

A bounded context that compiles evidence and admits knowledge effects.

Agents and operators do not write SQL into the canonical store, do not treat a model verdict as truth, and do not publish by prompt. They write **intents**. The service:

1. **Captures** source bytes with lineage.
2. **Prepares** representations, documents, and chunks that can be inspected and cited.
3. **Verifies** claims against those bytes — deterministic checks first, semantic judgment after, policy last.
4. **Reads** tenant knowledge through named catalog queries and digestible snapshots.
5. **Ingests** only what a sealed verification run and a pinned snapshot support, as `executor_service`.
6. **Retrieves** from published versions and returns **evidence packets** that can be replayed.
7. **Evaluates** retrieval quality against frozen corpora before a publication pointer moves.

Business rules live in `packages/application` and the algorithm packages. `apps/api` and `apps/mcp` invoke those packages directly. Other repositories call the versioned HTTP contract, `@aiengineer/knowledge-client`, the CLI, or MCP.

## What this is not

- A research agent. Research agents (Eve, Cursor Cloud, Claude Code, Codex) **call** these services. They capture quotes and write intent files; they do not compile bundles or mint verdicts.
- Mission Control. Mission Control **dispatches** verification, classifies retry and cancellation, and owns mission/work-item/attempt rows. Knowledge Services owns algorithms, policy admission, and durable knowledge execution.
- A second schema authority. Canonical migrations, Supabase config, and generated types live in [`ai-engineer-db-contract`](../../aiengineer/ai-engineer-db-contract). This repo consumes a pin.
- A finished flywheel-to-KB product. Schema/read/ingest paths are real and agent-facing; some modules are still **partial**. Verification is engineering-ready for integration; quality promotion remains gated. Preparation preview stops before embed, publish, or canonical writes.

## Two distributions

A bare `knowledge` on `PATH` is not an identity. Run pins and skill manifests name the distribution.

| Distribution | Package | What it exposes | Typical caller |
|---|---|---|---|
| **Sandbox executor** | `@aiengineer/knowledge-verification-executor` | `knowledge-verify` (capture → locate → claims → extract → judge → policy → seal) and a co-hosted `knowledge` bin for schema, bounded reads, ingestion, reports, sources, content links, checkpoints, and recovery | Research agents in sandboxes; local Cursor / Claude Code / Codex MCP |
| **Platform** | `@aiengineer/knowledge-cli`, `@aiengineer/knowledge-mcp`, `@aiengineer/knowledge-api` | Durable operations: verification mutations, retrieval, evaluation, vector stores, promotion. Worker executes queued work | Mission Control, dashboards, operator CLIs, other services |

The executor can run **in-process** against `VERIFY_STORE_DIR`, or **remotely**: the CLI inside a sandbox forwards to `knowledge-verify serve`, and the store, judge credentials, and receipts stay on the host.

```text
sandbox agent                 host / cluster
──────────────                ────────────────────────────
skills + CLI  ──HTTP/MCP──►   verification-executor
                              (store, DB role switch,
                               sealed verify, ingest)
                              ──or──
                              api + worker + mcp
                              (durable operations)
```

## Architecture

```text
                    published contracts
         HTTP / CLI / MCP / A2A / @aiengineer/knowledge-client
                              │
                              ▼
                    packages/application
                              │
     ┌───────────┬────────────┼────────────┬──────────────┐
     ▼           ▼            ▼            ▼              ▼
 sources      preparation       retrieval       verification
 evaluation   policy            knowledge-db    persistence
 core         host              contracts       client / jev
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
     apps/api + mcp + worker          apps/verification-executor
     services/docling                 services/parser
```

| Runtime | Path | Role |
|---|---|---|
| HTTP API | `apps/api` | Versioned Fastify API. Default `HOST=127.0.0.1`, `PORT=4100`. Vercel Fluid or a Node container. |
| MCP | `apps/mcp` | Stateless Streamable HTTP over the same application services. Default port **4101**. Route `POST /mcp`. |
| Worker | `apps/worker` | Durable executor for queued knowledge operations. Always-on container. Requires `WORKER_TENANT_ID`. |
| CLI | `apps/cli` | `ks`: remote `knowledge`/`verify`/`db` commands through the HTTP API, the verification intent pipeline on the local file-store profile, and offline utilities. `pack:sandbox` builds the installable `ks` tarball. |
| Verification executor | `apps/verification-executor` | Sandbox host: `knowledge-verify` plus schema/read/ingest. CLI, HTTP, MCP stdio, MCP Streamable HTTP. Default serve port **4310**. |
| Jev | `apps/jev` | Dedicated `jev` CLI, HTTP/MCP host and bounded child workers over local SQLite; `ks jev` remains reserved for slice 5F. |
| Docling | `services/docling` | Pinned conversion boundary. `docker compose -f services/docling/compose.yaml up -d` → `http://127.0.0.1:5001/health`. |
| Verification parser | `services/parser` | Isolated native PDF/HTML parser for verification projections. Not Docling. |

HTTP, MCP, and the worker do not own business rules. The executor creates its knowledge tools only when a database URL is configured.

## Capabilities and maturity

Honest status from the code map and accepted docs. “Implemented” means the module exists and is tested; it is not a deployment attestation.

| Capability | Owner | Maturity |
|---|---|---|
| Deterministic capture, convert, chunk, preview | `packages/sources`, `packages/preparation`, `packages/application` | Implemented. `vetOnly` / `preparePreview` stop at a review proposal. |
| Embeddings, hybrid retrieval, evidence packets | `packages/retrieval` (search, embeddings, projections and vector-backends submodules) | Implemented with explicit capability limits. Canonical search is pgvector; evaluation uses frozen corpora. |
| Platform verification (`verification.v1`) | `verification*` packages, API, worker | Implemented for Mission Control integration. Quality promotion still gated (see [verification guide](docs/verification/README.md)). |
| Sandbox verification (`knowledge-verify`) | `apps/verification-executor` | Implemented. Agent writes intents; executor compiles and seals. |
| Schema navigation | `packages/knowledge-db/src/schema-workspace`, executor `knowledge schema *` | Implemented. Contract view, not live tenant data. |
| Bounded reads | `packages/knowledge-db/src/db-read`, executor `knowledge db *` | **Partial.** Named-query snapshots work. `retrieval` operations on a read intent are skipped as `RETRIEVAL_UNAVAILABLE`. |
| Canonical ingestion | `packages/knowledge-db/src/ingestion`, executor `knowledge ingest *` | **Partial.** Plan/apply/receipt as `executor_service` exist. Ingestion records `orchestration.operation_intent` / `receipt` and does **not** write `knowledge_service.operation` or an outbox. |
| Agent skills | `skills/` | Eleven root versioned skills plus executor-local `knowledge-verify`. Pin `manifest.json`; eight-skill consolidation and DeepAgents parser conformance remain planned. |
| Evaluation / publication | `packages/evaluation`, `packages/retrieval/src/vector-backends`, platform CLI | Implemented as gates and pointer moves. Real embedding bundles remain `internal_exploratory` until promoted. |

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js **≥ 24** | `package.json` `engines` |
| pnpm **10.34.5** | Corepack (`packageManager`) |
| Postgres / Supabase | Durable API, MCP, worker, and executor knowledge tools. `KS_AIENG_DB_RUNTIME_DSN` |
| [`ai-engineer-db-contract`](../../aiengineer/ai-engineer-db-contract) | Canonical migrations and generated types. Schema workspace fails closed on migration-head mismatch unless an experiment-only stale flag is set. |
| Identity | `KNOWLEDGE_API_IDENTITIES` (token → actor + tenant grants) for the platform API |
| Optional conversion | Docker Docling on port 5001; Unstructured keys if that adapter is admitted |
| Optional verification parser | Built image + `VERIFICATION_PARSER_IMAGE_DIGEST` |
| Optional live models | `AI_GATEWAY_API_KEY` (embeddings / judge); `FIRECRAWL_API_KEY` (executor capture; HTTPS GET is the fallback) |

`corepack pnpm verify` does **not** require live web, Docling, or Gateway. CI uses captured text and deterministic fakes.

Do not load a full `.env` into a shell you will paste from. Export only the variables a profile needs. Never print grants, PEMs, or tokens.

## Quick start

From this repository root:

```bash
corepack pnpm install
corepack pnpm verify          # format, lint ratchet, typecheck, tests, build, boundaries, examples
corepack pnpm dev:api         # http://127.0.0.1:4100
```

Local platform stack (API + worker + MCP):

```bash
corepack pnpm dev:api
corepack pnpm dev:worker
corepack pnpm dev:mcp
```

Offline CLI demo (no API, Docker, or network). It writes reports from a frozen fixture and currently exits `2` with `verification_incomplete` by design — missing full-demo paths are listed in the generated quality-gate record:

```bash
corepack pnpm --filter @aiengineer/knowledge-cli... build
node apps/cli/dist/index.js verify demo diagnostics-companies \
  --dataset diagnostics-companies-v1 \
  --output ./diagnostics-reports
```

Health check once the API is up: `GET /health` → `{ "status": "ok" }`.

Operator procedures, Windows Corepack notes, and verification env profiles: [docs/verification/OPERATOR-RUNBOOK.md](docs/verification/OPERATOR-RUNBOOK.md).

## Use these services in your own environment

Knowledge Services is built to be **called**, not forked. Another team, a sibling agent, or a future mission runtime should take the contracts, the skills, and one of the two distributions — not a copy of `packages/verification`.

What is portable today:

- Versioned skills in `skills/` and the executor-local `knowledge-verify` skill
- The OKF concept bundle in `knowledge/`
- `@aiengineer/knowledge-contracts` and `@aiengineer/knowledge-client`
- HTTP `/v1/*`, platform MCP tools, `ks`, transitional executor `knowledge` / `knowledge-verify`, and dedicated `jev`
- The sandbox tarball from `pnpm --filter @aiengineer/knowledge-verification-executor pack:sandbox`
- Algorithm packages **in this repo** for local `pnpm verify` with fakes

What stays environment-specific:

- The shared Postgres schema (`ai-engineer-db-contract`) and tenant RLS roles (`pipeline_agent`, `app_reader`, `executor_service`)
- Mission Control ownership grants (`attemptId`, `missionId`, `workItemId`) for production platform verification
- Object-store buckets, identity maps, and judge / Firecrawl credentials
- A repo-only tarball without DB, storage, and parser image is **not** a complete production transfer

### 1. Research agents in a sandbox (executor)

This is the path for “I have an agent that must research and ingest, and I do not want credentials inside the sandbox.”

1. Build and pack:

   ```bash
   pnpm --filter @aiengineer/knowledge-verification-executor build
   pnpm --filter @aiengineer/knowledge-verification-executor pack:sandbox
   ```

   The tarball stages `knowledge-verify`, the `knowledge` bin, and the required skills (`schema-explore`, `knowledge-db`, `knowledge-ingest`, `knowledge-verification-recovery`, plus `knowledge-verify`). Pack fails if a required skill is missing.

   The platform `ks` tarball is separate (Unit 5C): `pnpm --filter @aiengineer/knowledge-cli... build` then `pnpm --filter @aiengineer/knowledge-cli pack:sandbox` writes `apps/cli/dist/sandbox/ks-<version>.tgz` with the `platform-cli` skills and `zod` as its only runtime dependency. It runs remote commands against an API URL and bearer, and the intent pipeline offline on its local profile (`ks verify capture|chain|artifact …`); the executor tarball above stays until 5H.

2. On the **host**, serve the executor (store and credentials stay here):

   ```bash
   node apps/verification-executor/dist/index.js serve --port 4310
   ```

3. In the **sandbox**, install the tarball (or point a local CLI at the host) and set:

   | Variable | Purpose |
   |---|---|
   | `VERIFY_EXECUTOR_URL` | Remote `knowledge-verify` (example `http://host:4310`) |
   | `KNOWLEDGE_EXECUTOR_URL` / `KNOWLEDGE_EXECUTOR_TOKEN` | Remote `knowledge` schema/read/ingest |
   | `VERIFY_EXECUTOR_TOKEN` | Bearer for HTTP |

4. Point the agent at the skills. The agent’s job is to **capture sources, choose exact quotes, and write intent files**. The executor compiles intents, runs `@aiengineer/knowledge-verification`, and never trusts agent-supplied digests, bundles, or verdicts.

5. MCP options:

   - Streamable HTTP: `knowledge-verify serve` → `POST /mcp` (`verify_*` plus `schema_*` / `db_*` / `ingest_*` when a DB URL is set)
   - stdio for Cursor / Claude Code: `knowledge-verify mcp-stdio`

Executor capture then claims:

```bash
knowledge-verify capture "https://example.com/docs" --run "$RUN" --capture-id cap-primary
knowledge-verify locate cap-primary "<exact quote>"
knowledge-verify verify-claims 30-claims-intent.json --run "$RUN"
knowledge-verify judge --run "$RUN"
knowledge-verify policy --run "$RUN"
knowledge-verify seal --run "$RUN"
```

Exit codes: `0` command and quality gate passed · `1` command succeeded but the gate failed · `2` usage, network, auth, or executor error. Every command prints one JSON document; `--out <file>` writes the document and prints a compact summary.

Full surface table: [apps/verification-executor/README.md](apps/verification-executor/README.md).

### 2. Platform API from another service

Use this when you already have (or will run) API + worker, and the caller is Mission Control, a dashboard, or another backend.

1. Consume **`@aiengineer/knowledge-client`** and **`@aiengineer/knowledge-contracts`**. Do not import `@aiengineer/knowledge-verification` or other workspace algorithm packages.
2. Authenticate with `Authorization: Bearer`, send `x-tenant-id`, and use idempotency keys on mutations.
3. Treat mutations as **202 + poll**. Poll `GET /v1/verification/operations/{id}` (or the receipt `statusUrl`) until a terminal state, then GET the family resource (claims, report, extraction, …).
4. On the production ownership path (`VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON`, required when `VERIFICATION_CLAIMS_ENABLED=1`), the caller must present `attemptId` + `missionId` + `workItemId` that match a grant and existing orchestration rows.

```ts
import { KnowledgeClient } from "@aiengineer/knowledge-client";
```

OpenAPI: `packages/contracts/generated/openapi.json`. Integrator details: [docs/verification/INTEGRATION-GUIDE.md](docs/verification/INTEGRATION-GUIDE.md).

CLI against a running API:

```bash
export KNOWLEDGE_API_URL=http://127.0.0.1:4100
export KNOWLEDGE_API_TOKEN=...
corepack pnpm --filter @aiengineer/knowledge-cli dev -- verify citations \
  --context '<OperationContext>' \
  --input '<VerifyClaimsRequest>' \
  --wait
```

After build: `node apps/cli/dist/index.js <group> <command…> ...` (`ks --help` lists them).

### 3. Skills in Cursor, Claude Code, or Codex

`skills/` is the source of truth for eleven root versioned skills; the executor-local `knowledge-verify` skill is additional. Consumers pin a released version. You may add runtime-specific wrapper instructions. You **must not** fork authority, evidence, tenant, or publication semantics.

```bash
node skills/check.mjs          # exit 1 on drift, 2 if a catalog source cannot be read
node skills/check.mjs --json   # per-skill digests for a run pin
```

The check reads the implemented catalogs (executor operation registry and MCP, platform `CLI_COMMANDS`, platform MCP tools) and fails when a skill names an unimplemented or unsupported command.

It does not currently prove DeepAgents metadata-parser conformance: five skill files lack `name:`. The [agent-skills concept](knowledge/agent-skills-and-consumer-readiness.md) separates current catalog checks from the proposed Unit 6 loader and installed-bundle gates.

Install pattern:

1. Copy or submodule `skills/` into the host’s skill directory (Cursor `.cursor/skills`, Claude Code `.claude/skills`, Codex skill slots).
2. For sandbox research, also install `apps/verification-executor/skills/knowledge-verify/` — that skill is **not** in the root `manifest.json` id list; it ships with the executor tarball.
3. Pin the digest from `node skills/check.mjs --json` on the run. Digests hash sorted relative paths over `SKILL.md` and every reference file.
4. Name the **distribution** in the run pin (`executor-cli` / `executor-mcp` vs `platform-cli` / `platform-mcp`).
5. Optionally copy `knowledge/` so agents can read concept pages instead of inferring architecture from code.

A2A admission exists on the platform API (`POST /v1/a2a/tasks`, signed callbacks). Task kinds map onto operation kinds (`document_preparation` → `transformation`, and so on). See [docs/security.md](docs/security.md) for callback signing.

### 4. Bring your own research corpus

You do not have to use AI Engineer YouTube starters. The same loop works on any corpus you are willing to capture and cite:

1. Discover and vet sources (`knowledge-acquisition-and-vetting`).
2. Capture **inside** the executor so quotes bind to immutable bytes (`knowledge-verify capture` / `capture-file`).
3. Write claims and extraction intents against exact, unique quotes (`normalization: none`).
4. Seal the run. Ingest only from that seal plus a persisted `knowledge-read-intent.v1` snapshot.
5. Promote and publish only after evaluation. Retrieval then returns packets, not unsupported answers.

CI in this repo uses versioned embedding bundles from the sibling research-starter repository as **fixtures**. That is a test convenience, not a product requirement.

## Research and ingestion loop

This is the loop a mission-completing agent should follow. Skills name the procedure; the executor or platform executes it.

```text
schema-explore
    → find named queries, vocab, proposal kinds
knowledge-acquisition-and-vetting
    → discover / import / vet; preserve untrusted attempts
knowledge-verify                          (sandbox)
    or knowledge-verification             (platform)
    → capture → locate → verify → judge → policy → seal
knowledge-db
    → knowledge-read-intent.v1 snapshot (persist) at knowledge head
knowledge-ingest
    → plan → apply → receipt; re-read to verify
knowledge-preparation-and-promotion
    → convert / chunk / content links / promotion propose + review
vector-store-management
    → ingest documents; submit publish / rollback; poll operation status
knowledge-retrieval-and-evidence
    → validated plan → search → evidence packet → citation replay
knowledge-evaluation
    → reviewed cases, ablations, release recommendation
knowledge-verification-recovery
    → on failure: observe → case → probe / plan / repair
      (do not resubmit the unchanged input)
```

Concept pages for the same loop:

| Need | Read |
|---|---|
| Which surface owns the work | [knowledge/service-boundaries.md](knowledge/service-boundaries.md) |
| Schema → snapshot → ingest | [knowledge/schema-read-and-ingestion.md](knowledge/schema-read-and-ingestion.md) |
| Capture → prepare → publish | [knowledge/preparation-and-publication.md](knowledge/preparation-and-publication.md) |
| Search and citation replay | [knowledge/retrieval-and-evidence.md](knowledge/retrieval-and-evidence.md) |
| Claims and admission | [knowledge/verification-and-admission.md](knowledge/verification-and-admission.md) |
| Leases, retries, repair | [knowledge/durable-execution-and-recovery.md](knowledge/durable-execution-and-recovery.md) |

Search the bundle from this repo root:

```bash
node .agent-docs/cli.mjs search --repo . --query "admission"
node .agent-docs/cli.mjs search --repo . --query "retry cancellation" --format json
```

### Safe ingest sequence

Do not invent table names or write SQL. The playbook is:

1. `knowledge schema manifest` — confirm `headMatches: true`.
2. `knowledge schema search` then `schema get` (domain page before relation; ≤ 4 reads).
3. `knowledge db read-intent` with `persist: true`. Retain `snapshotDigest`, `knowledgeSeq`, artifact ids.
4. Compose `knowledge-ingestion-intent.v1` from the **sealed** verify run and that snapshot. Planning writes nothing canonical.
5. `knowledge ingest apply` once. Identical replay is idempotent (`duplicateOf`). Do not mint a new `intentId` after a lost response — ask for the receipt.
6. Re-read. The receipt is authority for an uncertain apply; a snapshot is not proof that a write committed.

```bash
knowledge schema manifest
knowledge db head
knowledge db read-intent 05-read-intent.json --persist --out 06-snapshot.json
knowledge ingest plan 80-ingestion-intent.json --out 81-plan.json
knowledge ingest apply 80-ingestion-intent.json --out 82-receipt.json
knowledge ingest receipt <receiptId>
```

## Skills

Canonical catalog: [`skills/README.md`](skills/README.md) and [`skills/manifest.json`](skills/manifest.json).

| Skill | Surfaces | Use when |
|---|---|---|
| `schema-explore` | executor | You need the table, named query, vocab, or proposal shape. Does **not** query tenant data. |
| `knowledge-db` | executor | You need a reproducible snapshot an ingest intent can cite. Does **not** write canonical data. |
| `knowledge-ingest` | executor | You have a sealed verify run + snapshot and need plan/apply/receipt, reports, or content links. Agents do not write SQL. |
| `knowledge-acquisition-and-vetting` | executor, platform | Unknown source; preserve untrusted attempts; vet before capture. |
| `knowledge-preparation-and-promotion` | executor, platform | Convert, chunk, link content, **propose** promotion. Does not select or activate a publication pointer. |
| `knowledge-verification` | platform | Admitted platform verification (claims, report, benchmark, replay, adjudication). Do not mix with `knowledge-verify` in one run. |
| `knowledge-verification-recovery` | executor, platform | Terminal verification failure. Recovery is not “retry unchanged.” |
| `knowledge-retrieval-and-evidence` | platform | Answer against a **published** scope with replayable packets. |
| `knowledge-evaluation` | platform | Pre-publication quality gates and release **recommendations**. Does not move the pointer. |
| `vector-store-management` | platform | Store lifecycle, document ingest, submit publish/rollback. Poll `operation status`. |
| `jev-system-one` | Jev CLI, HTTP, MCP | Closed-choice judgments with captured inputs and bounded process workers; caller owns thresholds and escalation. |
| `knowledge-verify` | executor only | Sandbox research capture → seal. Canonical path: `apps/verification-executor/skills/knowledge-verify/`. |

The planned eight-skill consolidation follows the remaining transport folds. See [agent skills and consumer readiness](knowledge/agent-skills-and-consumer-readiness.md); older internal-fallback proposals do not establish today's delivery order.

MCP and CLI skills share one rule: no raw SQL beyond the guarded read-only capability, no secrets, no private bucket listing, no direct vector writes, no self-approval, no publication from the skill itself.

## Transports

| Transport | Contract | Notes |
|---|---|---|
| **HTTP** | `/v1/*` | Cross-repo default. OpenAPI in `packages/contracts/generated/openapi.json`. |
| **MCP (platform)** | `POST /mcp` on `apps/mcp` | Allow-listed `knowledge_*` and `verify_*` tools, with names matching the `ks` command groups. The former dotted and `knowledge_verify_*` names have no aliases. Forbidden: `raw_sql`, `secret.read`, `publication.publish`, and the rest of `FORBIDDEN_MCP_CAPABILITIES`. |
| **MCP (executor)** | `POST /mcp` or `mcp-stdio` | `verify_*` plus generated `schema_*` / `db_*` / `ingest_*` / … from one operation registry. `knowledge ops` prints the catalog; do not hand-write an operation list. |
| **CLI** | `ks` / executor `knowledge` and `knowledge-verify` | `ks` calls the HTTP API and runs the intent pipeline on its local profile, never falling back between them. The executor CLI (until 5H) can be local or remote. |
| **A2A** | `POST /v1/a2a/tasks`, `POST /v1/a2a/callbacks` | Async admission + signed callbacks. |

Representative platform HTTP families (see OpenAPI for the full set): `/v1/sources:discover`, `/v1/captures`, `/v1/transformations`, `/v1/documents`, `/v1/chunk-previews`, `/v1/chunk-sets`, `/v1/embedding-runs`, `/v1/vector-stores`, `/v1/retrieval-runs`, `/v1/evidence-packets/{id}`, `/v1/verification/*`, `/v1/operations/{id}`, `/v1/a2a/tasks`.

## Deterministic preparation pipeline

Implemented as focused submodules in the merged packages. Accepted design: [docs/architecture/0002-deterministic-preparation.md](docs/architecture/0002-deterministic-preparation.md).

| Package | Role |
|---|---|
| `packages/core` | Content-addressed artifacts and operation lifecycle primitives |
| `packages/sources` | Admitted acquisition contracts, SSRF-safe HTTP, deterministic fakes; npm name remains `knowledge-acquisition` |
| `packages/preparation/src/conversion` | Deterministic text / transcript / Markdown / HTML; Unstructured and Docling adapters |
| `packages/preparation/src/documents` | Immutable structural nodes and verifiable locators |
| `packages/preparation/src/chunking` | Admitted profiles, reconstructable spans, quality checks, duplicate / boilerplate handling |
| `packages/retrieval/src/projections` | Evidence-validated procedures for public domains and source-native sections |
| `packages/application` | `vetOnly` and `preparePreview` orchestration |

`preparePreview` **does not** embed, publish, or write canonical records. It stops at a curation proposal. Publication is a later, evaluated pointer move.

`knowledge-testkit` discovers and validates the versioned embedding bundles from the sibling research-starter repository. CI uses their captured text and fakes; it does not require arbitrary live web access.

Admitted local profiles and Gate 3–6 catalogs: [`catalog/README.md`](catalog/README.md), `catalog/capability-profiles.v1.json`.

## Verification and admission

Verification is an **evidence compiler**, not a confidence score. For every candidate it asks five questions **in order**. Later stages may add restrictions; they must not reverse an earlier deterministic failure.

1. Capture integrity
2. Selector integrity
3. Mechanical correctness
4. Semantic support
5. Policy admission

Keep **execution state** (`queued` | `running` | `needs_review` | `quarantined` | `succeeded` | `failed` | `cancelled`) separate from **admission disposition**. Mission Control `completed` + `review_required` is successful execution with a held result, not an infrastructure failure.

A seal is not admission. A high retrieval score is not proof. Abstention is a valid outcome. Semantic judgment cannot override a mechanical failure.

Guide: [docs/verification/README.md](docs/verification/README.md). Recovery: [docs/verification/OPERATOR-RUNBOOK.md](docs/verification/OPERATOR-RUNBOOK.md). Knowledge admission boundary: [docs/verification/KNOWLEDGE-ADMISSION.md](docs/verification/KNOWLEDGE-ADMISSION.md).

## Neighbor systems

| System | Relationship |
|---|---|
| [`ai-engineer-db-contract`](../../aiengineer/ai-engineer-db-contract) | Canonical shared schema. KS consumes the pin. Do not add app-local migrations or generated `Database` types. |
| [`mission-control`](../mission-control) | General mission runtime, scheduling and dispatch. KS owns its algorithms, admission and durable knowledge execution; this relationship does not certify every proposed integration. |
| [`research_starter_pre_research_agent`](../../aiengineer/research_starter_pre_research_agent) | Transcript-grounded pre-research packets and deterministic apply to `research_*` tables. Supplies embedding-bundle fixtures to this repo's testkit. Not the same path as canonical KB ingestion. |
| [`biotech-knowledge-services`](../../biotech/biotech-knowledge-services) | Separate Biotech domain ingestion, graph and API contracts. A similarly named service does not share the AI Engineer schema authority. |
| [`aiengineer`](../../aiengineer) and [`biotech`](../../biotech) | Domain application, product/user API and architecture homes. Resolve actual applications from each domain's guide; domain products consume published knowledge contracts. |

`ai-engineer-mission-control` and `research_ingestion_systems_agent` are retired, absent repositories. Older readiness/fixture documents naming them are historical evidence, not runnable entrypoints. A replacement consumer/harness requires explicit ownership and contract qualification; do not create or automatically repoint one.

## Documentation map

| Document | When to open it |
|---|---|
| [`knowledge/index.md`](knowledge/index.md) | Concept-first orientation (OKF bundle) |
| [`AGENTS.md`](AGENTS.md) | Agent navigation, rules, validation commands |
| [`docs/agents/CODE-MAP.md`](docs/agents/CODE-MAP.md) | Modules, entrypoints, interfaces, tests |
| [`docs/specs/belllabs-knowledge-platform/README.md`](docs/specs/belllabs-knowledge-platform/README.md) | Authorized platform direction, domain boundaries and implementation packet |
| [`docs/architecture/0001-runtime-and-deployment.md`](docs/architecture/0001-runtime-and-deployment.md) | Runtime, transports, deployment baseline |
| [`docs/architecture/0002-deterministic-preparation.md`](docs/architecture/0002-deterministic-preparation.md) | Preparation pipeline |
| [`docs/architecture/0003-embedding-retrieval-evaluation.md`](docs/architecture/0003-embedding-retrieval-evaluation.md) | Embeddings, retrieval, evaluation gates |
| [`docs/architecture/0004-transport-call-graph.md`](docs/architecture/0004-transport-call-graph.md) | Accepted in-process transport and external client boundary |
| [`docs/verification/README.md`](docs/verification/README.md) | Verification architecture and acceptance state |
| [`docs/verification/INTEGRATION-GUIDE.md`](docs/verification/INTEGRATION-GUIDE.md) | Headers, 202 polling, typed client, ownership grants |
| [`docs/verification/OPERATOR-RUNBOOK.md`](docs/verification/OPERATOR-RUNBOOK.md) | Local proofs, env, incidents |
| [`docs/verification/DEPLOYMENT.md`](docs/verification/DEPLOYMENT.md) | Deploy and rollback |
| [`docs/security.md`](docs/security.md) | Auth, capability admission, parser isolation, callback signing |
| [`docs/operations/runbooks.md`](docs/operations/runbooks.md) | Worker leases, callbacks, containment |
| [`apps/verification-executor/README.md`](apps/verification-executor/README.md) | Sandbox executor and knowledge co-host |
| [`apps/cli/README.md`](apps/cli/README.md) | Offline demo and attestation utilities |
| [`skills/README.md`](skills/README.md) | Skill catalog, distributions, conformance |
| [`catalog/README.md`](catalog/README.md) | Capability profiles and evaluation receipts |
| [`docs/operations/package-cleanup/README.md`](docs/operations/package-cleanup/README.md) | Cleanup archive and current handoff |
| [`docs/operations/package-cleanup/UNIT-5-SLICES.md`](docs/operations/package-cleanup/UNIT-5-SLICES.md) | Proposed executor folds and Jev consolidation |
| [`docs/operations/code-quality-and-delivery-process.md`](docs/operations/code-quality-and-delivery-process.md) | Proposed review and delivery workflow; active quality gates remain in `tools/quality/README.md` |
| [`packages/verification/CAPABILITIES.md`](packages/verification/CAPABILITIES.md) | Verification library capability matrix |
| [`apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md`](apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md) | Executor acquisition and public-surface limits |
| [`docs/architecture/modules/jev.md`](docs/architecture/modules/jev.md) | Current Jev service, APIs and workers |
| [`docs/architecture/technology-stack.md`](docs/architecture/technology-stack.md) | Pinned technology stack and runtime definitions |
| [`docs/operations/agent-maintenance.md`](docs/operations/agent-maintenance.md) | Git-driven maintenance and existing test evidence |

Secondary guides stay registered for freshness checks and module/context discovery even when omitted from the compact AGENTS task routes. Planning, tracker and domain authority links remain in AGENTS' authored planning section.

Refresh generated agent docs after editing `.agent-docs/config.json` or the knowledge frontmatter:

```bash
node .agent-docs/cli.mjs check --repo .
node .agent-docs/cli.mjs build --repo .
```

## Invariants

These are easy to get wrong in a README or an agent prompt. Do not weaken them.

1. **Call the contract.** External agents and repos use HTTP, CLI, MCP, or `@aiengineer/knowledge-client`. They do not import `@aiengineer/knowledge-verification` or other internal packages.
2. **Deterministic failures are monotonic.** Semantic and policy stages cannot reverse a mechanical failure.
3. **Preview is not publication.** `preparePreview` / `vetOnly` stop at a review proposal.
4. **Two verification surfaces.** Platform `ks verify …` (remote) and the intent pipeline (`ks verify capture|chain|artifact …` locally, or sandbox `knowledge-verify`) are not one run.
5. **Ingestion is an intent.** Agents plan and apply through the executor as `executor_service`. A receipt is authority; a row guess is not.
6. **Workspace ≠ database.** Schema workspace is a contract view. Head mismatch fails closed.
7. **Read-intent retrieval is unavailable.** Use the retrieval service. `RETRIEVAL_UNAVAILABLE` is not a negative search result.
8. **MCP is allow-listed.** No secrets, no publication approve, no unbounded SQL.
9. **Tenant isolation.** Auth + tenant/actor context; retrieval filters before candidates. Fail closed.
10. **Do not crawl** `artifacts/`, `outputs/`, `runs/`, caches, receipts, or private vaults. Read a specific artifact only when the task needs it.
11. **Shared schema has one owner:** `ai-engineer-db-contract`.
12. **Evaluation labels are not planner inputs.** A poisoned label must not change a retrieval packet.
13. **Docling and the verification parser are different routes.** Verification selectors do not shell out.
14. **Secrets never appear** in receipts or logs for embeddings or judges.

## Validate

From this repository root:

```bash
corepack pnpm verify
```

That is `typecheck && test && build` via Turborepo. Serial form if the host is contended:

```bash
corepack pnpm exec turbo run typecheck test build --concurrency=1
```

Targeted extras (not required for every change):

```bash
node skills/check.mjs
corepack pnpm --filter @aiengineer/knowledge-verification test
pnpm evaluate:broad                  # frozen evaluation replay
pnpm test:live:gateway               # live embeddings; needs credentials
```

Deployment status is not inferred from this README, a git marker, or a passing `verify`. See the verification and operations docs for rollout state.
