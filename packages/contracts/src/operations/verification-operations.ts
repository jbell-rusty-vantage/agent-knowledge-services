import { z } from "zod";
import { OperationStatusSchema } from "../integration.js";
import {
  VerificationBenchmarkRunManifestResourceSchema,
  VerificationBenchmarkRunSummaryResourceSchema,
} from "../verification/benchmark-reads.js";
import { VerificationBenchmarkComparisonResourceSchema } from "../verification/benchmark-comparison-reads.js";
import { ParseArtifactRequestSchema } from "../verification/parse.js";
import {
  ApplyProviderReconciliationRequestSchema,
  VerificationProviderReconciliationResourceSchema,
} from "../verification/provider-reconciliation.js";
import {
  CaptureSourceRequestSchema,
  CompareBenchmarkRunsRequestSchema,
  ExtractStructuredDataRequestSchema,
  ReplayRunRequestSchema,
  RunBenchmarkRequestSchema,
  VerifyExtractionRequestSchema,
} from "../verification/requests.js";
import { VerificationStructuredExtractionResourceSchema } from "../verification/structured-extraction-reads.js";
import { acceptedResult, EXAMPLE, type OperationContract } from "./contract-types.js";

const artifact = (n: number, character: string) => ({ artifactId: EXAMPLE.id(n), digest: EXAMPLE.digest(character) });
const handle = (n: number, mediaType: string) => ({
  artifactId: EXAMPLE.id(n),
  tenantId: EXAMPLE.tenantId,
  digest: EXAMPLE.digest("a"),
  mediaType,
  byteLength: 2_048,
  objectKey: `tenants/${EXAMPLE.tenantId}/artifacts/${EXAMPLE.id(n)}`,
  createdAt: EXAMPLE.at,
  producerActivityId: "example-producer",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "internal",
  parentArtifactIds: [],
});
const OPERATION = EXAMPLE.id(2);
const SUBMIT_NOTES = [
  "The caller needs the operation.submit permission for context.tenantId, and the deployment must recognise the caller as owner of the verification work: optional context.attemptId, workItemId and missionId carry that binding where the deployment requires it.",
  "context.idempotencyKey is 8 to 255 characters; over HTTP the context travels in headers (x-tenant-id, x-correlation-id, idempotency-key) and the body is the request alone.",
];
const READ_NOTES = ["The caller needs the knowledge.read permission for context.tenantId."];
const RequestIdsSchema = z.strictObject({ operationId: z.uuid(), providerAttemptId: z.uuid() });

