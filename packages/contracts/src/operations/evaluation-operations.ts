import { EvaluationFailuresResourceSchema } from "../resources.js";
import { acceptedResult, EXAMPLE, type OperationContract } from "./contract-types.js";
import {
  EvaluationDatasetInputSchema,
  EvaluationRunInputSchema,
  EvaluationRunReadInputSchema,
  ExperimentInputSchema,
} from "./evaluation-inputs.js";

const DATASET = {
  id: "agent-state-cases",
  version: 1,
  name: "Agent state cases",
  cases: [
    {
      id: "case-1",
      query: "How do agents keep their state?",
      domain: "engineering_claims",
      queryClass: "semantic",
      provenance: ["written for this example"],
      relevanceJudgments: [{ recordId: "record-1", grade: 3, rationale: "States the checkpointing rule." }],
    },
  ],
  reviewed: false,
  reviewMode: "development",
};
const OUTPUT = {
  caseId: "case-1",
  items: [{ recordId: "record-1", rank: 1, score: 0.9 }],
  abstained: false,
  latencyMs: 120,
  costMicros: 15,
};
const DATASET_NOTES = [
  "reviewMode independent (the default) needs reviewed true and a reviewArtifact that accepts the cases, names a reviewer other than the author, lists every case id and binds the case manifest by digest; reviewMode development needs reviewed false and no reviewArtifact.",
  "Case ids must differ. Each case needs a relevanceJudgments entry with a grade above 0, or expectedAbstain true; grades run from 0 (not relevant) to 3.",
  "These rules are checked when the operation runs, not when it is submitted.",
];
const OUTPUT_NOTES = [
  "There must be exactly one output per dataset case, and its items must be ranked 1, 2, 3 and so on without repeating a recordId.",
  "latencyMs is in milliseconds and costMicros is an amount in micros; k is the cut-off the metrics use, 1 to 100 and 10 when omitted.",
];

/** Retrieval evaluation: datasets, scored runs and experiments. */
export const EVALUATION_OPERATIONS: readonly OperationContract[] = [
  {
    operation: "evaluation_dataset",
    kind: "evaluation_dataset",
    effect: "submit",
    summary: "Freeze the retrieval evaluation cases you supply into one versioned dataset with a manifest digest.",
    when: "Use to fix a case set before scoring; it writes no cases itself and knowledge_eval_run scores outputs against a dataset.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Its output is the frozen dataset with manifestDigest.",
    input: EvaluationDatasetInputSchema,
    shape: "envelope",
    notes: DATASET_NOTES,
    example: DATASET,
    result: acceptedResult(
      "On success the step records the dataset with frozen: true, every case completed with its defaults, and manifestDigest.",
    ),
    related: ["tool:knowledge_eval_run", "tool:knowledge_eval_compare", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_eval_generate"],
    cli: ["knowledge eval generate"],
    http: ["POST /v1/eval-datasets"],
  },
  {
    operation: "evaluation_run",
    kind: "evaluation_run",
    effect: "submit",
    summary:
      "Score retrieval outputs you recorded against a dataset: recall, precision, MRR, nDCG and related measures.",
    when: "Use for one system's outputs; knowledge_eval_compare scores several arms against a control. It runs no retrieval itself.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Its output is the report per case, per domain, per query class and overall.",
    input: EvaluationRunInputSchema,
    shape: "envelope",
    notes: [...DATASET_NOTES, ...OUTPUT_NOTES],
    example: { dataset: DATASET, outputs: [OUTPUT] },
    result: acceptedResult(
      "On success the evaluate and report steps each record { stage, report: { datasetManifestDigest, k, cases, overall, byDomain, byQueryClass, outputManifestDigest } }.",
    ),
    related: ["tool:knowledge_eval_generate", "tool:knowledge_eval_compare", "tool:knowledge_eval_failures"],
    mcp: ["knowledge_eval_run"],
    cli: ["knowledge eval run"],
    http: ["POST /v1/eval-runs"],
  },
  {
    operation: "experiment",
    kind: "experiment",
    effect: "submit",
    summary:
      "Score two to twenty arms of recorded retrieval outputs on one dataset and compare each arm with the control.",
    when: "Use to compare configurations; knowledge_eval_run scores a single set of outputs. It runs no retrieval itself.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Its output has a report per arm and the differences from the control.",
    input: ExperimentInputSchema,
    shape: "envelope",
    notes: [
      ...DATASET_NOTES,
      ...OUTPUT_NOTES,
      "Exactly one arm has control true, arm ids must differ, and a dataset or an arm holds at most 500 cases.",
      "configuration is any JSON value that describes the arm; it is recorded, not executed.",
    ],
    example: {
      schemaVersion: "knowledge.experiment/v1",
      id: "rerank-on-off",
      hypothesis: "Reranking improves recall at 10.",
      dataset: DATASET,
      arms: [
        { id: "control", name: "No reranker", control: true, configuration: { reranker: null }, outputs: [OUTPUT] },
        { id: "rerank", name: "Reranker on", control: false, configuration: { reranker: "on" }, outputs: [OUTPUT] },
      ],
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.experiment-result/v1', matrixDigest, arms: [{ arm, report }], comparisons: [{ armId, controlArmId, recallAtKDelta, ndcgAtKDelta, p95LatencyMsDelta, totalCostMicrosDelta }], resultDigest }.",
    ),
    related: ["tool:knowledge_eval_generate", "tool:knowledge_eval_run", "tool:knowledge_eval_failures"],
    mcp: ["knowledge_eval_compare"],
    cli: ["knowledge eval compare"],
    http: ["POST /v1/experiments"],
  },
  {
    operation: "evaluation_failures",
    effect: "read",
    summary: "Read the failing cases of one stored evaluation run, with their metrics and recorded output.",
    when: "Use to see which cases failed and why; knowledge_eval_run scores a dataset and knowledge_eval_compare compares arms.",
    returns:
      "Returns at most 100 cases that did not pass or were falsely accepted or rejected; truncated says whether more exist.",
    input: EvaluationRunReadInputSchema,
    shape: "envelope",
    notes: [
      "runId is the id of a stored evaluation run.",
      "On MCP an input without a valid runId is refused with RESOURCE_ID_REQUIRED.",
    ],
    example: { runId: EXAMPLE.id(84) },
    result: {
      name: "EvaluationFailuresResource",
      schema: EvaluationFailuresResourceSchema,
      outcome: "Each failure has caseId, metrics, falseAcceptance, falseRejection and, when recorded, the output.",
    },
    related: ["tool:knowledge_eval_run", "tool:knowledge_eval_compare"],
    mcp: ["knowledge_eval_failures"],
    cli: ["knowledge eval failures"],
    http: ["GET /v1/eval-runs/{runId}/failures"],
  },
];
