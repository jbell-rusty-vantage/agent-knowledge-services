# Verification module: every surface, run in sequence

This note is the inventory the model-card experiment was missing. It walks every admitted verification path as if an operator were running it, then shows what the experiment did instead and why `occurrences` / `bindQuote` had to exist.

Canonical contracts live in Knowledge Services, not in this file:

- Skill: `skills/knowledge-verification/` (`SKILL.md`, `cli-reference.md`, `mcp-reference.md`, `examples.md`)
- Operator docs: `docs/verification/` (`README.md`, `SURFACE-REFERENCE.md`, `INTEGRATION-GUIDE.md`, `OPERATOR-RUNBOOK.md`)
- Algorithms: `packages/verification/` (must not be imported by other repos)
- Policy: `packages/policy/src/verification-policy.ts`
- Transports: `apps/cli`, `apps/mcp`, `apps/api`, `apps/worker`

Contract: `verification.v1`. Producer ≠ verifier. A research agent does not self-grade prose. It submits **handles**. Separate verifier workers check those handles against captured bytes.

---

## 0. Why this experiment wrote `occurrences` and `bindQuote`

Those two helpers are **not** missing verifier functions. The verifier already rejects non-unique quotes.

`resolveBuiltInSelector` → `resolveTextQuote` (`packages/verification/src/deterministic/selectors.ts`) scans the capture for the quote. Zero hits → `not_found`. More than one hit → `ambiguous`. Exactly one hit → `resolved` with `occurrenceCount: 1`. The mechanical engine then hard-fails `LOCATOR_UNIQUE` unless status is `resolved` and count is `1` (`packages/verification/src/deterministic/engine.ts`). Extraction does the same check as `EVIDENCE_RESOLUTION_FAILED` (`packages/verification/src/extraction/verification.ts`).

So if Terra emits a quote that is missing, slightly wrong, or appears twice on the model-card page, **admitted verification is supposed to fail**. That is a quality failure, not a bug.

The experiment needed the opposite of that for its **pass arm**. It is proving four stages:

1. capture integrity
2. selector integrity
3. mechanical correctness (pass *and* fail)
4. semantic support

Stage 4 only runs if stage 3 passes (`authorizeSemanticCase` throws `SEMANTIC_MECHANICAL_GATE_CLOSED` otherwise). If the producer quotes are unbound, the pass bundle never becomes semantically eligible, the judge never runs, and the receipt cannot prove the happy path.

`bindQuote` is therefore **producer-side locator construction**:

```text
Terra emits { value, quote, proposition }
  → occurrences(page, quote) === 1  → use that quote as the selector
  → else occurrences(page, value) === 1 → repair the selector to the unique value
  → else drop the metric (do not submit it)
```

That step does not exist as a CLI or MCP tool. Official producers are expected to already emit unique locators (`text_quote` with optional `prefix`/`suffix`, or `html` css/xpath/domPath). Display excerpts are never selectors. There is no public “help me find a unique quote” API.

The experiment also had to invent this because it is **not** on the admitted path:

| Official path | This experiment |
| --- | --- |
| `knowledge benchmark capture` / `knowledge_capture_source` issues a real `captureId` + representation handle | Firecrawl or `https.get`, then a fake `handleFor()` |
| Capture of a web page is `html_dom` (parser image) | Markdown / stripped HTML text |
| Claims arrive as a registered `verification-claims-artifact.v1` handle | In-memory `VerificationBundle` |
| Extraction schema/output are registered artifact handles | `admitExtractionSchema` + inline candidate object |
| Worker hydrates bytes from storage, seals, applies policy | Package functions on local strings |
| Semantic judge is a distinct verifier deployment | Same Terra model, in-process `GatewaySemanticJudgeAdapter` |

`occurrences` in the experiment is a slightly different counter than the library’s `allIndexes` (non-overlapping vs overlapping). That can disagree on overlapping needles: `"aaa"` in `"aaaa"` is one hit in the experiment and two in the resolver, so `bindQuote` would keep a quote the worker would mark `ambiguous`. For typical unique model IDs it does not matter. Uniqueness is still a **producer obligation**. The verifier only checks it.

Official `text_quote` can disambiguate with `prefix` and `suffix`. The experiment does not use those. It only accepts globally unique substrings, or falls back to the metric `value`. A quote unique in Firecrawl markdown can still be missing or duplicated on the official `html_dom` projection.

---

## 1. The five questions (every sequence answers these in order)

Later stages may add restrictions. They must not reverse an earlier deterministic failure.