/** Verification submissions and the reads of their results. */
export const VERIFICATION_OPERATIONS: readonly OperationContract[] = [
  {
    operation: "verification_capture",
    kind: "verification_capture",
    effect: "submit",
    summary:
      "Capture a source for verification: acquire an admitted web page or PDF by URL, or register content already stored.",
    when: "Use for evidence that verification will check; knowledge_source_fetch captures sources for preparation and search instead.",
    returns:
      "Returns the accepted operation; poll verify_status. The capture result is read over HTTP, not through an MCP tool.",
    input: CaptureSourceRequestSchema,
    shape: "request",
    notes: [
      ...SUBMIT_NOTES,
      'Only two combinations are admitted: sourceKind web_page with requestedProjectionKinds ["html_dom"], and mode acquire with sourceKind pdf and requestedProjectionKinds ["pdf_text", "geometry"] in that order. Anything else is refused with VERIFICATION_CAPTURE_MODE_NOT_ADMITTED.',
      "mode acquire needs a sourceUri that is a credential-free http or https URL which the deployment's capture catalog grants for this tenant with the same sourceKind.",
      "requestedProjectionKinds must not repeat a kind.",
    ],
    example: {
      verificationContractVersion: "verification.v1",
      source: { mode: "acquire", sourceKind: "web_page", sourceUri: "https://example.com/report" },
      requestedProjectionKinds: ["html_dom"],
    },
    result: acceptedResult(
      "When the operation succeeds the capture result is available at GET /v1/verification/captures/{operationId}.",
    ),
    related: ["tool:verify_status", "tool:verify_artifact_parse", "tool:verify_extraction_run"],
    mcp: ["verify_benchmark_capture"],
    cli: ["verify benchmark capture"],
    http: ["POST /v1/verification/captures"],
  },
  {
    operation: "verification_parse_artifact",
    kind: "verification_parse_artifact",
    effect: "submit",
    summary:
      "Parse one registered source artifact of a capture into canonical projections (HTML structure, PDF text, geometry).",
    when: "Use after a capture to obtain its parsed projections; it extracts and verifies nothing.",
    returns:
      "Returns the accepted operation; poll verify_status. Success means the projections are stored, not that any claim is verified.",
    input: ParseArtifactRequestSchema,
    shape: "request",
    notes: [
      ...SUBMIT_NOTES,
      "The deployment must hold a grant for exactly this capture and artifact; without one the call is refused with FORBIDDEN.",
      "sourceArtifact is the full artifact handle, including byteLength in bytes; the parser, the media handling and the source metadata are chosen by the service.",
    ],
    example: {
      verificationContractVersion: "verification.v1",
      captureId: EXAMPLE.id(90),
      sourceArtifact: handle(91, "text/html"),
    },
    result: acceptedResult(
      "On success the operation records { schemaVersion: 'verification-operation-result.v1', operationId, useCase: 'parseArtifact', requestDigest, sourceArtifact, output: { status: 'canonical_projection_admitted', projections: one or two of kind html_dom, pdf_text or geometry }, resultArtifact }.",
    ),
    related: ["tool:verify_benchmark_capture", "tool:verify_extraction_run", "tool:verify_status"],
    mcp: ["verify_artifact_parse"],
    cli: ["verify artifact parse"],
    http: ["POST /v1/verification/artifacts:parse"],
  },
  {
    operation: "verification_structured_extraction",
    kind: "verification_structured_extraction",
    effect: "submit",
    summary:
      "Produce a structured extraction candidate from one captured representation, following a registered schema.",
    when: "Use to create a candidate from a source; the candidate is unverified, and verify_extract is the operation that verifies an extraction.",
    returns: "Returns the accepted operation; poll verify_status, then read the result with verify_extraction_show.",
    input: ExtractStructuredDataRequestSchema,
    shape: "request",
    notes: [
      ...SUBMIT_NOTES,
      "The deployment must hold a grant for these inputs; without one the call is refused with FORBIDDEN.",
      "representation and extractionSchema name registered artifacts by id and digest; extractionProfile has one admitted value, registered_default.",
    ],
    example: {
      verificationContractVersion: "verification.v1",
      captureId: "capture-1",
      representation: artifact(92, "b"),
      extractionSchema: artifact(93, "c"),
      extractionProfile: "registered_default",
    },
    result: acceptedResult(
      "When the operation finishes, verify_extraction_show returns its custody record: either the candidate's artifact references or a typed failure.",
    ),
    related: ["tool:verify_extraction_show", "tool:verify_extract", "tool:verify_status"],
    mcp: ["verify_extraction_run"],
    cli: ["verify extraction run"],
    http: ["POST /v1/verification/extractions"],
  },
  {
    operation: "verification_extraction",
    kind: "verification_extraction",
    effect: "submit",
    summary: "Verify an extraction output against the evidence of one capture, following a registered schema.",
    when: "Use to check extracted values; verify_extraction_run produces a candidate and checks nothing.",
    returns:
      "Returns the accepted operation; poll verify_status. Replay a finished verification with verify_bundle_replay.",
    input: VerifyExtractionRequestSchema,
    shape: "request",
    notes: [
      ...SUBMIT_NOTES,
      "captureIds must hold exactly one id; more than one is refused with VERIFICATION_EXTRACTION_SINGLE_CAPTURE_REQUIRED.",
      "extractionSchema and extractionOutput name registered artifacts by id and digest.",
    ],
    example: {
      verificationContractVersion: "verification.v1",
      captureIds: ["capture-1"],
      extractionSchema: artifact(93, "c"),
      extractionOutput: artifact(94, "d"),
    },
    result: acceptedResult(
      "The operation status reports the state; the verification result is recorded with the operation.",
    ),
    related: ["tool:verify_extraction_run", "tool:verify_bundle_replay", "tool:verify_status"],
    mcp: ["verify_extract"],
    cli: ["verify extract"],
    http: ["POST /v1/verification/extractions:verify"],
  },
  {
    operation: "verification_replay",
    kind: "verification_replay",
    effect: "submit",
    summary: "Replay a finished extraction verification from its registered artifacts and recompute the result.",
    when: "Use to confirm that a past verification still reproduces; it is not a new verification of new output.",
    returns: "Returns the accepted operation; poll verify_status.",
    input: ReplayRunRequestSchema,
    shape: "request",
    notes: [...SUBMIT_NOTES, "Over HTTP the runId in the path must equal runId in the body."],
    example: { verificationContractVersion: "verification.v1", runId: "run-1", replayMode: "deterministic_only" },
    result: acceptedResult("The operation status reports the state; the replay result is recorded with the operation."),
    related: ["tool:verify_extract", "tool:verify_status"],
    mcp: ["verify_bundle_replay"],
    cli: ["verify bundle replay"],
    http: ["POST /v1/verification/runs/{runId}:replay"],
  },
  {
    operation: "verification_benchmark",
    kind: "verification_benchmark",
    effect: "submit",
    summary: "Run a registered, frozen benchmark from recorded observations; no provider is called.",
    when: "Use to score an experiment definition against a dataset; verify_benchmark_compare compares two finished runs.",
    returns:
      "Returns the accepted operation; poll verify_status, then read the run with verify_benchmark_show or verify_benchmark_manifest.",
    input: RunBenchmarkRequestSchema,
    shape: "request",
    notes: [
      ...SUBMIT_NOTES,
      "The deployment must hold a grant for these inputs; without one the call is refused with FORBIDDEN.",
      "dataset and experimentDefinition name registered artifacts by id and digest; executionMode has one admitted value, offline_recorded.",
    ],
    example: {
      verificationContractVersion: "verification.v1",
      dataset: artifact(95, "e"),
      experimentDefinition: artifact(96, "f"),
      executionMode: "offline_recorded",
    },
    result: acceptedResult(
      "When the operation succeeds the signed run is read with verify_benchmark_show (summary) and verify_benchmark_manifest (reproducibility data).",
    ),
    related: ["tool:verify_benchmark_show", "tool:verify_benchmark_manifest", "tool:verify_benchmark_compare"],
    mcp: ["verify_benchmark_run"],
    cli: ["verify benchmark run"],
    http: ["POST /v1/verification/benchmarks:run"],
  },
  {
    operation: "verification_benchmark_compare",
    kind: "verification_benchmark_compare",
    effect: "submit",
    summary: "Compare two finished, signed benchmark runs with a registered comparison profile.",
    when: "Use after two verify_benchmark_run operations succeeded; it reruns neither of them.",
    returns:
      "Returns the accepted operation; poll verify_status, then read the statistics with verify_benchmark_comparison.",
    input: CompareBenchmarkRunsRequestSchema,
    shape: "request",
    notes: [
      ...SUBMIT_NOTES,
      "The deployment must hold a grant for the comparison profile; without one the call is refused with FORBIDDEN.",
      "candidateRunId must differ from baselineRunId.",
    ],
    example: {
      verificationContractVersion: "verification.v1",
      baselineRunId: EXAMPLE.id(97),
      candidateRunId: EXAMPLE.id(98),
      comparisonProfile: "paired_default",
    },
    result: acceptedResult(
      "When the operation succeeds the signed comparison is read with verify_benchmark_comparison.",
    ),
    related: ["tool:verify_benchmark_run", "tool:verify_benchmark_comparison", "tool:verify_status"],
    mcp: ["verify_benchmark_compare"],
    cli: ["verify benchmark compare"],
    http: ["POST /v1/verification/benchmarks:compare"],
  },
  {
    operation: "verification_operation",
    effect: "read",
    summary: "Read the state and receipt ids of one verification operation.",
    when: "Use to poll any verify_* submission; read the result with the show tool of that operation once the state is succeeded.",
    returns:
      "Returns the operation status: kind, state, receiptIds and, after a failure, a failure summary. It never contains the result itself.",
    input: z.strictObject({ operationId: z.uuid() }),
    shape: "flat",
    notes: [
      ...READ_NOTES,
      "state is one of queued, running, needs_review, quarantined, succeeded, failed, cancelled.",
      "On MCP an unknown operation is answered with the text NOT_FOUND.",
    ],
    example: { operationId: OPERATION },
    result: {
      name: "OperationStatus",
      schema: OperationStatusSchema,
      outcome:
        "failure, when present, carries the receipt id, a category, an error class and whether a retry can help.",
    },
    related: ["tool:verify_extraction_show", "tool:verify_benchmark_show", "tool:verify_benchmark_comparison"],
    mcp: ["verify_status"],
    cli: ["verify status"],
    http: ["GET /v1/verification/operations/{operationId}"],
  },
  {
    operation: "structured_extraction_read",
    effect: "read",
    summary:
      "Read the custody record of one structured extraction: its signed publication and either the candidate or the failure.",
    when: "Use after verify_extraction_run finished; the candidate it references is still unverified.",
    returns:
      "Returns the extraction resource with artifact references only, never source text or provider content. Verify output with verify_extract.",
    input: z.strictObject({ operationId: z.uuid() }),
    shape: "flat",
    notes: [
      ...READ_NOTES,
      "operationId is the operationId of the verify_extraction_run operation; only the caller that owns the operation can read it.",
    ],
    example: { operationId: OPERATION },
    result: {
      name: "VerificationStructuredExtractionResource",
      schema: VerificationStructuredExtractionResourceSchema,
      outcome:
        "publication.purpose is artifact_custody_only: the signature proves custody of the artifact, not correctness of the values.",
    },
    related: ["tool:verify_extraction_run", "tool:verify_extract", "tool:verify_reconciliation_show"],
    mcp: ["verify_extraction_show"],
    cli: ["verify extraction show"],
    http: ["GET /v1/verification/extractions/{operationId}"],
  },
  {
    operation: "benchmark_run_read",
    effect: "read",
    summary:
      "Read the summary of one finished, signed benchmark run: dataset, experiment, lifecycle and the status of each arm.",
    when: "Use for the outcome of a run; verify_benchmark_manifest adds the data needed to reproduce it.",
    returns:
      "Returns the run summary with two to sixteen arms, exactly one of them the control. Compare runs with verify_benchmark_compare.",
    input: z.strictObject({ runId: z.uuid() }),
    shape: "flat",
    notes: [
      ...READ_NOTES,
      "qualityClaims are all false by contract: a run is an engineering measurement, not human-validated quality.",
    ],
    example: { runId: EXAMPLE.id(97) },
    result: {
      name: "VerificationBenchmarkRunSummaryResource",
      schema: VerificationBenchmarkRunSummaryResourceSchema,
      outcome: "Each arm has a terminalStatus of succeeded, failed, review or abstained and a summaryDigest.",
    },
    related: ["tool:verify_benchmark_run", "tool:verify_benchmark_manifest", "tool:verify_benchmark_compare"],
    mcp: ["verify_benchmark_show"],
    cli: ["verify benchmark show"],
    http: ["GET /v1/verification/benchmarks/{runId}"],
  },
  {
    operation: "benchmark_manifest_read",
    effect: "read",
    summary:
      "Read the reproducibility data of one finished benchmark run: runtime, execution mode, digests and per-arm artifacts.",
    when: "Use to reproduce or audit a run; verify_benchmark_show is the shorter summary of the same run.",
    returns:
      "Returns the run manifest: everything in the summary plus runtime, execution, runner and checkpoint digests and each arm's configuration and policy artifacts.",
    input: z.strictObject({ runId: z.uuid() }),
    shape: "flat",
    notes: [...READ_NOTES, "execution.externalProviderRequests is always 0: runs replay recorded observations."],
    example: { runId: EXAMPLE.id(97) },
    result: {
      name: "VerificationBenchmarkRunManifestResource",
      schema: VerificationBenchmarkRunManifestResourceSchema,
      outcome: "runtime names the deployment, attempt, code reference and git revision that produced the run.",
    },
    related: ["tool:verify_benchmark_show", "tool:verify_benchmark_run"],
    mcp: ["verify_benchmark_manifest"],
    cli: ["verify benchmark manifest"],
    http: ["GET /v1/verification/benchmarks/{runId}/manifest"],
  },
  {
    operation: "benchmark_comparison_read",
    effect: "read",
    summary:
      "Read the signed statistics of one benchmark comparison: paired rates, differences, intervals and corrected p-values.",
    when: "Use after verify_benchmark_compare succeeded; verify_benchmark_show reads a single run.",
    returns:
      "Returns the comparison with one to sixteen pairs of nine metrics each, the gate outcome and Holm-corrected tests.",
    input: z.strictObject({ comparisonId: z.uuid() }),
    shape: "flat",
    notes: [
      ...READ_NOTES,
      "The statistics describe paired engineering observations; the contract states that independence of the clusters was not assessed.",
    ],
    example: { comparisonId: EXAMPLE.id(99) },
    result: {
      name: "VerificationBenchmarkComparisonResource",
      schema: VerificationBenchmarkComparisonResourceSchema,
      outcome:
        "Each metric reports baseline and candidate rates, the delta, whether a regression was observed, a cluster bootstrap and two p-values.",
    },
    related: ["tool:verify_benchmark_compare", "tool:verify_benchmark_show"],
    mcp: ["verify_benchmark_comparison"],
    cli: ["verify benchmark comparison"],
    http: ["GET /v1/verification/benchmarks/comparisons/{comparisonId}"],
  },
  {
    operation: "provider_reconciliation_read",
    effect: "read",
    summary: "Read the accounting decision applied to one provider attempt of a structured extraction.",
    when: "Use to see what an attempt finally cost; verify_reconciliation_apply records the decision.",
    returns:
      "Returns the applied decision: actual cost, released reservation, the decision artifact and when it was applied.",
    input: RequestIdsSchema,
    shape: "flat",
    notes: [
      ...READ_NOTES,
      "The deployment must have operator reconciliation authority configured; otherwise the read is refused as not admitted.",
      "actualCostMicros and releasedReservationCostMicros are amounts in micros.",
    ],
    example: { operationId: OPERATION, providerAttemptId: EXAMPLE.id(100) },
    result: {
      name: "VerificationProviderReconciliationResource",
      schema: VerificationProviderReconciliationResourceSchema,
      outcome:
        "redispatchAuthorized is always false: a reconciliation settles the original attempt and never sends it again.",
    },
    related: ["tool:verify_reconciliation_apply", "tool:verify_extraction_show"],
    mcp: ["verify_reconciliation_show"],
    cli: ["verify reconciliation show"],
    http: ["GET /v1/verification/extractions/{operationId}/provider-attempts/{providerAttemptId}/reconciliation"],
  },
  {
    operation: "provider_reconciliation_apply",
    effect: "control",
    summary: "Apply a signed accounting decision to one provider attempt of a structured extraction.",
    when: "Use as the operator step that settles the original attempt; it never sends the attempt again.",
    returns:
      "Returns the applied decision at once, with the actual cost and the released reservation; read it later with verify_reconciliation_show.",
    input: RequestIdsSchema.extend(ApplyProviderReconciliationRequestSchema.shape),
    shape: "flat",
    notes: [
      "The caller needs the operation.submit permission for context.tenantId, and the deployment must have operator reconciliation authority configured.",
      "artifact is the full handle of the registered, signed decision document for this operation and provider attempt; byteLength is in bytes.",
    ],
    example: { operationId: OPERATION, providerAttemptId: EXAMPLE.id(100), artifact: handle(101, "application/json") },
    result: {
      name: "VerificationProviderReconciliationResource",
      schema: VerificationProviderReconciliationResourceSchema,
      outcome: "redispatchAuthorized is always false.",
    },
    related: ["tool:verify_reconciliation_show", "tool:verify_extraction_show"],
    mcp: ["verify_reconciliation_apply"],
    cli: ["verify reconciliation apply"],
    http: ["POST /v1/verification/extractions/{operationId}/provider-attempts/{providerAttemptId}/reconciliation"],
  },
];
