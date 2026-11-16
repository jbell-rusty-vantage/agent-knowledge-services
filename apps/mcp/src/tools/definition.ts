import { operationCatalog, type CatalogOperation } from "@aiengineer/knowledge-host";
import {
  toolDescription,
  toolListingSchema,
  ToolReadContextSchema,
  type JsonSchema,
} from "@aiengineer/knowledge-contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

export const McpReadContextSchema = ToolReadContextSchema;

export interface ToolDefinition {
  readonly name: string;
  readonly group: "knowledge" | "verify" | "db" | "jev";
  readonly operation: string;
  /** The schema the server validates the arguments with before the handler runs. */
  readonly inputSchema: ZodRawShape;
  /** The compact JSON Schema the tool list publishes; `knowledge_describe` returns the full one. */
  readonly published: JsonSchema;
  readonly authority: "read" | "submit" | "review";
  readonly description: string;
  readonly run: (value: unknown) => Promise<CallToolResult>;
}

function bindingNames(operation: CatalogOperation): readonly string[] {
  return "on" in operation.mcp ? operation.mcp.on : [];
}

export function catalogToolNames(): Set<string> {
  return new Set(operationCatalog.flatMap((operation) => bindingNames(operation)));
}

/**
 * A tool takes its description and its published input schema from the operation contract. A tool without a
 * written contract is not registered: nothing falls back to a generated description or an untyped input.
 */
export function defineTool(input: Pick<ToolDefinition, "name" | "inputSchema" | "run">): ToolDefinition {
  const operation = operationCatalog.find((row) => bindingNames(row).includes(input.name));
  if (!operation) throw new Error(`UNREGISTERED_MCP_TOOL:${input.name}`);
  const group = input.name.split("_", 1)[0];
  if (group !== "knowledge" && group !== "verify" && group !== "db" && group !== "jev")
    throw new Error(`INVALID_MCP_TOOL_GROUP:${input.name}`);
  const description = toolDescription(input.name);
  const published = toolListingSchema(input.name);
  if (!description || !published) throw new Error(`UNDESCRIBED_MCP_TOOL:${input.name}`);
  return {
    ...input,
    description,
    published,
    operation: operation.id,
    group,
    authority:
      input.name === "verify_adjudication_decision" ? "review" : operation.effect === "read" ? "read" : "submit",
  };
}

export function toolCollector() {
  const definitions: ToolDefinition[] = [];
  return {
    definitions,
    add(name: string, inputSchema: ZodRawShape, run: ToolDefinition["run"]) {
      definitions.push(defineTool({ name, inputSchema, run }));
    },
  };
}
