# Verification and admission

**What it does.** `packages/verification` runs a staged deterministic bundle check (capture digest, selectors,
assertions), then semantic judging only when the mechanical gate is open, then seal, inspect and replay. Admission is a
separate step: `packages/policy` evaluates the verification policy, and
`packages/knowledge-db/src/ingestion/exact-use-admission.ts` admits one exact downstream use inside the commit
transaction. The governed chain (`chain_write`) takes nine proposal-only writes: `record_claim`, `restate_claim`,
`record_triage`, `register_probe`, `record_probe_run`, `propose_verdict`, `record_source_assessment`,
`raise_attention_sweep`, `settle_attention_sweep`; none of them verifies a claim. Concept: [verification and
admission](../knowledge/verification-and-admission.md#verification-and-admission).

**Code.** `packages/verification/src/{deterministic,evidence-selection,semantic,provenance,extraction,report,providers}`;
`packages/policy/src/verification-policy.ts`; `packages/knowledge-db/src/chain/executor.ts`
(`GovernedChainExecutor`); `packages/contracts/src/verification-chain.ts`; `packages/research-core`,
`packages/knowledge-operation-protocol`, `packages/host/src/knowledge-operation/`;
`apps/verification-executor/src/knowledge-operation/{http.ts,mcp-tools.ts}`.

**Tests.** `packages/verification/examples/01-…06-*.test.ts`; `packages/policy/src/verification-policy.test.ts`;
`packages/knowledge-db/src/chain/chain.test.ts`; `packages/contracts/src/verification-chain.test.ts`;
`apps/verification-executor/src/knowledge-operation/conformance.test.ts` (in-memory backend). The
`*.integration.test.ts` suites need a loopback `KS_AIENG_DB_ADMIN_DSN`.

**Reach it.**
- `knowledge chain write <request.json>`, `knowledge evidence units [--text|--capture-id|...]`; executor MCP
  `chain_write`, `evidence_units`, `knowledge_describe`; HTTP `POST /knowledge/chain_write`.
- The K01 protocol `ks.knowledge_operation.v2`: HTTP `POST /knowledge-operation/v2/invoke`, `GET /describe`,
  `GET /operations/:id`, `POST /operations/:id/cancel`, `GET /receipts/:key`, `GET /artifacts/:id`; MCP
  `knowledge_operation_invoke`, `knowledge_operation_get`, `knowledge_operation_cancel`, `knowledge_receipt_get`.
- The platform `verify` group: MCP `verify_benchmark_capture`, `verify_artifact_parse`, `verify_extract`,
  `verify_extraction_run`, `verify_bundle_replay`, `verify_benchmark_run`, `verify_benchmark_compare`,
  `verify_status`, `verify_extraction_show`, `verify_benchmark_show|manifest|comparison`,
  `verify_reconciliation_show|apply`; the matching `ks verify ...` commands; HTTP `/v1/verification/...`
  (`apps/api/src/routes/verification.ts`).

**Prove it.** `./dev test verification examples/05-semantic-recorded-judge.test.ts`: a corrupted bundle closes with
`MECHANICAL_GATE_CLOSED` and the judge is never called. Also `./dev test policy src/verification-policy.test.ts`
(semantic or override state never reverses a mechanical failure) and `corepack pnpm examples:verification`.

**Gotchas.**
- Retired `knowledge-verify` commands (`verify-claims`, `verify-extraction`, `judge`, `policy`, `seal`,
  `check-report`, `status`) exit 2 with "retired (SV-17)".
- Chain refusals exit 1 with stable codes such as `VERDICT_CELL_NOT_RUN` and `HUMAN_REVIEW_NOT_AGENT_WRITABLE`.
- Admission refuses with `STALE_DECISION`, `REVIEW_REQUIRED`, `EFFECT_CONFLICT`, `UNRESOLVED_EFFECT`,
  `EXACT_REVISION_UNAVAILABLE`, and `AIDB_GUARD_REQUIRED` when neither `verification.assert_admitted_use` nor
  `research.assert_admitted_use` is installed in the database.
- The K01 routes need `KS_KNOWLEDGE_ISSUER` with its audience, JWKS and bindings variables; they never accept the
  static bearer token. Refusals are `protocol-error.v2`.
- `knowledge-verify grant-reviewer --database-url-env <NAME>` needs a live database.
