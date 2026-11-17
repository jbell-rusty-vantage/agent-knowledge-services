import { z } from "zod";
import { inputJsonSchema, type JsonSchema } from "./operations/json-schema.js";

/**
 * The governed writes of the research verification chain (AI Engineer database contract 0.10.0, schema `api`):
 * nine functions through which a bounded database role records a claim with evidence, restates it, registers a
 * probe, records a run, proposes a verdict, triages a candidate, assesses a source, and opens and settles an
 * attention sweep. This module is the one definition of what a caller sends for each: every transport validates
 * with these schemas before anything is submitted, and `describeChainOperation` returns them in full.
 *
 * Field names are the function's parameter names without the `p_` prefix, and the nested objects (`actor`, an
 * evidence anchor) are the database's own shapes, so the idempotency key and the actor pass through unchanged and
 * the schema workspace pages (`tasks/write-verification-chain.md`) read one to one.
 */

const Uuid = z.uuid();
const JsonObject = z.record(z.string(), z.unknown());
const Text = (max: number) => z.string().trim().min(1).max(max);
const Timestamp = z.iso.datetime({ offset: true });

/** `p_idempotency_key`: chosen by the caller, derived from the operation and never from the attempt. */
export const ChainIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, "an idempotency key is not blank");

/** `p_actor`: who acted. The database records the session role itself; a label never names a person. */
export const GovernedActorSchema = z.strictObject({
  label: z.string().min(1).max(200).optional().describe("The agent or tool that acted; never a person."),
  mission_id: Uuid.optional().describe("orchestration.mission whose budget bounds the work."),
  mc: z
    .strictObject({
      mission_id: Text(200),
      run_id: Text(200),
      operation_id: Text(200),
      operation_attempt: z.int().nonnegative(),
      execution_generation: z.int().nonnegative(),
      lane: Text(200),
      activation_id: Text(200).optional(),
    })
    .optional()
    .describe("The Mission Control invocation that caused the write."),
  origin_digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
});
export type GovernedActor = z.infer<typeof GovernedActorSchema>;

const EvidenceLinkRole = z.enum(["supports", "contradicts", "qualifies", "context"]);

/** One evidence anchor: an existing locator, or a quote that is verbatim in a content unit of a capture. */
export const EvidenceAnchorSchema = z.union([
  z.strictObject({ locator_id: Uuid, role: EvidenceLinkRole.optional() }),
  z.strictObject({
    capture_id: Uuid,
    node_id: Uuid,
    quote: z.string().min(1).max(20_000),
    selector_kind: z.literal("text_quote").optional(),
    role: EvidenceLinkRole.optional(),
  }),
  z.strictObject({
    capture_id: Uuid,
    node_id: Uuid,
    pointer: z.string().min(1).max(2000),
    selector_kind: z.literal("json_pointer"),
    quote: z.string().min(1).max(20_000).optional(),
    role: EvidenceLinkRole.optional(),
  }),
]);
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;

export const SUPPORT_VERDICTS = [
  "directly_supported",
  "supported_with_qualification",
  "partially_supported",
  "context_only",
  "contradicted",
  "not_supported",
  "unverifiable",
  "pending_semantic_review",
  "mixed_or_conflicting",
  "insufficient_evidence",
  "source_unavailable",
  "locator_error",
  "parser_error",
  "derived_verified",
  "derived_failed",
] as const;

export const RecordClaimInputSchema = z.strictObject({
  claim_type: Text(120).describe("A code of evidence.claim_type, for example assertion, capability, measurement."),
  statement: Text(4000),
  evidence: z.array(EvidenceAnchorSchema).min(1).max(50),
  subjects: z
    .array(
      z.union([Uuid, z.strictObject({ entity_id: Uuid, role: z.enum(["subject", "object", "context"]).optional() })]),
    )
    .max(200)
    .optional(),
  attributions: z
    .array(
      z.strictObject({
        entity_id: Uuid,
        role: Text(120).optional(),
        source_id: Uuid.optional(),
        evidence_index: z.int().nonnegative().optional(),
      }),
    )
    .max(200)
    .optional(),
  structured: JsonObject.optional().describe("Free context such as path, source_role, stated_at."),
});

export const RestateClaimInputSchema = z.strictObject({
  original_claim_id: Uuid,
  statement: Text(4000),
  qualified: z.boolean().optional(),
  dropped: z.string().max(400).optional().describe("What the restatement left out, for example attribution."),
  polarity: JsonObject.nullable().optional().describe('For example {"negative": true}.'),
});

