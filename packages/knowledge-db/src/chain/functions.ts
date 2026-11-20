import type { ChainOperationName } from "@aiengineer/knowledge-contracts";

/** The PostgreSQL type a governed function declares for one parameter; it decides how the value is bound. */
export type ChainParameterType =
  | "text"
  | "uuid"
  | "uuid[]"
  | "jsonb"
  | "boolean"
  | "numeric"
  | "integer"
  | "timestamp with time zone";

/**
 * The signature of each governed function, in declaration order and without `p_idempotency_key` (always first) and
 * `p_actor` (always last): the parameter (the input field with `p_` prefixed) and its declared type. It restates
 * `pg_get_function_identity_arguments` of AI Engineer contract 0.12.0; the integration test compares the two.
 */
export const CHAIN_FUNCTION_PARAMETERS: Readonly<
  Record<ChainOperationName, readonly (readonly [field: string, type: ChainParameterType])[]>
> = {
  record_claim: [
    ["claim_type", "text"],
    ["statement", "text"],
    ["evidence", "jsonb"],
    ["subjects", "jsonb"],
    ["attributions", "jsonb"],
    ["structured", "jsonb"],
  ],
  restate_claim: [
    ["original_claim_id", "uuid"],
    ["statement", "text"],
    ["qualified", "boolean"],
    ["dropped", "text"],
    ["polarity", "jsonb"],
  ],
  register_probe: [
    ["slug", "text"],
    ["title", "text"],
    ["hypothesis", "text"],
    ["kind", "text"],
    ["claims", "jsonb"],
    ["subject_entity_ids", "uuid[]"],
    ["script", "jsonb"],
    ["environment", "jsonb"],
    ["matrix", "jsonb"],
    ["model_policy", "text"],
    ["budget_usd", "numeric"],
  ],
  record_probe_run: [
    ["probe_id", "uuid"],
    ["cell_label", "text"],
    ["outcome", "text"],
    ["started_at", "timestamp with time zone"],
    ["observations", "jsonb"],
    ["output", "jsonb"],
    ["cell", "jsonb"],
    ["resolved", "jsonb"],
    ["run", "jsonb"],
    ["sweep_id", "uuid"],
  ],
  propose_verdict: [
    ["claim_id", "uuid"],
    ["probe_id", "uuid"],
    ["verdict", "text"],
    ["cells", "jsonb"],
    ["rationale", "text"],
  ],
  record_triage: [
    ["claim_id", "uuid"],
    ["disposition", "text"],
    ["checkability", "text"],
    ["rationale", "text"],
    ["priority", "numeric"],
    ["components", "jsonb"],
    ["duplicate_of_claim_id", "uuid"],
    ["probe_id", "uuid"],
  ],
  record_source_assessment: [
    ["subject_entity_id", "uuid"],
    ["method", "text"],
    ["topic_entity_id", "uuid"],
    ["source_role_code", "text"],
    ["conflict_of_interest", "text"],
    ["method_disclosure", "text"],
    ["rationale", "text"],
  ],
  raise_attention_sweep: [
    ["policy", "text"],
    ["trigger_kind", "text"],
    ["trigger_ref", "jsonb"],
    ["note", "text"],
    ["window_from", "timestamp with time zone"],
    ["window_to", "timestamp with time zone"],
  ],
  settle_attention_sweep: [
    ["sweep_id", "uuid"],
    ["outcome", "text"],
    ["items_seen", "integer"],
    ["items_selected", "integer"],
    ["items_captured", "integer"],
    ["rejected", "jsonb"],
    ["spend_usd", "numeric"],
    ["credits", "integer"],
  ],
};

/** The identity arguments of a governed function, as PostgreSQL prints them. */
export function chainFunctionSignature(operation: ChainOperationName): string {
  return [
    "p_idempotency_key text",
    ...CHAIN_FUNCTION_PARAMETERS[operation].map(([field, type]) => `p_${field} ${type}`),
    "p_actor jsonb",
  ].join(", ");
}

export interface ChainStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

const bind = (type: ChainParameterType, value: unknown): unknown => (type === "jsonb" ? JSON.stringify(value) : value);

/**
 * One call of a governed function in named notation. The idempotency key and the actor are bound as the caller
 * sent them; a field the caller left out is not passed, so the function's own default applies.
 */
export function chainStatement(input: {
  readonly operation: ChainOperationName;
  readonly function: string;
  readonly idempotencyKey: string;
  readonly actor: unknown;
  readonly fields: Readonly<Record<string, unknown>>;
}): ChainStatement {
  const parts: string[] = ["p_idempotency_key => $1::text"];
  const values: unknown[] = [input.idempotencyKey];
  for (const [field, type] of CHAIN_FUNCTION_PARAMETERS[input.operation]) {
    const value = input.fields[field];
    if (value === undefined || value === null) continue;
    values.push(bind(type, value));
    parts.push(`p_${field} => $${values.length}::${type}`);
  }
  if (input.actor !== undefined) {
    values.push(JSON.stringify(input.actor));
    parts.push(`p_actor => $${values.length}::jsonb`);
  }
  if (!/^api\.[a-z_]+$/.test(input.function)) throw new Error(`not a governed function: ${input.function}`);
  return { text: `select ${input.function}(${parts.join(", ")}) as result`, values };
}
