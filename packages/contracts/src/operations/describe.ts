import { ENVELOPE_NOTES, toolArgumentsExample, toolArgumentsSchema, type OperationContract } from "./contract-types.js";
import { compactJsonSchema, inputJsonSchema, outputJsonSchema, type JsonSchema } from "./json-schema.js";
import {
  DESCRIBE_PREFIXES,
  OPERATION_CONTRACTS,
  operationContract,
  operationContractForTool,
  operationDescription,
  PLATFORM_TOOL_NAMES,
  toolDescription,
} from "./operation-contracts.js";
import { SKILL_CATALOG } from "./skill-catalog.generated.js";

/** Where an operation can be called. */
export interface OperationSurfaces {
  /** MCP tool names. */
  readonly mcp: readonly string[];
  /** `ks` command lines. */
  readonly cli: readonly string[];
  /** HTTP routes, `METHOD /path`. */
  readonly http: readonly string[];
}

export interface DescribedResult {
  readonly name: string;
  /** Required fields and types of the returned value, two levels deep. */
  readonly shape?: JsonSchema;
  readonly outcome: string;
}

export type Description =
  | {
      readonly ref: string;
      readonly type: "tool";
      readonly name: string;
      readonly operation: string;
      readonly effect: OperationContract["effect"];
      readonly description: string;
      /** JSON Schema of the tool's arguments. */
      readonly arguments: JsonSchema;
      readonly notes: readonly string[];
      /** One valid set of arguments. */
      readonly example: unknown;
      readonly result: DescribedResult;
      readonly related: readonly string[];
      readonly surfaces: OperationSurfaces;
    }
  | {
      readonly ref: string;
      readonly type: "operation";
      readonly name: string;
      readonly effect: OperationContract["effect"];
      readonly description: string;
      /** JSON Schema of the operation's input. */
      readonly input: JsonSchema;
      readonly notes: readonly string[];
      /** One valid input. */
      readonly example: unknown;
      readonly result: DescribedResult;
      readonly related: readonly string[];
      readonly surfaces: OperationSurfaces;
    }
  | {
      readonly ref: string;
      readonly type: "skill";
      readonly name: string;
      readonly version: string;
      readonly description: string;
      readonly surfaces: readonly string[];
      readonly operations: readonly string[];
    };

/** The refusal of a reference `describe` cannot answer. */
export interface DescribeRefusal {
  readonly code: "NOT_FOUND";
  readonly ref: string;
  readonly message: string;
  readonly validPrefixes: readonly string[];
  /** The names that exist under the prefix the caller used; empty when the prefix itself is unknown. */
  readonly valid: readonly string[];
}

export type DescribeResult =
  | { readonly ok: true; readonly description: Description }
  | { readonly ok: false; readonly refusal: DescribeRefusal };

const READ_ENVELOPE_NOTES = Object.freeze([
  "context is the OperationContext the submitting tools take: context.actor must be the caller the bearer token identifies and context.tenantId a tenant that token may read.",
  "expectedVersions is required and not used by this read; {} is accepted.",
]);

const surfaces = (contract: OperationContract): OperationSurfaces => ({
  mcp: contract.mcp,
  cli: contract.cli.map((command) => `ks ${command}`),
  http: contract.http,
});
const result = (contract: OperationContract): DescribedResult => ({
  name: contract.result.name,
  ...(contract.result.schema ? { shape: compactJsonSchema(outputJsonSchema(contract.result.schema), 2) } : {}),
  outcome: contract.result.outcome,
});
const transportNotes = (contract: OperationContract): readonly string[] =>
  contract.shape !== "envelope" ? [] : contract.effect === "read" ? READ_ENVELOPE_NOTES : ENVELOPE_NOTES;

function describeTool(ref: string, tool: string, contract: OperationContract): Description {
  return {
    ref,
    type: "tool",
    name: tool,
    operation: contract.operation,
    effect: contract.effect,
    description: toolDescription(tool) ?? operationDescription(contract),
    arguments: inputJsonSchema(toolArgumentsSchema(contract)),
    notes: [...contract.notes, ...transportNotes(contract)],
    example: toolArgumentsExample(contract),
    result: result(contract),
    related: contract.related,
    surfaces: surfaces(contract),
  };
}

function describeOperation(ref: string, contract: OperationContract): Description {
  return {
    ref,
    type: "operation",
    name: contract.operation,
    effect: contract.effect,
    description: operationDescription(contract),
    input: inputJsonSchema(contract.input),
    notes: contract.notes,
    example: contract.example,
    result: result(contract),
    related: contract.related,
    surfaces: surfaces(contract),
  };
}

const refusal = (ref: string, message: string, valid: readonly string[]): DescribeResult => ({
  ok: false,
  refusal: { code: "NOT_FOUND", ref, message, validPrefixes: DESCRIBE_PREFIXES, valid },
});

/**
 * Everything about one tool, operation or skill. The same answer is served by the MCP tool, the HTTP route and
 * the `ks` command, so a caller with any one of them can learn how to use the others.
 */
export function describeReference(refValue: string): DescribeResult {
  const ref = refValue.trim();
  const separator = ref.indexOf(":");
  const prefix = separator < 0 ? "" : ref.slice(0, separator + 1);
  const name = separator < 0 ? "" : ref.slice(separator + 1);
  if (prefix === "tool:") {
    const contract = operationContractForTool(name);
    return contract
      ? { ok: true, description: describeTool(ref, name, contract) }
      : refusal(ref, `No tool is named ${JSON.stringify(name)}.`, PLATFORM_TOOL_NAMES);
  }
  if (prefix === "operation:") {
    const contract = operationContract(name);
    return contract
      ? { ok: true, description: describeOperation(ref, contract) }
      : refusal(
          ref,
          `No operation is named ${JSON.stringify(name)}.`,
          OPERATION_CONTRACTS.map((item) => item.operation),
        );
  }
  if (prefix === "skill:") {
    const skill = SKILL_CATALOG.find((item) => item.name === name);
    return skill
      ? { ok: true, description: { ref, type: "skill", ...skill } }
      : refusal(
          ref,
          `No skill is named ${JSON.stringify(name)}.`,
          SKILL_CATALOG.map((item) => item.name),
        );
  }
  return refusal(ref, "A reference starts with tool:, operation: or skill:.", []);
}

/**
 * The compact input schema a tool publishes in the tool list: the required fields of its input and their types,
 * `depth` levels deep. `describe` returns the full schema.
 */
export function toolListingSchema(tool: string, depth = 1): JsonSchema | undefined {
  const contract = operationContractForTool(tool);
  if (!contract) return undefined;
  const full = inputJsonSchema(toolArgumentsSchema(contract));
  if (contract.shape === "bare") {
    // An input whose fields are all optional has no compact form: the list publishes it whole, so its fields show.
    const compact = compactJsonSchema(full, depth);
    return compact.properties === undefined ? full : compact;
  }
  // The input of these tools sits one level down, beside a short context.
  if (contract.shape !== "envelope") return compactJsonSchema(full, depth + 1);
  // The context is the same for every tool of this shape, so the list names it without repeating its fields.
  const input = compactJsonSchema(inputJsonSchema(contract.input), depth);
  return {
    type: "object",
    required: ["context", "input", "expectedVersions"],
    properties: {
      context: { type: "object" },
      input: { type: "object", ...input },
      expectedVersions: { type: "object" },
    },
  };
}
