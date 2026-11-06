import { operationCatalog, type CatalogOperation } from "@aiengineer/knowledge-host";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

export const McpReadContextSchema = z.strictObject({
  tenantId: z.uuid(),
  correlationId: z.string().trim().min(1).max(255),
});

export interface ToolDefinition {
  readonly name: string;
  readonly group: "knowledge" | "verify" | "db" | "jev";
  readonly operation: string;
  readonly inputSchema: ZodRawShape;
  readonly authority: "read" | "submit" | "review";
  readonly description: string;
  readonly run: (value: unknown) => Promise<CallToolResult>;
}

function bindingNames(operation: CatalogOperation): readonly string[] {
  return "on" in operation.mcp ? operation.mcp.on : "failsClosed" in operation.mcp ? operation.mcp.failsClosed : [];
}

export function catalogToolNames(): Set<string> {
  return new Set(operationCatalog.flatMap((operation) => bindingNames(operation)));
}

export function defineTool(
  input: Pick<ToolDefinition, "name" | "inputSchema" | "description" | "run">,
): ToolDefinition {
  const operation = operationCatalog.find((row) => bindingNames(row).includes(input.name));
  if (!operation) throw new Error(`UNREGISTERED_MCP_TOOL:${input.name}`);
  const group = input.name.split("_", 1)[0];
  if (group !== "knowledge" && group !== "verify" && group !== "db" && group !== "jev")
    throw new Error(`INVALID_MCP_TOOL_GROUP:${input.name}`);
  return {
    ...input,
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
    add(name: string, config: { description: string; inputSchema: ZodRawShape }, run: ToolDefinition["run"]) {
      definitions.push(defineTool({ name, ...config, run }));
    },
  };
}
