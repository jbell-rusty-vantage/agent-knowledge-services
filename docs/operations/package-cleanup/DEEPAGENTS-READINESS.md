# DeepAgents readiness for real KS fixtures

Status: **proposed**, 2026-09-29. Implementation belongs to `research_ingestion_systems_agent/agents/deepagents-stage`, not a KS cleanup slice. One readiness slice per session and branch, `feat/deepagents-dr1-model-routing` through similarly named DR2–DR5 branches. Read that repository's AGENTS.md before implementation. Preserve the uncommitted proof on `exp/deepagents-stage-proof`; establish an integrated baseline explicitly before branching. No code or agents are run by this documentation change.

## Accepted decisions and evidence boundary

Stage agents use TypeScript DeepAgents **1.14.x** on LangGraph. LangGraph Postgres checkpointer and store use local Docker Postgres until a production database arrives, **never the shared Supabase database**. KS fixture databases/storage are separately disposable. LangSmith sandboxes use a pinned Dockerfile snapshot. Skills and MCP servers are assembled separately for every agent from the stage file. Eve remains untouched in its repository and unmaintained for these fixtures; an adapter may come later.

Anthropic, OpenAI and Vercel AI Gateway credentials are available; the gateway's provider breadth is valuable. Never commit credential values. The two fixture compositions are GPT-6 Sol → GPT-6 Luna and Claude Opus 5.5 → Claude Sonnet 5, with a combined $25 ceiling, not $25 each.

Observed evidence: [proof plan](../../../../research_ingestion_systems_agent/DEEPAGENTS_STAGE_PROOF.md), [RESULT.md](../../../../research_ingestion_systems_agent/agents/deepagents-stage/RESULT.md), [proof stage](../../../../research_ingestion_systems_agent/agents/deepagents-stage/stages/proof.stage.json), and `src/config.ts` / `src/compose.ts` beside it. The proof pins 1.14.1, composes a root plus compiled and dict children, and demonstrates inherited child checkpoints, restart, approval/rejection and fork. OpenAI completed; Anthropic was incomplete. KS MCP was skipped. Async execution and the seven-stage fixture below were **not** proven. No raw run-directory crawl is needed to interpret that result.

## Config-driven parent and real children

Interpret the requested “resemblance config” as a stage configuration resembling the research/ingestion mission, extending the existing strict `deepagents-stage.v1` file. It is not an existing library or a new KS-owned configuration authority. Parent and child agents use the same builder: model/route, prompt digest, skill ids/digests, MCP tool allowlists, backend/snapshot, interrupts and structured result schema. No role-specific agent implementation or pretend delegation.

Separate **construction** (compiled graph versus declarative/dict agent) from **execution** (sync versus native async). Require compiled children in both execution modes; dict children can cover small checks but cannot substitute for those proofs. Dynamic subagents are a third facility and remain out of scope.

For sync, build the child's DeepAgent just like the parent, wrap its runnable in `CompiledSubAgent`, and register it in the parent's `subagents`. For async, build the child graph from the same config, register/serve it through an Agent Protocol endpoint and give the parent an `AsyncSubAgent` descriptor pointing at that graph. A `CompiledSubAgent` runnable is not itself an async descriptor. Use explicit HTTP for the proposed TypeScript proof; validate the pinned API and server lifecycle rather than assuming the documentation's co-deployed transport works in this runner. Official references: [subagents](https://docs.langchain.com/oss/javascript/deepagents/subagents), [async subagents](https://docs.langchain.com/oss/javascript/deepagents/async-subagents), [types](https://reference.langchain.com/javascript/deepagents/types).