1. **Capture integrity** — exact source bytes preserved (`CAPTURE_DIGEST_MATCH`, `CAPTURE_BYTE_LENGTH_MATCH`).
2. **Selector integrity** — the stored locator still selects the claimed evidence (`LOCATOR_UNIQUE`, resolver status `resolved`).
3. **Mechanical correctness** — identity, type, value, unit, pointer, citation binding, producer/verifier independence.
4. **Semantic support** — optional judge on **authorized fragments only**. Closed if mechanics failed.
5. **Policy admission** — `packages/policy` `evaluateVerificationPolicy` → `pass` / `pass_with_warnings` / `review` / `fail` / `abstain`.

Orthogonal properties (stored separately, never rolled into one score): evidence support, world correctness, attribution faithfulness, source authority (`assessSourceAuthority`), provenance integrity.

Exit lattice for CLI `--wait`: `0` admitted, `1` completed quality failure or held review, `2` infrastructure/config/auth. `completed` + `review_required` is held, not a failure. Do not retry a held or failed quality result on the producer deployment.

---

## 2. Surface map

Three public transports share one HTTP API. The algorithm package is a fourth, private surface.

### 2.1 Shared envelope

CLI catalog commands:

```text
knowledge <group> <action> --context '<OperationContext>' --input '<request>' [--wait] [--human]
```

`--context` is the full `OperationContextSchema` (`tenantId`, `operationId`, `attemptId`, `correlationId`, `actor`, `capabilityVersion`, `idempotencyKey`, `reason`, `contractVersion`, plus optional `missionId` / `workItemId` / …).

MCP mutations take a slimmer `{ context, request }` (`tenantId`, `correlationId`, `idempotencyKey`, plus ownership hints). MCP reads need only `tenantId` + `correlationId`.

On the production ownership path (`VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON`, required when `VERIFICATION_CLAIMS_ENABLED=1`), `attemptId` + `missionId` + `workItemId` must match a grant and existing orchestration rows. Otherwise **403** `"Verification operation ownership denied"`.

Artifact inputs are always `{ artifactId, digest }` where `digest` is `sha256:` + 64 hex. Mutations return `AcceptedOperationSchema` (`operationId`, `state: "queued"`, control URLs). Handles come from the **family terminal read** after success. Do not invent IDs.

`--wait` polls `getVerificationOperation` for: capture, extraction verify, replay, metric, benchmark, compare, claims, report. It does **not** handle parse, structured extraction, adjudication, or audit inspect (`VERIFICATION_WAIT_UNSUPPORTED_KIND` → exit 2). Prefer `knowledge verify status` / `knowledge_get_verification_operation`, then the family read. `--wait` completion is not authoritative.

### 2.2 CLI catalog (30 HTTP commands)

| Sequence role | CLI | MCP | HTTP |
| --- | --- | --- | --- |
| Capture source | `knowledge benchmark capture` | `knowledge_capture_source` | `POST /v1/verification/captures` |
| Capture terminal | **none** | **none** | `GET /v1/verification/captures/:operationId` |
| Parse projections | `knowledge artifact parse` | `knowledge_parse_artifact` | `POST /v1/verification/artifacts:parse` |
| Structured extract | `knowledge extraction run` | `knowledge_extract_structured_data` | `POST /v1/verification/extractions` |
| Extraction terminal | `knowledge extraction show` | `knowledge_get_structured_extraction` | `GET /v1/verification/extractions/:operationId` |
| Verify extraction | `knowledge verify extract` | `knowledge_verify_extraction` | `POST /v1/verification/extractions:verify` |
| Verify claims / citations | `knowledge verify citations` | `knowledge_verify_claims` | `POST /v1/verification/claims:verify` |
| Claims terminal | `knowledge verify claims-result` | `knowledge_get_verification_claims_result` | `GET /v1/verification/claims/:operationId` |
| Verify report | `knowledge verify report` | `knowledge_verify_report` | `POST /v1/verification/reports:verify` |
| Report terminal | `knowledge verify report-result` | `knowledge_get_verification_report_result` | `GET /v1/verification/reports/:operationId` |
| Verify metric | `knowledge verify metric` | `knowledge_verify_metric` | `POST /v1/verification/metrics:verify` |
| Poll any kind | `knowledge verify status` | `knowledge_get_verification_operation` | `GET /v1/verification/operations/:id` |
| Run / manifest / cases | `verify run\|manifest\|cases\|case\|evidence` | `knowledge_get_verification_*` | `/v1/verification/runs|cases|evidence` |
| Replay | `knowledge bundle replay` | `knowledge_replay_run` | `POST /v1/verification/runs/:runId:replay` |
| Audit inspect | `knowledge bundle inspect` | `knowledge_inspect_audit_bundle` | `POST /v1/verification/audit-bundles:inspect` |
| Audit terminal | `knowledge bundle show` | `knowledge_get_audit_inspection` | `GET /v1/verification/audit-inspections/:operationId` |
| Adjudication request | `knowledge adjudication request` | `knowledge_request_adjudication` | `POST /v1/verification/adjudications:request` |
| Adjudication decision | `knowledge adjudication decision` | `knowledge_record_adjudication_decision` | `POST /v1/verification/adjudications:record-decision` |
| Adjudication reads | `adjudication get` / `get-decision` | `knowledge_get_adjudication*` | `/v1/verification/adjudications*` |
| Benchmark run | `knowledge benchmark run` | `knowledge_run_benchmark` | `POST /v1/verification/benchmarks:run` |
| Benchmark compare | `knowledge benchmark compare` | `knowledge_compare_benchmark_runs` | `POST /v1/verification/benchmarks:compare` |
| Benchmark reads | `benchmark show\|manifest\|comparison` | `knowledge_get_benchmark_*` | `/v1/verification/benchmarks*` |
| Provider recon | `reconciliation apply\|show` | `knowledge_apply/get_provider_reconciliation` | `…/provider-attempts/:id/reconciliation` |

