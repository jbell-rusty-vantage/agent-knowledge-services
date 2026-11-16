import { z } from "zod";
import type { OperationKind } from "../integration.js";
import { PromotionProposalInputSchema } from "../promotion-selection.js";
import { RetrievalRunInputSchema } from "../retrieval.js";
import {
  SelectedCandidateEvaluationInputSchema,
  SelectedCandidateIndexInputSchema,
  VectorStoreCreateInputSchema,
  VectorStoreDocumentsInputSchema,
  VectorStoreIngestionInputSchema,
} from "../vector-store.js";
import {
  CaptureSourceRequestSchema,
  CompareBenchmarkRunsRequestSchema,
  ExtractStructuredDataRequestSchema,
  ReplayRunRequestSchema,
  RunBenchmarkRequestSchema,
  VerifyExtractionRequestSchema,
} from "../verification/requests.js";
import { ParseArtifactRequestSchema } from "../verification/parse.js";
import { EvaluationDatasetInputSchema, EvaluationRunInputSchema, ExperimentInputSchema } from "./evaluation-inputs.js";
import {
  ChunkComparisonInputSchema,
  ChunkPreviewInputSchema,
  ChunkSetInputSchema,
  RepresentationComparisonInputSchema,
  RepresentationDecisionInputSchema,
  TransformationInputSchema,
} from "./preparation-inputs.js";
import {
  EmbeddingRunInputSchema,
  PublicationRollbackInputSchema,
  SpacePublicationInputSchema,
  VectorStoreEvaluationInputSchema,
  VectorStoreIngestionJobInputSchema,
  VectorVerificationInputSchema,
} from "./publication-inputs.js";
import { EvidencePacketInputSchema } from "./retrieval-inputs.js";
import { PromotionDecisionInputSchema, ReviewDecisionInputSchema } from "./review-inputs.js";
import {
  CaptureInputSchema,
  SourceDiscoveryInputSchema,
  SourceResolutionInputSchema,
  SourceVettingInputSchema,
} from "./source-inputs.js";

/** The kinds a caller submits with `{ context, input, expectedVersions }`: every kind except verification's. */
export type KnowledgeOperationKind = Exclude<OperationKind, `verification_${string}`>;
export type VerificationOperationKind = Extract<OperationKind, `verification_${string}`>;

/**
 * The input of every knowledge operation, by kind. A transport checks the caller's input against this schema
 * before it submits the operation, and the worker parses the same schema when it executes the step.
 */
export const OPERATION_INPUT_SCHEMAS = Object.freeze({
  source_discovery: SourceDiscoveryInputSchema,
  source_resolution: SourceResolutionInputSchema,
  capture: CaptureInputSchema,
  source_vetting: SourceVettingInputSchema,
  vector_store_create: VectorStoreCreateInputSchema,
  vector_store_documents: VectorStoreDocumentsInputSchema,
  vector_store_ingestion: VectorStoreIngestionJobInputSchema,
  vector_store_evaluation: VectorStoreEvaluationInputSchema,
  transformation: TransformationInputSchema,
  representation_comparison: RepresentationComparisonInputSchema,
  representation_decision: RepresentationDecisionInputSchema,
  chunk_preview: ChunkPreviewInputSchema,
  chunk_comparison: ChunkComparisonInputSchema,
  chunk_set: ChunkSetInputSchema,
  promotion_proposal: PromotionProposalInputSchema,
  promotion_decision: PromotionDecisionInputSchema,
  embedding_run: EmbeddingRunInputSchema,
  space_publication: SpacePublicationInputSchema,
  publication_verification: VectorVerificationInputSchema,
  publication_rollback: PublicationRollbackInputSchema,
  retrieval_run: RetrievalRunInputSchema,
  evidence_packet: EvidencePacketInputSchema,
  evaluation_dataset: EvaluationDatasetInputSchema,
  experiment: ExperimentInputSchema,
  evaluation_run: EvaluationRunInputSchema,
  review_decision: ReviewDecisionInputSchema,
} satisfies Record<KnowledgeOperationKind, z.ZodType>);

/** The public request of every verification operation, by kind. The caller's context travels beside it. */
export const VERIFICATION_REQUEST_SCHEMAS = Object.freeze({
  verification_capture: CaptureSourceRequestSchema,
  verification_parse_artifact: ParseArtifactRequestSchema,
  verification_extraction: VerifyExtractionRequestSchema,
  verification_structured_extraction: ExtractStructuredDataRequestSchema,
  verification_replay: ReplayRunRequestSchema,
  verification_benchmark: RunBenchmarkRequestSchema,
  verification_benchmark_compare: CompareBenchmarkRunsRequestSchema,
} satisfies Record<VerificationOperationKind, z.ZodType>);

export function isKnowledgeOperationKind(kind: string): kind is KnowledgeOperationKind {
  return Object.hasOwn(OPERATION_INPUT_SCHEMAS, kind);
}

const schemaVersionOf = (input: unknown): unknown =>
  input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).schemaVersion
    : undefined;

/**
 * The schema one input of this kind must satisfy. Two kinds accept two input forms; the form is chosen the way
 * the worker chooses it, so a refusal names the fields of the form the caller sent.
 */
export function operationInputSchemaFor(kind: KnowledgeOperationKind, input: unknown): z.ZodType {
  if (kind === "vector_store_ingestion")
    return schemaVersionOf(input) === "knowledge.selected-candidate-index/v1"
      ? SelectedCandidateIndexInputSchema
      : VectorStoreIngestionInputSchema;
  if (kind === "vector_store_evaluation")
    return schemaVersionOf(input) === "knowledge.selected-candidate-evaluation/v1"
      ? SelectedCandidateEvaluationInputSchema
      : VectorVerificationInputSchema;
  return OPERATION_INPUT_SCHEMAS[kind];
}

/** One reason an input is refused: where, as a dotted path from the request root, and why. */
export interface ContractIssue {
  readonly path: string;
  readonly message: string;
}

/** Every transport reports at most this many issues of one refusal. */
export const MAXIMUM_CONTRACT_ISSUES = 25;

/** The issues of a failed schema check in the form every transport reports with `INVALID_CONTRACT`. */
export function contractIssues(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): ContractIssue[] {
  return error.issues.slice(0, MAXIMUM_CONTRACT_ISSUES).map((issue) => ({
    path: issue.path.map(String).join(".") || "$",
    message: issue.message,
  }));
}

/**
 * Checks the input of a knowledge operation before it is submitted. It throws the schema error with every path
 * placed under `input` (or the request member that carries the input), so the API problem handler, the MCP tools
 * and the CLI report the same `INVALID_CONTRACT` issues. The caller submits the input it was given: defaults are
 * applied by the worker, as before. Verification kinds are not checked here; their request schemas are parsed by
 * the verification submission.
 */
export function assertOperationInput(kind: OperationKind, input: unknown, member = "input"): void {
  if (!isKnowledgeOperationKind(kind)) return;
  const result = operationInputSchemaFor(kind, input).safeParse(input);
  if (result.success) return;
  throw new z.ZodError(result.error.issues.map((issue) => ({ ...issue, path: [member, ...issue.path] })));
}

/** The issues `assertOperationInput` would throw, or an empty list when the input is valid. */
export function operationInputIssues(kind: OperationKind, input: unknown): ContractIssue[] {
  try {
    assertOperationInput(kind, input);
    return [];
  } catch (error) {
    if (error instanceof z.ZodError) return contractIssues(error);
    throw error;
  }
}