Proposed schema extension (design sketch, **not valid input to today's v1 parser**):

```json
{
  "name": "research-worker",
  "kind": "compiled",
  "execution": "async",
  "model": "$subagent",
  "systemPromptFile": "prompts/research-worker.md",
  "skills": [{ "id": "ks:knowledge-sources", "sha256": "<manifest-pinned digest>" }],
  "mcp": { "ks": ["<catalog-resolved allowed tool>"] },
  "sandbox": "research-tools",
  "responseFormat": "schemas/research-result.json",
  "asyncBinding": { "graphId": "research-worker", "urlEnv": "DEEPAGENTS_AGENT_PROTOCOL_URL" }
}
```

DR4 chooses a versioned schema, rejects unknown/mixed modes and records resolved registrations. Coordinator-requested custom configurations must be validated against pinned templates, tool/skill grants and budget before compilation; requests cannot expand authority. Parent manifests include every child's effective config digest. Async graph registration must bind to that digest, avoiding mutable graph-id substitution.

## DR1 — model routing and conformance

Use each provider's own LangChain client (`ChatAnthropic`, `ChatOpenAI`); never route non-OpenAI models through the OpenAI-compatible endpoint. Default to the gateway's provider-native route; use direct Anthropic/OpenAI for a model whose gateway route fails conformance. Record model, client/version, route, reasoning settings and prices per model in the run manifest.

For **every (model, route)** used by either composition, prove no-argument tool calls, parallel calls, structured output with tools, accurate streamed usage including cache tokens, pause/resume and reasoning settings. A route with zero/missing usage does not pass merely because a final answer exists. Compare live usage to settled billing; fail closed or select a conformant direct route. If neither passes, that composition is blocked.

Proof findings: the OpenAI-compatible endpoint broke Claude's no-argument tool calls; gateway-native Claude streaming reported zero input tokens and lost cache reads; the conservative estimate stopped a cached Claude run too early. Native routing fixed the first issue, not the other two. Cost truth is gateway billed-generation reconciliation, or direct provider usage multiplied by pinned prices. Exit: four model conformance records, route decisions, price pins and reconciliation evidence; do not assert the current gateway Claude route passes.

## DR2 — KS reachability

Depends on KS **5C–5D3**. Prove the stage parent and sandboxed children reach the folded `ks` service over MCP, HTTP or installed CLI against a disposable KS database/storage target. Remote sandboxes cannot use the operator's loopback address: record a reachable authenticated endpoint and test from inside the sandbox. KS is required, never silently optional as in the proof.

Resolve per-agent subsets from `packages/application/src/operations/catalog.ts` groups (`knowledge`, `verify`, `db`, `operations`, `system`) and pin actual operation ids, transport bindings, profile, admission and required ports. A group is not a blanket grant. Reviewer/publisher authority is enforced by KS; use authorized HTTP/CLI when MCP excludes the operation. Never bypass an exclusion with a broad generic operation-submit tool.

Exit: **DeepAgents smoke against ks**, including a real config-composed parent/compiled sync child, actual service call/receipt and sandbox reachability, denied cross-role mutation, installed CLI smoke and public-contract-only imports. This minimal consumer smoke gates 5H after 5F as well; it does not depend on full DR4 or canonical Unit 6 skills. Use existing compliant pinned skills so there is no 5H → Unit 6 → DR4 → 5H cycle. Recheck it after executor removal. Async topology connectivity is completed with DR4.

## DR3 — durable artifact sharing and reconciliation

Observed problem: page text in one sandbox was invisible to the evidence-checker. One model searched the filesystem until budget exhaustion. Require **every durable agent-produced artifact** to enter KS artifact custody, returning a handle with `id`, `sha256`, `mediaType`, and producer `run`, `thread`, `agent`, `checkpoint`. Temporary scratch files may stay local; durable outputs may not. Check the existing custody contract first; record any missing public capability as a prerequisite, not an invented implemented endpoint.

Children return handles in structured output, never local paths. Siblings, later stages and Mission Control retrieve by handle and verify bytes/digest and authorization. Every stage seal enumerates all handles, including child outputs. A shared LangGraph store alone is not KS custody.

Spike a `CompositeBackend` route `/artifacts/` backed by a custom KS-artifact backend versus explicit register/get tools. First prove a `LangSmithSandbox` default still exposes `execute` through that composite. Compare digest validation, atomic writes, large artifacts, tenant isolation, retry/idempotency and sandbox restart. Record the choice and its failure behavior before building the fixture.

Exit: sandbox producer → sibling checker → later-stage reader receives identical bytes after producer restart/deletion; missing, altered or unauthorized handles fail closed. Define the Mission Control reconciliation bundle: parent and child thread/checkpoint identities + sealed artifact handles + KS receipts/re-read state. A checkpoint proves agent state, a handle proves custody, and a receipt proves a service action; none alone proves acceptance. Record unresolved operations and interrupted/cancelled async children for later reconciliation.

## DR4 — stage graph runner and both delegation modes

Depends on DR1–DR3; canonical fixture materialization also requires Unit 6. Define:

- Graph manifest: stage id, dependencies, input bindings, stage file/digest and composition.
- Stage input manifest: upstream seal digests, question ids, cutoff, pins and remaining budget.
- Stage result seal: run-manifest pin hash, structured result, all handles, receipts, usage and unresolved operations; additionally child config digests, sync checkpoint namespaces and async task/thread/run/checkpoint identities.
- Validator: re-read KS custody, receipts, decisions and publication state, check digests and schema, reject missing/pending/failed children. A final chat message is not acceptance.

Implement `graph status` then `graph next` as **new proposed commands**: validate predecessors, construct/pin inputs, present the next stage and cost ceiling, and launch only after operator confirmation. Ingestion requires both research and report seals. Operator intervention uses approve, reject and fork (the proof currently exposes rejection via `approve --reject`); do not pretend a standalone `reject` command already exists.

Prove one parent genuinely invokes a compiled sync child and a compiled async child built from the resemblance config in **each composition**. Native async must return a task id while the parent can continue; a Promise or parallel blocking `task` calls are insufficient. Exercise native start/check/list/update/cancel lifecycle, retrieve a completed structured result, restart parent and child processes, reattach sandboxes, propagate interrupts and budget, and reject sealing with outstanding children. Verify the pinned 1.14.x exports and endpoint/server support before implementation; no silent version upgrade or sync fallback. Update the proof's built-in tool audit for only the installed native async tools.

Forks must record which async threads are continued, cancelled or replaced, prevent duplicate side effects and preserve original checkpoints. New child configs get new digests/registrations. Persist async identity mappings independently of compacted chat messages. All stages remain sequential even when children within a stage run concurrently.

Exit: validated seven-stage manifests, real sync+async evidence, deterministic rejection cases, restart/intervention/fork evidence and operator-confirmed continuation with no duplicate launch. Runner completion is provisional engineering evidence, not Mission Control Stage Acceptance.

## DR5 — budget and enforced intervention

Calibrate live estimates by settled billed/estimate ratios per model/route, including cached input. Keep safety headroom and distinguish unsettled commitments from available funds. Reserve budget atomically across parent and all sync/async children; stopping a parent must also stop/cancel outstanding paid work. Persist the ledger across resume/fork, avoid double-counting, reconcile delayed charges before releasing reservations, and report sandbox/tool costs separately while keeping total fixture spend inside $25.

Enforce operator constraints through interrupts or tool removal, including newly compiled children and async updates. Prompt text alone failed the proof's “no browser” intervention. Use [stage ceilings](./REAL-FIXTURE-STAGE-GRAPH.md#budget-and-run-order); the $3 reserve requires a recorded operator allocation and cannot be spent twice. Readiness paid checks need their own explicitly authorized budget before running; no proof balance is assumed available.

Exit: calibrated ledger, concurrent reservation/stop proof, enforced approve/reject/fork constraints, per-stage ceilings and settled total. Then run the real fixtures; Mission Control follows their recorded outcomes, not this readiness proposal.

## Decisions to confirm before implementation

1. Anthropic's preferred default remains native gateway if it passes DR1; should direct Anthropic be preferred from the outset given the observed streaming defect?
2. DR3: select the KS-backed `/artifacts/` route or explicit custody tools after the spike.
3. Scheduling: land Unit 6 first (default sequence), or explicitly parallelize its work with DR1–DR3 preparation? Both gates still precede fixtures.