### 2.3 CLI specials (local, not the HTTP catalog)

| Command | What it does |
| --- | --- |
| `knowledge demo diagnostics-companies` | Frozen offline pack. No token, no provider authority, no human gold. Exit 2 `verification_incomplete` is expected until labels exist. |
| `knowledge benchmark capture diagnostics-companies` | Local proposal refresh against a server-owned capture profile. |
| `knowledge benchmark diff` | Local previous-vs-proposed catalog diff. |
| `knowledge verification attestation-export` | Sign a local audit bundle (`KNOWLEDGE_VERIFICATION_ATTESTATION_SIGNING_KEY_PEM`). |
| `knowledge verification attestation-inspect` | Verify a local DSSE/SLSA attestation. |

### 2.4 HTTP / typed-client only (no CLI, no MCP)

These exist on `KnowledgeClient` and the API. Agents using only the skill will not see them.

| Client method | Route | Why it matters |
| --- | --- | --- |
| `getVerificationCaptureResult` | `GET /v1/verification/captures/:operationId` | **Only** way to read the capture terminal (`captureId`, representation handles). Skill says this explicitly. |
| `captureVerificationSourceWithProfile` | `POST /v1/verification/benchmark-capture-profiles/:profileName/captures` | Server-owned profile capture. Bearer + idempotency only; no caller ownership headers. |
| `applySemanticProviderReconciliation` / `getSemanticProviderReconciliation` | claims/report recon hosts | CLI apply/show uses the extraction recon host. |
| Drift internals | `/v1/internal/verification/drift-*` | Scope `verification.drift.consume`. Not an agent tool. |

Generic recovery (same bin, not verification-specific): `knowledge operation status|events|retry|reconcile`.

### 2.5 Library-only (what the experiment imported)

Cross-repo callers must not import `@aiengineer/knowledge-verification`. The experiment is inside Knowledge Services, so it may.

| Function | Stage | Public equivalent |
| --- | --- | --- |
| `sha256Digest` | capture integrity | Server recomputes this on hydrate |
| `resolveBuiltInSelector` | selector integrity | Worker selector resolution |
| `admitExtractionSchema` | schema gate | Server admits schema artifacts before extract |
| `verifyExtractionFields` | mechanical extraction | `knowledge verify extract` |
| `verifyDeterministicBundle` | mechanical claims | `knowledge verify citations` |
| `authorizeSemanticCase` | semantic gate | Worker semantic step |
| `verifyAssertionSemantics` / `GatewaySemanticJudgeAdapter` | semantic judge | Worker + `VERIFICATION_SEMANTIC_*` |
| `evaluateVerificationPolicy` | policy | Worker seal / claims result `policyOutcome` |
| `assessSourceAuthority` | authority | Policy inputs, not a tool |
| `acceptClaimDecomposition` | report atomization | No public tool |
| `applyReportWideMechanicalGates` / `verifyReportWide*` | report gates | `knowledge verify report` |
| `sealAuditBundle` / `inspectAuditBundle` | provenance | `knowledge bundle inspect` |
| `projectionSelectorResolver` | html/pdf/table/… | Parser + worker, not markdown `text_quote` |

---

## 3. Shared preflight (run this before every admitted sequence)

```text
1. KNOWLEDGE_API_URL + KNOWLEDGE_API_TOKEN
2. API / worker / MCP up (4100 / worker loop / 4101)
3. Ownership grant + orchestration.mission / work_item / attempt rows
4. Capability flags for the kind you will call (empty JSON = unregistered → 503)
5. Parser image digest if any verification worker block is on
6. Real handles from a prior admitted operation — never invent artifactId / digest / captureId
```