export const RegisterProbeInputSchema = z.strictObject({
  slug: z.string().regex(/^[A-Za-z0-9._-]{2,100}$/),
  title: Text(400),
  hypothesis: Text(4000),
  kind: z.enum(["executed", "static_docs", "resolution", "registry_check", "live_model"]),
  claims: z
    .array(z.union([Uuid, z.strictObject({ claim_id: Uuid, expectation: JsonObject.optional() })]))
    .min(1)
    .max(200),
  script: z.strictObject({ path: Text(1000), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  matrix: z.array(JsonObject).max(500).optional().describe('Cells, each with a "label".'),
  model_policy: z.enum(["none", "fake", "live"]).optional(),
  environment: JsonObject.optional(),
  budget_usd: z.number().nonnegative().optional(),
  subject_entity_ids: z.array(Uuid).max(200).optional(),
});

export const RecordProbeRunInputSchema = z.strictObject({
  probe_id: Uuid,
  cell_label: Text(200),
  outcome: z.enum(["pass", "fail", "error", "skipped"]).describe("Of the probe's own checks, not of the claim."),
  started_at: Timestamp,
  cell: JsonObject.optional(),
  observations: JsonObject.optional(),
  resolved: JsonObject.optional().describe("Resolved versions, for example package versions."),
  output: EvidenceAnchorSchema.optional().describe("The captured output; required when outcome is pass or fail."),
  run: z
    .strictObject({
      ended_at: Timestamp.optional(),
      exit_code: z.int().optional(),
      lock_sha256: z.string().max(200).optional(),
      python_version: z.string().max(100).optional(),
      platform: z.string().max(200).optional(),
      tokens_in: z.int().nonnegative().optional(),
      tokens_out: z.int().nonnegative().optional(),
      cost_usd: z.number().nonnegative().optional(),
      latency_ms: z.number().nonnegative().optional(),
    })
    .optional(),
  sweep_id: Uuid.optional(),
});

export const ProposeVerdictInputSchema = z.strictObject({
  claim_id: Uuid,
  probe_id: Uuid,
  verdict: z.enum(SUPPORT_VERDICTS),
  cells: JsonObject.refine((value) => Object.keys(value).length > 0, "name at least one cell").describe(
    "Keyed by the cell labels of the recorded runs the verdict rests on, with what each showed.",
  ),
  rationale: Text(4000),
});

export const RecordTriageInputSchema = z.strictObject({
  claim_id: Uuid,
  disposition: z.enum(["probe", "docs_check", "registry_check", "not_checkable", "duplicate", "out_of_scope"]),
  checkability: z.enum([
    "deterministic_local",
    "needs_live_model",
    "needs_external_service",
    "historical_only",
    "not_applicable",
  ]),
  rationale: Text(4000),
  priority: z.number().min(0).max(100).optional(),
  components: JsonObject.optional(),
  duplicate_of_claim_id: Uuid.optional().describe("Required with disposition duplicate, and only then."),
  probe_id: Uuid.optional().describe("The probe the candidate became; only with disposition probe."),
});

export const RecordSourceAssessmentInputSchema = z.strictObject({
  subject_entity_id: Uuid.describe("A source_channel, community_actor, organization or person."),
  method: z.enum(["prior", "derived"]).describe("reviewed is a person's judgment and is refused."),
  topic_entity_id: Uuid.optional(),
  source_role_code: Text(120).optional().describe("A code of content.source_role; for method prior."),
  conflict_of_interest: z.enum(["none", "vendor_self", "vendor_adjacent", "competitor", "unknown"]).optional(),
  method_disclosure: z.string().max(4000).optional(),
  rationale: z.string().max(4000).optional(),
});

export const RaiseAttentionSweepInputSchema = z.strictObject({
  policy: Text(200).describe("The attention policy slug or id."),
  trigger_kind: z.enum(["schedule", "event", "manual", "backfill"]),
  trigger_ref: JsonObject.optional(),
  note: z.string().max(2000).optional(),
  window_from: Timestamp.optional(),
  window_to: Timestamp.optional(),
});

export const SettleAttentionSweepInputSchema = z.strictObject({
  sweep_id: Uuid,
  outcome: z.enum(["completed", "partial", "failed", "budget_stopped"]),
  items_seen: z.int().nonnegative(),
  items_selected: z.int().nonnegative(),
  items_captured: z.int().nonnegative(),
  rejected: JsonObject.optional().describe('Counts by reason, for example {"off_topic": 26}.'),
  spend_usd: z.number().nonnegative().optional(),
  credits: z.int().nonnegative().optional(),
});

/** The bounded database roles Knowledge Services writes the chain as. */
export type ChainRole = "pipeline_agent" | "verifier_agent";

export interface ChainOperation {
  /** The operation name: the function name without its schema. */
  readonly operation: string;
  /** The governed function it calls. */
  readonly function: `api.${string}`;
  /**
   * The role Knowledge Services calls it as. Claims and sweeps are written as `pipeline_agent`; probes, runs,
   * verdicts, triage and assessments as `verifier_agent`, so the ledger separates who recorded a claim from who
   * judged it. Every role is one the contract grants the function to.
   */
  readonly role: ChainRole;
  /** The step, in the order a chain is written. */
  readonly step: number;
  readonly summary: string;
  readonly returns: string;
  readonly input: z.ZodObject;
  /** What the schema cannot express. */
  readonly notes: readonly string[];
  /** One valid input. */
  readonly example: Record<string, unknown>;
  /** The schema workspace page that explains the step (`schema_get`). */
  readonly task: string;
}

const id = (n: number) => `0192b000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const CHAIN_OPERATIONS: readonly ChainOperation[] = [
  {
    operation: "record_claim",
    function: "api.record_claim",
    role: "pipeline_agent",
    step: 1,
    summary: "Record a statement read from a source as a proposed claim, with 1 to 50 evidence anchors.",
    returns:
      "claim_id, created, reused, status (always proposed for a new claim), locator_ids, subjects, attributions. Next: restate_claim when the statement is attribution-framed, else record_triage.",
    input: RecordClaimInputSchema,
    notes: [
      "An anchor is an existing locator_id, or capture_id + node_id + quote where the quote is verbatim in that content unit (whitespace and typographic quotes aside). Find capture_id and node_id with evidence_units.",
      "The same statement again returns the existing claim with reused true and adds no evidence to it.",
      "structured.path restatement and structured.restates are reserved for restate_claim.",
      "It never sets a status other than proposed. A claim becomes verified only through a Knowledge Services admission.",
    ],
    example: {
      claim_type: "assertion",
      statement: "create_agent ends the loop when tool_calls is empty.",
      evidence: [{ capture_id: id(1), node_id: id(2), quote: "the loop exits when tool_calls is empty" }],
      subjects: [id(11)],
      structured: { path: "first_party_docs", source_role: "first_party" },
    },
    task: "task:record-claim-with-evidence",
  },
  {
    operation: "restate_claim",
    function: "api.restate_claim",
    role: "pipeline_agent",
    step: 2,
    summary:
      'Turn an attribution-framed proposed claim ("the post states that X") into X, the statement a probe can test.',
    returns:
      "claim_id of the restatement, original_claim_id, created, reused, status, probe, copied {subjects, attributions, evidence_links}. Next: record_triage or register_probe on the restatement.",
    input: RestateClaimInputSchema,
    notes: [
      "One restatement per original; only a proposed claim that is not itself a restatement is restated.",
      "The original is never changed; the restatement copies its subjects, attributions and evidence links.",
    ],
    example: {
      original_claim_id: id(1),
      statement: "Passing checkpoint_ns in the config does not change where a root invoke stores checkpoints.",
      qualified: false,
      dropped: "attribution",
      polarity: { negative: true },
    },
    task: "task:record-claim-with-evidence",
  },
  {
    operation: "record_triage",
    function: "api.record_triage",
    role: "verifier_agent",
    step: 3,
    summary: "Record what to do with a proposed claim before anyone checks it. Never a judgment of truth.",
    returns:
      "triage_id, written, unchanged, disposition, review_state (always agent_proposed), supersedes_id. Next: register_probe when the disposition is probe.",
    input: RecordTriageInputSchema,
    notes: [
      "Append-only: a changed triage is a new row that supersedes the agent's current one; the same triage again writes nothing (unchanged true).",
      "A triage a person reviewed is not superseded (TRIAGE_REVIEWED_BY_PERSON).",
      "duplicate_of_claim_id goes with disposition duplicate and only with it; probe_id only with disposition probe.",
    ],
    example: {
      claim_id: id(1),
      disposition: "probe",
      checkability: "deterministic_local",
      rationale: "a short script with a fake model can observe the namespace",
      priority: 85,
    },
    task: "task:triage-claims-and-assess-sources",
  },
  {
    operation: "register_probe",
    function: "api.register_probe",
    role: "verifier_agent",
    step: 4,
    summary: "Register a probe (an experiment) with the claims it tests and what is expected, before any run.",
    returns: "probe_id, slug, state (active), claims. Next: record_probe_run for every cell.",
    input: RegisterProbeInputSchema,
    notes: [
      "kind live_model goes with model_policy live, and only it does; budget_usd is 0 for a probe that calls no live model.",
      "Each claim is an id or {claim_id, expectation}, named once.",
    ],
    example: {
      slug: "P20-checkpoint-ns",
      title: "Checkpoint namespaces",
      hypothesis: "a root checkpoint_ns in the config is not stored",
      kind: "executed",
      claims: [{ claim_id: id(1), expectation: { expected: "root_ns_stays_empty true in every cell" } }],
      matrix: [{ label: "D3-latest" }],
      model_policy: "fake",
    },
    task: "task:propose-verdict-from-probe",
  },
  {
    operation: "record_probe_run",
    function: "api.record_probe_run",
    role: "verifier_agent",
    step: 5,
    summary: "Record one run of a probe in one cell, with its captured output as an evidence anchor.",
    returns:
      "probe_run_id, probe, cell_label, outcome, output_capture_id, output_locator_id, origin_kind, over_budget. Next: propose_verdict once every cell the verdict cites has a run.",
    input: RecordProbeRunInputSchema,
    notes: [
      "A run that passed or failed needs output (PROBE_RUN_OUTPUT_REQUIRED). outcome is about the probe's checks, not about the claim.",
      "Only a live_model probe reports tokens or cost in run. A run made by a Mission Control invocation names actor.mission_id.",
      "sweep_id ties the run to an open sweep of the same mission.",
    ],
    example: {
      probe_id: id(21),
      cell_label: "D3-latest",
      outcome: "pass",
      started_at: "2026-11-16T09:00:00Z",
      observations: { checks: { root_ns_stays_empty: true } },
      resolved: { langgraph: "1.2.22" },
      output: { capture_id: id(1), node_id: id(2), selector_kind: "json_pointer", pointer: "/runs/0" },
    },
    task: "task:propose-verdict-from-probe",
  },
  {
    operation: "propose_verdict",
    function: "api.propose_verdict",
    role: "verifier_agent",
    step: 6,
    summary: "Propose what the recorded runs of a probe show about a claim. A proposal, never a verification.",
    returns:
      "verdict_id, written, unchanged, verdict, review_state (agent_proposed for every row written), supersedes_id, claim_status, claim_status_changed, needs_review, restatements_to_review.",
    input: ProposeVerdictInputSchema,
    notes: [
      "Every key of cells needs a recorded run (VERDICT_CELL_NOT_RUN); the claim must be one the probe was registered to test, or a restatement of one (CLAIM_NOT_PROBED).",
      "Append-only: the same verdict again writes nothing (unchanged true); a changed verdict is a new row that supersedes.",
      "A contradicted verdict from a deterministic probe moves a proposed claim to disputed. A verified claim is never changed: needs_review is true instead.",
      "A person confirms or rejects a verdict elsewhere; a verdict a person rejected is not proposed again.",
    ],
    example: {
      claim_id: id(1),
      probe_id: id(21),
      verdict: "directly_supported",
      cells: { "D3-latest": { root_ns_stays_empty: true } },
      rationale: "stored under the empty namespace in every cell",
    },
    task: "task:propose-verdict-from-probe",
  },
  {
    operation: "record_source_assessment",
    function: "api.record_source_assessment",
    role: "verifier_agent",
    step: 7,
    summary: "Append what is known about a source: a role prior, or an assessment derived from verdicts on its claims.",
    returns:
      "assessment_id, method, written, unchanged, authority_score, and for a derived row claims_observed, claims_checked, self_checked, recommended_watch_level, supersedes_id.",
    input: RecordSourceAssessmentInputSchema,
    notes: [
      "The caller never passes a score. A derived assessment needs a prior first (ASSESSMENT_BASE_REQUIRED) and takes role, conflict of interest and disclosure from it.",
      "method reviewed records a person's judgment and is refused (HUMAN_REVIEW_NOT_AGENT_WRITABLE).",
      "Append-only: a new assessment supersedes; a source a person reviewed on a topic is not superseded.",
    ],
    example: {
      subject_entity_id: id(31),
      method: "prior",
      source_role_code: "community",
      conflict_of_interest: "none",
      rationale: "a community forum",
    },
    task: "task:triage-claims-and-assess-sources",
  },
  {
    operation: "raise_attention_sweep",
    function: "api.raise_attention_sweep",
    role: "pipeline_agent",
    step: 8,
    summary: "Open one execution of an attention policy before the work, under the mission's budget.",
    returns:
      "sweep_id, policy, origin_kind, open, budget_stopped, mission_spent_usd, mission_budget_usd, budget_usd_per_run, budget_credits_per_run. Do the work only when open is true; then settle_attention_sweep.",
    input: RaiseAttentionSweepInputSchema,
    notes: [
      "open false with budget_stopped true: the mission's budget is spent and the sweep is already settled. Stop.",
      "A call made by a Mission Control invocation (actor.mc) names actor.mission_id (MISSION_REQUIRED).",
      "Only an active policy above watch level W0 is swept. Policies are a person's decisions: nothing here creates or changes one.",
    ],
    example: {
      policy: "vendor-issues-on-release",
      trigger_kind: "event",
      trigger_ref: { release: "langgraph 1.2.22" },
      note: "watch tick",
    },
    task: "task:run-attention-sweep",
  },
  {
    operation: "settle_attention_sweep",
    function: "api.settle_attention_sweep",
    role: "pipeline_agent",
    step: 9,
    summary: "Settle an open sweep once, with what was seen, selected and captured and what it cost.",
    returns:
      "sweep_id, policy, outcome, settled, over_budget_usd, over_budget_credits, mission_spent_usd, mission_budget_usd, mission_budget_exhausted.",
    input: SettleAttentionSweepInputSchema,
    notes: [
      "items_captured <= items_selected <= items_seen. Spend is recorded as reported, even over the per-run budget.",
      "A sweep is settled once, under the mission that opened it (SWEEP_ALREADY_SETTLED, SWEEP_MISSION_MISMATCH).",
    ],
    example: {
      sweep_id: id(41),
      outcome: "completed",
      items_seen: 30,
      items_selected: 4,
      items_captured: 4,
      rejected: { off_topic: 26 },
      spend_usd: 0.12,
      credits: 0,
    },
    task: "task:run-attention-sweep",
  },
];

export const CHAIN_OPERATION_NAMES = CHAIN_OPERATIONS.map((item) => item.operation) as [string, ...string[]];
export type ChainOperationName =
  | "record_claim"
  | "restate_claim"
  | "record_triage"
  | "register_probe"
  | "record_probe_run"
  | "propose_verdict"
  | "record_source_assessment"
  | "raise_attention_sweep"
  | "settle_attention_sweep";

export const chainOperation = (name: string): ChainOperation | undefined =>
  CHAIN_OPERATIONS.find((item) => item.operation === name);

/** What a `chain_write` call carries: one operation, the caller's key, its typed input and, optionally, the actor. */
export const ChainWriteRequestSchema = z.strictObject({
  operation: z.enum(CHAIN_OPERATION_NAMES).describe("Which governed write."),
  idempotency_key: ChainIdempotencyKeySchema.describe(
    "Your key for this write, derived from the operation and not from the attempt. The same key with the same input returns the first result (replayed true).",
  ),
  input: JsonObject.describe(
    "The operation's arguments: the function's parameters without p_. Full schema: knowledge_describe operation:<name>.",
  ),
  actor: GovernedActorSchema.optional().describe("Who acted: label, mission_id, mc, origin_digest."),
});
export type ChainWriteRequest = z.infer<typeof ChainWriteRequestSchema>;

/** How a refused governed write is classed; the SQLSTATE of the database error names the class. */
export type GovernedWriteErrorClass = "not_allowed" | "malformed" | "not_found" | "state_refuses" | "taken";

export const GOVERNED_WRITE_SQLSTATE_CLASS: Readonly<Record<string, GovernedWriteErrorClass>> = {
  "42501": "not_allowed",
  "22023": "malformed",
  P0002: "not_found",
  "23514": "state_refuses",
  "23505": "taken",
};

export interface GovernedWriteErrorEntry {
  readonly class: GovernedWriteErrorClass;
  /** What the refusal means. */
  readonly meaning: string;
  /** What to do next. */
  readonly next: string;
}

const entry = (errorClass: GovernedWriteErrorClass, meaning: string, next: string): GovernedWriteErrorEntry => ({
  class: errorClass,
  meaning,
  next,
});
const FIX_INPUT = "Correct the input and call again with the same idempotency key.";
const NOT_RETRYABLE = "Do not retry and do not look for another path: this is a rule, not a fault.";

/**
 * Every stable code a governed write can refuse with (the message of the database error), what it means and what
 * to do next. The 71 codes are the contract's `ApiGovernedWriteErrorCode`; the last entries are the table-level
 * rules a bounded role meets when it writes around the functions.
 */
export const GOVERNED_WRITE_ERRORS = {
  TENANT_CONTEXT_REQUIRED: entry(
    "not_allowed",
    "The transaction carried no tenant.",
    "Report it: the executor sets the tenant, a caller cannot.",
  ),
  HUMAN_REVIEW_NOT_AGENT_WRITABLE: entry(
    "not_allowed",
    "The row would record a person's judgment (review_state human_confirmed or human_rejected, method reviewed). No agent role writes one.",
    `Propose instead (a verdict, a triage, a prior or derived assessment) and ask for the review. ${NOT_RETRYABLE}`,
  ),
  IDEMPOTENCY_KEY_REQUIRED: entry(
    "malformed",
    "The idempotency key is blank or longer than 200 characters.",
    "Send a key of 1 to 200 characters derived from the operation.",
  ),
  ACTOR_INVALID: entry(
    "malformed",
    "actor is not {label, mission_id, mc, origin_digest}, mc is incomplete, origin_digest is not sha256:<64 hex>, or the label names a person (starts with human).",
    "Send the agent or tool as label; with mc send mission_id, run_id, operation_id, operation_attempt, execution_generation and lane together. A governed write is never labelled as a person.",
  ),
  MISSION_REQUIRED: entry(
    "malformed",
    "A sweep or probe run made by a Mission Control invocation did not name the AI Engineer mission whose budget bounds it.",
    "Add actor.mission_id (an orchestration.mission id) beside actor.mc.",
  ),
  STATEMENT_REQUIRED: entry("malformed", "The statement is empty or longer than 4000 characters.", FIX_INPUT),
  CLAIM_TYPE_UNKNOWN: entry(
    "malformed",
    "claim_type is not a code of evidence.claim_type.",
    "Read the codes with db_sql_readonly (select code from evidence.claim_type) and send one of them.",
  ),
  STRUCTURED_INVALID: entry("malformed", "structured is not an object.", FIX_INPUT),
  STRUCTURED_RESERVED: entry(
    "malformed",
    "structured.path restatement and structured.restates are written only by restate_claim.",
    "Remove them, or call restate_claim to restate a claim.",
  ),
  EVIDENCE_REQUIRED: entry(
    "malformed",
    "A claim is recorded with 1 to 50 evidence anchors.",
    "Add at least one anchor; find one with evidence_units.",
  ),
  EVIDENCE_INVALID: entry(
    "malformed",
    "An anchor is not {locator_id} or {capture_id, node_id, quote} (text_quote) or {capture_id, node_id, pointer, selector_kind json_pointer}, mixes both forms, has an unknown role, or its unit has no text.",
    "Send one form per anchor; role is supports, contradicts, qualifies or context.",
  ),
  EVIDENCE_SELECTOR_UNSUPPORTED: entry(
    "malformed",
    "A new anchor is text_quote or json_pointer; another selector kind is made by the capture pipeline.",
    "Pass the locator_id of the existing anchor instead.",
  ),
  QUOTE_REQUIRED: entry(
    "malformed",
    "A text_quote anchor carries the verbatim quote; a quote of only whitespace is no quote.",
    "Add quote, copied from the unit text evidence_units returns.",
  ),
  SUBJECT_INVALID: entry(
    "malformed",
    "A subject is an entity id or {entity_id, role} with role subject, object or context; subjects and attributions are arrays.",
    FIX_INPUT,
  ),
  ATTRIBUTION_INVALID: entry(
    "malformed",
    "An attribution is {entity_id, role, source_id, evidence_index}; evidence_index names one of the anchors of this call.",
    FIX_INPUT,
  ),
  RESTATEMENT_UNCHANGED: entry(
    "malformed",
    "The restated statement is the original statement.",
    "Restate only when the wording changes; otherwise use the original claim.",
  ),
  POLARITY_INVALID: entry("malformed", 'polarity is an object such as {"negative": true}, or null.', FIX_INPUT),
  PROBE_SLUG_INVALID: entry("malformed", "A slug is 2 to 100 letters, digits, dot, underscore or hyphen.", FIX_INPUT),
  PROBE_INVALID: entry(
    "malformed",
    "A probe has a title and a hypothesis; environment is an object, matrix an array of cells, script {path, sha256 of 64 hex}.",
    FIX_INPUT,
  ),
  PROBE_KIND_INVALID: entry(
    "malformed",
    "kind is executed, static_docs, resolution, registry_check or live_model.",
    FIX_INPUT,
  ),
  PROBE_MODEL_POLICY_INVALID: entry("malformed", "model_policy is none, fake or live.", FIX_INPUT),
  PROBE_MODEL_POLICY_MISMATCH: entry(
    "malformed",
    "A live_model probe has model_policy live, and only a live_model probe does.",
    FIX_INPUT,
  ),
  PROBE_BUDGET_INVALID: entry(
    "malformed",
    "budget_usd is 0 for a probe that calls no live model, and never negative.",
    FIX_INPUT,
  ),
  PROBE_CLAIMS_REQUIRED: entry(
    "malformed",
    "A probe is registered with the 1 to 200 claims it tests, each an id or {claim_id, expectation}, named once.",
    "Record the claims first (record_claim), then name them in claims.",
  ),
  PROBE_RUN_INVALID: entry(
    "malformed",
    "The run details are malformed (for example ended_at before started_at, or a non-numeric count).",
    FIX_INPUT,
  ),
  PROBE_RUN_OUTPUT_REQUIRED: entry(
    "malformed",
    "A run that passed or failed is recorded with its captured output as an evidence anchor, so a verdict can cite it.",
    "Capture the run output (verify_capture_file), register it with source_prepare_captured and pass the anchor it returns as output.",
  ),
  VERDICT_INVALID: entry(
    "malformed",
    "verdict is not a value of evidence.support_verdict.",
    "Send one of the values knowledge_describe operation:propose_verdict lists.",
  ),
  VERDICT_REQUIRES_RUNS: entry(
    "malformed",
    "cells is not an object keyed by the cell labels of the runs the verdict rests on, with what each showed.",
    'Record a run for each cell with record_probe_run, then send cells keyed by those cell labels, for example {"D3-latest": {"check": true}}.',
  ),
  RATIONALE_REQUIRED: entry(
    "malformed",
    "A verdict says what the runs showed; a triage row says why.",
    "Add rationale.",
  ),
  TRIAGE_INVALID: entry(
    "malformed",
    "disposition, checkability, priority or components is not an allowed value.",
    FIX_INPUT,
  ),
  TRIAGE_DUPLICATE_INVALID: entry(
    "malformed",
    "disposition duplicate names another claim of the tenant in duplicate_of_claim_id, and only it does.",
    FIX_INPUT,
  ),
  TRIAGE_PROBE_INVALID: entry(
    "malformed",
    "probe_id names the probe a candidate became, with disposition probe.",
    FIX_INPUT,
  ),
  ASSESSMENT_METHOD_INVALID: entry(
    "malformed",
    "method is prior (from the source role) or derived (from the verdicts on the claims the source stated).",
    FIX_INPUT,
  ),
  ASSESSMENT_SUBJECT_INVALID: entry(
    "malformed",
    "A source is a source_channel, community_actor, organization or person.",
    "Assess the entity that published the content, not the content.",
  ),
  ASSESSMENT_ROLE_UNKNOWN: entry(
    "malformed",
    "source_role_code is not a code of content.source_role.",
    "Read the codes with db_sql_readonly (select code from content.source_role).",
  ),
  ASSESSMENT_INVALID: entry(
    "malformed",
    "conflict_of_interest is none, vendor_self, vendor_adjacent, competitor or unknown; a derived assessment takes role, conflict and disclosure from the prior.",
    FIX_INPUT,
  ),
  SWEEP_INVALID: entry(
    "malformed",
    "trigger_kind is schedule, event, manual or backfill; outcome is completed, partial, failed or budget_stopped; the window does not end before it starts.",
    FIX_INPUT,
  ),
  SWEEP_COUNTS_INVALID: entry(
    "malformed",
    "items_captured <= items_selected <= items_seen, none negative; spend and credits are not negative.",
    FIX_INPUT,
  ),
  MISSION_NOT_FOUND: entry(
    "not_found",
    "actor.mission_id names no orchestration.mission in this tenant.",
    "Send the AI Engineer mission id, not the Mission Control mission id (that one goes in actor.mc.mission_id).",
  ),
  EVIDENCE_NOT_FOUND: entry(
    "not_found",
    "The locator or the source capture is not in this tenant.",
    "Find a capture and unit with evidence_units; an executor capture that was not prepared into the knowledge base cannot be anchored yet.",
  ),
  EVIDENCE_UNIT_NOT_IN_CAPTURE: entry(
    "not_found",
    "node_id is not a content unit of a document version read from this capture.",
    "Take capture_id and node_id from the same evidence_units row.",
  ),
  SUBJECT_NOT_FOUND: entry(
    "not_found",
    "A subject entity is not in this tenant.",
    "Resolve the entity first (db_read_intent entity.resolve).",
  ),
  ATTRIBUTION_ENTITY_NOT_FOUND: entry(
    "not_found",
    "An attribution entity is not in this tenant.",
    "Resolve the entity first (db_read_intent entity.resolve).",
  ),
  ATTRIBUTION_SOURCE_NOT_FOUND: entry(
    "not_found",
    "An attribution source is not in this tenant.",
    "Omit source_id to take the source of the anchor, or read sources with db_read_intent evidence.sources_by_domain.",
  ),
  CLAIM_NOT_FOUND: entry(
    "not_found",
    "The claim is not in this tenant.",
    "Use the claim_id record_claim returned, or read it with db_read_intent evidence.claim.",
  ),
  PROBE_NOT_FOUND: entry(
    "not_found",
    "The probe is not in this tenant.",
    "Use the probe_id register_probe returned, or read probes with db_read_intent evidence.probes.",
  ),
  SWEEP_NOT_FOUND: entry(
    "not_found",
    "The attention sweep is not in this tenant.",
    "Use the sweep_id raise_attention_sweep returned, or read db_read_intent acquisition.open_sweeps.",
  ),
  ASSESSMENT_SUBJECT_NOT_FOUND: entry(
    "not_found",
    "The assessed entity is not in this tenant.",
    "Resolve the entity first (db_read_intent entity.resolve).",
  ),
  ASSESSMENT_TOPIC_NOT_FOUND: entry(
    "not_found",
    "The topic entity is not in this tenant.",
    "Resolve the entity first, or omit topic_entity_id for an overall assessment.",
  ),
  ATTENTION_POLICY_NOT_FOUND: entry(
    "not_found",
    "No attention policy has this slug or id in this tenant.",
    "Read db_read_intent acquisition.attention_policies. A policy is a person's decision: do not try to create one.",
  ),
  MISSION_ENDED: entry(
    "state_refuses",
    "The mission named in actor.mission_id has ended.",
    "Stop writing under it; report that the mission ended.",
  ),
  QUOTE_NOT_IN_UNIT: entry(
    "state_refuses",
    "The quote is not verbatim in the unit (after whitespace and typographic quotes are normalised), or the unit has no text to hold one.",
    "Copy the quote from the unit text evidence_units returns; do not paraphrase or join text from two units. A unit with no text anchors nothing: name a unit that has text.",
  ),
  CLAIM_NOT_RESTATABLE: entry(
    "state_refuses",
    "Only a proposed claim that is not itself a restatement is restated.",
    "Use the existing claim; a verified, disputed or restated claim is not restated.",
  ),
  CLAIM_NOT_TRIAGEABLE: entry(
    "state_refuses",
    "Triage is for a candidate: only a proposed claim is triaged.",
    "Do not triage it; read its state with db_read_intent evidence.claim.",
  ),
  CLAIM_NOT_PROBED: entry(
    "state_refuses",
    "The probe was not registered to test this claim (or a claim it restates).",
    "Register a probe that names the claim, or propose the verdict on the claim the probe tests.",
  ),
  PROBE_NOT_ACTIVE: entry(
    "state_refuses",
    "The probe is draft or retired.",
    "Use an active probe, or register a new one.",
  ),
  PROBE_RUN_SPEND_NOT_ALLOWED: entry(
    "state_refuses",
    "The probe's model_policy is not live: a run of it reports no model tokens or cost.",
    "Remove tokens_in, tokens_out and cost_usd from run.",
  ),
  VERDICT_CELL_NOT_RUN: entry(
    "state_refuses",
    "A cell the verdict cites has no recorded run of this probe.",
    "Record the run with record_probe_run first, or cite only cells that ran.",
  ),
  VERDICT_REJECTED_BY_PERSON: entry(
    "state_refuses",
    "A person rejected this verdict of this probe on this claim.",
    `Do not propose it again; new runs that change the verdict are a different proposal. ${NOT_RETRYABLE}`,
  ),
  TRIAGE_REVIEWED_BY_PERSON: entry(
    "state_refuses",
    "A person reviewed the triage of this claim.",
    `Leave it; ask for a new review if the situation changed. ${NOT_RETRYABLE}`,
  ),
  ASSESSMENT_BASE_REQUIRED: entry(
    "state_refuses",
    "A derived assessment moves a role prior; the source has none on this topic.",
    "Record method prior first, then method derived.",
  ),
  ASSESSMENT_REVIEWED_BY_PERSON: entry(
    "state_refuses",
    "A person reviewed this source on this topic.",
    `Leave it; ask for a new review if the evidence changed. ${NOT_RETRYABLE}`,
  ),
  ATTENTION_POLICY_NOT_SWEEPABLE: entry(
    "state_refuses",
    "Only an active, current policy above watch level W0 is swept.",
    "Do not sweep it. Changing a policy is a person's decision.",
  ),
  SWEEP_NOT_OPEN: entry(
    "state_refuses",
    "The sweep is already settled, so nothing more is recorded under it.",
    "Open a new sweep for new work.",
  ),
  SWEEP_ALREADY_SETTLED: entry(
    "state_refuses",
    "A sweep is settled once.",
    "Nothing to do: read the settlement with db_read_intent chain.governed_writes.",
  ),
  SWEEP_MISSION_MISMATCH: entry(
    "state_refuses",
    "A sweep is settled, and its runs recorded, under the mission that opened it (or under none when none did).",
    "Send the same actor.mission_id the sweep was raised with.",
  ),
  IDEMPOTENCY_KEY_REUSED: entry(
    "taken",
    "The key was used with other arguments.",
    "A retry repeats the arguments exactly; a new write takes a new key.",
  ),
  IDEMPOTENCY_KEY_FOREIGN_TENANT: entry("taken", "The key belongs to another tenant.", "Choose another key."),
  RESTATEMENT_EXISTS: entry(
    "taken",
    "The claim is already restated.",
    "Use the existing restatement named in the detail.",
  ),
  PROBE_SLUG_TAKEN: entry(
    "taken",
    "A probe with this slug exists.",
    "Use the existing probe (db_read_intent evidence.probes) or choose another slug.",
  ),
  PROBE_RUN_DUPLICATE: entry(
    "taken",
    "The probe already has a run in this cell started at this time.",
    "Nothing to do for a repeat; a new run has a new started_at.",
  ),
  VERIFIED_CLAIM_REQUIRES_ADMITTED_USE: entry(
    "not_allowed",
    "A claim becomes verified only when Knowledge Services admits a sealed verification run. No chain operation, and no direct write, sets that status.",
    `Say proposed until evidence.verified_claims lists the claim. The path is a sealed research run and its admission (knowledge_operation_invoke), not this tool. ${NOT_RETRYABLE}`,
  ),
  CHAIN_ROLE_NOT_GRANTED: entry(
    "not_allowed",
    "The database does not grant this function to the role Knowledge Services writes it as.",
    "Report it: the AI Engineer database is not at contract 0.10.0 (migration 20261116150000), or its grants were changed.",
  ),
} as const satisfies Record<string, GovernedWriteErrorEntry>;
export type GovernedWriteErrorCode = keyof typeof GOVERNED_WRITE_ERRORS;

export const governedWriteError = (code: string): GovernedWriteErrorEntry | undefined =>
  (GOVERNED_WRITE_ERRORS as Record<string, GovernedWriteErrorEntry>)[code];

/** A refusal Knowledge Services returns before anything is submitted, or relays from the database. */
export interface ChainRefusal {
  readonly code: string;
  readonly class: GovernedWriteErrorClass | "unknown_operation" | "invalid_input";
  readonly message: string;
  readonly next: string;
  readonly details?: unknown;
}

const HUMAN_JUDGMENT_FIELDS = ["review_state", "reviewed_by", "reviewed_at", "decided_by", "confirmed_by"];
const VERIFY_WORDS = /verif|confirm|approve|accept|admit|review|reject/i;

const refuse = (code: GovernedWriteErrorCode, details?: unknown): ChainRefusal => ({
  code,
  class: GOVERNED_WRITE_ERRORS[code].class,
  message: GOVERNED_WRITE_ERRORS[code].meaning,
  next: GOVERNED_WRITE_ERRORS[code].next,
  ...(details === undefined ? {} : { details }),
});

/**
 * The plain refusals of the three rules no chain tool works around, raised with the database's own codes before a
 * request is submitted: no status is set (verified least of all), no row records a person's judgment, and there
 * is no operation that changes or deletes a written row. The database refuses the same writes.
 */
export function chainRuleRefusal(raw: unknown): ChainRefusal | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const request = raw as { operation?: unknown; input?: unknown };
  const operation = typeof request.operation === "string" ? request.operation : "";
  if (operation !== "" && !chainOperation(operation)) {
    if (VERIFY_WORDS.test(operation))
      return /verif|admit/i.test(operation)
        ? refuse("VERIFIED_CLAIM_REQUIRES_ADMITTED_USE", { operation, operations: CHAIN_OPERATION_NAMES })
        : refuse("HUMAN_REVIEW_NOT_AGENT_WRITABLE", { operation, operations: CHAIN_OPERATION_NAMES });
    return {
      code: "CHAIN_OPERATION_UNKNOWN",
      class: "unknown_operation",
      message: `${JSON.stringify(operation)} is not a governed write. Verdicts, triage rows and assessments are append-only: there is no update or delete operation.`,
      next: `Use one of: ${CHAIN_OPERATION_NAMES.join(", ")}.`,
      details: { operation, operations: CHAIN_OPERATION_NAMES },
    };
  }
  const input = request.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  const judgment = HUMAN_JUDGMENT_FIELDS.filter((name) => name in fields);
  if (judgment.length > 0 || fields.method === "reviewed")
    return refuse("HUMAN_REVIEW_NOT_AGENT_WRITABLE", {
      operation,
      fields: fields.method === "reviewed" ? [...judgment, "method"] : judgment,
    });
  if ("status" in fields || "claim_status" in fields)
    return refuse("VERIFIED_CLAIM_REQUIRES_ADMITTED_USE", {
      operation,
      fields: ["status", "claim_status"].filter((name) => name in fields),
    });
  return undefined;
}

export type ParsedChainWrite =
  | {
      readonly ok: true;
      readonly operation: ChainOperation;
      readonly idempotencyKey: string;
      readonly actor: GovernedActor | undefined;
      readonly input: Record<string, unknown>;
    }
  | { readonly ok: false; readonly refusal: ChainRefusal };

/**
 * Validate one `chain_write` call in full: the rules above, the envelope, then the operation's own input schema.
 * Nothing reaches the database unless this returns `ok`.
 */
export function parseChainWrite(raw: unknown): ParsedChainWrite {
  const rule = chainRuleRefusal(raw);
  if (rule) return { ok: false, refusal: rule };
  const envelope = ChainWriteRequestSchema.safeParse(raw);
  if (!envelope.success)
    return {
      ok: false,
      refusal: {
        code: "INPUT_INVALID",
        class: "invalid_input",
        message: "The call does not match { operation, idempotency_key, input, actor? }.",
        next: "Correct the listed fields. Nothing was submitted.",
        details: { issues: envelope.error.issues },
      },
    };
  const operation = chainOperation(envelope.data.operation) as ChainOperation;
  const input = operation.input.safeParse(envelope.data.input);
  if (!input.success)
    return {
      ok: false,
      refusal: {
        code: "INPUT_INVALID",
        class: "invalid_input",
        message: `input does not match the schema of ${operation.operation}.`,
        next: `Correct the listed fields (knowledge_describe operation:${operation.operation} returns the full schema and an example). Nothing was submitted.`,
        details: { operation: operation.operation, issues: input.error.issues },
      },
    };
  return {
    ok: true,
    operation,
    idempotencyKey: envelope.data.idempotency_key,
    actor: envelope.data.actor,
    input: input.data as Record<string, unknown>,
  };
}

export interface ChainOperationDescription {
  readonly ref: string;
  readonly type: "chain_operation";
  readonly name: string;
  readonly function: string;
  readonly role: ChainRole;
  readonly step: number;
  readonly description: string;
  readonly returns: string;
  /** JSON Schema of `input`. */
  readonly input: JsonSchema;
  /** JSON Schema of `actor`. */
  readonly actor: JsonSchema;
  readonly notes: readonly string[];
  /** One valid `chain_write` call. */
  readonly example: unknown;
  readonly task: string;
  readonly surfaces: {
    readonly mcp: readonly string[];
    readonly cli: readonly string[];
    readonly http: readonly string[];
  };
}

export const CHAIN_TOOL = "chain_write";
export const EVIDENCE_UNITS_TOOL = "evidence_units";

/** Everything about one chain operation: the full input schema, the rules the schema cannot express, an example. */
export function describeChainOperation(name: string): ChainOperationDescription | undefined {
  const operation = chainOperation(name);
  if (!operation) return undefined;
  return {
    ref: `operation:${operation.operation}`,
    type: "chain_operation",
    name: operation.operation,
    function: operation.function,
    role: operation.role,
    step: operation.step,
    description: operation.summary,
    returns: `${operation.returns} Every result also carries intent_id, receipt_id and replayed.`,
    input: inputJsonSchema(operation.input),
    actor: inputJsonSchema(GovernedActorSchema),
    notes: operation.notes,
    example: {
      operation: operation.operation,
      idempotency_key: `run-2fa5:${operation.operation}:1`,
      input: operation.example,
      actor: { label: "ks:research-agent" },
    },
    task: operation.task,
    surfaces: {
      mcp: [CHAIN_TOOL],
      cli: ["knowledge chain write <request.json>"],
      http: ["POST /knowledge/chain_write"],
    },
  };
}

/**
 * `evidence_units`: find the content units a claim can quote, with the capture each was read from. A Knowledge
 * Services read (camelCase, like the other executor reads); each row carries the anchor in the database's shape.
 */
export const EvidenceUnitsInputSchema = z.strictObject({
  captureId: Uuid.optional().describe("An evidence.source_capture id."),
  documentId: Uuid.optional().describe("A content.document id."),
  nodeId: Uuid.optional().describe("One content unit."),
  url: z.string().min(1).max(2000).optional().describe("The capture's request URL, exact."),
  text: z.string().min(2).max(400).optional().describe("Words the unit text must contain."),
  limit: z.int().min(1).max(100).optional().describe("Default 20."),
  maxTextChars: z.int().min(80).max(4000).optional().describe("Unit text returned per row; default 600."),
});
export type EvidenceUnitsInput = z.infer<typeof EvidenceUnitsInputSchema>;
export const EVIDENCE_UNITS_FILTERS = ["captureId", "documentId", "nodeId", "url", "text"] as const;
