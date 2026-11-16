import {
  CHAIN_OPERATIONS,
  CHAIN_TOOL,
  compactJsonSchema,
  describeChainOperation,
  inputJsonSchema,
  type JsonSchema,
} from "@aiengineer/knowledge-contracts";
import { z, type ZodRawShape } from "zod";

/**
 * What the executor tells a client about its tools. The server validates a call with the tool's full schema; the
 * tool list publishes a short form of that schema so the list stays small, and `knowledge_describe` returns the full
 * one with notes and, for the verification chain, each operation's own input.
 */
export interface ExecutorTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The schema the server validates the arguments with before the handler runs. */
  readonly validated: z.ZodObject;
  /** The typed schema to publish when the handler validates a nested request itself. */
  readonly published?: z.ZodObject;
  /** `knowledge <group> <command>` when the tool is also a CLI command and an HTTP route. */
  readonly cli?: string;
}

export const asObjectSchema = (schema: z.ZodObject | ZodRawShape): z.ZodObject =>
  schema instanceof z.ZodType ? (schema as z.ZodObject) : z.object(schema);

/** A full input schema at or under this size is published whole: compacting it would save little and hide fields. */
export const PUBLISH_WHOLE_BYTES = 560;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The JSON Schema of everything a tool accepts. */
export function fullToolSchema(tool: Pick<ExecutorTool, "validated" | "published">): JsonSchema {
  return inputJsonSchema(tool.published ?? tool.validated);
}

/**
 * The schema a tool publishes in the tool list. A small schema is published whole. A large one keeps every
 * top-level field by name and type, and below that only required fields and their types (two levels), closed value
 * lists included; descriptions, bounds, patterns and optional nested fields are left to `knowledge_describe`.
 */
export function toolListingSchema(tool: Pick<ExecutorTool, "name" | "validated" | "published">): JsonSchema {
  const full = fullToolSchema(tool);
  if (JSON.stringify(full).length <= PUBLISH_WHOLE_BYTES) return full;
  const properties = isObject(full.properties) ? full.properties : {};
  const definitions = isObject(full.$defs) ? { $defs: full.$defs } : {};
  return {
    type: "object",
    description: `Short form. Full schema: knowledge_describe {"ref":"tool:${tool.name}"}.`,
    ...(Array.isArray(full.required) && full.required.length > 0 ? { required: full.required } : {}),
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, node]) => [
        name,
        compactJsonSchema({ ...(isObject(node) ? node : {}), ...definitions }, 2),
      ]),
    ),
  };
}

export interface ToolDescription {
  readonly ref: string;
  readonly type: "tool";
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** JSON Schema of the tool's arguments, in full. */
  readonly arguments: JsonSchema;
  readonly surfaces: {
    readonly mcp: readonly string[];
    readonly cli: readonly string[];
    readonly http: readonly string[];
  };
  /** For `chain_write`: the nine operations, each described in full under its own ref. */
  readonly operations?: readonly { ref: string; step: number; summary: string; role: string }[];
  readonly notes?: readonly string[];
}

export interface DescribeRefusal {
  readonly code: "NOT_FOUND";
  readonly ref: string;
  readonly message: string;
  readonly validPrefixes: readonly string[];
  readonly valid: readonly string[];
}

export type ExecutorDescription =
  | {
      readonly ok: true;
      readonly description: ToolDescription | NonNullable<ReturnType<typeof describeChainOperation>>;
    }
  | { readonly ok: false; readonly refusal: DescribeRefusal };

const CHAIN_TOOL_NOTES = [
  "request is { operation, idempotency_key, input, actor? }. input is the operation's own arguments: read knowledge_describe operation:<name> for its schema, rules and a valid example.",
  "A call is validated in full before anything is submitted; a refused call wrote nothing. A refusal carries the database's stable code, what it means and what to do next.",
  "Three rules have no workaround: a claim becomes verified only through a Knowledge Services admission; no agent writes a person's judgment (human_confirmed, human_rejected, reviewed); verdicts, triage rows and assessments are append-only.",
  "The same idempotency_key with the same input returns the first result with replayed true; with another input it is refused IDEMPOTENCY_KEY_REUSED.",
];

const refusal = (ref: string, message: string, valid: readonly string[]): ExecutorDescription => ({
  ok: false,
  refusal: { code: "NOT_FOUND", ref, message, validPrefixes: ["tool:", "operation:"], valid },
});

/** Everything about one executor tool (`tool:<name>`) or one verification-chain operation (`operation:<name>`). */
export function describeExecutorReference(refValue: string, tools: readonly ExecutorTool[]): ExecutorDescription {
  const ref = refValue.trim();
  const separator = ref.indexOf(":");
  const prefix = separator < 0 ? "" : ref.slice(0, separator + 1);
  const name = separator < 0 ? "" : ref.slice(separator + 1);
  if (prefix === "tool:") {
    const tool = tools.find((item) => item.name === name);
    if (!tool)
      return refusal(
        ref,
        `No tool is named ${JSON.stringify(name)} on this server.`,
        tools.map((item) => item.name),
      );
    return {
      ok: true,
      description: {
        ref,
        type: "tool",
        name: tool.name,
        title: tool.title,
        description: tool.description,
        arguments: fullToolSchema(tool),
        surfaces: {
          mcp: [tool.name],
          cli: tool.cli ? [tool.cli] : [],
          http: tool.cli ? [`POST /knowledge/${tool.name}`] : [],
        },
        ...(tool.name === CHAIN_TOOL
          ? {
              operations: CHAIN_OPERATIONS.map((operation) => ({
                ref: `operation:${operation.operation}`,
                step: operation.step,
                summary: operation.summary,
                role: operation.role,
              })),
              notes: CHAIN_TOOL_NOTES,
            }
          : {}),
      },
    };
  }
  if (prefix === "operation:") {
    const described = describeChainOperation(name);
    return described
      ? { ok: true, description: described }
      : refusal(
          ref,
          `No verification-chain operation is named ${JSON.stringify(name)}.`,
          CHAIN_OPERATIONS.map((operation) => operation.operation),
        );
  }
  return refusal(ref, "A reference starts with tool: or operation:.", []);
}

/** What a client is told once, when it connects. */
export const EXECUTOR_INSTRUCTIONS = [
  "Knowledge Services executor: capture sources and locate quotes, read the knowledge base (schema_*, db_*), ingest facts (ingest_*), write the research verification chain (chain_write) and keep scoped checkpoints.",
  "Start with knowledge_guide, without arguments: the jobs in order, the skill to read and the tools of each job.",
  'The tool list publishes a short form of every large input. Call knowledge_describe with {"ref":"tool:<name>"} before the first use of such a tool: it returns the full schema. For chain_write, {"ref":"operation:<name>"} returns one operation\'s input, rules and a valid example.',
  "Every call is validated with the full schema before anything runs: a wrong input is refused with the failing fields and nothing is written.",
].join("\n");