Start from `ai-engineer-knowledge-services/` after `corepack pnpm --filter @aiengineer/knowledge-cli build`:

```text
node apps/cli/dist/index.js …
```

MCP cannot grant capabilities. Do not load the Knowledge Services `.env` for local proofs.

---

## Sequence A — Capture bytes into custody

This is how a URI or already-registered bytes become a `captureId` and representation handles. Every later sequence starts here.

```text
allowlisted URI  ──acquire──►  knowledge benchmark capture
already-registered bytes  ──register──►  same command
```

**CLI**

```text
knowledge benchmark capture --context '<OperationContext>' --input '{
  "verificationContractVersion": "verification.v1",
  "source": { "mode": "acquire", "sourceKind": "web_page", "sourceUri": "https://…" },
  "requestedProjectionKinds": ["html_dom"]
}' --wait
```

Acquire-mode only fetches URIs already in `VERIFICATION_SOURCE_ACQUISITION_GRANTS_JSON`. It is not an open browser. Register-mode takes `{ mode: "register", sourceKind, sourceId, contentArtifact: { artifactId, digest } }` — the bytes must already be in storage.

Admitted shapes (application is stricter than Zod):

- `web_page` → exactly `requestedProjectionKinds: ["html_dom"]`
- `acquire` + `pdf` → exactly `["pdf_text", "geometry"]`
- anything else → `VERIFICATION_CAPTURE_MODE_NOT_ADMITTED`

**MCP:** `knowledge_capture_source` `{ context, request }`.

**Wait:** `--wait` is admitted (`verification_capture`) and always grades capture as quality-passed. That is not a claims verdict.

**Then — HTTP only:**

```text
GET /v1/verification/captures/:operationId
```

Typed client: `getVerificationCaptureResult`. There is no `knowledge capture show` and no MCP capture-show tool. This is the first real gap an agent hits: you can start a capture from CLI/MCP, but you cannot read the issued `captureId` / projection handles without HTTP or the typed client.

Worker: `verification_capture` / `register_and_admit`. Acquire also runs the parser and returns projections in the same operation. A separate `knowledge artifact parse` exists when you already have a registered source artifact and need canonical projections later.

**What the experiment did instead:** `capturePage()` via Firecrawl markdown or stripped HTML. `handleFor()` minted `artifactId` / `digest` / `objectKey` in memory. That proves SHA-256 replay. It does not prove capture custody, acquisition grants, parser lineage, or `html_dom` projections.

---

## Sequence B — Parse (canonical projections, no claims)

Use when capture registered raw bytes and you still need `html_dom` / `pdf_text` / `geometry`.

```text
knowledge artifact parse --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "captureId": "<uuid>",
  "sourceArtifact": { <full VerificationArtifactHandle> }
}'
```

**MCP:** `knowledge_parse_artifact`. **Wait:** unsupported. Poll `verify status`, then there is no parse-result CLI — read the operation / result artifact via HTTP.

`sourceArtifact` here is a **full** `VerificationArtifactHandleSchema`, not the usual `{artifactId, digest}` pair. There is also no parse-result CLI/MCP read.

Parser identity is server-side (pinned Docker image). Success means `canonical_projection_admitted`. It asserts no extraction and no policy.

**Library equivalent the experiment never called:** `parseCanonicalProjection` + `projectionSelectorResolver` (html css/xpath/domPath, pdf offsets, tables, …). The experiment only used built-in `text_quote` against markdown bytes.

---

## Sequence C — Structured extraction, then verify extraction

This is the official “fill a schema from one capture” path. Two operations, not one.

### C1. Produce the candidate (server-owned provider)

```text
knowledge extraction run --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "captureId": "<from capture terminal>",
  "representation": { "artifactId": "<projection>", "digest": "sha256:…" },
  "extractionSchema": { "artifactId": "<admitted schema>", "digest": "sha256:…" },
  "extractionProfile": "registered_default"
}'
```

`--wait` does **not** handle `verification_structured_extraction`. Poll:

```text
knowledge verify status --input '{"operationId":"<extract-op>"}'
knowledge extraction show --input '{"operationId":"<extract-op>"}'
```

**MCP:** `knowledge_extract_structured_data` then `knowledge_get_structured_extraction`.

The schema handle and profile are catalog-admitted. You cannot POST an inline JSON Schema on the public route. Library `admitExtractionSchema` is what the server runs before a provider is invoked (bounded keywords, required descriptions, `maxLength` on strings, no `$ref`).

Official extract locators live in the **registered extraction profile**, not in the LLM candidate. `extraction run` fills values against those already-authored selectors. That is why Sequence C does not need `bindQuote`: the producer is not inventing quotes. The experiment’s extraction arm is closer to claims (free quotes) than to this profile path.

