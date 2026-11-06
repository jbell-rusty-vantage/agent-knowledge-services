# Knowledge verification CLI reference

Bin name: `ks` (`apps/cli/package.json` → `./dist/index.js`). Package: `@aiengineer/knowledge-cli`. Command names are listed by `ks --help` and defined in `apps/cli/src/ks-commands.ts`.

## Generic invocation

Remote catalog commands (not the local specials) parse argv as `ks <group> <command…> [flags]`; the command table picks the profile, never a failure.

| item | contract |
| --- | --- |
| flags | `--base-url`, `--context` (JSON `OperationContextSchema`), `--input` (JSON, default `{}`), `--timeout-ms` (100–300000, default 60000), `--wait` (verification_mutation only), `--human` (pretty JSON) |
| env | `KNOWLEDGE_API_URL` (or `--base-url`), `KNOWLEDGE_API_TOKEN` (required for catalog commands) |
| stdout | JSON of the accepted mutation/read payload, or the `--wait` completion object |
| stderr | JSON — `{code:"CLI_ERROR",command,message}`; usage `{code:"USAGE",command,message,help}`; unknown command `{code:"UNKNOWN_COMMAND",command,help}` |
| exit | `0` on success without `--wait`; `--wait` uses `completed.exitCode` (`1` when the quality gate fails); usage, auth, network or executor error → `2`, never a fallback |

`--context` is the full envelope in `packages/contracts/src/identity.ts` (`OperationContextSchema`): `tenantId`, `operationId`, `attemptId`, `correlationId`, `actor`, `capabilityVersion`, `idempotencyKey`, `reason`, `contractVersion` (`"v1"`), optional `projectId`, `missionId`, `workItemId`, `causationId`, `externalExecution`. Spec-style flags such as `--operation-id`, `--mission-id`, `--policy` are **not** implemented.

`--input` must be a JSON object. Mutation bodies are the public request schemas. Read commands accept only the keys in the catalog table.

### `--wait` semantics

`--wait` is ignored unless `command.mode === "verification_mutation"`. It requires `operationId` on the accepted payload, then polls `getVerificationOperation` (`verification-completion.ts`). `--wait` also reads `GET /v1/receipts/:id` for every receipt id and therefore requires `knowledge.read` on the same bearer plus the API receipts reader configured (503 without a resource reader).

| operation kind | `--wait` |
| --- | --- |
| `verification_capture` | exit `0` (capture treated as quality-passed) |
| `verification_extraction` | `0` if `result.valid===true`, `1` if `false` |
| `verification_replay` | same `result.valid` rule |
| `verification_benchmark` | `0` on success receipt |
| `verification_benchmark_compare` | `0` unless `engineeringGateOutcome==="fail"` → `1` |
| `needs_review` state | exit `1` (`qualityPassed: false`) |
| `failed` / `cancelled` / `quarantined` | throw → CLI `2` |
| timeout / missing success receipt / `valid` not boolean | throw → CLI `2` |

`--wait` does **not** handle these kinds (throws a message that starts with `VERIFICATION_WAIT_UNSUPPORTED_KIND:<kind>` → exit `2` even after `succeeded`): `verification_parse_artifact`, `verification_structured_extraction`.

Poll instead: `ks verify status --input '{"operationId":"<uuid>"}'` then the terminal read in the catalog. Prefer `verify status` (`getVerificationOperation` → `GET /v1/verification/operations/:id`) over `operation status` (generic `GET /v1/operations/:id`). `needs_review` / `review_required` is held: do not retry or override.

## Command catalog

Verification rows from `KS_COMMANDS` → `CLI_COMMANDS` + `dispatchCliCommand` (14). `--input` keys are required unless marked optional.

| ks command | mode | use case / resource | required input keys |
| --- | --- | --- | --- |
| `verify reconciliation apply` | provider_reconciliation | apply | `operationId`, `providerAttemptId`, `artifact` |
| `verify reconciliation show` | provider_reconciliation | show | `operationId`, `providerAttemptId` |
| `verify extraction run` | verification_mutation | extractStructuredData | full `ExtractStructuredDataRequestSchema` |
| `verify extraction show` | read | structured_extraction | `operationId` only |
| `verify benchmark comparison` | read | benchmark_comparison | `comparisonId` only |
| `verify benchmark compare` | verification_mutation | compareBenchmarkRuns | full `CompareBenchmarkRunsRequestSchema` |
| `verify benchmark show` | read | benchmark_run | `runId` |
| `verify benchmark manifest` | read | benchmark_manifest | `runId` |
| `verify benchmark run` | verification_mutation | runBenchmark | full `RunBenchmarkRequestSchema` |
| `verify benchmark capture` | verification_mutation | captureSource | full `CaptureSourceRequestSchema` |
| `verify artifact parse` | verification_mutation | parseArtifact | full `ParseArtifactRequestSchema` |
| `verify status` | read | verification_operation (`getVerificationOperation`) | `operationId` only |
| `verify extract` | verification_mutation | verifyExtraction | full `VerifyExtractionRequestSchema` (exactly one `captureId`) |
| `verify bundle replay` | verification_mutation | replayRun | full `ReplayRunRequestSchema` |

Claims, citation, report, metric, run/case/evidence reads, audit-bundle inspection and adjudication commands were retired in SV-17; claims, runs and seals go through ks.knowledge_operation.v2 (K01) on the knowledge_verification component.

`ks verify benchmark capture diagnostics-companies` is a separate local command (special below). The `knowledge` group (`ks knowledge operation status|events|retry|reconcile`, retrieve, eval, …) is on the same bin but out of scope for this skill.

There is no `capture show` catalog action.

## Special local commands

These bypass `KNOWLEDGE_API_TOKEN` except where noted. Stderr codes: `BENCHMARK_CAPTURE_ERROR`, `BENCHMARK_DIFF_ERROR`, attestation codes.

| ks command | mode | flags | exit |
| --- | --- | --- | --- |
| `verify benchmark capture diagnostics-companies` | local+HTTP optional | `--propose-version` (must `diagnostics-companies-v2`), `--output` (default `.knowledge/benchmark-proposals/diagnostics-companies-v2`), `--profile` (must `diagnostics-companies`), `--base-url`, `--timeout-ms` (100–60000, default 60000) | `0` `proposed_review_required`; `2` `refresh_incomplete` |
| `verify benchmark diff` | local | positional previous/proposed; `--catalog-root`, `--proposal-root` | success `0`; catch `2` |
| `verify attestation export` | local | `--audit-bundle`, `--trusted-public-keys`, `--trusted-binding`, `--output` | `0`; catch `2` |
| `verify attestation inspect` | local | `--audit-bundle`, `--trusted-public-keys`, `--trusted-binding`, `--attestation` | `0` verified / `1` not; catch `2` |

The local file-store profile also runs the executor capture and artifact tools: `ks verify capture source|file|list|read|search|locate|media-types` and `ks verify artifact register|get`.

## How to run from the repo

Working directory: the repository root. There is no root `package.json` script for the CLI.

1. **Built bin.**

```text
corepack pnpm --filter @aiengineer/knowledge-cli build
node apps/cli/dist/index.js verify extract --context '<json>' --input '<json>'
```

If the `ks` bin is on `PATH` after install (the `pack:sandbox` tarball) or link, the same argv works.

2. **Dev (catalog HTTP commands).** `apps/cli` script `dev` is `tsx src/index.ts`. Extra args after `--`:

```text
corepack pnpm --filter @aiengineer/knowledge-cli dev -- verify extract --context '<json>' --input '<json>'
```