Worker: `verification_structured_extraction` / `extract_and_register` (Gateway or Interfaze). Needs `AI_GATEWAY_API_KEY` or `INTERFAZE_API_KEY` plus signing keys.

### C2. Verify the candidate against the capture

```text
knowledge verify extract --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "captureIds": ["<exactly-one-captureId>"],
  "extractionSchema": { "artifactId": "…", "digest": "sha256:…" },
  "extractionOutput": { "artifactId": "…", "digest": "sha256:…" }
}' --wait
```

Extra capture IDs → `VERIFICATION_EXTRACTION_SINGLE_CAPTURE_REQUIRED`. `--wait` grades `result.valid`. There is no extract-result CLI; MCP has no dedicated extract-verify read tool. Use `verify status` / receipt.

**MCP:** `knowledge_verify_extraction`.

**Library (experiment):**

```text
admitExtractionSchema({ schemaId, schemaVersion, schema })
  → verifyExtractionFields({ schema, candidate, fields, evidence, representations })
```

The experiment built `candidate` from three bound quotes and proved a fail arm by replacing `metric_1_value` with `"99.9 invented"`. That is the mechanical field check only. It skipped C1 (no registered schema artifact, no `extraction run`, no worker publication).

---

## Sequence D — Claims / citations / source attribution

This is the research-producer path. `verify citations` and “source attribution” are the same use case: `verifyClaims`.

### D1. Producer work that is not a public tool

The HTTP body is **not** a JSON array of claims. It is a handle:

```text
assertions: { artifactId, digest }
  → bytes must be { schemaVersion: "verification-claims-artifact.v1", bundle }
```

Every `kind: "claim"` evidence edge needs a real selector into a registered capture (`text_quote`, `html`, `pdf_text`, …). Display excerpts are never selectors.

There is **no** `knowledge claims register` and **no** public artifact-upload route. Producer bytes enter storage through:

1. capture
2. structured extraction
3. operator / repository registration (proofs, fixtures, Mission Control hosts)

That missing public registration step is why the experiment inlined `claim()` + `bundleFor()` and why a flywheel producer cannot yet “just MCP the claims in.”

### D2. Submit verification

```text
knowledge verify citations --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "captureIds": ["<capture-1>"],
  "assertions": { "artifactId": "<claims-artifact>", "digest": "sha256:…" }
}' --wait
```

**MCP:** `knowledge_verify_claims`.

`--wait` completion `{ claims: { runId, manifestDigest, policyOutcome, mechanicalStatus, disposition } }` is a compact projection:

| disposition | meaning | exit |
| --- | --- | --- |
| `admitted` | mechanical `passed` and policy `pass` / `pass_with_warnings` | 0 |
| `held_for_review` | review/abstain policy or `review_required` mechanics | 1 — escalate, do not retry |
| `quality_failed` | mechanical `failed` or policy `fail` | 1 |

### D3. Authoritative read

```text
knowledge verify status --input '{"operationId":"…"}'
knowledge verify claims-result --input '{"operationId":"…"}'
```

**MCP:** `knowledge_get_verification_operation` then `knowledge_get_verification_claims_result`.

Then inspect the sealed run:

```text
knowledge verify run --input '{"runId":"…"}'
knowledge verify manifest --input '{"runId":"…"}'
knowledge verify cases --input '{"runId":"…"}'
knowledge verify case --input '{"caseRunId":"…"}'
knowledge verify evidence --input '{"evidenceId":"…"}'
```

Worker: `verification_claims`. Optional semantic stage if `VERIFICATION_SEMANTIC_RUNTIME_JSON` + profile grants are set. Seal uses code identity + policy grants.

**Library (experiment):**

```text
verifyDeterministicBundle({ bundle, artifacts, runtimePrincipals })
  → PRODUCER_VERIFIER_INDEPENDENT must pass
  → first passed + semantically eligible assertion
  → authorizeSemanticCase(bundle, mechanical, assertionId, selectedFragments)
  → verifyAssertionSemantics({ …, adapters: { primary: GatewaySemanticJudgeAdapter } })
```

The experiment’s fail arm submitted a fabricated quote. Mechanical failed `LOCATOR_UNIQUE` / `EVIDENCE_MECHANICALLY_VALID` — the judge was never allowed to “fix” that. That is the invariant.

Policy (question 5) was **not** run. `evaluateVerificationPolicy` never appears in `run.ts`. An admitted claims result always includes `policyOutcome`.

---

## Sequence E — Report + claim ledger

Use when a written report must be bound to exact UTF-16 offsets and citations.

```text
knowledge verify report --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "report": { "artifactId": "…", "digest": "sha256:…" },
  "claimLedger": { "artifactId": "…", "digest": "sha256:…" },
  "captureIds": ["…"]
}' --wait
```

Ledger schema: `verification-report-ledger.v1`. Assertions are `kind: "report_assertion"`. Offsets must bind the exact report artifact. Citations must bind declared evidence IDs.

**MCP:** `knowledge_verify_report` then `knowledge_get_verification_report_result`.

Report-wide mechanical gates (`applyReportWideMechanicalGates`) can only **add** hard failures: incomplete citations, bad pointers, missing qualifiers, internal contradictions, cross-section inconsistency. They never promote a mechanical fail to a pass.

**Library-only producer help:** `acceptClaimDecomposition` / `evaluateDecompositionProposal` — atomize report text into atomic claims. No CLI/MCP. Human gold for this is still open (VR-010).

The experiment did not run Sequence E.

---

## Sequence F — Metric observations

```text
knowledge verify metric --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "captureIds": ["…"],
  "observations": { "artifactId": "…", "digest": "sha256:…" }
}' --wait
```

**MCP:** `knowledge_verify_metric`. Worker: `verification_metric`. The deterministic engine also verifies `bundle.metricObservations` (decimal replay, cycle detection) when they appear on a bundle. Claims artifacts are forbidden from carrying metric observations (`VerificationClaimsArtifactSchema`).

The experiment’s “metrics” are ordinary claims + extraction fields, not this use case.

---

## Sequence G — Held result → adjudication

Trigger: claims/report `held_for_review`, operation `needs_review`, or mechanical `review_required` (for example lossy `casefold_whitespace_filler_removed` quotes).

```text
knowledge adjudication request --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "target": { "kind": "run", "runId": "…" },
  "reason": "policy_review",
  "evidencePacket": { "artifactId": "…", "digest": "sha256:…" },
  "requesterNote": "held after claims"
}'
```

Reasons: `ambiguous_evidence` | `conflicting_evidence` | `policy_review` | `quality_failure` | `appeal`. Target may be `assertion` / `evidence` / `run`.

`--wait` unsupported. Poll `verify status`, then:

```text
knowledge adjudication get --input '{"operationId":"…"}'
```

A **model** may request only. Recording a decision requires authenticated `human`, or `service` + `serviceIdentity: human_reviewer`. Never `model`. Identity comes from `KNOWLEDGE_API_IDENTITIES`, not a forged `--context.actor`.

```text
knowledge adjudication decision --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "subjectId": "…",
  "packetArtifact": { "artifactId": "…", "digest": "sha256:…" },
  "decision": "affirm" | "reject" | "defer",
  "rationale": "…"
}'
knowledge adjudication get-decision --input '{"operationId":"…"}'
```

Decisions record review only (`admissionChanged` is always `false`). Quorum uses distinct `human_origin` `affirm` only. A decision cannot override a deterministic failure.

The experiment never held a result and never called adjudication.

---

## Sequence H — Replay, then audit, then attest

Integrity path after a sealed run exists.

```text
knowledge bundle replay --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "runId": "…",
  "replayMode": "deterministic_only" | "recorded_provider_outputs"
}' --wait
```

HTTP path `runId` must match the body. Divergence is a quality/integrity failure, not a license to change the original verdict. Then `verify run` / `verify manifest`.

```text
knowledge bundle inspect --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "auditBundle": { "artifactId": "…", "digest": "sha256:…" }
}'
knowledge bundle show --input '{"operationId":"…"}'
```

`--wait` does not handle inspect. Local-only attestation (no API):

```text
knowledge verification attestation-export --audit-bundle … --trusted-public-keys … --trusted-binding … --output …
knowledge verification attestation-inspect --audit-bundle … --trusted-public-keys … --trusted-binding … --attestation …
```

**Library:** `sealAuditBundle`, `inspectAuditBundle`, `replayAuditBundle`, `createVerificationDsseSlsaAttestation`. The experiment sealed nothing.

If a provider attempt needs reconciliation (never a redispatch):

```text
knowledge reconciliation apply --input '{"operationId":"…","providerAttemptId":"…","artifact":{…}}'
knowledge reconciliation show --input '{"operationId":"…","providerAttemptId":"…"}'
```

CLI and MCP always hit the **extraction** recon host (`/v1/verification/extractions/.../reconciliation`). Claims/report recon HTTP routes exist; they are not what `knowledge reconciliation` calls. MCP has no `--wait`; agents poll `knowledge_get_verification_operation`. Parse, structured extraction, extract-verify, and metric have no family terminal CLI/MCP read — only operation status plus receipt.

---

## Sequence I — Offline benchmark (not live research)

```text
knowledge benchmark run --context '…' --input '{
  "verificationContractVersion": "verification.v1",
  "dataset": { "artifactId": "…", "digest": "sha256:…" },
  "experimentDefinition": { "artifactId": "…", "digest": "sha256:…" },
  "executionMode": "offline_recorded"
}' --wait
```

`executionMode` is only `offline_recorded`. Then `benchmark show` / `benchmark manifest`. Compare:

```text
knowledge benchmark compare --input '{
  "verificationContractVersion": "verification.v1",
  "baselineRunId": "…",
  "candidateRunId": "…",
  "comparisonProfile": "paired_default" | "regression_gate"
}' --wait
```

`--wait` exit 1 if `engineeringGateOutcome === "fail"`. Incomplete recorded outputs or missing human gold → abstain; do not claim production quality.

Local demo (different command, not this workflow):

```text
knowledge demo diagnostics-companies --dataset diagnostics-companies-v1 --output <empty-dir>
```

---

## Sequence J — What the model-card experiment actually ran

This is the library walk the script already executes. It is a **proof of stages**, not an admitted operation.

```text
1. capturePage()
     Firecrawl markdown | https.get + tag strip
     → page.markdown, finalUrl

2. handleFor(page.markdown)
     sha256Digest + invented artifactId
     → VerificationArtifactHandle

3. capture integrity
     registeredDigest === sha256Digest(page.markdown)
     byteLength match
     [official: CAPTURE_DIGEST_MATCH on hydrated storage bytes]

4. produceMetrics(page)
     Vercel AI SDK + openai/gpt-5.6-terra
     structured { metrics: [{ fieldId, modelId, metricName, value, quote, proposition }] }
     [official: this is a research producer, not a verifier]

5. bindQuote(page, metric)          ← PRODUCER, not verifier
     occurrences === 1 on quote, else on value
     drop unbound metrics
     [official: producer must already emit unique selectors;
      prefix/suffix or html locators; no public bind API]

6. admitExtractionSchema(…)
     bounded object schema, three string leaves
     [official extract: registered profile already contains selectors;
      this experiment invents quotes the way a claims producer would]

7. verifyExtractionFields(pass)
     candidate values === unique quotes
     text_quote evidence + expectedSelectedContentDigest
     verifyExtractionFields(fail) with invented "99.9 invented"
     [official: knowledge verify extract on handles]

8. claim() + bundleFor()
     in-memory verification.v1 bundle
     [official: register verification-claims-artifact.v1, then verify citations]

9. verifyDeterministicBundle(pass) / (fail fabricated quote)
     capture checks + LOCATOR_UNIQUE + PRODUCER_VERIFIER_INDEPENDENT
     [official: worker verification_claims]

10. resolveBuiltInSelector for each bound quote
     status resolved, occurrenceCount 1
     [official: same function inside the worker]

11. authorizeSemanticCase + GatewaySemanticJudgeAdapter + verifyAssertionSemantics
     judge sees only authorized fragment text
     [official: worker semantic profile; policy still after this]

12. write output/latest.json
     no persist, no policy, no seal, no capture terminal, no operationId
```

Receipt from the last live run proved all four stages, including a Terra judge `directly_supported` / `admit` on one mechanically eligible claim. That is a package proof. It is not a Knowledge Services operation.

---

## 4. What is missing to plug this into deep research + ingestion

North star phase 1 is flywheel-to-KB (`ai-engineer-meta/docs/product/11-north-star-path.md`). Official knowledge is supposed to come from deep research / ingestion into a proprietary KB. The intended rule is continuous persistence with gated promotion: write captures immediately; promote only independently verified atoms (`ai-engineer-meta/ai-engineer-architecture/specs/research-ingestion-blueprint/WHEN_AND_WHERE_TO_INGEST.md`). Verification is that post-research admission gate. It is not a required stage of the **live** flywheel yet.

The live research path is the pre-research packet + `research_ingestion_intent` apply loop (`research_starter_pre_research_agent/`). It writes `research_evidence_anchor` rows (short excerpt + char offsets) and producer-side flags such as `verification_status: verified`. Those flags are not `verification.v1` dispositions. A source-attribution lab already found matching transcript hashes but 0 of 124 exact anchors. KS also has a separate document-prep → `promotion_proposal` → embed chain that stops at a review proposal and is not bound to a sealed `verify citations` / `verify report` run. Mission Control’s research vertical (M11) and a durable “promote this verification result into canonical KB” command are still unbuilt.

### Have

- Durable verify operations for capture, parse, extract, verify-extract, claims, report, metric, benchmark, replay, audit, adjudication.
- CLI + MCP parity for those mutations (30 tools), except capture **read**.
- Deterministic-before-semantic, producer/verifier independence, content-addressed captures.
- Policy engine and authority assessment (library + worker seal, not a standalone CLI).
- Mission Control / Eve / Cursor integration docs (`docs/verification/INTEGRATION-GUIDE.md`).
- An experiment that proves a live producer can emit bindable quotes and that the four algorithm stages work on a real page.

### Missing (blockers for “research then ingest”)

1. **No public producer registration for claims / report / schema / extraction-output artifacts.** Agents cannot upload a `verification-claims-artifact.v1`. Fixtures do this through `registerContentAddressedArtifact` inside the repo. A flywheel producer has nowhere to put the bundle the verifier requires.

2. **No public capture-show.** After `knowledge_capture_source`, the agent cannot read `captureId` / projection handles without the typed client or raw HTTP.

3. **Acquire is catalog-only.** A research agent cannot capture an arbitrary Anthropic docs URL unless that URI is already in the acquisition grant catalog. The experiment’s Firecrawl fetch is exactly the thing acquire-mode refuses to be.

4. **Official web capture is `html_dom`, not markdown.** Selectors should be `html` (css / xpath / domPath) with optional `text_quote` fallback, or `text_quote` against canonical text — not Firecrawl markdown. Table-heavy model cards will keep producing ambiguous short quotes until producers use structural locators or prefix/suffix.

5. **No producer locator-construction API.** `bindQuote` is the stand-in. The official answer is: the producer must emit unique selectors, or verification fails. For a flywheel we still need a **producer helper** (not a verifier bypass): given capture bytes + a candidate quote, return a unique `text_quote` (with prefix/suffix) or abstain. That helper must not be allowed to change a verifier verdict.

6. **Policy + seal + persist are not in the experiment and not in the research loop.** Question 5 never ran. Nothing is written to the KB. Nothing is replayable.

7. **Structured extraction cannot take an inline schema.** Official courses that “extract model-card fields” need a pre-registered schema artifact and `registered_default` profile, or a new admission path.

8. **Ingestion does not require an admitted verification disposition.** There is no flywheel gate: `if claims.disposition !== admitted then do not publish to KB`. Pre-research apply and KS `promotion_proposal` can both proceed without a sealed claims/report run. `research_evidence_anchor` is a different contract from `verification-claims-artifact.v1`.

9. **Human adjudication is request-only from models.** Real held research still needs a human reviewer identity. Synthetic dashboard proof exists; human-origin labels do not (VR-014 and related matrix rows).

10. **Acceptance is not whole-module complete.** Engineering-ready for Mission Control integration; quality promotion still gated (human gold, sealed Pilot, Interfaze sensitive-input approval). See `docs/verification/README.md`.

### Recommended official research → ingest pipeline

```text
deep-research producer (distinct deployment)
  → catalog URI or operator-registered source bytes
  → captureSource (web_page + html_dom)          [Sequence A]
  → GET capture terminal                          [HTTP-only today]
  → producer builds unique selectors
       (html locators or text_quote + prefix/suffix;
        bindQuote-class helper lives here, on the producer)
  → operator/service registers
       verification-claims-artifact.v1
       optional report + verification-report-ledger.v1
  → verify citations  [Sequence D]
  → optional verify report  [Sequence E]
  → if held: adjudication request  [Sequence G]
  → if admitted (mechanical passed + policy pass/pass_with_warnings):
       ingest / publish to KB
  → later: bundle replay + audit inspect  [Sequence H]
```

Alternate leaf path when the object is a schema, not a narrative:

```text
capture → extraction run → extraction show → verify extract → ingest leaves
```

Do not merge producer and verifier deployments. Do not call Gateway from the producer and call that “verified.” Do not treat Firecrawl markdown as an admitted capture.

---

## 5. How the next experiment should evolve

Keep this script as a **stage proof**. Do not pretend it is admitted.

A follow-on experiment that is actually on the module should, in order:

1. Put the Anthropic models URL in a local acquisition catalog (or register already-fetched HTML bytes — not markdown — via operator registration).
2. `knowledge benchmark capture` with `web_page` + `html_dom`.
3. Read `GET /v1/verification/captures/:operationId` (typed client). Record the real `captureId` and projection handle.
4. Keep Terra as the **producer only**. Have it emit selectors, then a producer-side binder (the current `bindQuote`, plus prefix/suffix when the quote is not globally unique).
5. Register a real `verification-claims-artifact.v1` through the same repository port the proofs use (until a public register route exists).
6. `knowledge verify citations --wait`, then `verify claims-result`.
7. Leave the fabricated-quote fail arm as a second claims artifact, not an in-process second `verifyDeterministicBundle`.
8. Only then decide whether extraction run + `verify extract` is a second experiment or the same one.

Until step 5 exists as a public mutation, deep research cannot close the loop through CLI/MCP alone. That is the integration hole, not the absence of `occurrences` inside the verifier.
